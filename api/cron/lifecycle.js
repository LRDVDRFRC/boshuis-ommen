// Daily cron — fires once per day at 09:00 UTC (≈10:00-11:00 NL time).
// Walks through pending bookings and sends the right email for each stage:
//
//   Payment reminder      : 2 days before payment deadline, if still awaiting_payment
//   Final payment reminder: on payment deadline day
//   Auto-cancel           : 3 days before check-in, if still unpaid (releases the dates)
//   Pre-arrival Welkomstgids: 3 days before check-in, if paid
//   Review request        : 1 day after check-out, if paid
//
// Idempotent: each send sets a timestamp on the booking so it never re-sends.

import Redis from 'ioredis';
import { listBookings, updateBooking, issuePromoCode } from '../_lib/store.js';
import {
  sendEmail, preArrivalEmail, paymentReminderEmail,
  finalReminderEmail, autoCancelEmail, checkoutDayEmail, reviewRequestEmail
} from '../_lib/emails.js';
import { paymentDeadline, daysBetween } from '../_lib/timing.js';
import { sendWhatsApp } from '../_lib/whatsapp.js';

export const maxDuration = 30;

const DAY_MS = 86_400_000;

export default async function handler(req, res) {
  // Vercel cron auth: only accept requests from Vercel's cron or with the admin secret
  const isCron = req.headers['authorization'] === `Bearer ${process.env.ADMIN_SECRET}` ||
                 req.headers['x-vercel-cron'] === '1';
  const manualSecret = req.query.secret === process.env.ADMIN_SECRET;
  if (!isCron && !manualSecret) return res.status(401).json({ error: 'unauthorized' });

  const iban = process.env.OWNER_IBAN || '';
  const ownerName = process.env.OWNER_NAME || 'Jan van Waveren';
  const envConfig = {
    keyCode: process.env.KEY_CODE,
    wifiName: process.env.WIFI_NAME,
    wifiPassword: process.env.WIFI_PASSWORD,
    ownerPhone: process.env.OWNER_PHONE
  };

  const now = new Date();
  const today0 = new Date(now); today0.setUTCHours(0, 0, 0, 0);

  const bookings = await listBookings({ limit: 500 });
  const actions = [];

  for (const b of bookings) {
    try {
      const checkin = new Date(b.checkin + 'T00:00:00Z');
      const checkout = new Date(b.checkout + 'T00:00:00Z');
      const sent = b.sentEmails || {};
      const daysToCheckin = daysBetween(checkin, today0);
      const daysSinceCheckout = daysBetween(today0, checkout);

      // Natuurhuisje bookings skip payment reminders and auto-cancel
      const isNH = b.source === 'natuurhuisje';

      // 1. Payment reminder — 2 days before deadline, if still awaiting
      if (!isNH && b.status === 'awaiting_payment' && !sent.paymentReminder) {
        const deadline = paymentDeadline(b);
        const daysToDeadline = daysBetween(deadline, today0);
        if (daysToDeadline === 2 || daysToDeadline === 1) {
          const { subject, html } = paymentReminderEmail(b, iban, ownerName);
          await sendEmail({ to: b.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(b.reference, { sentEmails: { ...sent, paymentReminder: now.toISOString() } });
          actions.push({ ref: b.reference, action: 'payment_reminder' });
          continue;
        }
      }

      // 2. Final reminder — on deadline day
      if (!isNH && b.status === 'awaiting_payment' && !sent.finalReminder) {
        const deadline = paymentDeadline(b);
        const daysToDeadline = daysBetween(deadline, today0);
        if (daysToDeadline === 0) {
          const { subject, html } = finalReminderEmail(b, iban, ownerName);
          await sendEmail({ to: b.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(b.reference, { sentEmails: { ...sent, finalReminder: now.toISOString() } });
          actions.push({ ref: b.reference, action: 'final_reminder' });
          continue;
        }
      }

      // 3. Auto-cancel — 3 days before check-in, if still unpaid.
      //    Safeguard: only fire if at least 5 days have passed since acceptance,
      //    so last-minute bookings aren't auto-cancelled before the host has a chance.
      if (!isNH && b.status === 'awaiting_payment' && daysToCheckin <= 3 && daysToCheckin >= 0 && !sent.autoCancel) {
        const acceptedMs = b.acceptedAt ? new Date(b.acceptedAt).getTime() : 0;
        const daysSinceAcceptance = Math.round((Date.now() - acceptedMs) / DAY_MS);
        if (daysSinceAcceptance >= 5) {
          const { subject, html } = autoCancelEmail(b);
          await sendEmail({ to: b.email, subject, html, replyTo: process.env.OWNER_EMAIL });
          await updateBooking(b.reference, {
            status: 'cancelled',
            cancelledAt: now.toISOString(),
            cancelReason: 'auto_no_payment',
            sentEmails: { ...sent, autoCancel: now.toISOString() }
          });
          actions.push({ ref: b.reference, action: 'auto_cancel' });
          continue;
        } else {
          // Too early to auto-cancel — leave it for you to resolve manually
          actions.push({ ref: b.reference, action: 'skipped_autocancel_too_recent', daysSinceAcceptance });
          continue;
        }
      }

      // 4. Pre-arrival — ideally 3 days before check-in, but also catches
      //    last-minute bookings that were paid after the 3-day mark.
      if (b.status === 'paid' && daysToCheckin <= 3 && daysToCheckin >= 0 && !sent.preArrival) {
        const { subject, html } = preArrivalEmail(b, envConfig);
        await sendEmail({ to: b.email, subject, html, replyTo: process.env.OWNER_EMAIL });
        await updateBooking(b.reference, { sentEmails: { ...sent, preArrival: now.toISOString() } });
        await sendWhatsApp(`📬 Welkomstgids verstuurd naar ${b.name} (${b.email}) — check-in ${b.checkin}`);
        actions.push({ ref: b.reference, action: 'pre_arrival' });
        continue;
      }

      // 5. Checkout-day farewell — on checkout day, if paid
      if (b.status === 'paid' && daysSinceCheckout >= 0 && daysSinceCheckout <= 1 && !sent.checkoutDay) {
        const { subject, html } = checkoutDayEmail(b);
        await sendEmail({ to: b.email, subject, html, replyTo: process.env.OWNER_EMAIL });
        await updateBooking(b.reference, { sentEmails: { ...sent, checkoutDay: now.toISOString() } });
        actions.push({ ref: b.reference, action: 'checkout_day' });
        continue;
      }

      // 6. Thank-you + review + personal code — 1 day after check-out, if paid.
      //    This is the moment the customer is still warm from their stay — perfect time to
      //    hand them their own unique share-able code. We issue it here (first-time only)
      //    and embed it in the email where a Putter bird holds a sign with the code.
      if (b.status === 'paid' && daysSinceCheckout >= 1 && daysSinceCheckout <= 5 && !sent.reviewRequest) {
        let bWithCode = b;
        if (!b.personalCode) {
          try {
            const issued = await issuePromoCode({
              ownerRef: b.reference,
              ownerEmail: b.email,
              pct: 10
            });
            bWithCode = await updateBooking(b.reference, {
              personalCode: issued.code,
              personalCodeIssuedAt: now.toISOString()
            }) || { ...b, personalCode: issued.code };
          } catch (err) {
            console.error('issuePromoCode during review step failed (sending email without code):', err);
            // If issuing fails we still send the review email — just without the code block.
          }
        }
        const { subject, html } = reviewRequestEmail(bWithCode);
        await sendEmail({ to: bWithCode.email, subject, html, replyTo: process.env.OWNER_EMAIL });
        await updateBooking(b.reference, {
          sentEmails: { ...(bWithCode.sentEmails || sent), reviewRequest: now.toISOString() }
        });
        actions.push({ ref: b.reference, action: 'review_request_with_code', code: bWithCode.personalCode || null });
        continue;
      }
    } catch (err) {
      console.error(`Error processing booking ${b.reference}:`, err);
      actions.push({ ref: b.reference, action: 'error', detail: String(err.message) });
    }
  }

  // --- iCal monitor: detect new Natuurhuisje bookings and WhatsApp notify ---
  let icalResult = { skipped: true };
  try {
    icalResult = await checkIcalForNewBookings();
  } catch (err) {
    console.error('iCal monitor error (non-fatal):', err.message);
    icalResult = { error: err.message };
  }

  return res.status(200).json({
    ok: true,
    runAt: now.toISOString(),
    totalBookings: bookings.length,
    actionsToken: actions.length,
    actions,
    icalMonitor: icalResult
  });
}

/* ================================================================
   iCal monitor — checks Natuurhuisje feed for new bookings
   and sends WhatsApp notifications for any unseen UIDs.
================================================================ */

const SEEN_KEY = 'ical:seen_uids';

function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false, lazyConnect: false });
}

function parseIcalDate(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
}

function fmtDateShortNL(d) {
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function parseIcalEvents(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let inEvent = false, ev = {};
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; ev = {}; continue; }
    if (line === 'END:VEVENT') {
      if (ev.UID && ev.DTSTART && ev.DTEND) events.push(ev);
      inEvent = false; ev = {};
      continue;
    }
    if (!inEvent) continue;
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const prop = line.slice(0, ci).split(';')[0].toUpperCase();
    if (['UID', 'DTSTART', 'DTEND', 'SUMMARY'].includes(prop)) {
      ev[prop] = line.slice(ci + 1);
    }
  }
  return events;
}

async function checkIcalForNewBookings() {
  const icalUrl = process.env.NATUURHUISJE_ICAL_URL;
  if (!icalUrl) return { skipped: 'no NATUURHUISJE_ICAL_URL' };

  const resp = await fetch(icalUrl, {
    headers: { 'User-Agent': 'BoshuisOmmen/1.0 (+https://boshuisdeputter.nl)' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!resp.ok) throw new Error(`iCal fetch ${resp.status}`);
  const icalText = await resp.text();

  const events = parseIcalEvents(icalText);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const futureEvents = events.filter(ev => {
    const start = parseIcalDate(ev.DTSTART);
    return start && start >= today;
  });

  const r = getRedis();
  if (!r) return { skipped: 'no REDIS_URL' };

  try {
    const seenUids = await r.smembers(SEEN_KEY);
    const seenSet = new Set(seenUids);
    const newEvents = futureEvents.filter(ev => !seenSet.has(ev.UID));
    const isFirstRun = seenUids.length === 0 && futureEvents.length > 0;

    if (isFirstRun) {
      const uids = futureEvents.map(ev => ev.UID);
      if (uids.length > 0) await r.sadd(SEEN_KEY, ...uids);
      return { firstRun: true, seeded: uids.length };
    }

    const notified = [];
    for (const ev of newEvents) {
      const start = parseIcalDate(ev.DTSTART);
      const end = parseIcalDate(ev.DTEND);
      const nights = end && start ? Math.round((end - start) / 86400000) : '?';
      const summary = ev.SUMMARY || 'Boeking';

      await sendWhatsApp(
        `🏡 Nieuwe Natuurhuisje boeking!\n\n` +
        `${summary}\n` +
        `${fmtDateShortNL(start)} → ${fmtDateShortNL(end)} (${nights}n)\n\n` +
        `Check Natuurhuisje voor details.`
      );
      await r.sadd(SEEN_KEY, ev.UID);
      notified.push({ uid: ev.UID, start: start.toISOString().slice(0, 10) });
    }

    // Clean up stale UIDs (past bookings no longer in the feed)
    const allUids = await r.smembers(SEEN_KEY);
    const currentUids = new Set(events.map(ev => ev.UID));
    const stale = allUids.filter(uid => !currentUids.has(uid));
    if (stale.length > 0) await r.srem(SEEN_KEY, ...stale);

    return { total: futureEvents.length, newNotified: notified.length, notified, cleaned: stale.length };
  } finally {
    r.disconnect();
  }
}
