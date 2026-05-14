// Shared email-sending + all lifecycle email templates
// (pre-arrival, payment reminder × 2, auto-cancel, review request)

import { signReviewToken } from './review-token.js';

const FROM = 'De Putter · Boshuis Ommen <reserveringen@boshuisdeputter.nl>';
const ADMIN_FROM = 'De Putter · Admin <admin@boshuisdeputter.nl>';
const LOGO_URL = 'https://boshuisdeputter.nl/putter-logo.png';
const BASE_URL = 'https://boshuisdeputter.nl';

export async function sendEmail({ to, subject, html, replyTo, from = FROM }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (replyTo) body.reply_to = replyTo;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtDate(iso, lang = 'nl') {
  const d = new Date(iso + 'T00:00:00Z');
  const locale = lang === 'de' ? 'de-DE' : lang === 'en' ? 'en-GB' : 'nl-NL';
  return d.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function logoHeader(title, accent = '#2d5016') {
  return `<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:12px">
    <tr><td align="center" style="padding:8px 0 0"><img src="${LOGO_URL}" width="64" height="64" alt="De Putter" style="display:block;border:0"></td></tr>
    <tr><td align="center" style="padding:10px 0 20px"><h1 style="margin:0;color:${accent};font-family:Georgia,serif;font-size:26px;font-weight:700">${title}</h1></td></tr>
  </table>`;
}

export function footerLine(lang = 'nl') {
  const t = {
    nl: 'Volg ons op Instagram voor foto\'s uit het bos:',
    de: 'Folgen Sie uns auf Instagram für Fotos aus dem Wald:',
    en: 'Follow us on Instagram for photos from the forest:'
  }[lang] || '';
  return `<p style="text-align:center;font-size:13px;color:#636e72;margin-top:24px;padding-top:16px;border-top:1px solid #eee">
    📷 ${t} <a href="https://www.instagram.com/boshuisommen/" target="_blank" rel="noopener" style="color:#2d5016;font-weight:600;text-decoration:none">@boshuisommen</a>
  </p>`;
}

function daysUntil(dateStr) {
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((then - Date.now()) / 86400000));
}

/* ================================================================
   TEMPLATE 0 — (unused) PAYMENT CONFIRMED template
   Kept here for future use if Jan wants a separate payment receipt email.
   Current flow delivers the personal code with the review email instead.
================================================================ */
// eslint-disable-next-line no-unused-vars
function _unused_paymentConfirmedEmail(b) {
  const lang = b.language || 'nl';
  const code = b.personalCode || '';
  const pct = 10; // keep in sync with issuePromoCode default
  const t = {
    nl: {
      subject: `✨ Betaling ontvangen — jouw persoonlijke code (${b.reference})`,
      h1: 'Betaling ontvangen!',
      intro: `Hoi ${esc(b.name)}, we hebben je betaling van <strong>€${b.total}</strong> binnen. Je boeking is nu definitief — we kijken uit naar je komst op ${fmtDate(b.checkin, 'nl')}.`,
      codeH: 'Jouw persoonlijke code',
      codeIntro: 'Als dank krijg je een eigen code. Eenmalig in te wisselen voor',
      pct: `${pct}% korting`,
      codeUse: 'Gebruik hem zelf bij een volgende boeking, of deel hem met een vriend, collega of familielid. Wie hem als eerste invult bij een boeking, krijgt de korting.',
      stayH: 'Jouw verblijf',
      labels: { arr: 'Aankomst', dep: 'Vertrek', nights: 'Nachten', ref: 'Kenmerk' },
      nextH: 'Wat volgt?',
      next: 'Drie dagen voor je aankomst sturen we je een welkomstgids met de sleutelcode, WiFi-gegevens en praktische tips. Tot dan!',
      signoff: 'Tot snel,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    de: {
      subject: `✨ Zahlung erhalten — Ihr persönlicher Code (${b.reference})`,
      h1: 'Zahlung erhalten!',
      intro: `Hallo ${esc(b.name)}, wir haben Ihre Zahlung von <strong>€${b.total}</strong> erhalten. Ihre Buchung ist nun endgültig — wir freuen uns auf Ihren Aufenthalt ab ${fmtDate(b.checkin, 'de')}.`,
      codeH: 'Ihr persönlicher Code',
      codeIntro: 'Als Dankeschön erhalten Sie einen eigenen Code. Einmalig einlösbar für',
      pct: `${pct}% Rabatt`,
      codeUse: 'Nutzen Sie ihn selbst bei einer nächsten Buchung oder teilen Sie ihn mit einem Freund, Kollegen oder Familienmitglied. Wer ihn als Erster eingibt, bekommt den Rabatt.',
      stayH: 'Ihr Aufenthalt',
      labels: { arr: 'Anreise', dep: 'Abreise', nights: 'Nächte', ref: 'Referenz' },
      nextH: 'Wie geht es weiter?',
      next: 'Drei Tage vor Ihrer Ankunft erhalten Sie einen Willkommensguide mit Schlüsselcode, WLAN-Zugang und praktischen Tipps. Bis dahin!',
      signoff: 'Bis bald,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    en: {
      subject: `✨ Payment received — your personal code (${b.reference})`,
      h1: 'Payment received!',
      intro: `Hi ${esc(b.name)}, we've received your payment of <strong>€${b.total}</strong>. Your booking is now final — we're looking forward to your stay starting ${fmtDate(b.checkin, 'en')}.`,
      codeH: 'Your personal code',
      codeIntro: 'As a thank-you, here is your own code. Can be redeemed once for',
      pct: `${pct}% off`,
      codeUse: 'Use it yourself on a future booking, or share it with a friend, colleague or family member. Whoever enters it first at the booking form gets the discount.',
      stayH: 'Your stay',
      labels: { arr: 'Check-in', dep: 'Check-out', nights: 'Nights', ref: 'Reference' },
      nextH: 'What next?',
      next: 'Three days before your arrival we\'ll send you a welcome guide with the door-lock code, WiFi details and some practical tips. See you soon!',
      signoff: 'See you soon,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    }
  }[lang] || {};

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p>${t.intro}</p>

    <!-- Personal code block — the "hero" of this email -->
    <div style="background:linear-gradient(135deg,#fdf8f0 0%,#fff4d6 100%);border:2px solid #c9a96e;border-radius:12px;padding:22px 24px;margin:24px 0;text-align:center">
      <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8b6a4a;font-weight:600;margin-bottom:10px">🪶 ${t.codeH}</div>
      <div style="font-family:Consolas,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:3px;color:#2d5016;padding:14px 18px;background:#fff;border-radius:8px;display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin:4px 0">${esc(code)}</div>
      <p style="font-size:13.5px;color:#5c3d2e;margin:16px 0 6px;line-height:1.55">${t.codeIntro} <strong>${t.pct}</strong>.</p>
      <p style="font-size:12.5px;color:#7a6b3a;margin:0;line-height:1.6">${t.codeUse}</p>
    </div>

    <div style="background:#fff;border-left:4px solid #2d5016;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
      <h2 style="margin:0 0 8px;color:#2d5016;font-size:17px;font-family:Georgia,serif">${t.stayH}</h2>
      <table style="width:100%;font-size:14px">
        <tr><td style="padding:4px 0;color:#636e72;width:120px">${t.labels.arr}</td><td><strong>${fmtDate(b.checkin, lang)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.dep}</td><td><strong>${fmtDate(b.checkout, lang)}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.nights}</td><td>${b.nights}</td></tr>
        <tr><td style="padding:4px 0;color:#636e72">${t.labels.ref}</td><td style="font-family:Consolas,monospace">${esc(b.reference)}</td></tr>
      </table>
    </div>

    <h2 style="color:#2d5016;font-family:Georgia,serif;font-size:17px;margin-top:28px">${t.nextH}</h2>
    <p style="font-size:14px;line-height:1.6">${t.next}</p>

    <p style="margin-top:32px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 0B — NH WELCOME (sent immediately on Natuurhuisje enrollment)
   "Bedankt voor je boeking" + welkomstgids + website link.
================================================================ */
export function nhWelcomeEmail(b) {
  const lang = b.language || 'nl';
  const t = {
    nl: {
      subject: `🌲 Welkom — fijn dat je hebt geboekt bij De Putter!`,
      h1: 'Wat leuk dat je komt!',
      intro: `Hoi ${esc(b.name)}, bedankt voor je boeking! Wat leuk dat jullie naar ons boshuisje komen van <strong>${fmtDate(b.checkin, 'nl')}</strong> t/m <strong>${fmtDate(b.checkout, 'nl')}</strong>.`,
      infoNote: 'Je ontvangt alle praktische informatie (sleutelcode, WiFi, routebeschrijving) automatisch per e-mail vóór je aankomst. Je hoeft niks te doen — wij regelen het.',
      inspireH: 'Alvast wat inspiratie',
      inspireTxt: 'Op onze website vindt je nog meer informatie over het huisje en de omgeving, <a href="https://boshuisdeputter.nl" style="color:#2d5016;font-weight:600">check het hier</a>.',
      questionsH: 'Vragen?',
      questionsTxt: 'Mocht je vragen of verzoeken hebben, dan kan je mij bereiken door gewoon te reageren op deze mail.',
      brochureH: '📖 Welkomstgids',
      brochureTxt: 'We hebben een digitale welkomstgids gemaakt met alles over het huisje, de omgeving, wandelroutes en tips. Handig om alvast door te bladeren! Daarnaast vind je op onze website nog meer info en foto\'s van het huis en de omgeving.',
      brochureCta: '📖 Welkomstgids bekijken',
      endTxt: 'Geniet van de voorpret!',
      signoff: 'Groetjes,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    de: {
      subject: `🌲 Willkommen — schön, dass Sie bei De Putter gebucht haben!`,
      h1: 'Wie schön, dass Sie kommen!',
      intro: `Hallo ${esc(b.name)}, vielen Dank für Ihre Buchung! Wie schön, dass Sie in unser Waldhäuschen kommen, vom <strong>${fmtDate(b.checkin, 'de')}</strong> bis <strong>${fmtDate(b.checkout, 'de')}</strong>.`,
      infoNote: 'Sie erhalten alle praktischen Informationen (Schlüsselcode, WLAN, Anfahrt) automatisch per E-Mail vor Ihrer Ankunft. Sie müssen nichts tun — wir kümmern uns darum.',
      inspireH: 'Schon mal etwas Inspiration',
      inspireTxt: 'Auf unserer Website finden Sie weitere Informationen über das Häuschen und die Umgebung, <a href="https://boshuisdeputter.nl" style="color:#2d5016;font-weight:600">schauen Sie hier</a>.',
      questionsH: 'Fragen?',
      questionsTxt: 'Bei Fragen oder Wünschen können Sie einfach auf diese E-Mail antworten.',
      brochureH: '📖 Willkommensführer',
      brochureTxt: 'Wir haben einen digitalen Willkommensführer erstellt mit allem über das Häuschen, die Umgebung, Wanderwege und Tipps. Praktisch zum Vorab-Durchblättern! Außerdem finden Sie auf unserer Website weitere Infos und Fotos.',
      brochureCta: '📖 Willkommensführer ansehen',
      endTxt: 'Genießen Sie die Vorfreude!',
      signoff: 'Herzliche Grüße,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    },
    en: {
      subject: `🌲 Welcome — great to have you at De Putter!`,
      h1: 'So glad you\'re coming!',
      intro: `Hi ${esc(b.name)}, thank you for your booking! How lovely that you\'re coming to our forest cabin from <strong>${fmtDate(b.checkin, 'en')}</strong> to <strong>${fmtDate(b.checkout, 'en')}</strong>.`,
      infoNote: 'You\'ll receive all practical information (key code, WiFi, directions) by email before your arrival. No need to do anything — we\'ll take care of it.',
      inspireH: 'Some inspiration',
      inspireTxt: 'On our website you\'ll find more information about the cabin and the area, <a href="https://boshuisdeputter.nl" style="color:#2d5016;font-weight:600">check it out here</a>.',
      questionsH: 'Questions?',
      questionsTxt: 'If you have any questions or requests, just reply to this email.',
      brochureH: '📖 Welcome guide',
      brochureTxt: 'We\'ve put together a digital welcome guide with everything about the cabin, surroundings, walking routes and tips. Great to browse before your arrival! You\'ll also find more info and photos on our website.',
      brochureCta: '📖 View welcome guide',
      endTxt: 'Enjoy the anticipation!',
      signoff: 'See you soon,',
      sig: 'Jan — De Putter · Boshuis Ommen'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p style="font-size:15px;line-height:1.6">${t.intro}</p>

    <div style="background:#f0f7ec;border-radius:8px;padding:14px 18px;margin:18px 0">
      <p style="margin:0;font-size:14px;color:#2d5016;line-height:1.6">📬 ${t.infoNote}</p>
    </div>

    <h3 style="color:#2d5016;font-family:Georgia,serif;font-size:16px;margin-top:24px">${t.inspireH}</h3>
    <p style="font-size:14px;line-height:1.6">${t.inspireTxt}</p>

    <h3 style="color:#2d5016;font-family:Georgia,serif;font-size:16px;margin-top:20px">${t.questionsH}</h3>
    <p style="font-size:14px;line-height:1.6">${t.questionsTxt}</p>

    <div style="background:#fff;border:1.5px solid #c9a96e;border-radius:10px;padding:18px 22px;margin:22px 0;text-align:center">
      <h3 style="margin:0 0 8px;color:#2d5016;font-family:Georgia,serif;font-size:16px">${t.brochureH}</h3>
      <p style="margin:0 0 14px;font-size:13.5px;color:#5c3d2e;line-height:1.5">${t.brochureTxt}</p>
      <a href="https://boshuisdeputter.nl/welkomstgids.pdf" target="_blank" rel="noopener" style="display:inline-block;background:#2d5016;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${t.brochureCta}</a>
    </div>

    <p style="font-size:14px;line-height:1.6;font-style:italic;color:#5c3d2e">${t.endTxt}</p>

    <p style="margin-top:28px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 1 — PRE-ARRIVAL WELKOMSTGIDS (sent 7 days before check-in)
================================================================ */
export function preArrivalEmail(b, envConfig = {}) {
  const { keyCode = '[wordt nog toegestuurd]', wifiName = 'Odido-Boshuis', wifiPassword = '[wordt nog toegestuurd]', ownerPhone = '' } = envConfig;
  const lang = b.language || 'nl';
  const days = daysUntil(b.checkin);

  const t = {
    nl: {
      subject: `🌲 Bijna zover — praktische info voor je verblijf in De Putter`,
      h1: `Nog ${days} dagen!`,
      intro: `Hoi ${esc(b.name)}, over ${days} dagen ben je in het bos 🌲 Hier is alles wat je nodig hebt voor aankomst.`,
      keyH: '🔑 Sleutelkastje',
      keyTxt: `De sleutel hangt in een kastje <strong>rechts om de hoek vanaf de voordeur</strong>, naast de openslaande deuren van de keuken.<br>Code: <strong style="font-family:Consolas,monospace;font-size:18px;color:#2d5016">${esc(keyCode)}</strong>`,
      wifiH: '📶 WiFi',
      wifiTxt: `Netwerk: <strong>${esc(wifiName)}</strong><br>Wachtwoord: <strong style="font-family:Consolas,monospace">${esc(wifiPassword)}</strong>`,
      routeH: '🚗 De weg naar ons toe',
      routeTxt: `Als je vanuit Ommen/Arriën komt, neem je vanaf de Coevorderweg <strong>het 2<sup>e</sup> weggetje rechts</strong> — niet het eerste (dat is moerassig). Na 150m zie je het huisje links. Parkeren op eigen terrein (ruimte voor 2 auto\'s).`,
      checkH: '⏰ Check-in & check-out',
      checkTxt: 'Aankomst tussen 15:00 en 22:00 · Vertrek vóór 11:00',
      shoesH: '👟 Schoenen uit',
      shoesTxt: 'We houden ons aan het Scandinavische gebruik om binnen de schoenen uit te doen — je loopt veel zand binnen vanuit het bos. Fijn als jullie dat ook willen doen.',
      houseH: '🏠 In het huis',
      houseTxt: 'Bedden zijn opgemaakt, handdoeken liggen klaar. Houtkachel + hout in de schuur. Nespresso-cupjes staan klaar. Basisvoorraad is aanwezig (kruiden, suiker, olie, koffie, thee).',
      flamingoH: '🦩 Een kleine uitdaging',
      flamingoTxt: 'In het huis zijn <strong>5 flamingo\'s</strong> verstopt. Waarom? Gewoon omdat het leuk is om te speuren. De uitdaging: vind ze allemaal — en bij vertrek weer verstoppen voor de volgende gast.',
      contactH: '📞 Contact',
      contactTxt: ownerPhone ? `Iets kwijt of niet duidelijk? Stuur een berichtje of bel: <strong>${esc(ownerPhone)}</strong>. Ook in noodgevallen.` : 'Vragen? Stuur gerust een mailtje naar janvanwaveren@gmail.com.',
      endH: 'Heel veel plezier!',
      endTxt: 'Geniet van het bos, hoor de vogels, stook de haard op, wees zuinig met het hout, houd een oogje open voor flamingo\'s.',
      signoff: 'Tot snel,',
      sig: 'Jan'
    },
    de: {
      subject: `🌲 Bald ist es so weit — praktische Infos für Ihren Aufenthalt in De Putter`,
      h1: `Noch ${days} Tage!`,
      intro: `Hallo ${esc(b.name)}, in ${days} Tagen sind Sie im Wald 🌲 Hier alles, was Sie für die Anreise brauchen.`,
      keyH: '🔑 Schlüsseltresor',
      keyTxt: `Der Schlüssel liegt im Kasten <strong>rechts um die Ecke vom Eingang</strong>, bei den Küchentüren.<br>Code: <strong style="font-family:Consolas,monospace;font-size:18px;color:#2d5016">${esc(keyCode)}</strong>`,
      wifiH: '📶 WLAN',
      wifiTxt: `Netzwerk: <strong>${esc(wifiName)}</strong><br>Passwort: <strong style="font-family:Consolas,monospace">${esc(wifiPassword)}</strong>`,
      routeH: '🚗 Der Weg zu uns',
      routeTxt: `Wenn Sie aus Ommen/Arriën kommen, nehmen Sie von der Coevorderweg <strong>den 2. Weg rechts</strong> — nicht den ersten (moorig). Nach 150m sehen Sie das Häuschen links. Parken auf dem Grundstück (Platz für 2 Autos).`,
      checkH: '⏰ An- & Abreise',
      checkTxt: 'Anreise zwischen 15:00 und 22:00 · Abreise bis 11:00 Uhr',
      shoesH: '👟 Schuhe aus',
      shoesTxt: 'Skandinavische Tradition: drinnen bitte die Schuhe ausziehen — es kommt viel Sand vom Wald mit herein.',
      houseH: '🏠 Im Haus',
      houseTxt: 'Betten sind bezogen, Handtücher liegen bereit. Holzofen + Holz im Schuppen. Nespresso-Kapseln vorhanden. Grundvorrat ist da (Gewürze, Zucker, Öl, Kaffee, Tee).',
      flamingoH: '🦩 Eine kleine Herausforderung',
      flamingoTxt: 'Im Haus sind <strong>5 Flamingos</strong> versteckt. Einfach weil es Spaß macht zu suchen. Finden Sie alle — und verstecken Sie sie bei der Abreise für den nächsten Gast.',
      contactH: '📞 Kontakt',
      contactTxt: ownerPhone ? `Etwas unklar? Schreiben Sie oder rufen Sie an: <strong>${esc(ownerPhone)}</strong>. Auch im Notfall.` : 'Fragen? E-Mail an janvanwaveren@gmail.com.',
      endH: 'Viel Spaß!',
      endTxt: 'Genießen Sie den Wald, hören Sie die Vögel, machen Sie ein Feuer an, halten Sie Ausschau nach Flamingos.',
      signoff: 'Bis bald,',
      sig: 'Jan'
    },
    en: {
      subject: `🌲 Almost there — practical info for your stay at De Putter`,
      h1: `${days} days to go!`,
      intro: `Hi ${esc(b.name)}, in ${days} days you'll be in the forest 🌲 Here's everything you need for arrival.`,
      keyH: '🔑 Key safe',
      keyTxt: `The key is in a small safe <strong>around the right corner from the front door</strong>, by the kitchen's double doors.<br>Code: <strong style="font-family:Consolas,monospace;font-size:18px;color:#2d5016">${esc(keyCode)}</strong>`,
      wifiH: '📶 WiFi',
      wifiTxt: `Network: <strong>${esc(wifiName)}</strong><br>Password: <strong style="font-family:Consolas,monospace">${esc(wifiPassword)}</strong>`,
      routeH: '🚗 Getting here',
      routeTxt: `Coming from Ommen/Arriën, on Coevorderweg <strong>take the 2nd little road on the right</strong> — not the first (it's boggy). After 150m you'll see the cabin on your left. Park on the grounds (room for 2 cars).`,
      checkH: '⏰ Check-in & check-out',
      checkTxt: 'Check-in 15:00–22:00 · Check-out by 11:00',
      shoesH: '👟 Shoes off inside',
      shoesTxt: 'Scandinavian custom: please take your shoes off inside — otherwise you\'ll track forest sand through the house.',
      houseH: '🏠 Inside',
      houseTxt: 'Beds are made up, towels laid out. Wood stove + firewood in the shed. Nespresso pods ready. Basics are stocked (herbs, sugar, oil, coffee, tea).',
      flamingoH: '🦩 A little hunt',
      flamingoTxt: '<strong>5 flamingos</strong> are hidden in the house. Just because it\'s fun to search for them. Find them all — and hide them again for the next guest before you leave.',
      contactH: '📞 Contact',
      contactTxt: ownerPhone ? `Something unclear? Message or call: <strong>${esc(ownerPhone)}</strong>. Also for emergencies.` : 'Questions? Email janvanwaveren@gmail.com.',
      endH: 'Have a wonderful time!',
      endTxt: 'Enjoy the forest, listen for the birds, light the fire, keep an eye out for flamingos.',
      signoff: 'See you soon,',
      sig: 'Jan'
    }
  }[lang] || t.nl;

  const section = (h, body) => `<div style="background:#fff;border-left:4px solid #2d5016;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0">
    <h3 style="margin:0 0 6px;color:#2d5016;font-size:15px;font-family:Georgia,serif">${h}</h3>
    <div style="font-size:14px;color:#2d3436;line-height:1.6">${body}</div>
  </div>`;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p style="font-size:15px">${t.intro}</p>

    ${section(t.keyH, t.keyTxt)}
    ${section(t.wifiH, t.wifiTxt)}
    ${section(t.routeH, t.routeTxt)}
    ${section(t.checkH, t.checkTxt)}
    ${section(t.shoesH, t.shoesTxt)}
    ${section(t.houseH, t.houseTxt)}
    ${section(t.contactH, t.contactTxt)}

    <div style="background:linear-gradient(135deg,#fff5f8 0%,#ffe8f0 100%);border:1px dashed #e06b8c;padding:16px 20px;border-radius:10px;margin:20px 0;text-align:center">
      <h3 style="margin:0 0 6px;color:#c4456a;font-family:Georgia,serif;font-size:16px">${t.flamingoH}</h3>
      <p style="margin:0;font-size:13.5px;color:#5c3d2e;line-height:1.6">${t.flamingoTxt}</p>
    </div>

    <p style="font-size:15px;font-style:italic;color:#5c3d2e;text-align:center;margin:28px 0 8px"><strong style="font-family:Georgia,serif;color:#2d5016;font-size:17px">${t.endH}</strong><br>${t.endTxt}</p>

    <p style="margin-top:28px;text-align:center;font-family:Georgia,serif;color:#2d5016;font-size:16px">${t.signoff}<br><strong>${t.sig}</strong></p>

    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 2 — PAYMENT REMINDER (2 days before deadline)
================================================================ */
export function paymentReminderEmail(b, iban, ownerName) {
  const lang = b.language || 'nl';
  const t = {
    nl: {
      subject: `💳 Kleine reminder: betaling De Putter (${b.reference})`,
      h1: 'Kleine reminder',
      intro: `Hoi ${esc(b.name)}, we hebben je betaling voor <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> nog niet binnen zien komen. Misschien is er iets misgegaan of is het aan je aandacht ontschoten.`,
      payIntro: 'Ter herinnering:',
      payLabels: { iban: 'IBAN', tnv: 'T.n.v.', amount: 'Bedrag', ref: 'Kenmerk' },
      already: 'Heb je al betaald? Dan kan het zijn dat we elkaars mail gekruist hebben — laat het gerust even weten.',
      signoff: 'Groeten,',
      sig: 'Jan · De Putter'
    },
    de: {
      subject: `💳 Freundliche Erinnerung: Zahlung De Putter (${b.reference})`,
      h1: 'Freundliche Erinnerung',
      intro: `Hallo ${esc(b.name)}, wir haben Ihre Zahlung für <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> noch nicht erhalten. Vielleicht ist etwas schiefgegangen oder es ist Ihrer Aufmerksamkeit entgangen.`,
      payIntro: 'Zur Erinnerung:',
      payLabels: { iban: 'IBAN', tnv: 'Kontoinhaber', amount: 'Betrag', ref: 'Verwendungszweck' },
      already: 'Haben Sie bereits bezahlt? Dann haben sich vielleicht unsere E-Mails gekreuzt — lassen Sie es mich wissen.',
      signoff: 'Grüße,',
      sig: 'Jan · De Putter'
    },
    en: {
      subject: `💳 Friendly reminder: payment for De Putter (${b.reference})`,
      h1: 'Friendly reminder',
      intro: `Hi ${esc(b.name)}, we haven't seen your payment for <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> come in yet. Maybe something went wrong, or it slipped your attention.`,
      payIntro: 'As a reminder:',
      payLabels: { iban: 'IBAN', tnv: 'Account holder', amount: 'Amount', ref: 'Payment reference' },
      already: 'Already paid? Our messages may have crossed — just let me know.',
      signoff: 'Best,',
      sig: 'Jan · De Putter'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1, '#c9a96e')}
    <p>${t.intro}</p>
    <p>${t.payIntro}</p>
    <table style="width:100%;font-size:14px;background:#fff;padding:14px;border-radius:6px;margin:12px 0">
      <tr><td style="padding:4px 8px;color:#636e72;width:160px">${t.payLabels.iban}</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600">${esc(iban)}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">${t.payLabels.tnv}</td><td style="padding:4px 8px">${esc(ownerName)}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">${t.payLabels.amount}</td><td style="padding:4px 8px;font-weight:700;color:#2d5016">€${b.total}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">${t.payLabels.ref}</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600;color:#c0392b">${esc(b.reference)}</td></tr>
    </table>
    <p style="color:#636e72;font-size:14px;font-style:italic">${t.already}</p>
    <p style="margin-top:32px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 3 — FINAL PAYMENT REMINDER (deadline day)
================================================================ */
export function finalReminderEmail(b, iban, ownerName) {
  const lang = b.language || 'nl';
  const t = {
    nl: {
      subject: `⏰ Laatste reminder: betaling voor De Putter vervalt vandaag (${b.reference})`,
      h1: 'Betaaldeadline vandaag',
      intro: `Hoi ${esc(b.name)}, vandaag is de deadline voor de betaling van je verblijf in De Putter.`,
      warn: `Als we de betaling niet vandaag ontvangen, moeten we de boeking <strong>helaas automatisch annuleren</strong> en de datums weer vrijgeven. Dat zou jammer zijn — bel of mail ons gerust als er iets is.`,
      contact: 'Contact: janvanwaveren@gmail.com',
      signoff: 'Groeten,',
      sig: 'Jan · De Putter'
    },
    de: {
      subject: `⏰ Letzte Erinnerung: Zahlungsfrist heute (${b.reference})`,
      h1: 'Zahlungsfrist heute',
      intro: `Hallo ${esc(b.name)}, heute läuft die Zahlungsfrist für Ihren Aufenthalt in De Putter ab.`,
      warn: `Wenn wir die Zahlung heute nicht erhalten, müssen wir die Buchung <strong>leider automatisch stornieren</strong> und die Daten freigeben. Das wäre schade — melden Sie sich gerne, falls etwas ist.`,
      contact: 'Kontakt: janvanwaveren@gmail.com',
      signoff: 'Grüße,',
      sig: 'Jan · De Putter'
    },
    en: {
      subject: `⏰ Final reminder: payment deadline today (${b.reference})`,
      h1: 'Payment deadline today',
      intro: `Hi ${esc(b.name)}, today is the payment deadline for your stay at De Putter.`,
      warn: `If we don't receive payment today, we'll unfortunately have to <strong>automatically cancel the booking</strong> and release the dates. That would be a shame — get in touch if there's anything.`,
      contact: 'Contact: janvanwaveren@gmail.com',
      signoff: 'Best,',
      sig: 'Jan · De Putter'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1, '#c0392b')}
    <p>${t.intro}</p>
    <div style="background:#ffebee;border-left:4px solid #c0392b;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0;font-size:14px">${t.warn}</div>
    <table style="width:100%;font-size:14px;background:#fff;padding:14px;border-radius:6px;margin:12px 0">
      <tr><td style="padding:4px 8px;color:#636e72;width:160px">IBAN</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600">${esc(iban)}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">T.n.v.</td><td style="padding:4px 8px">${esc(ownerName)}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">Bedrag</td><td style="padding:4px 8px;font-weight:700;color:#2d5016">€${b.total}</td></tr>
      <tr><td style="padding:4px 8px;color:#636e72">Kenmerk</td><td style="padding:4px 8px;font-family:Consolas,monospace;font-weight:600;color:#c0392b">${esc(b.reference)}</td></tr>
    </table>
    <p style="font-size:13.5px;color:#636e72">${t.contact}</p>
    <p style="margin-top:32px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 4 — AUTO-CANCEL NOTICE
================================================================ */
export function autoCancelEmail(b) {
  const lang = b.language || 'nl';
  const t = {
    nl: {
      subject: `Boeking geannuleerd — geen betaling ontvangen (${b.reference})`,
      h1: 'Boeking automatisch geannuleerd',
      body: `Hoi ${esc(b.name)}, we hebben de betaling voor <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> helaas niet op tijd ontvangen. We hebben de boeking daarom geannuleerd en de datums weer vrijgegeven.`,
      alt: `Wil je alsnog komen? Stuur een mailtje — we kijken graag of we nog iets kunnen regelen. Of boek opnieuw via <a href="https://boshuisdeputter.nl">boshuisdeputter.nl</a>.`,
      signoff: 'Groeten,',
      sig: 'Jan · De Putter'
    },
    de: {
      subject: `Buchung storniert — keine Zahlung erhalten (${b.reference})`,
      h1: 'Buchung automatisch storniert',
      body: `Hallo ${esc(b.name)}, wir haben die Zahlung für <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> leider nicht rechtzeitig erhalten. Wir haben die Buchung storniert und die Daten freigegeben.`,
      alt: `Möchten Sie dennoch kommen? Schreiben Sie uns gerne — wir schauen, ob wir etwas einrichten können. Oder buchen Sie erneut auf <a href="https://boshuisdeputter.nl">boshuisdeputter.nl</a>.`,
      signoff: 'Grüße,',
      sig: 'Jan · De Putter'
    },
    en: {
      subject: `Booking cancelled — payment not received (${b.reference})`,
      h1: 'Booking automatically cancelled',
      body: `Hi ${esc(b.name)}, we haven't received payment for <strong>${fmtDate(b.checkin, lang)} – ${fmtDate(b.checkout, lang)}</strong> in time, so we've cancelled the booking and released the dates.`,
      alt: `Still want to come? Drop us a line — we'll see if we can work something out. Or book again at <a href="https://boshuisdeputter.nl">boshuisdeputter.nl</a>.`,
      signoff: 'Best,',
      sig: 'Jan · De Putter'
    }
  }[lang] || t.nl;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1, '#636e72')}
    <p>${t.body}</p>
    <p>${t.alt}</p>
    <p style="margin-top:28px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 4b — CHECKOUT DAY (sent on checkout morning)
   Warm farewell with practical reminders (bedding, key) and a heads-up
   about the thank-you email with discount code coming tomorrow.
================================================================ */
export function checkoutDayEmail(b) {
  const lang = b.language || 'nl';

  const t = {
    nl: {
      subject: `🏡 Fijne terugreis — tot ziens vanuit De Putter!`,
      h1: 'Fijne terugreis!',
      intro: `Hoi ${esc(b.name)}, we hopen dat jullie een heerlijk verblijf hebben gehad in het bos. Wat fijn dat jullie er waren!`,
      checklistH: 'Voor vertrek',
      items: [
        { icon: '🛏️', text: 'Zou je de <strong>lakens en handdoeken in de wasmachine</strong> willen doen? Dat scheelt ons enorm bij het klaarmaken voor de volgende gasten.' },
        { icon: '🚪', text: 'Doe de <strong>voordeur op slot</strong> met de sleutel.' },
        { icon: '🔑', text: 'Leg de <strong>sleutel terug in het sleutelkastje</strong> en draai het slot dicht.' }
      ],
      travelH: 'Goede reis!',
      travelTxt: 'We wensen jullie een veilige terugreis. Morgen ontvangen jullie van ons een bedankmail met een <strong>persoonlijke kortingscode</strong> — voor een volgend verblijf, of om te delen met vrienden of familie.',
      welcomeBack: 'Jullie zijn altijd welkom voor een volgende keer in het bos.',
      signoff: 'Tot ziens,',
      sig: 'Jan · De Putter'
    },
    de: {
      subject: `🏡 Gute Heimreise — auf Wiedersehen von De Putter!`,
      h1: 'Gute Heimreise!',
      intro: `Hallo ${esc(b.name)}, wir hoffen, Sie hatten einen wunderbaren Aufenthalt im Wald. Schön, dass Sie da waren!`,
      checklistH: 'Vor der Abreise',
      items: [
        { icon: '🛏️', text: 'Könnten Sie die <strong>Bettwäsche und Handtücher in die Waschmaschine</strong> tun? Das hilft uns sehr bei der Vorbereitung für die nächsten Gäste.' },
        { icon: '🚪', text: 'Schließen Sie die <strong>Haustür ab</strong> mit dem Schlüssel.' },
        { icon: '🔑', text: 'Legen Sie den <strong>Schlüssel zurück in den Schlüsseltresor</strong> und drehen Sie das Schloss zu.' }
      ],
      travelH: 'Gute Reise!',
      travelTxt: 'Wir wünschen Ihnen eine sichere Heimreise. Morgen erhalten Sie von uns eine Dankesmail mit einem <strong>persönlichen Rabattcode</strong> — für einen nächsten Aufenthalt oder zum Teilen mit Freunden und Familie.',
      welcomeBack: 'Sie sind jederzeit willkommen für einen nächsten Besuch im Wald.',
      signoff: 'Auf Wiedersehen,',
      sig: 'Jan · De Putter'
    },
    en: {
      subject: `🏡 Safe travels — goodbye from De Putter!`,
      h1: 'Safe travels!',
      intro: `Hi ${esc(b.name)}, we hope you had a wonderful time in the forest. So glad you stayed with us!`,
      checklistH: 'Before you leave',
      items: [
        { icon: '🛏️', text: 'Could you pop the <strong>sheets and towels in the washing machine</strong>? It helps us a lot when getting ready for the next guests.' },
        { icon: '🚪', text: '<strong>Lock the front door</strong> with the key.' },
        { icon: '🔑', text: 'Put the <strong>key back in the key safe</strong> and lock it.' }
      ],
      travelH: 'Have a safe trip home!',
      travelTxt: 'We wish you a safe journey home. Tomorrow you\'ll receive a thank-you email from us with a <strong>personal discount code</strong> — for a future stay, or to share with friends and family.',
      welcomeBack: 'You\'re always welcome back in the forest.',
      signoff: 'Goodbye,',
      sig: 'Jan · De Putter'
    }
  }[lang] || {};

  const itemsHtml = t.items.map(item => `
    <tr>
      <td style="padding:8px 12px 8px 0;font-size:22px;vertical-align:top;width:36px">${item.icon}</td>
      <td style="padding:8px 0;font-size:14px;line-height:1.55;color:#2d3436">${item.text}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p style="font-size:15px;line-height:1.6">${t.intro}</p>

    <div style="background:#fff;border-left:4px solid #c9a96e;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0">
      <h3 style="margin:0 0 12px;color:#5c3d2e;font-family:Georgia,serif;font-size:16px">${t.checklistH}</h3>
      <table style="width:100%;border-collapse:collapse">${itemsHtml}</table>
    </div>

    <div style="background:linear-gradient(135deg,#f0f5eb 0%,#e8f5e0 100%);border-radius:10px;padding:18px 22px;margin:24px 0;border:1px solid #cfe0bc">
      <h3 style="margin:0 0 8px;color:#2d5016;font-family:Georgia,serif;font-size:16px">${t.travelH}</h3>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">${t.travelTxt}</p>
      <p style="margin:0;font-size:14px;line-height:1.6;font-style:italic;color:#5c3d2e">${t.welcomeBack}</p>
    </div>

    <p style="margin-top:28px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}

/* ================================================================
   TEMPLATE 5 — THANK-YOU + REVIEW + PERSONAL CODE (1 day after checkout)

   Reframed: the primary message is "thank you for staying" with the
   personal-code-on-a-sign as the hero image. Review is the secondary ask.
   The Putter (European goldfinch) holds a wooden sign displaying the code —
   inline SVG renders in Apple Mail, Gmail, Yahoo; falls back gracefully elsewhere.
================================================================ */
export function reviewRequestEmail(b) {
  const lang = b.language || 'nl';
  const code = b.personalCode || '';
  const hasCode = !!code;
  const pct = 10;
  const isNH = b.source === 'natuurhuisje';

  // Review link: Natuurhuisje guests → Natuurhuisje review page; direct guests → our own.
  let reviewUrl;
  if (isNH) {
    reviewUrl = 'https://www.natuurhuisje.nl/vakantiehuis/review';
  } else {
    reviewUrl = `${BASE_URL}/review.html`;
    try {
      const reviewToken = signReviewToken({
        ref: b.reference,
        email: b.email,
        name: b.name,
        checkin: b.checkin,
        checkout: b.checkout
      });
      reviewUrl = `${BASE_URL}/review.html?t=${encodeURIComponent(reviewToken)}`;
    } catch (err) {
      console.error('signReviewToken failed (fallback to plain review URL):', err);
    }
  }

  const t = {
    nl: {
      subject: `🌲 Bedankt voor jullie verblijf, ${esc(b.name)}!`,
      h1: 'Bedankt voor jullie verblijf!',
      intro: `Hoi ${esc(b.name)}, we hopen dat jullie hebben genoten van de dagen in het bos. Fijn dat jullie er waren — en wie weet tot een volgende keer.`,
      giftCaption: 'Onze putter heeft iets voor jullie',
      codeLabel: 'Jullie persoonlijke code',
      codeNote: `Eenmalig geldig voor <strong>${pct}% korting</strong> op een volgend verblijf.`,
      codeShare: 'Gebruik hem zelf, of deel hem met een vriend, collega of familielid — wie hem als eerste invult bij een boeking, krijgt de korting.',
      signNoCode: 'Tot ziens!',
      askH: 'En als je toch even tijd hebt…',
      askTxt: isNH
        ? 'Zou je een korte beoordeling willen achterlaten op Natuurhuisje? Het kost je 2 minuten en helpt ons én toekomstige gasten enorm — we lezen elke review zelf.'
        : 'Zou je een korte beoordeling willen achterlaten? Het kost je 2 minuten en helpt ons én toekomstige gasten enorm — we lezen elke review zelf.',
      ctaLabel: isNH ? '✍️ Review op Natuurhuisje' : '✍️ Beoordeling schrijven',
      signoff: 'Hopelijk tot snel,',
      sig: 'Jan · De Putter'
    },
    de: {
      subject: `🌲 Danke für Ihren Aufenthalt, ${esc(b.name)}!`,
      h1: 'Danke für Ihren Aufenthalt!',
      intro: `Hallo ${esc(b.name)}, wir hoffen, Sie haben Ihre Tage im Wald genossen. Schön, dass Sie da waren — und wer weiß, bis zum nächsten Mal.`,
      giftCaption: 'Unser Stieglitz hat etwas für Sie',
      codeLabel: 'Ihr persönlicher Code',
      codeNote: `Einmalig gültig für <strong>${pct}% Rabatt</strong> auf einen nächsten Aufenthalt.`,
      codeShare: 'Nutzen Sie ihn selbst oder teilen Sie ihn mit einem Freund, Kollegen oder Familienmitglied — wer ihn als Erster bei einer Buchung eingibt, bekommt den Rabatt.',
      signNoCode: 'Auf Wiedersehen!',
      askH: 'Und wenn Sie kurz Zeit haben…',
      askTxt: isNH
        ? 'Würden Sie eine kurze Bewertung auf Natuurhuisje hinterlassen? Es kostet 2 Minuten und hilft uns und zukünftigen Gästen sehr — wir lesen jede Bewertung selbst.'
        : 'Würden Sie eine kurze Bewertung hinterlassen? Es kostet 2 Minuten und hilft uns und zukünftigen Gästen sehr — wir lesen jede Bewertung selbst.',
      ctaLabel: isNH ? '✍️ Bewertung auf Natuurhuisje' : '✍️ Bewertung schreiben',
      signoff: 'Bis hoffentlich bald,',
      sig: 'Jan · De Putter'
    },
    en: {
      subject: `🌲 Thanks for staying with us, ${esc(b.name)}!`,
      h1: 'Thanks for staying with us!',
      intro: `Hi ${esc(b.name)}, we hope you enjoyed your days in the forest. Lovely to have had you — and who knows, until next time.`,
      giftCaption: 'Our Putter has something for you',
      codeLabel: 'Your personal code',
      codeNote: `Redeemable once for <strong>${pct}% off</strong> a future stay.`,
      codeShare: 'Use it yourself, or share it with a friend, colleague or family member — whoever enters it first at the booking form gets the discount.',
      signNoCode: 'See you again!',
      askH: 'And if you have a minute…',
      askTxt: isNH
        ? 'Would you leave a short review on Natuurhuisje? It takes 2 minutes and helps us and future guests a lot — we read every review ourselves.'
        : 'Would you leave a short review? It takes 2 minutes and helps us and future guests a lot — we read every review ourselves.',
      ctaLabel: isNH ? '✍️ Review on Natuurhuisje' : '✍️ Write a review',
      signoff: 'Hope to see you again,',
      sig: 'Jan · De Putter'
    }
  }[lang] || {};

  // Putter holding a wooden sign with the code. All SVG — keeps the email self-contained,
  // renders crisp on retina, no external image hosting. Code text is part of the SVG too.
  const signText = hasCode ? esc(code) : (t.signNoCode || 'Tot ziens!');
  const putterSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 220" width="320" height="196" style="display:block;margin:0 auto;max-width:100%;height:auto" aria-hidden="true">
      <!-- Wooden post -->
      <rect x="174" y="60" width="12" height="140" rx="1.5" fill="#5c3d2e"/>
      <rect x="174" y="60" width="4"  height="140" fill="#3d2817" opacity="0.5"/>
      <!-- Sign plank -->
      <g>
        <rect x="60" y="70" width="240" height="80" rx="4" fill="#c9a96e"/>
        <rect x="60" y="70" width="240" height="80" rx="4" fill="url(#woodGrain)" opacity="0.35"/>
        <rect x="60" y="70" width="240" height="80" rx="4" fill="none" stroke="#5c3d2e" stroke-width="3"/>
        <!-- Wood grain lines -->
        <path d="M 72 92 Q 180 95 288 90" stroke="#5c3d2e" stroke-width="0.9" fill="none" opacity="0.35"/>
        <path d="M 72 108 Q 180 104 288 110" stroke="#5c3d2e" stroke-width="0.9" fill="none" opacity="0.35"/>
        <path d="M 72 128 Q 180 131 288 124" stroke="#5c3d2e" stroke-width="0.9" fill="none" opacity="0.35"/>
        <!-- Nails -->
        <circle cx="74"  cy="82"  r="2" fill="#2d1b10"/>
        <circle cx="286" cy="82"  r="2" fill="#2d1b10"/>
        <circle cx="74"  cy="138" r="2" fill="#2d1b10"/>
        <circle cx="286" cy="138" r="2" fill="#2d1b10"/>
      </g>
      <!-- CODE TEXT on the sign -->
      <text x="180" y="118" text-anchor="middle"
            font-family="Consolas, Menlo, 'Courier New', monospace"
            font-size="${hasCode ? 30 : 22}" font-weight="700"
            fill="#2d1b10" letter-spacing="${hasCode ? 3 : 1.5}">${signText}</text>

      <!-- Putter bird perched on top of the sign (left side) — European goldfinch -->
      <g transform="translate(70,18)">
        <!-- Tail feathers -->
        <path d="M -4 32 L -16 26 L -14 36 Z" fill="#1a0f08"/>
        <path d="M -4 36 L -18 34 L -10 44 Z" fill="#1a0f08"/>
        <!-- Body (yellow-gold) -->
        <ellipse cx="10" cy="34" rx="18" ry="14" fill="#d4af37"/>
        <!-- Wing (dark with yellow stripe) -->
        <path d="M 0 30 Q 12 22 22 30 Q 16 40 4 40 Z" fill="#1a0f08"/>
        <path d="M 4 32 Q 12 28 20 32" stroke="#d4af37" stroke-width="3" fill="none" stroke-linecap="round"/>
        <!-- Head black-white-black -->
        <ellipse cx="26" cy="22" rx="10" ry="9" fill="#1a0f08"/>
        <!-- White cheek -->
        <ellipse cx="30" cy="24" rx="5" ry="5" fill="#f5ead0"/>
        <!-- Red face mask -->
        <path d="M 32 18 Q 38 14 40 20 Q 38 26 32 24 Q 30 21 32 18 Z" fill="#c0392b"/>
        <!-- Eye -->
        <circle cx="28" cy="22" r="1.4" fill="#0a0504"/>
        <circle cx="28.3" cy="21.7" r="0.4" fill="#fff"/>
        <!-- Beak (pointy, off-white) -->
        <path d="M 40 22 L 46 22 L 40 25 Z" fill="#f5ead0"/>
        <!-- Two feet standing on top-left of sign -->
        <path d="M 10 48 L 8 54 M 18 48 L 20 54" stroke="#c9a96e" stroke-width="1.5" stroke-linecap="round"/>
      </g>

      <!-- A little confetti of leaves as extra warmth -->
      <g opacity="0.8">
        <ellipse cx="30"  cy="30"  rx="4" ry="2" fill="#4a7c2e" transform="rotate(-20 30 30)"/>
        <ellipse cx="330" cy="40"  rx="4" ry="2" fill="#5e9038" transform="rotate(30 330 40)"/>
        <ellipse cx="20"  cy="180" rx="3" ry="2" fill="#2d5016" transform="rotate(25 20 180)"/>
        <ellipse cx="340" cy="170" rx="3" ry="2" fill="#4a7c2e" transform="rotate(-30 340 170)"/>
      </g>

      <!-- Wood grain gradient -->
      <defs>
        <linearGradient id="woodGrain" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8b6a4a"/>
          <stop offset="100%" stop-color="#5c3d2e"/>
        </linearGradient>
      </defs>
    </svg>`;

  const codeBlock = hasCode ? `
    <div style="margin:12px 0 4px;text-align:center">
      <div style="font-size:11.5px;letter-spacing:2.5px;text-transform:uppercase;color:#8b6a4a;font-weight:600;margin-bottom:6px">${t.giftCaption}</div>
    </div>
    ${putterSvg}
    <div style="text-align:center;margin:8px 0 20px">
      <p style="font-size:13.5px;color:#5c3d2e;margin:14px 0 6px;line-height:1.55">${t.codeNote}</p>
      <p style="font-size:12.5px;color:#7a6b3a;margin:0 auto;max-width:420px;line-height:1.65">${t.codeShare}</p>
    </div>
  ` : '';

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#2d3436;background:#faf9f6">
    ${logoHeader(t.h1)}
    <p style="font-size:15px;line-height:1.6">${t.intro}</p>

    ${codeBlock}

    <div style="background:#fff;border-left:4px solid #2d5016;padding:16px 20px;margin:22px 0 14px;border-radius:0 8px 8px 0">
      <h3 style="margin:0 0 6px;color:#2d5016;font-family:Georgia,serif;font-size:16px">${t.askH}</h3>
      <p style="margin:0;font-size:14px;line-height:1.55">${t.askTxt}</p>
    </div>

    <p style="text-align:center;margin:20px 0">
      <a href="${reviewUrl}" style="display:inline-block;background:#2d5016;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${t.ctaLabel}</a>
    </p>

    <p style="margin-top:28px">${t.signoff}<br><strong>${t.sig}</strong></p>
    ${footerLine(lang)}
  </body></html>`;

  return { subject: t.subject, html };
}
