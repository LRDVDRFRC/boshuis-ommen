// Shared booking-timing helpers used by both booking-action.js (accept flow)
// and cron/lifecycle.js. Pure date math — no I/O.

const DAY_MS = 86_400_000;

/** Normalise a timestamp to midnight UTC on the same calendar day. */
function normaliseToMidnight(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Compute the payment deadline for a booking.
 *
 * Rules:
 *   - Ideal: 7 days before check-in, capped at 7 days after acceptance
 *   - For last-minute bookings (ideal would be in the past):
 *       fallback to 1 day before check-in
 *   - For same-day bookings (even "1 day before" is past):
 *       fallback to day of acceptance (meaning "pay today")
 *   - Always returned at midnight UTC so daysBetween gives whole integers
 */
export function paymentDeadline(booking) {
  const acceptedMs = booking.acceptedAt ? new Date(booking.acceptedAt).getTime() : Date.now();
  const checkinMs = new Date(booking.checkin + 'T00:00:00Z').getTime();

  const idealDeadline = Math.min(checkinMs - 7 * DAY_MS, acceptedMs + 7 * DAY_MS);

  let deadlineMs;
  if (idealDeadline < acceptedMs) {
    // Last-minute: ideal deadline is in the past. Use day before check-in.
    deadlineMs = checkinMs - 1 * DAY_MS;
    if (deadlineMs < acceptedMs) {
      // Same-day booking: even "day before" is in the past. Pay today.
      deadlineMs = acceptedMs;
    }
  } else {
    deadlineMs = idealDeadline;
  }

  return normaliseToMidnight(deadlineMs);
}

/**
 * Whole days from `a` to `b` (both normalised to midnight UTC).
 * Positive = b is in the future.
 */
export function daysBetween(a, b) {
  const aDay = typeof a === 'number' ? a : a.getTime();
  const bDay = typeof b === 'number' ? b : b.getTime();
  return Math.round((aDay - bDay) / DAY_MS);
}

/**
 * True if the booking is "last-minute" (accepted within 5 days of check-in).
 * When this is true, the accept email should include pre-arrival info
 * (key code, WiFi, route) because the normal 3-days-before cron won't
 * fire in time — or only once, which is tight.
 */
export function isLastMinute(booking) {
  const acceptedMs = booking.acceptedAt ? new Date(booking.acceptedAt).getTime() : Date.now();
  const checkinMs = new Date(booking.checkin + 'T00:00:00Z').getTime();
  return (checkinMs - acceptedMs) < 5 * DAY_MS;
}

/**
 * True if check-in is within 24 hours. Used in the initial booking-request
 * acknowledgement email to soften the "binnen 24 uur" promise for same-day bookings.
 */
export function isVeryUrgent(checkinDateStr) {
  const checkinMs = new Date(checkinDateStr + 'T00:00:00Z').getTime();
  return (checkinMs - Date.now()) < 1 * DAY_MS;
}
