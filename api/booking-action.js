// Handles accept/decline clicks from the owner's booking-request notification.
// Token carries all booking data (HMAC-signed) so no database is needed.
//
// URL: /api/booking-action?t=<token>&action=accept|decline
//
// Env vars:
//   RESEND_API_KEY  — for sending the guest email
//   ADMIN_SECRET    — HMAC key for verifying the token
//   OWNER_EMAIL     — shown in guest email as contact
//   OWNER_IBAN      — payment details in accept email (e.g. NL00RABO0123456789)
//   OWNER_NAME      — for IBAN "t.n.v." line (default: Jan van Waveren)

import { verifyToken } from './booking-request.js';
import { saveBooking } from './_lib/store.js';
import { paymentDeadline as computePaymentDeadline, isLastMinute } from './_lib/timing.js';

export const maxDuration = 15;

const LOGO_URL = 'https://boshuisdeputter.nl/putter-logo.png';

function logoHeader(title, accentColor = '#2d5016') {
  return `<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:12px">
    <tr><td align="center" style="padding:8px 0 0"><img src="${LOGO_URL}" width="64" height="64" alt="De Putter" style="display:block;border:0"></td></tr>
    <tr><td align="center" style="padding:10px 0 20px"><h1 style="margin:0;color:${accentColor};font-family:Georgia,serif;font-size:26px;font-weight:700">${title}</h1></td></tr>
  </table>`;
}

function daysUntil(dateStr) {
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.round((then - now) / 86400000));
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function fmtDateShort(iso, locale = 'nl-NL') {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  const body = {
    from: 'De Putter · Boshuis Ommen <reserveringen@boshuisdeputter.nl>',
    to: [to], subject, html
  };
  if (replyTo) body.reply_to = replyTo;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Resend ${resp.status}: ${t}`);
  }
  return resp.json();
}

/* ========== EMAIL CONTENT: accept (with payment instructions) ========== */
function acceptEmailHtml(b, lang, iban, ownerName, ownerEmail, extras = {}) {
  const pd = computePaymentDeadline({ ...b, acceptedAt: b.acceptedAt || new Date().toISOString() });
  const deadlineStr = {
    nl: pd.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }),
    de: pd.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }),
    en: pd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  }[lang] || pd.toLocaleDateString('nl-NL');
  const lastMinute = extras.lastMinute || false;
  const { keyCode, wifiName, wifiPassword, ownerPhone } = extras;

  const t = {
    nl: {
      subject: `✅ Boeking bevestigd — De Putter (${b.reference})`,
      h1: 'Je boeking is bevestigd! 🌲',
      intro: `Hoi ${esc(b.name)}, wat leuk dat je komt! Je verblijf in De Putter is bevestigd. Hieronder vind je de betaalinstructies.`,
      stayH: 'Je verblijf',
      labels: { arr: 'Aankomst', dep: 'Vertrek', nights: 'Nachten', guests: 'Gasten', total: 'Totaalbedrag' },
      check: 'Aankomst vanaf 15:00, vertrek voor 11:00.',
      payH: '💳 Betaalinstructies',
      payIntro: `Maak het bedrag van <strong>€${b.total}</strong> over naar:`,
      payDeadline: `<strong>Uiterlijk ${deadlineStr}.</strong> Zodra de betaling binnen is, is de boeking definitief.`,
      inclusiveH: '✓ Alles inbegrepen',
      inclusive: 'Geen bijkomende kosten: hout voor de haard, bedlinnen, handdoeken en toeristenbelasting zijn allemaal inbegrepen. De schoonmaakvergoeding van €75 zit al in het totaalbedrag.',
      whatNext: 'Een paar dagen voor aankomst sturen we je de welkomstgids met praktische info: de code voor het sleutelkastje, het WiFi-wachtwoord en tips voor de omgeving.',
      whatNextLastMinute: 'Omdat je binnenkort al komt, vind je hieronder alvast alle praktische info — sleutelcode, WiFi en de weg naar ons toe.',
      keyH: '🔑 Sleutelkastje',
      keyTxt: `De sleutel hangt in een kastje <strong>rechts om de hoek vanaf de voordeur</strong>, naast de openslaande deuren van de keuken. Code: <strong style="font-family:Consolas,monospace;font-size:16px;color:#2d5016">${esc(keyCode || '[Jan stuurt je de code apart]')}</strong>`,
      wifiH: '📶 WiFi',
      wifiTxt: `Netwerk: <strong>${esc(wifiName || 'Odido')}</strong><br>Wachtwoord: <strong style="font-family:Consolas,monospace">${esc(wifiPassword || '[Jan stuurt apart]')}</strong>`,
      routeH: '🚗 De weg naar ons toe',
      routeTxt: `Als je vanuit Ommen/Arriën komt, neem je vanaf de Coevorderweg <strong>het 2<sup>e</sup> weggetje rechts</strong> — niet het eerste (dat is moerassig). Na 150m zie je het huisje links. Parkeren op eigen terrein (ruimte voor 2 auto's).`,
      contactH: '📞 Contact',
      contactTxt: ownerPhone ? `Vragen onderweg? Bel of app: <strong>${esc(ownerPhone)}</strong>.` : 'Vragen? Mail gerust naar janvanwaveren@gmail.com.',
      signoff: 'Tot gauw in het bos!',
      sig: 'Jan — De Putter · Boshuis Ommen',
      refLabel: 'Kenmerk',
      ibanLabel: 'IBAN',
      tnvLabel: 'T.n.v.',
      kenmerkLabel: 'Kenmerk / Betalingskenmerk'
    },
    de: {
      subject: `✅ Buchung bestätigt — De Putter (${b.reference})`,
      h1: 'Ihre Buchung ist bestätigt! 🌲',
      intro: `Hallo ${esc(b.name)}, schön, dass Sie kommen! Ihr Aufenthalt in De Putter ist bestätigt. Unten finden Sie die Zahlungsanweisungen.`,
      stayH: 'Ihr Aufenthalt',
      labels: { arr: 'Anreise', dep: 'Abreise', nights: 'Nächte', guests: 'Gäste', total: 'Gesamtbetrag' },
      check: 'Anreise ab 15:00, Abreise bis 11:00 Uhr.',
      payH: '💳 Zahlungsanweisungen',
      payIntro: `Überweisen Sie <strong>€${b.total}</strong> auf:`,
      payDeadline: `<strong>Spätestens ${deadlineStr}.</strong> Sobald die Zahlung eingegangen ist, ist die Buchung verbindlich.`,
      inclusiveH: '✓ Alles inklusive',
      inclusive: 'Keine Zusatzkosten: Holz für den Ofen, Bettwäsche, Handtücher und Kurtaxe sind alle inklusive. Die Endreinigungsgebühr von €75 ist im Gesamtbetrag bereits enthalten.',
      whatNext: 'Ein paar Tage vor der Anreise senden wir Ihnen die Willkommensmappe mit praktischen Informationen: Code für den Schlüsseltresor, WLAN-Passwort und Tipps für die Umgebung.',
      whatNextLastMinute: 'Da Sie bald anreisen, finden Sie unten bereits alle praktischen Informationen — Schlüsselcode, WLAN und Anfahrt.',
      keyH: '🔑 Schlüsseltresor',
      keyTxt: `Der Schlüssel liegt im Kasten <strong>rechts um die Ecke vom Eingang</strong>, bei den Küchentüren. Code: <strong style="font-family:Consolas,monospace;font-size:16px;color:#2d5016">${esc(keyCode || '[Jan sendet den Code separat]')}</strong>`,
      wifiH: '📶 WLAN',
      wifiTxt: `Netzwerk: <strong>${esc(wifiName || 'Odido')}</strong><br>Passwort: <strong style="font-family:Consolas,monospace">${esc(wifiPassword || '[wird separat gesendet]')}</strong>`,
      routeH: '🚗 Anfahrt',
      routeTxt: `Wenn Sie aus Ommen/Arriën kommen, nehmen Sie von der Coevorderweg <strong>den 2. Weg rechts</strong> — nicht den ersten (moorig). Nach 150m sehen Sie das Häuschen links. Parken auf dem Grundstück (Platz für 2 Autos).`,
      contactH: '📞 Kontakt',
      contactTxt: ownerPhone ? `Fragen unterwegs? Anrufen oder WhatsApp: <strong>${esc(ownerPhone)}</strong>.` : 'Fragen? E-Mail an janvanwaveren@gmail.com.',
      signoff: 'Bis bald im Wald!',
      sig: 'Jan — De Putter · Boshuis Ommen',
      refLabel: 'Referenz',
      ibanLabel: 'IBAN',
      tnvLabel: 'Kontoinhaber',
      kenmerkLabel: 'Verwendungszweck'
    },
    en: {
      subject: `✅ Booking confirmed — De Putter (${b.reference})`,
      h1: 'Your booking is confirmed! 🌲',
      intro: `Hi ${esc(b.name)}, so glad you're coming! Your stay at De Putter is confirmed. Payment instructions are below.`,
      stayH: 'Your stay',
      labels: { arr: 'Check-in', dep: 'Check-out', nights: 'Nights', guests: 'Guests', total: 'Total' },
      check: 'Check-in from 15:00, check-out by 11:00.',
      payH: '💳 Payment instructions',
      payIntro: `Please transfer <strong>€${b.total}</strong> to:`,
      payDeadline: `<strong>By ${deadlineStr} at the latest.</strong> Once payment is received, the booking is final.`,
      inclusiveH: '✓ All included',
      inclusive: 'No extra charges: firewood, bed linen, towels and tourist tax are all included. The €75 cleaning fee is already in the total.',
      whatNext: `A few days before arrival we'll send the welcome guide with practical info: the key-safe code, WiFi password, and tips for exploring the area.`,
      whatNextLastMinute: `Since your stay is coming up soon, here's all the practical info already — key code, WiFi and directions.`,
      keyH: '🔑 Key safe',
      keyTxt: `The key is in a small safe <strong>around the right corner from the front door</strong>, by the kitchen's double doors. Code: <strong style="font-family:Consolas,monospace;font-size:16px;color:#2d5016">${esc(keyCode || '[Jan will send the code separately]')}</strong>`,
      wifiH: '📶 WiFi',
      wifiTxt: `Network: <strong>${esc(wifiName || 'Odido')}</strong><br>Password: <strong style="font-family:Consolas,monospace">${esc(wifiPassword || '[sent separately]')}</strong>`,
      routeH: '🚗 Getting here',
      routeTxt: `Coming from Ommen/Arriën, on Coevorderweg <strong>take the 2nd little road on the right</strong> — not the first (it's boggy). After 150m you'll see the cabin on your left. Park on the grounds (room for 2 cars).`,
      contactH: '📞 Contact',
      contactTxt: ownerPhone ? `Questions on the way? Call or WhatsApp: <strong>${esc(ownerPhone)}</strong>.` : 'Questions? Email janvanwaveren@gmail.com.',
      signoff: 'See you soon in the woods!',
      sig: 'Jan — De Putter · Boshuis Ommen',
      refLabel: 'Reference',
      ibanLabel: 'IBAN',
      tnvLabel: 'Account holder',
      kenmerkLabel: 'Payment reference'
    }
  }[lang] || t.nl;

  const days = daysUntil(b.checkin);
  const funBlock = {
    nl: {
      countdown: days === 0 ? 'Je komt vandaag al!' : days === 1 ? '<strong>Morgen</strong> ben je in het bos 🌲' : `Nog <strong>${days}</strong> dagen tot je in het bos bent 🌲`,
      flamingo: 'Tussen het inpakken door: in het huis zijn <strong>5 flamingo\'s</strong> verstopt 🦩. Gewoon omdat het leuk is om te speuren. De uitdaging: vind ze allemaal — en bij vertrek weer verstoppen voor de volgende gast.'
    },
    de: {
      countdown: days === 0 ? 'Sie kommen heute!' : days === 1 ? '<strong>Morgen</strong> sind Sie im Wald 🌲' : `Noch <strong>${days}</strong> Tage bis Sie im Wald sind 🌲`,
      flamingo: 'Zwischen dem Packen: im Haus sind <strong>5 Flamingos</strong> versteckt 🦩. Einfach weil es Spaß macht. Die Herausforderung: finden Sie alle — und verstecken Sie sie bei der Abreise für den nächsten Gast.'
    },
    en: {
      countdown: days === 0 ? 'You\'re arriving today!' : days === 1 ? '<strong>Tomorrow</strong> you\'ll be in the forest 🌲' : `<strong>${days}</strong> days to go until you\'re in the forest 🌲`,
      flamingo: 'While you\'re packing: <strong>5 flamingos</strong> are hidden in the house 🦩. Just because it\'s fun to hunt for them. The challenge: find them all — and hide them again for the next guest before you leave.'
    }
  }[lang] || {};

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p>${t.intro}</p>

    <div style="background:#fff;border-left:4px solid #2d5016;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
      <h2 style="margin:0 0 10px;color:#2d5016;font-size:17px;font-family:Georgia,serif">${t.stayH}</h2>
      <table style="width:100%;font-size:14px">
        <tr><td style="padding:4px 0;color:#636e72;width:130px">${t.labels.arr}</td><td><strong>${fmtDate(b.checkin)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.dep}</td><td><strong>${fmtDate(b.checkout)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.nights}</td><td>${b.nights}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.guests}</td><td>${b.guests}</td></tr>
        <tr><td style="padding:6px 0 4px;color:#636e72;border-top:1px solid #eee">${t.labels.total}</td><td style="padding-top:6px;border-top:1px solid #eee;font-weight:700;font-size:17px;color:#2d5016">€${b.total}</td></tr>
      </table>
      <p style="margin:12px 0 0;color:#636e72;font-size:13px">${t.check}</p>
    </div>

    <div style="background:#fdf8f0;border-left:4px solid #c9a96e;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
      <h2 style="margin:0 0 10px;color:#5c3d2e;font-size:17px;font-family:Georgia,serif">${t.payH}</h2>
      <p style="margin:0 0 8px">${t.payIntro}</p>
      <table style="width:100%;font-size:14px;background:#fff;padding:14px;border-radius:6px;margin:8px 0">
        <tr><td style="padding:4px 8px;color:#636e72;width:160px">${t.ibanLabel}</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600">${esc(iban)}</td></tr>
        <tr><td style="padding:4px 8px;color:#636e72">${t.tnvLabel}</td><td style="padding:4px 8px">${esc(ownerName)}</td></tr>
        <tr><td style="padding:4px 8px;color:#636e72">${t.labels.total}</td><td style="padding:4px 8px;font-weight:700;color:#2d5016">€${b.total}</td></tr>
        <tr><td style="padding:4px 8px;color:#636e72">${t.kenmerkLabel}</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600;color:#c0392b">${esc(b.reference)}</td></tr>
      </table>
      <p style="margin:10px 0 0;font-size:14px">${t.payDeadline}</p>
    </div>

    <div style="background:#f0f5eb;padding:14px 18px;border-radius:6px;margin:20px 0;font-size:13.5px;color:#2d5016">
      <strong style="display:block;margin-bottom:4px">${t.inclusiveH}</strong>
      ${t.inclusive}
    </div>

    <p style="color:#636e72;font-size:14px">${lastMinute ? t.whatNextLastMinute : t.whatNext}</p>

    ${lastMinute ? `
    <div style="background:#fff;border-left:4px solid #2d5016;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0">
      <h3 style="margin:0 0 6px;color:#2d5016;font-size:15px;font-family:Georgia,serif">${t.keyH}</h3>
      <div style="font-size:14px;color:#2d3436;line-height:1.6">${t.keyTxt}</div>
    </div>
    <div style="background:#fff;border-left:4px solid #2d5016;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0">
      <h3 style="margin:0 0 6px;color:#2d5016;font-size:15px;font-family:Georgia,serif">${t.wifiH}</h3>
      <div style="font-size:14px;color:#2d3436;line-height:1.6">${t.wifiTxt}</div>
    </div>
    <div style="background:#fff;border-left:4px solid #2d5016;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0">
      <h3 style="margin:0 0 6px;color:#2d5016;font-size:15px;font-family:Georgia,serif">${t.routeH}</h3>
      <div style="font-size:14px;color:#2d3436;line-height:1.6">${t.routeTxt}</div>
    </div>
    <div style="background:#fff;border-left:4px solid #2d5016;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0">
      <h3 style="margin:0 0 6px;color:#2d5016;font-size:15px;font-family:Georgia,serif">${t.contactH}</h3>
      <div style="font-size:14px;color:#2d3436;line-height:1.6">${t.contactTxt}</div>
    </div>
    ` : ''}

    <div style="background:linear-gradient(135deg,#f0f5eb 0%,#e8f5e0 100%);border-radius:10px;padding:18px 22px;margin:24px 0;text-align:center;border:1px solid #cfe0bc">
      <div style="font-size:18px;color:#2d5016;font-family:Georgia,serif;font-weight:600;margin-bottom:10px">🎉 ${funBlock.countdown}</div>
      <div style="height:1px;background:#cfe0bc;margin:12px auto;width:60%"></div>
      <p style="font-size:13.5px;color:#5c3d2e;margin:0;line-height:1.65">${funBlock.flamingo}</p>
    </div>

    <p style="color:#636e72;font-size:13px;margin-top:14px">
      <span style="color:#888">
        ${lang === 'de' ? 'Stornierungsbedingungen und Hausregeln:' : lang === 'en' ? 'Cancellation policy and house rules:' : 'Annuleringsvoorwaarden en huisregels:'}
        <a href="https://boshuisdeputter.nl/voorwaarden" style="color:#2d5016">boshuisdeputter.nl/voorwaarden</a>
      </span>
    </p>

    <p style="margin-top:32px">${t.signoff}<br><strong style="color:#2d5016">${t.sig}</strong></p>

    <p style="text-align:center;font-size:13px;color:#636e72;margin-top:24px;padding-top:16px;border-top:1px solid #eee">
      📷 ${lang === 'de' ? 'Folgen Sie uns auf Instagram für Fotos aus dem Wald:' : lang === 'en' ? 'Follow us on Instagram for photos from the forest:' : 'Volg ons op Instagram voor foto\'s uit het bos:'}
      <a href="https://www.instagram.com/boshuisommen/" target="_blank" rel="noopener" style="color:#2d5016;font-weight:600;text-decoration:none">@boshuisommen</a>
    </p>
    <p style="font-size:11px;color:#999;margin-top:12px">${t.refLabel}: ${esc(b.reference)}</p>
  </body></html>`;

  return { subject: t.subject, html };
}

/* ========== EMAIL CONTENT: decline ========== */
function declineEmailHtml(b, lang) {
  const t = {
    nl: {
      subject: 'Over je boekingsverzoek — De Putter',
      h1: 'Bedankt voor je interesse',
      body: `Hoi ${esc(b.name)}, bedankt voor je boekingsverzoek voor De Putter voor <strong>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</strong>. Helaas is het huisje voor deze datums niet beschikbaar of past het om een andere reden niet.`,
      alt: `Mocht je flexibel zijn met data, laat het ons weten — we kijken graag of we iets kunnen vinden dat past. Je kunt ook altijd onze actuele beschikbaarheid bekijken op <a href="https://boshuisdeputter.nl" style="color:#2d5016">boshuisdeputter.nl</a>.`,
      signoff: 'Hopelijk tot ziens,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    de: {
      subject: 'Bezüglich Ihrer Buchungsanfrage — De Putter',
      h1: 'Vielen Dank für Ihr Interesse',
      body: `Hallo ${esc(b.name)}, vielen Dank für Ihre Buchungsanfrage für De Putter vom <strong>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</strong>. Leider ist das Häuschen an diesen Daten nicht verfügbar oder passt aus einem anderen Grund nicht.`,
      alt: `Wenn Sie mit den Daten flexibel sind, lassen Sie es uns wissen — wir schauen gerne, ob wir etwas Passendes finden können. Die aktuelle Verfügbarkeit finden Sie auch auf <a href="https://boshuisdeputter.nl" style="color:#2d5016">boshuisdeputter.nl</a>.`,
      signoff: 'Bis hoffentlich bald,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    en: {
      subject: 'About your booking request — De Putter',
      h1: 'Thank you for your interest',
      body: `Hi ${esc(b.name)}, thank you for your booking request for De Putter for <strong>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</strong>. Unfortunately the cabin is not available for these dates, or it doesn't quite fit for another reason.`,
      alt: `If you're flexible with dates, let us know — we'd be happy to see if we can find something that works. You can also check current availability on <a href="https://boshuisdeputter.nl" style="color:#2d5016">boshuisdeputter.nl</a>.`,
      signoff: 'Hope to see you another time,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p>${t.body}</p>
    <p>${t.alt}</p>
    <p style="margin-top:28px">${t.signoff}<br><strong>${t.sig}</strong></p>
  </body></html>`;
  return { subject: t.subject, html };
}

/* ========== CONFIRMATION PAGES (shown in browser) ========== */
function renderPage({ title, body, success = true }) {
  const color = success ? '#2d5016' : '#c0392b';
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
  <style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#f5f3ee;color:#2d3436;line-height:1.6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:12px;padding:36px 40px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,0.08);border-top:5px solid ${color}}
  h1{font-family:Georgia,serif;color:${color};font-size:28px;margin-bottom:10px}
  h2{font-family:Georgia,serif;color:#2d5016;font-size:17px;margin:24px 0 10px}
  p{margin-bottom:12px;color:#444}
  .booking-box{background:#f9f9f9;border-left:3px solid ${color};padding:14px 18px;border-radius:0 6px 6px 0;margin:16px 0;font-size:14px}
  .booking-box strong{color:${color}}
  code{background:#eef4e6;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:13px;color:#2d5016}
  .reminder{background:#fff4d6;border-left:3px solid #c9a96e;padding:12px 16px;border-radius:0 6px 6px 0;margin:20px 0;font-size:13.5px;color:#7d5a00}
  a{color:${color};font-weight:500}
  </style></head><body><div class="card">${body}</div></body></html>`;
}

/* ========== HANDLER ========== */
export default async function handler(req, res) {
  const { t, action, confirmed } = req.query || {};
  if (!t || !action) {
    return res.status(400).send(renderPage({ title: 'Fout', success: false, body: '<h1>Ongeldige link</h1><p>Deze link mist informatie.</p>' }));
  }

  const booking = verifyToken(t);
  if (!booking) {
    return res.status(401).send(renderPage({ title: 'Verlopen', success: false, body: '<h1>Link ongeldig of verlopen</h1><p>Deze link is niet (meer) geldig. Zoek de originele boekingsverzoek-email op, of controleer of het verzoek al verwerkt is.</p>' }));
  }

  if (action === 'accept') {
    // Require a confirm step to avoid accidental double-send if Jan refreshes
    if (confirmed !== '1') {
      const confirmUrl = `/api/booking-action?t=${encodeURIComponent(t)}&action=accept&confirmed=1`;
      return res.status(200).send(renderPage({
        title: 'Boeking accepteren?',
        body: `
          <h1>Boeking accepteren?</h1>
          <p>Je staat op het punt om deze boeking te accepteren. De gast ontvangt direct een bevestigingsmail met de betaalinstructies.</p>
          <div class="booking-box">
            <strong>${esc(booking.name)}</strong> · ${esc(booking.email)}<br>
            ${fmtDateShort(booking.checkin)} → ${fmtDateShort(booking.checkout)} · ${booking.nights} nachten · ${booking.guests} gasten<br>
            <strong>€${booking.total}</strong> · kenmerk <code>${esc(booking.reference)}</code>
          </div>
          <p><a href="${confirmUrl}" style="display:inline-block;background:#2d5016;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:10px">✅ Ja, accepteren</a> &nbsp; <a href="javascript:window.close()" style="color:#888;font-size:14px">annuleren</a></p>
        `
      }));
    }

    const iban = process.env.OWNER_IBAN || '(IBAN niet ingesteld — voeg OWNER_IBAN toe aan je Vercel env vars)';
    const ownerName = process.env.OWNER_NAME || 'Jan van Waveren';
    const ownerEmail = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';

    const acceptedAt = new Date().toISOString();
    const bookingWithAccept = { ...booking, acceptedAt };
    const lastMinute = isLastMinute(bookingWithAccept);

    try {
      const email = acceptEmailHtml(bookingWithAccept, booking.language, iban, ownerName, ownerEmail, {
        lastMinute,
        keyCode: process.env.KEY_CODE,
        wifiName: process.env.WIFI_NAME,
        wifiPassword: process.env.WIFI_PASSWORD,
        ownerPhone: process.env.OWNER_PHONE
      });
      await sendEmail({ to: booking.email, subject: email.subject, html: email.html, replyTo: ownerEmail });
    } catch (err) {
      console.error('Accept email failed:', err);
      return res.status(502).send(renderPage({
        title: 'Email mislukt', success: false,
        body: `<h1>Email kon niet verzonden worden</h1><p>${esc(err.message)}</p><p>De gast heeft geen bevestiging ontvangen. Je kunt hem handmatig mailen: <a href="mailto:${esc(booking.email)}">${esc(booking.email)}</a></p>`
      }));
    }

    // Persist to KV so daily cron can manage lifecycle emails.
    // For last-minute bookings, mark preArrival as already sent (it was combined into the confirmation).
    try {
      await saveBooking({
        ...booking,
        status: 'awaiting_payment',
        acceptedAt,
        paidAt: null,
        cancelledAt: null,
        sentEmails: lastMinute ? { preArrival: acceptedAt } : {}
      });
    } catch (err) {
      console.error('KV save failed (continuing anyway):', err);
    }

    return res.status(200).send(renderPage({
      title: 'Boeking geaccepteerd',
      body: `
        <h1>✅ Boeking geaccepteerd</h1>
        <p>De gast heeft zojuist een bevestigingsmail ontvangen met de betaalinstructies.</p>
        <div class="booking-box">
          <strong>${esc(booking.name)}</strong> · ${esc(booking.email)}<br>
          ${fmtDateShort(booking.checkin)} → ${fmtDateShort(booking.checkout)} · ${booking.nights} nachten<br>
          <strong>€${booking.total}</strong> · kenmerk <code>${esc(booking.reference)}</code>
        </div>

        <h2>Wat nu?</h2>
        <div class="reminder">
          <strong>Blokkeer de datums in Natuurhuisje</strong><br>
          Ga naar <a href="https://www.natuurhuisje.nl" target="_blank" rel="noopener">natuurhuisje.nl</a> → jouw verhuurder-dashboard → kalender → blokkeer <strong>${fmtDateShort(booking.checkin)} t/m ${fmtDateShort(booking.checkout)}</strong>. Binnen 10 minuten past onze kalender op de site zich ook aan (via de iCal-sync).
        </div>
        <p style="font-size:14px;color:#666">Zodra de betaling binnen is (bedrag <strong>€${booking.total}</strong>, kenmerk <code>${esc(booking.reference)}</code>), is de boeking definitief.</p>
        <p style="font-size:14px;color:#666">Een paar dagen voor aankomst kun je de welkomstgids uit <a href="/email-templates">email-templates</a> naar ${esc(booking.email)} sturen (met het sleutelkastje-code en WiFi-wachtwoord).</p>
      `
    }));
  }

  if (action === 'decline') {
    if (confirmed !== '1') {
      const confirmUrl = `/api/booking-action?t=${encodeURIComponent(t)}&action=decline&confirmed=1`;
      return res.status(200).send(renderPage({
        title: 'Boeking afwijzen?', success: false,
        body: `
          <h1 style="color:#c0392b">Boeking afwijzen?</h1>
          <p>De gast ontvangt een vriendelijke email met uitleg dat het huisje niet beschikbaar is voor deze data.</p>
          <div class="booking-box">
            <strong>${esc(booking.name)}</strong> · ${esc(booking.email)}<br>
            ${fmtDateShort(booking.checkin)} → ${fmtDateShort(booking.checkout)}
          </div>
          <p><a href="${confirmUrl}" style="display:inline-block;background:#c0392b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:10px">❌ Ja, afwijzen</a> &nbsp; <a href="javascript:window.close()" style="color:#888;font-size:14px">annuleren</a></p>
        `
      }));
    }

    const ownerEmail = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';
    try {
      const email = declineEmailHtml(booking, booking.language);
      await sendEmail({ to: booking.email, subject: email.subject, html: email.html, replyTo: ownerEmail });
    } catch (err) {
      console.error('Decline email failed:', err);
      return res.status(502).send(renderPage({
        title: 'Email mislukt', success: false,
        body: `<h1>Email kon niet verzonden worden</h1><p>${esc(err.message)}</p>`
      }));
    }

    return res.status(200).send(renderPage({
      title: 'Boeking afgewezen', success: false,
      body: `
        <h1 style="color:#c0392b">Boeking afgewezen</h1>
        <p>De gast heeft een vriendelijke afwijzingsmail ontvangen.</p>
        <div class="booking-box">
          <strong>${esc(booking.name)}</strong> · ${esc(booking.email)}
        </div>
        <p style="font-size:14px;color:#666">Als je nog iets persoonlijks wilt toevoegen, reageer gewoon op het originele boekingsverzoek.</p>
      `
    }));
  }

  return res.status(400).send(renderPage({ title: 'Onbekende actie', success: false, body: '<h1>Onbekende actie</h1><p>Actie moet "accept" of "decline" zijn.</p>' }));
}
