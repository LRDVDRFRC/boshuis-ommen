// Receives a booking request from the website form.
// Sends: (1) notification email to the owner with accept/decline links,
//        (2) acknowledgement email to the guest.
// No database — booking data is signed into the accept/decline URLs so
// /api/booking-action can verify + act on them without any stored state.
//
// Env vars:
//   RESEND_API_KEY  — for email sending (required)
//   ADMIN_SECRET    — used as HMAC signing key (reused from admin)
//   OWNER_EMAIL     — recipient of owner notification (default janvanwaveren@gmail.com)
//   OWNER_IBAN      — used in accept email; not needed in request flow

import crypto from 'node:crypto';
import { getPromoCode, reservePromoCode, isPromoExpired } from './_lib/store.js';
import { sendWhatsApp } from './_lib/whatsapp.js';

export const maxDuration = 15;

/* ========== PRICING (mirrors website; server is source of truth) ========== */
const PRICING = {
  baseRate: 119,
  cleaning: 75,
  weekendSurcharge: 15,
  minNights: 2,
  minNightsHighSeason: 2,
  seasons: [
    { from: [12, 20], to: [1, 5],   rate: 135, high: true },
    { from: [2, 15],  to: [3, 5],   rate: 125 },
    { from: [4, 24],  to: [5, 10],  rate: 130, high: true },
    { from: [5, 11],  to: [5, 20],  rate: 125 },
    { from: [5, 21],  to: [6, 5],   rate: 125 },
    { from: [7, 1],   to: [8, 31],  rate: 135, high: true },
    { from: [6, 15],  to: [6, 30],  rate: 125 },
    { from: [10, 15], to: [11, 1],  rate: 125 },
    { from: [9, 1],   to: [10, 14], rate: 119 },
    { from: [3, 6],   to: [4, 23],  rate: 119 },
    { from: [11, 2],  to: [12, 19], rate: 85 },
    { from: [1, 6],   to: [2, 14],  rate: 85 }
  ],
  stayDiscounts: [
    { minNights: 14, pct: 10 },
    { minNights: 7,  pct: 5 }
  ]
  // Promo codes are stored in KV (see _lib/store.js) and validated server-side,
  // since they are unique per customer and one-time use.
};

function dateInSeason(d, s) {
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const curr = m * 100 + day;
  const start = s.from[0] * 100 + s.from[1];
  const end = s.to[0] * 100 + s.to[1];
  return start <= end ? (curr >= start && curr <= end) : (curr >= start || curr <= end);
}

function getNightlyRate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let rate = PRICING.baseRate, high = false;
  for (const s of PRICING.seasons) {
    if (dateInSeason(d, s)) { rate = s.rate; high = !!s.high; break; }
  }
  const dow = d.getUTCDay();
  if (dow === 5 || dow === 6) rate += PRICING.weekendSurcharge;
  return { rate, high };
}

/** Price calculator — pure math. Promo discount is passed in pre-validated (from KV). */
function calculateStay(checkin, checkout, promoDiscount = null) {
  const start = new Date(checkin + 'T00:00:00Z');
  const end = new Date(checkout + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const nights = Math.round((end - start) / 86400000);
  if (nights <= 0) return null;

  let subtotal = 0;
  let anyHighSeason = false;
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const info = getNightlyRate(d.toISOString().slice(0, 10));
    subtotal += info.rate;
    if (info.high) anyHighSeason = true;
  }

  const requiredMin = anyHighSeason ? PRICING.minNightsHighSeason : PRICING.minNights;
  if (nights < requiredMin) return { tooShort: true, nights, requiredMin };

  // Length-of-stay discount
  let stayDiscountPct = 0;
  for (const d of PRICING.stayDiscounts) {
    if (nights >= d.minNights) { stayDiscountPct = d.pct; break; }
  }

  // Promo code discount — passed in pre-validated (the caller looked it up in KV)
  const promoDiscountPct = (promoDiscount && promoDiscount.pct) || 0;
  const promoApplied = !!promoDiscount;
  const promoKey = promoApplied ? promoDiscount.code : null;
  const promoWaivesCleaning = promoApplied && !!promoDiscount.waiveCleaning;

  // Policy: don't stack % discounts — use whichever gives the bigger discount.
  // BUT: if a friend promo waives cleaning, always honor the promo (even if stay-% is higher),
  // otherwise the cleaning waiver would be silently dropped.
  const usePromo = promoApplied && (promoDiscountPct >= stayDiscountPct || promoWaivesCleaning);
  const discountPct = usePromo ? promoDiscountPct : stayDiscountPct;
  const discount = Math.round(subtotal * discountPct / 100);
  const discountSource = usePromo ? 'promo'
                       : stayDiscountPct > 0 ? 'stay'
                       : 'none';

  const cleaning = promoWaivesCleaning && usePromo ? 0 : PRICING.cleaning;
  const total = subtotal - discount + cleaning;
  return {
    nights, subtotal, discount, discountPct,
    discountSource, promoCode: discountSource === 'promo' ? promoKey : null,
    cleaningWaived: cleaning === 0 && PRICING.cleaning > 0,
    cleaning, total,
    avgRate: Math.round(subtotal / nights),
    anyHighSeason
  };
}

/* ========== SIGNED TOKEN (HMAC-SHA256) ========== */
export function signPayload(payload) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET env var not configured');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    // 14-day expiry to be safe for late accepts
    if (Date.now() - payload.t > 14 * 24 * 3600 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ========== EMAIL (Resend) ========== */
async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY env var not configured');

  const body = {
    from: 'De Putter · Boshuis Ommen <reserveringen@boshuisdeputter.nl>',
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };
  if (replyTo) body.reply_to = replyTo;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend ${resp.status}: ${errText}`);
  }
  return resp.json();
}

/* ========== HTML TEMPLATES ========== */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const LOGO_URL = 'https://boshuisdeputter.nl/putter-logo.png';

function logoHeader(title, accentColor = '#2d5016') {
  return `<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:12px">
    <tr><td align="center" style="padding:8px 0 0"><img src="${LOGO_URL}" width="64" height="64" alt="De Putter" style="display:block;border:0"></td></tr>
    <tr><td align="center" style="padding:10px 0 20px"><h1 style="margin:0;color:${accentColor};font-family:Georgia,serif;font-size:26px;font-weight:700">${title}</h1></td></tr>
  </table>`;
}

function ownerNotificationHtml(b, baseUrl, token) {
  const acceptUrl = `${baseUrl}/api/booking-action?t=${encodeURIComponent(token)}&action=accept`;
  const declineUrl = `${baseUrl}/api/booking-action?t=${encodeURIComponent(token)}&action=decline`;
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader('Nieuw boekingsverzoek')}
    <p>Hoi Jan, er is een nieuw boekingsverzoek binnen voor De Putter.</p>

    <div style="background:#fff;border-left:4px solid #2d5016;padding:16px 20px;border-radius:0 8px 8px 0;margin:16px 0">
      <h2 style="margin:0 0 8px;color:#2d5016;font-size:18px;font-family:Georgia,serif">Het verblijf</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#636e72">Aankomst</td><td style="padding:4px 0"><strong>${fmtDate(b.checkin)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Vertrek</td><td style="padding:4px 0"><strong>${fmtDate(b.checkout)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Nachten</td><td style="padding:4px 0">${b.nights} (€${b.avgRate}/n gem.)${b.anyHighSeason ? ' · <span style="color:#c9a96e">hoogseizoen</span>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Gasten</td><td style="padding:4px 0">${b.guests}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Subtotaal</td><td style="padding:4px 0">€${b.subtotal}</td></tr>
        ${b.discount > 0 ? `<tr><td style="padding:4px 0;color:#0b6e2f">Korting ${b.discountPct}%${b.discountSource === 'promo' ? ` <code style="background:#e8f5e0;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace;font-size:11px">${esc(b.promoCode)}</code>` : ''}</td><td style="padding:4px 0;color:#0b6e2f">−€${b.discount}</td></tr>` : ''}
        ${b.cleaningWaived
          ? `<tr><td style="padding:4px 0;color:#0b6e2f">Schoonmaak</td><td style="padding:4px 0;color:#0b6e2f">gratis <span style="font-size:11px;color:#0b6e2f">(vrienden-korting)</span></td></tr>`
          : `<tr><td style="padding:4px 0;color:#636e72">Schoonmaak</td><td style="padding:4px 0">€${b.cleaning}</td></tr>`}
        <tr><td style="padding:4px 0;color:#636e72;border-top:1px solid #eee;padding-top:8px">Totaal</td><td style="padding:4px 0;font-size:18px;font-weight:700;color:#2d5016;border-top:1px solid #eee;padding-top:8px">€${b.total}</td></tr>
      </table>
    </div>

    <div style="background:#fff;border-left:4px solid #c9a96e;padding:16px 20px;border-radius:0 8px 8px 0;margin:16px 0">
      <h2 style="margin:0 0 8px;color:#5c3d2e;font-size:18px;font-family:Georgia,serif">De gast</h2>
      <table style="width:100%;font-size:14px">
        <tr><td style="padding:4px 0;color:#636e72;width:90px">Naam</td><td style="padding:4px 0"><strong>${esc(b.name)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Email</td><td style="padding:4px 0"><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">Telefoon</td><td style="padding:4px 0">${esc(b.phone) || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72;vertical-align:top">Taal</td><td style="padding:4px 0">${esc(b.language).toUpperCase()}</td></tr>
      </table>
      ${b.notes ? `<div style="margin-top:12px;padding:12px;background:#fdf8f0;border-radius:6px;font-size:14px;font-style:italic">💬 "${esc(b.notes)}"</div>` : ''}
    </div>

    <h2 style="color:#2d5016;font-family:Georgia,serif;margin-top:32px">Wat nu?</h2>
    <p>Klik op één van de knoppen hieronder. De gast krijgt automatisch de bijbehorende email.</p>

    <div style="text-align:center;margin:24px 0">
      <a href="${acceptUrl}" style="display:inline-block;background:#2d5016;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:4px">✅ Accepteren &amp; betaalinstructies sturen</a>
      <br>
      <a href="${declineUrl}" style="display:inline-block;background:transparent;color:#c0392b;padding:10px 20px;border:1.5px solid #c0392b;border-radius:8px;text-decoration:none;font-weight:600;margin:8px;font-size:13px">❌ Afwijzen (met vriendelijke reden)</a>
    </div>

    <div style="background:#fff4d6;padding:12px 16px;border-radius:6px;font-size:13px;color:#7d5a00;margin:16px 0">
      ℹ️ <strong>Na acceptatie:</strong> blokkeer de datums handmatig in Natuurhuisje zodat er geen dubbele boeking ontstaat. De gast betaalt binnen 7 dagen via overschrijving — zodra de betaling binnen is, is de boeking definitief.
    </div>

    <p style="font-size:12px;color:#888;margin-top:32px">Kenmerk: <code>${esc(b.reference)}</code> · Verstuurd: ${new Date(b.t).toLocaleString('nl-NL')}</p>
  </body></html>`;
}

function guestAckHtml(b, lang) {
  const checkinMs = new Date(b.checkin + 'T00:00:00Z').getTime();
  const hoursUntilCheckin = (checkinMs - Date.now()) / 3_600_000;
  const veryUrgent = hoursUntilCheckin < 48;
  const t = {
    nl: {
      subject: 'Bedankt voor je boekingsverzoek — De Putter',
      h1: 'Bedankt voor je boekingsverzoek!',
      intro: veryUrgent
        ? `Hoi ${esc(b.name)}, we hebben je verzoek voor <strong>De Putter</strong> ontvangen. Omdat je verblijf al snel begint, komen we zo spoedig mogelijk bij je terug met een persoonlijke bevestiging en betaalinstructies.`
        : `Hoi ${esc(b.name)}, we hebben je verzoek voor <strong>De Putter</strong> ontvangen. Binnen 24 uur komen we bij je terug met een persoonlijke bevestiging en betaalinstructies.`,
      stayH: 'Jouw verzoek',
      labels: { arr: 'Aankomst', dep: 'Vertrek', nights: 'Nachten', guests: 'Gasten', total: 'Totaal' },
      note: 'Let op: de boeking is pas definitief na onze bevestiging en ontvangst van de betaling.',
      funH: 'Wist je dat?',
      fun: 'De putter (<em>Carduelis carduelis</em>), vaak distelvink genoemd, is een kleurrijke zangvogel met een rood masker, zwart-witte kop en gele vleugelstrepen. Hij dankt zijn naam aan het vroeger leren "putten" van water met een vingerhoedje aan een ketting in kooien, en is dol op distelzaden.',
      follow: 'Volg ons ondertussen op Instagram voor foto\'s uit het bos',
      signoff: 'Tot zo,',
      sig: 'Jan — De Putter · Boshuis Ommen',
      ref: 'Kenmerk'
    },
    de: {
      subject: 'Vielen Dank für Ihre Buchungsanfrage — De Putter',
      h1: 'Vielen Dank für Ihre Buchungsanfrage!',
      intro: veryUrgent
        ? `Hallo ${esc(b.name)}, wir haben Ihre Anfrage für <strong>De Putter</strong> erhalten. Da Ihr Aufenthalt bald beginnt, melden wir uns so schnell wie möglich mit einer persönlichen Bestätigung und Zahlungsanweisungen.`
        : `Hallo ${esc(b.name)}, wir haben Ihre Anfrage für <strong>De Putter</strong> erhalten. Innerhalb von 24 Stunden erhalten Sie eine persönliche Bestätigung und Zahlungsanweisungen.`,
      stayH: 'Ihre Anfrage',
      labels: { arr: 'Anreise', dep: 'Abreise', nights: 'Nächte', guests: 'Gäste', total: 'Gesamt' },
      note: 'Hinweis: Die Buchung wird erst nach unserer Bestätigung und Zahlungseingang endgültig.',
      funH: 'Wussten Sie schon?',
      fun: 'Der Stieglitz (<em>Carduelis carduelis</em>), auf Niederländisch "putter" genannt, ist ein farbenfroher Singvogel mit roter Maske, schwarz-weißem Kopf und gelben Flügelstreifen. Seinen niederländischen Namen verdankt er einem alten Brauch: in Käfigen wurden sie früher dressiert, mit einem winzigen Fingerhut an einer Kette Wasser hochzuziehen ("putten"). Ihre Leibspeise: Distelsamen.',
      follow: 'Folgen Sie uns inzwischen auf Instagram für Fotos aus dem Wald',
      signoff: 'Bis bald,',
      sig: 'Jan — De Putter · Boshuis Ommen',
      ref: 'Referenz'
    },
    en: {
      subject: 'Thanks for your booking request — De Putter',
      h1: 'Thanks for your booking request!',
      intro: veryUrgent
        ? `Hi ${esc(b.name)}, we've received your request for <strong>De Putter</strong>. Since your stay starts very soon, we'll get back to you as soon as possible with a personal confirmation and payment instructions.`
        : `Hi ${esc(b.name)}, we've received your request for <strong>De Putter</strong>. Within 24 hours you'll get a personal confirmation and payment instructions.`,
      stayH: 'Your request',
      labels: { arr: 'Check-in', dep: 'Check-out', nights: 'Nights', guests: 'Guests', total: 'Total' },
      note: 'Note: the booking is only final after our confirmation and payment has been received.',
      funH: 'Did you know?',
      fun: 'The "putter" (<em>Carduelis carduelis</em>), commonly called the European goldfinch, is a colourful songbird with a red face mask, black-and-white head and yellow wing bars. Its Dutch name comes from an old practice of training caged birds to draw ("putten") water up from a well with a tiny thimble on a chain — and it\'s crazy about thistle seeds.',
      follow: 'Follow us on Instagram in the meantime for photos from the forest',
      signoff: 'See you soon,',
      sig: 'Jan — De Putter · Boshuis Ommen',
      ref: 'Reference'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p>${t.intro}</p>

    <div style="background:#fff;border-left:4px solid #2d5016;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
      <h2 style="margin:0 0 8px;color:#2d5016;font-size:17px;font-family:Georgia,serif">${t.stayH}</h2>
      <table style="width:100%;font-size:14px">
        <tr><td style="padding:4px 0;color:#636e72;width:120px">${t.labels.arr}</td><td><strong>${fmtDate(b.checkin)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.dep}</td><td><strong>${fmtDate(b.checkout)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.nights}</td><td>${b.nights}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.guests}</td><td>${b.guests}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.total}</td><td style="font-weight:700;color:#2d5016">€${b.total}</td></tr>
      </table>
    </div>

    <p style="color:#7d5a00;background:#fff4d6;padding:10px 14px;border-radius:6px;font-size:13px">ℹ️ ${t.note}</p>

    <div style="background:#fdf8f0;border-left:3px solid #c9a96e;padding:14px 18px;border-radius:0 8px 8px 0;margin:28px 0 20px">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;font-weight:600;margin-bottom:4px">🪶 ${t.funH}</div>
      <p style="font-size:13.5px;color:#5c3d2e;margin:0;line-height:1.65;font-style:italic">${t.fun}</p>
    </div>

    <p style="margin-top:32px">${t.signoff}<br><strong>${t.sig}</strong></p>

    <p style="text-align:center;font-size:13px;color:#636e72;margin-top:24px;padding-top:16px;border-top:1px solid #eee">
      📷 ${t.follow}:
      <a href="https://www.instagram.com/boshuisommen/" target="_blank" rel="noopener" style="color:#2d5016;font-weight:600;text-decoration:none">@boshuisommen</a>
    </p>
    <p style="font-size:11px;color:#888;margin-top:12px">${t.ref}: ${esc(b.reference)}</p>
  </body></html>`;

  return { subject: t.subject, html };
}

/* ========== HANDLER ========== */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://boshuisdeputter.nl');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { checkin, checkout, guests, name, email, phone, notes, language, honeypot, promoCode } = req.body || {};

  // Anti-spam honeypot — if filled, silently accept but don't send
  if (honeypot) return res.status(200).json({ ok: true });

  // Validate
  if (!checkin || !checkout || !name || !email || !guests) {
    return res.status(400).json({ error: 'Vul alle verplichte velden in.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ongeldig email-adres.' });
  }

  // Look up the promo code server-side (KV is source of truth — frontend only hints at the pct).
  // We don't fail the whole booking if the code is bad; we silently drop the discount so the
  // customer still gets a booking at full price.
  let promoDiscount = null;
  const cleanPromoInput = (promoCode || '').trim().toUpperCase();
  if (cleanPromoInput) {
    try {
      const rec = await getPromoCode(cleanPromoInput);
      if (rec && rec.status === 'active' && !isPromoExpired(rec)) {
        promoDiscount = {
          code: rec.code,
          pct: rec.pct || 10,
          waiveCleaning: !!rec.waiveCleaning
        };
      }
    } catch (err) {
      console.error('Promo code lookup failed (continuing without discount):', err);
    }
  }

  // Calculate authoritative price (server is the source of truth for pricing AND the discount pct)
  const price = calculateStay(checkin, checkout, promoDiscount);
  if (!price) return res.status(400).json({ error: 'Ongeldige datums.' });
  if (price.tooShort) {
    return res.status(400).json({ error: `Minimum ${price.requiredMin} nachten voor deze datums.` });
  }

  // Block bookings more than 9 months in advance
  const maxAdvance = new Date();
  maxAdvance.setUTCMonth(maxAdvance.getUTCMonth() + 9);
  maxAdvance.setUTCHours(0, 0, 0, 0);
  const checkinDate = new Date(checkin + 'T00:00:00Z');
  if (checkinDate > maxAdvance) {
    return res.status(400).json({ error: 'Boekingen zijn mogelijk tot 9 maanden vooruit. Probeer een eerdere datum.' });
  }

  const reference = 'DP' + Date.now().toString(36).toUpperCase();

  // If the booking uses a promo code, RESERVE it atomically before we send any emails.
  // If reservation fails (someone else just used it, or the lookup went stale), we drop
  // the discount and continue — no promo discount rather than no booking.
  if (price.discountSource === 'promo' && price.promoCode) {
    const reserved = await reservePromoCode(price.promoCode, reference);
    if (!reserved) {
      // Code was snatched between validate and reserve — recompute at full price
      const fullPrice = calculateStay(checkin, checkout, null);
      if (fullPrice && !fullPrice.tooShort) {
        Object.assign(price, fullPrice);
      }
    }
  }

  const payload = {
    reference,
    checkin, checkout,
    guests: Number(guests),
    name: String(name).slice(0, 120),
    email: String(email).slice(0, 160),
    phone: String(phone || '').slice(0, 40),
    notes: String(notes || '').slice(0, 1000),
    language: ['nl', 'de', 'en'].includes(language) ? language : 'nl',
    nights: price.nights,
    avgRate: price.avgRate,
    total: price.total,
    subtotal: price.subtotal,
    cleaning: price.cleaning,
    discount: price.discount,
    discountPct: price.discountPct,
    discountSource: price.discountSource,
    promoCode: price.promoCode,
    anyHighSeason: !!price.anyHighSeason,
    t: Date.now()
  };

  let token;
  try {
    token = signPayload(payload);
  } catch (err) {
    console.error('Signing failed:', err);
    return res.status(500).json({ error: err.message });
  }

  const ownerEmail = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';
  const baseUrl = 'https://boshuisdeputter.nl';

  try {
    // Owner notification (with accept/decline links) + Reply-To guest so Jan can reply directly
    await sendEmail({
      to: ownerEmail,
      subject: `🌲 Boekingsverzoek: ${payload.name} · ${payload.checkin} → ${payload.checkout} · €${payload.total}`,
      html: ownerNotificationHtml(payload, baseUrl, token),
      replyTo: payload.email
    });

    // Guest acknowledgement
    const guest = guestAckHtml(payload, payload.language);
    await sendEmail({
      to: payload.email,
      subject: guest.subject,
      html: guest.html
    });

    // WhatsApp notification (fire-and-forget, never blocks the response)
    sendWhatsApp(
      `🌲 Nieuw boekingsverzoek!\n\n` +
      `${payload.name}\n` +
      `${payload.checkin} → ${payload.checkout} (${payload.nights}n)\n` +
      `€${payload.total}\n\n` +
      `Check je mail om te accepteren.`
    ).catch(() => {});
  } catch (err) {
    console.error('Email send failed:', err);
    return res.status(502).json({ error: 'Kon de bevestigingsmail niet versturen. Probeer het opnieuw of neem direct contact op met janvanwaveren@gmail.com.', detail: String(err.message) });
  }

  return res.status(200).json({ ok: true, reference });
}
