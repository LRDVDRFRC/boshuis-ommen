// Admin-only: send a preview of any lifecycle email to a specified address.
// Useful for sanity-checking email templates (especially the new thank-you email
// with the Putter bird holding the personal code) without having to simulate a
// full booking + payment + cron run.
//
// Usage:
//   GET /api/admin/preview-email?secret=XXX&template=thankyou&to=you@x.com[&code=DP-ABCDEF]
//
// Supported templates:
//   thankyou          → reviewRequestEmail (thank-you + review + personal code)
//   pre-arrival       → preArrivalEmail
//   payment-reminder  → paymentReminderEmail
//   final-reminder    → finalReminderEmail
//   auto-cancel       → autoCancelEmail

import {
  sendEmail, preArrivalEmail, paymentReminderEmail,
  finalReminderEmail, autoCancelEmail, reviewRequestEmail
} from '../_lib/emails.js';

export const maxDuration = 10;

export default async function handler(req, res) {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const to = String(req.query.to || process.env.OWNER_EMAIL || '').trim();
  const template = String(req.query.template || 'thankyou').trim().toLowerCase();
  const lang = ['nl', 'de', 'en'].includes(req.query.lang) ? req.query.lang : 'nl';
  const code = String(req.query.code || 'DP-X3K2Y9').trim().toUpperCase();

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Invalid or missing `to` email address' });
  }

  // A realistic mock booking so the template has everything it needs to render.
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d; };

  const isNH = req.query.source === 'natuurhuisje';

  const mock = {
    reference: 'DPPREVIEW',
    name: 'Jan van Waveren',
    email: to,
    phone: '+31 6 12345678',
    language: lang,
    guests: 4,
    checkin: iso(plus(-5)),
    checkout: iso(plus(-1)),
    nights: 4,
    avgRate: 119,
    subtotal: 476,
    cleaning: 75,
    discount: 0,
    discountPct: 0,
    discountSource: 'none',
    promoCode: null,
    total: 551,
    anyHighSeason: false,
    status: 'paid',
    acceptedAt: plus(-12).toISOString(),
    paidAt: plus(-6).toISOString(),
    personalCode: code,
    personalCodeIssuedAt: new Date().toISOString(),
    notes: 'Preview email — not an actual booking.',
    source: isNH ? 'natuurhuisje' : undefined,
    t: Date.now()
  };

  let emailOut;
  try {
    if (template === 'thankyou' || template === 'review' || template === 'review-request') {
      emailOut = reviewRequestEmail(mock);
    } else if (template === 'pre-arrival' || template === 'prearrival' || template === 'welcome') {
      emailOut = preArrivalEmail(mock, {
        keyCode: process.env.KEY_CODE || '[KEY-CODE]',
        wifiName: process.env.WIFI_NAME || 'Odido-Boshuis',
        wifiPassword: process.env.WIFI_PASSWORD || '[WIFI-PASS]',
        ownerPhone: process.env.OWNER_PHONE || ''
      });
    } else if (template === 'payment-reminder') {
      emailOut = paymentReminderEmail(mock, process.env.OWNER_IBAN || 'NL00 ABCD 0123 4567 89', 'Jan van Waveren');
    } else if (template === 'final-reminder') {
      emailOut = finalReminderEmail(mock, process.env.OWNER_IBAN || 'NL00 ABCD 0123 4567 89', 'Jan van Waveren');
    } else if (template === 'auto-cancel') {
      emailOut = autoCancelEmail(mock);
    } else {
      return res.status(400).json({ error: `Unknown template: ${template}` });
    }

    await sendEmail({
      to,
      subject: `[PREVIEW] ${emailOut.subject}`,
      html: emailOut.html,
      replyTo: process.env.OWNER_EMAIL
    });

    return res.status(200).json({
      ok: true,
      sentTo: to,
      template,
      lang,
      subjectPreview: emailOut.subject,
      note: 'Sent as preview with a fake booking. The booking reference DPPREVIEW is not in the database.'
    });
  } catch (err) {
    console.error('preview-email failed:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
