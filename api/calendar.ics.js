// Outbound iCal feed — exposes our direct bookings as an RFC 5545 calendar
// so Natuurhuisje (and any other platform) can import them and block those
// dates on their side. This is the "sending" half of two-way calendar sync.
//
// URL: /api/calendar.ics
// Headers: text/calendar
//
// What's included:
//   - All bookings with status 'awaiting_payment' or 'paid'
//   - Cancelled bookings are excluded (slot becomes available again)
//   - Cleaning day (checkout day) is included in the block
//
// What's NOT included (for privacy):
//   - Guest names, emails, notes — just a generic "Direct geboekt" label
//
// Public endpoint (no auth) — this is what Natuurhuisje / other platforms pull.
// Don't include PII in the output.

import { listBookings } from './_lib/store.js';

export const maxDuration = 10;

/** YYYY-MM-DD → YYYYMMDD (iCal date value format) */
function toIcalDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

/** Returns YYYY-MM-DD for dateStr + n days. */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Current UTC time in YYYYMMDDTHHMMSSZ format for DTSTAMP. */
function nowIcalStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape a value for iCal TEXT (newline → \n, comma/semicolon → escaped). */
function icalEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');

  try {
    const bookings = await listBookings({ limit: 1000 });

    // Block both awaiting_payment and paid — anyone with a pending payment is "holding"
    // that slot and we don't want Natuurhuisje selling it in parallel.
    const active = bookings.filter(b =>
      b.status === 'awaiting_payment' || b.status === 'paid'
    );

    const stamp = nowIcalStamp();
    const events = active.map(b => {
      const dtstart = toIcalDate(b.checkin);
      // iCal DTEND is exclusive. Our booking reserves nights [checkin..checkout)
      // plus a cleaning day on checkout itself — so DTEND = checkout + 1.
      const dtend = toIcalDate(addDays(b.checkout, 1));
      const uid = `boshuisdeputter-${b.reference}@boshuisdeputter.nl`;
      return [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `DTEND;VALUE=DATE:${dtend}`,
        `SUMMARY:${icalEscape('Direct geboekt — De Putter')}`,
        `DESCRIPTION:${icalEscape('Rechtstreekse boeking via boshuisdeputter.nl')}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT'
      ].join('\r\n');
    });

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//De Putter//Boshuis Ommen Direct Bookings//NL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:De Putter — Directe boekingen',
      'X-WR-TIMEZONE:Europe/Amsterdam',
      ...events,
      'END:VCALENDAR'
    ].join('\r\n') + '\r\n';

    res.status(200).send(ics);
  } catch (err) {
    console.error('iCal export failed:', err);
    res.setHeader('Content-Type', 'text/plain');
    res.status(500).send(`iCal generation failed: ${err.message}`);
  }
}
