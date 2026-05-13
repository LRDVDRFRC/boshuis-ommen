// Public endpoint the booking form calls to validate a promo code in real time.
// Returns { valid, pct, reason } — frontend uses pct to recompute the preview total.
// Does NOT reserve the code — reservation happens inside /api/booking-request.js when
// the full booking is submitted, so a validate-then-abandon doesn't lock it up.
//
// CORS locked to the production domain.

import { getPromoCode, isPromoExpired } from './_lib/store.js';

export const maxDuration = 5;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://boshuisdeputter.nl');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ valid: false, reason: 'method_not_allowed' });

  const rawCode = (req.body?.code || '').toString().trim().toUpperCase();
  if (!rawCode || rawCode.length < 4 || rawCode.length > 20) {
    return res.status(200).json({ valid: false, reason: 'empty' });
  }

  let rec;
  try {
    rec = await getPromoCode(rawCode);
  } catch (err) {
    console.error('validate-promo lookup failed:', err);
    return res.status(500).json({ valid: false, reason: 'lookup_error' });
  }

  if (!rec) {
    return res.status(200).json({ valid: false, reason: 'not_found' });
  }
  if (rec.status === 'used') {
    return res.status(200).json({ valid: false, reason: 'already_used' });
  }
  if (rec.status === 'revoked') {
    return res.status(200).json({ valid: false, reason: 'revoked' });
  }
  if (rec.status === 'reserved') {
    // Treat as "unavailable right now" — another booking is holding it pending payment.
    return res.status(200).json({ valid: false, reason: 'reserved' });
  }
  if (isPromoExpired(rec)) {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }
  // status === 'active'
  return res.status(200).json({
    valid: true,
    pct: rec.pct || 10,
    waiveCleaning: !!rec.waiveCleaning,
    kind: rec.kind || 'referral',
    code: rec.code
  });
}
