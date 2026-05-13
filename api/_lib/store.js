// Lightweight Redis wrapper for bookings + reviews.
// Uses Vercel's auto-injected REDIS_URL (from the connected KV/Redis database).

import Redis from 'ioredis';

let _redis = null;
function getClient() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL env var missing — did you connect the KV database to this project?');
  _redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: false
  });
  return _redis;
}

/* ========== BOOKINGS ========== */

const BOOKING_PREFIX = 'booking:';
const BOOKINGS_INDEX = 'bookings:by_checkin'; // ZSET: score=unix(checkin), value=reference

export async function saveBooking(booking) {
  const r = getClient();
  const key = BOOKING_PREFIX + booking.reference;
  const checkinTs = Math.floor(new Date(booking.checkin + 'T00:00:00Z').getTime() / 1000);
  await r.multi()
    .set(key, JSON.stringify(booking))
    .zadd(BOOKINGS_INDEX, checkinTs, booking.reference)
    .exec();
  return booking;
}

export async function getBooking(reference) {
  const r = getClient();
  const raw = await r.get(BOOKING_PREFIX + reference);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updateBooking(reference, updates) {
  const current = await getBooking(reference);
  if (!current) return null;
  const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
  const r = getClient();
  await r.set(BOOKING_PREFIX + reference, JSON.stringify(merged));
  return merged;
}

export async function deleteBooking(reference) {
  const r = getClient();
  await r.multi()
    .del(BOOKING_PREFIX + reference)
    .zrem(BOOKINGS_INDEX, reference)
    .exec();
}

/** Get all bookings, sorted by check-in date descending (most recent first). */
export async function listBookings({ limit = 200 } = {}) {
  const r = getClient();
  const refs = await r.zrevrange(BOOKINGS_INDEX, 0, limit - 1);
  if (refs.length === 0) return [];
  const pipeline = r.pipeline();
  refs.forEach(ref => pipeline.get(BOOKING_PREFIX + ref));
  const results = await pipeline.exec();
  return results
    .map(([err, val]) => (!err && val) ? JSON.parse(val) : null)
    .filter(Boolean);
}

/** Find bookings whose checkin is in the window [fromDays, toDays] from today. */
export async function findBookingsByCheckinWindow(fromDays, toDays) {
  const r = getClient();
  const now = Date.now();
  const fromTs = Math.floor((now + fromDays * 86400000) / 1000);
  const toTs = Math.floor((now + toDays * 86400000) / 1000);
  const refs = await r.zrangebyscore(BOOKINGS_INDEX, fromTs, toTs);
  if (refs.length === 0) return [];
  const pipeline = r.pipeline();
  refs.forEach(ref => pipeline.get(BOOKING_PREFIX + ref));
  const results = await pipeline.exec();
  return results.map(([err, val]) => (!err && val) ? JSON.parse(val) : null).filter(Boolean);
}

/* ========== REVIEWS ========== */

const REVIEW_PREFIX = 'review:';
const REVIEWS_INDEX = 'reviews:by_date'; // ZSET: score=unix(date), value=id

function genId() {
  return 'rev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function saveReview(review) {
  const r = getClient();
  const id = review.id || genId();
  const now = new Date().toISOString();
  const data = {
    ...review,
    id,
    createdAt: review.createdAt || now,
    updatedAt: now
  };
  const dateTs = Math.floor(new Date(review.date + 'T00:00:00Z').getTime() / 1000);
  await r.multi()
    .set(REVIEW_PREFIX + id, JSON.stringify(data))
    .zadd(REVIEWS_INDEX, dateTs, id)
    .exec();
  return data;
}

export async function getReview(id) {
  const r = getClient();
  const raw = await r.get(REVIEW_PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function deleteReview(id) {
  const r = getClient();
  await r.multi()
    .del(REVIEW_PREFIX + id)
    .zrem(REVIEWS_INDEX, id)
    .exec();
}

/** List reviews, most recent first. */
export async function listReviews({ limit = 50, onlyVisible = false } = {}) {
  const r = getClient();
  const ids = await r.zrevrange(REVIEWS_INDEX, 0, limit - 1);
  if (ids.length === 0) return [];
  const pipeline = r.pipeline();
  ids.forEach(id => pipeline.get(REVIEW_PREFIX + id));
  const results = await pipeline.exec();
  let list = results.map(([err, val]) => (!err && val) ? JSON.parse(val) : null).filter(Boolean);
  if (onlyVisible) list = list.filter(rev => rev.visible !== false);
  return list;
}

/* ========== PROMO CODES (unique per customer, one-time use) ==========
 *
 * Data model for each code at key `promocode:{CODE}`:
 *   {
 *     code:           'DP-X3K2Y9',     // the human-friendly code itself
 *     pct:            10,              // discount percentage
 *     waiveCleaning:  false,           // optional: also skip the cleaning fee (friend codes)
 *     expiresAt:      '2026-05-23T…',  // optional ISO date; past => treated as expired
 *     kind:           'referral'|'friend', // optional tag for admin filtering/audit
 *     note:           'Voor Marit',    // optional human note (who this is for)
 *     ownerRef:       'DPABC123',      // booking reference that earned this code (referral only)
 *     ownerEmail:     'guest@x.com',   // who received it — for admin audit
 *     status:         'active' | 'reserved' | 'used' | 'revoked',
 *     reservedByRef:  'DPDEF456'?,     // the booking currently holding this code
 *     usedByRef:      'DPDEF456'?,     // the booking that consumed it (after paid)
 *     createdAt, reservedAt?, usedAt?, revokedAt?
 *   }
 *
 * Lifecycle:
 *   active → reserved (when a booking request cites this code)
 *          → active   (if that booking is declined/cancelled before paid)
 *          → used     (when the reserving booking is marked paid)
 *   active → revoked  (if the OWNING booking — the one that earned the code — is cancelled)
 */

export function isPromoExpired(rec) {
  return !!(rec?.expiresAt && new Date(rec.expiresAt).getTime() < Date.now());
}

const PROMO_PREFIX = 'promocode:';

/** Generate a short readable promo code. Avoids confusable chars (0/O, 1/I, etc.). */
export function generatePromoCode() {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0,O,1,I,L
  let out = 'DP-';
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export async function savePromoCode(data) {
  const r = getClient();
  const code = String(data.code).toUpperCase();
  const record = { ...data, code, createdAt: data.createdAt || new Date().toISOString() };
  await r.set(PROMO_PREFIX + code, JSON.stringify(record));
  return record;
}

export async function getPromoCode(code) {
  const r = getClient();
  const raw = await r.get(PROMO_PREFIX + String(code).toUpperCase());
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updatePromoCode(code, updates) {
  const current = await getPromoCode(code);
  if (!current) return null;
  const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
  const r = getClient();
  await r.set(PROMO_PREFIX + current.code, JSON.stringify(merged));
  return merged;
}

/** Generate a UNIQUE promo code (retries on collision — statistically rare but cheap to check). */
export async function issuePromoCode({ ownerRef, ownerEmail, pct = 10 }) {
  const r = getClient();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generatePromoCode();
    const exists = await r.exists(PROMO_PREFIX + code);
    if (!exists) {
      return await savePromoCode({
        code, pct, ownerRef, ownerEmail,
        kind: 'referral',
        status: 'active'
      });
    }
  }
  throw new Error('Could not generate a unique promo code after 6 attempts');
}

/** Issue a friend promo (higher pct, optional waiveCleaning, time-limited). Not tied to a booking. */
export async function issueFriendPromoCode({ pct = 35, waiveCleaning = true, expiresInDays = 30, note = '' }) {
  const r = getClient();
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generatePromoCode();
    const exists = await r.exists(PROMO_PREFIX + code);
    if (!exists) {
      return await savePromoCode({
        code, pct, waiveCleaning, expiresAt, note,
        kind: 'friend',
        status: 'active'
      });
    }
  }
  throw new Error('Could not generate a unique promo code after 6 attempts');
}

/** Atomically try to reserve a code for a booking. Returns the updated record or null if unavailable.
 *  Uses WATCH/MULTI to avoid a race when two bookings use the same code in flight. */
export async function reservePromoCode(code, bookingRef) {
  const r = getClient();
  const key = PROMO_PREFIX + String(code).toUpperCase();
  // Simple CAS loop
  for (let attempt = 0; attempt < 3; attempt++) {
    await r.watch(key);
    const raw = await r.get(key);
    if (!raw) { await r.unwatch(); return null; }
    let rec;
    try { rec = JSON.parse(raw); } catch { await r.unwatch(); return null; }
    if (rec.status !== 'active') { await r.unwatch(); return null; }
    // Don't let a customer reserve their own code (would be self-referral)
    if (rec.ownerRef === bookingRef) { await r.unwatch(); return null; }
    const updated = {
      ...rec,
      status: 'reserved',
      reservedByRef: bookingRef,
      reservedAt: new Date().toISOString()
    };
    const result = await r.multi().set(key, JSON.stringify(updated)).exec();
    if (result) return updated; // null result = WATCH saw a change → retry
  }
  return null;
}

/** Mark a promo code as consumed (called when the reserving booking is paid). */
export async function consumePromoCode(code, bookingRef) {
  const now = new Date().toISOString();
  return await updatePromoCode(code, {
    status: 'used',
    usedByRef: bookingRef,
    usedAt: now
  });
}

/** Release a reserved code back to 'active' (called when reserving booking is cancelled). */
export async function releasePromoCode(code) {
  return await updatePromoCode(code, {
    status: 'active',
    reservedByRef: null,
    reservedAt: null
  });
}

/** Revoke a code because the owning booking was cancelled (so the code shouldn't be spendable). */
export async function revokePromoCode(code) {
  return await updatePromoCode(code, {
    status: 'revoked',
    revokedAt: new Date().toISOString()
  });
}

export async function seedDefaultReviews() {
  const r = getClient();
  const existing = await r.zcard(REVIEWS_INDEX);
  if (existing > 0) return { seeded: false, existing };

  const defaults = [
    {
      author: 'Mark',
      date: '2026-03-27',
      rating: 9,
      ratingDisplay: '9/10',
      text: {
        nl: 'Heerlijke omgeving in een bos met mooie natuurlijke tuin. Schattig huisje met voldoende ruimte. Heerlijk haardvuur en alles is aanwezig — je voelt de liefde van de eigenaren voor deze plek.',
        de: 'Wunderschöne Lage im Wald mit schönem Naturgarten. Entzückendes Häuschen mit genügend Platz. Herrliches Kaminfeuer — man spürt die Liebe der Eigentümer für diesen Ort.',
        en: 'Lovely setting in a forest with beautiful natural garden. Charming cabin with plenty of space. Wonderful fireplace — you can feel the owners\' love for this place.'
      },
      reply: null,
      visible: true
    },
    {
      author: 'Hanneke',
      date: '2026-03-06',
      rating: 9,
      ratingDisplay: '9/10',
      text: {
        nl: 'Echt een fantastische locatie. Ingericht met een fijne vibe waardoor je je thuis voelt en ook direct een vakantiegevoel. De eekhoorntjes die \'s ochtends voor het raam renden waren een feest. Perfect geschikt voor kleine kinderen.',
        de: 'Wirklich ein fantastischer Standort. Mit einem tollen Vibe eingerichtet, der sich wie zu Hause anfühlt. Die Eichhörnchen morgens vor dem Fenster waren ein Fest. Perfekt für kleine Kinder.',
        en: 'Truly a fantastic location. Decorated with a lovely vibe that makes you feel at home instantly. The squirrels running past the window each morning were a delight. Perfect for young children.'
      },
      reply: null,
      visible: true
    },
    {
      author: 'Krista',
      date: '2026-01-30',
      rating: 8,
      ratingDisplay: '8/10',
      text: {
        nl: 'Fijn contact met eigenaar. Alles op afstand maar toch duidelijk gevoel van gastvrijheid. Heel fijn huisje, alles aanwezig wat je nodig hebt. Grote tuin, veel privacy. Vogels in overvloed.',
        de: 'Angenehmer Kontakt mit dem Eigentümer. Alles aus der Ferne, aber dennoch ein deutliches Gefühl von Gastfreundschaft. Toller Garten, viel Privatsphäre. Vögel in Hülle und Fülle.',
        en: 'Great contact with the owner. Everything remote but still a clear sense of hospitality. Lovely cabin, everything you need. Large garden, lots of privacy. Birds galore.'
      },
      reply: null,
      visible: true
    }
  ];
  for (const rev of defaults) await saveReview(rev);
  return { seeded: true, count: defaults.length };
}
