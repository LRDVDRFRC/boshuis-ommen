// Vercel serverless function: merges Natuurhuisje iCal feed with our own
// direct bookings from Redis, returns JSON for the front-end calendar.
//
// Configure: set env var NATUURHUISJE_ICAL_URL in Vercel project settings.
// The endpoint degrades gracefully (returns empty list) if unconfigured.

import { listBookings } from './_lib/store.js';

function addDirectBookingDates(bookedDates, bookings) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const b of bookings) {
    if (b.status !== 'awaiting_payment' && b.status !== 'paid') continue;
    if (!b.checkin || !b.checkout) continue;

    const start = new Date(b.checkin + 'T00:00:00Z');
    const end = new Date(b.checkout + 'T00:00:00Z');

    // Block all nights + checkout day (cleaning day)
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d >= today) bookedDates.add(d.toISOString().slice(0, 10));
    }
  }
}

export default async function handler(req, res) {
  const ICAL_URL = process.env.NATUURHUISJE_ICAL_URL;

  // CORS + caching — reduced to 2 min so direct bookings show up faster
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=60');

  let icalResult = { bookedDates: [], upcomingBookings: 0, lastBookedAt: null };
  let configured = !!ICAL_URL;

  if (ICAL_URL) {
    try {
      const response = await fetch(ICAL_URL, {
        headers: { 'User-Agent': 'BoshuisOmmen/1.0 (+https://boshuisdeputter.nl)' }
      });
      if (response.ok) {
        const text = await response.text();
        icalResult = parseIcal(text);
      }
    } catch (err) {
      // iCal fetch failed — continue with direct bookings only
    }
  }

  // Merge direct bookings from Redis
  const mergedDates = new Set(icalResult.bookedDates);
  try {
    const directBookings = await listBookings({ limit: 500 });
    addDirectBookingDates(mergedDates, directBookings);
  } catch (err) {
    // Redis unavailable — still return iCal dates
  }

  return res.status(200).json({
    configured,
    bookedDates: [...mergedDates].sort(),
    upcomingBookings: icalResult.upcomingBookings,
    lastBookedAt: icalResult.lastBookedAt
  });
}

function parseIcal(text) {
  // Unfold RFC 5545 line continuations (CRLF followed by space/tab)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const bookedDates = new Set();
  let latestCreated = null;
  let upcomingBookings = 0;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Walk VEVENT blocks
  let inEvent = false;
  let ev = {};
  for (const rawLine of lines) {
    if (rawLine === 'BEGIN:VEVENT') { inEvent = true; ev = {}; continue; }
    if (rawLine === 'END:VEVENT')   {
      processEvent(ev);
      inEvent = false; ev = {};
      continue;
    }
    if (!inEvent) continue;

    // Handle params in property names, e.g. DTSTART;VALUE=DATE:20260101
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx === -1) continue;
    const left = rawLine.slice(0, colonIdx);
    const value = rawLine.slice(colonIdx + 1);
    const propName = left.split(';')[0].toUpperCase();

    if (propName === 'DTSTART' || propName === 'DTEND' ||
        propName === 'CREATED' || propName === 'DTSTAMP' ||
        propName === 'LAST-MODIFIED' || propName === 'SUMMARY') {
      ev[propName] = value;
    }
  }

  function processEvent(ev) {
    if (!ev.DTSTART || !ev.DTEND) return;
    const start = parseIcalDate(ev.DTSTART);
    const end   = parseIcalDate(ev.DTEND);
    if (!start || !end) return;

    // iCal DTEND is exclusive — e.g. booking Mon–Fri has DTEND=Fri; Fri is
    // the checkout day. We also block DTEND itself as a cleaning day so
    // the next guest can arrive the following day (no same-day turnover).
    // Only include dates from today onwards.
    for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d >= today) bookedDates.add(d.toISOString().slice(0, 10));
    }
    // Cleaning day = the checkout day (DTEND). Set dedupes back-to-back bookings.
    if (end >= today) bookedDates.add(end.toISOString().slice(0, 10));

    if (start >= today) upcomingBookings++;

    // Only use CREATED or LAST-MODIFIED — NOT DTSTAMP, which for most feeds
    // (e.g. Natuurhuisje) is the feed generation time, not the booking-creation
    // time. Using DTSTAMP would make "last booked X days ago" meaningless.
    const tsStr = ev.CREATED || ev['LAST-MODIFIED'];
    if (tsStr) {
      const ts = parseIcalDate(tsStr);
      if (ts && (!latestCreated || ts > latestCreated)) latestCreated = ts;
    }
  }

  return {
    bookedDates: [...bookedDates].sort(),
    upcomingBookings,
    lastBookedAt: latestCreated ? latestCreated.toISOString() : null
  };
}

function parseIcalDate(s) {
  // Accepts "20260501" (date) or "20260501T120000Z" (datetime UTC) or "20260501T120000" (floating)
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
}
