// Signed token for the public review submission flow.
// Mirrors the booking accept/decline token approach: the token IS the state —
// it proves the holder received the post-stay thank-you email, so no session
// or password is needed to leave a review.
//
// Payload shape: { ref, email, checkin, checkout, name, t }
// Expiry: 90 days (plenty of time for a guest to get around to writing a review)

import crypto from 'node:crypto';

const REVIEW_TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;

export function signReviewToken(payload) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET env var not configured');
  const body = { ...payload, t: payload.t || Date.now(), kind: 'review' };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyReviewToken(token) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  let sigBuf, expectedBuf;
  try { sigBuf = Buffer.from(sig); expectedBuf = Buffer.from(expected); } catch { return null; }
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.kind !== 'review') return null;
    if (Date.now() - payload.t > REVIEW_TOKEN_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
