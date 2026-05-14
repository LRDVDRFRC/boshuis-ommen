// Admin API for bookings — list all + mark as paid/cancelled + Natuurhuisje enrollment.
// GET  /api/admin/bookings?secret=XXX                    → list
// POST /api/admin/bookings?secret=XXX&ref=XXX&action=paid → mark paid
// POST /api/admin/bookings?secret=XXX&ref=XXX&action=cancel
// POST /api/admin/bookings?secret=XXX&action=issue-promo   → issue friend promo code(s)
// POST /api/admin/bookings?secret=XXX&action=enroll-nh     → enroll Natuurhuisje guest
// POST /api/admin/bookings?secret=XXX&ref=XXX&action=send-prearrival → send pre-arrival now
// POST /api/admin/bookings?secret=XXX&ref=XXX&action=send-thankyou   → send thank-you now

import {
  listBookings, updateBooking, getBooking, deleteBooking, saveBooking,
  consumePromoCode, releasePromoCode, revokePromoCode,
  issueFriendPromoCode
} from '../_lib/store.js';
import {
  sendEmail, preArrivalEmail, reviewRequestEmail, nhWelcomeEmail
} from '../_lib/emails.js';

const BASE_URL = 'https://boshuisdeputter.nl';

export const maxDuration = 15;

export default async function handler(req, res) {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const bookings = await listBookings({ limit: 500 });
      return res.status(200).json({ ok: true, bookings });
    }

    if (req.method === 'POST') {
      const { ref, action } = req.query;
      if (!action) return res.status(400).json({ error: 'Missing action' });

      // Enroll a Natuurhuisje guest into our email flow
      if (action === 'enroll-nh') {
        const body = req.body || {};
        const { name, email, language, checkin, checkout } = body;
        const guests = Math.min(Math.max(parseInt(body.guests, 10) || 2, 1), 10);
        if (!name || !email || !checkin || !checkout) {
          return res.status(400).json({ error: 'Missing required fields: name, email, checkin, checkout' });
        }
        const checkinDate = new Date(checkin + 'T00:00:00Z');
        const checkoutDate = new Date(checkout + 'T00:00:00Z');
        const nights = Math.round((checkoutDate - checkinDate) / 86400000);
        if (nights < 1) return res.status(400).json({ error: 'checkout must be after checkin' });

        const reference = 'NH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
        const now = new Date().toISOString();
        const booking = {
          reference, source: 'natuurhuisje',
          name: name.trim(), email: email.trim().toLowerCase(),
          language: ['nl', 'de', 'en'].includes(language) ? language : 'nl',
          checkin, checkout, nights, guests,
          status: 'paid', acceptedAt: now, paidAt: now,
          sentEmails: {}, total: 0, subtotal: 0, cleaning: 0, t: Date.now()
        };
        await saveBooking(booking);

        // Send welcome email immediately
        try {
          const { subject, html } = nhWelcomeEmail(booking);
          await sendEmail({ to: booking.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(reference, { sentEmails: { nhWelcome: now } });
        } catch (err) {
          console.error('NH welcome email failed (non-fatal):', err);
        }

        return res.status(200).json({ ok: true, booking });
      }

      // Send pre-arrival or thank-you email for NH booking
      if (action === 'send-prearrival' || action === 'send-thankyou') {
        if (!ref) return res.status(400).json({ error: 'Missing ref' });
        const booking = await getBooking(ref);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const sent = booking.sentEmails || {};
        const now = new Date().toISOString();

        if (action === 'send-prearrival') {
          const envConfig = {
            keyCode: process.env.KEY_CODE, wifiName: process.env.WIFI_NAME,
            wifiPassword: process.env.WIFI_PASSWORD, ownerPhone: process.env.OWNER_PHONE
          };
          const { subject, html } = preArrivalEmail(booking, envConfig);
          await sendEmail({ to: booking.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(ref, { sentEmails: { ...sent, preArrival: now } });
          return res.status(200).json({ ok: true, action: 'pre_arrival_sent', ref });
        }
        if (action === 'send-thankyou') {
          const { subject, html } = reviewRequestEmail(booking);
          await sendEmail({ to: booking.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(ref, { sentEmails: { ...sent, reviewRequest: now } });
          return res.status(200).json({ ok: true, action: 'thankyou_sent', ref });
        }
      }

      // Friend promo issuance — no `ref` needed, returns codes + pre-filled booking URLs
      if (action === 'issue-promo') {
        const body = req.body || {};
        const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 20);
        const pct = Math.min(Math.max(parseInt(body.pct, 10) || 35, 1), 100);
        const waiveCleaning = body.waiveCleaning !== false;
        const expiresInDays = Math.min(Math.max(parseInt(body.expiresInDays, 10) || 30, 1), 365);
        const note = (body.note || '').toString().slice(0, 120);
        const codes = [];
        for (let i = 0; i < count; i++) {
          const rec = await issueFriendPromoCode({ pct, waiveCleaning, expiresInDays, note });
          codes.push({
            code: rec.code,
            pct: rec.pct,
            waiveCleaning: !!rec.waiveCleaning,
            expiresAt: rec.expiresAt,
            note: rec.note || '',
            url: `${BASE_URL}/?promo=${encodeURIComponent(rec.code)}#booking`
          });
        }
        return res.status(200).json({ ok: true, codes });
      }

      if (!ref) return res.status(400).json({ error: 'Missing ref' });
      const booking = await getBooking(ref);
      if (!booking) return res.status(404).json({ error: 'Booking not found' });

      const now = new Date().toISOString();
      let updated;
      if (action === 'paid') {
        // Mark booking paid + consume any redeemed promo code.
        // The customer's OWN personal code is issued later — see cron/lifecycle.js,
        // where it's generated and included in the post-stay thank-you email.
        if (booking.promoCode) {
          try {
            await consumePromoCode(booking.promoCode, booking.reference);
          } catch (err) {
            console.error('consumePromoCode failed (continuing):', err);
          }
        }
        updated = await updateBooking(ref, { status: 'paid', paidAt: now });

      } else if (action === 'cancel') {
        const patch = {
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: req.query.reason || 'manual'
        };

        // Release any reserved code (a booking using someone's code) back to active
        if (booking.promoCode && booking.status !== 'paid') {
          try { await releasePromoCode(booking.promoCode); } catch (err) { console.error('releasePromoCode failed:', err); }
        }
        // Revoke the code THIS booking earned — it shouldn't be spendable if the trip never happened
        if (booking.personalCode) {
          try { await revokePromoCode(booking.personalCode); } catch (err) { console.error('revokePromoCode failed:', err); }
        }

        updated = await updateBooking(ref, patch);

      } else if (action === 'tonia-paid') {
        updated = await updateBooking(ref, { toniaPaid: true, toniaPaidAt: now });

      } else if (action === 'tonia-unpaid') {
        updated = await updateBooking(ref, { toniaPaid: false, toniaPaidAt: null });

      } else if (action === 'unpay') {
        // Undo mark-as-paid if mistakenly set. Don't touch the personal code — keep issued,
        // but reverse the consumption of the redeemed code so the customer isn't unfairly charged.
        if (booking.promoCode) {
          try { await releasePromoCode(booking.promoCode); } catch (err) { console.error('releasePromoCode failed:', err); }
        }
        updated = await updateBooking(ref, { status: 'awaiting_payment', paidAt: null });

      } else {
        return res.status(400).json({ error: `Unknown action: ${action}` });
      }
      return res.status(200).json({ ok: true, booking: updated });
    }

    if (req.method === 'DELETE') {
      const { ref } = req.query;
      if (!ref) return res.status(400).json({ error: 'Missing ref' });
      await deleteBooking(ref);
      return res.status(200).json({ ok: true, deleted: ref });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admin/bookings error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
