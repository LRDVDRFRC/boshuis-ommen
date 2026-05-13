// Public reviews API — both the read side (used by the main site) and the
// guest submission side (used by /review.html) share this one endpoint so
// we stay under Vercel's 12-function Hobby-plan limit.
//
//   GET  /api/reviews                → list of visible reviews (cached, for the site)
//   GET  /api/reviews?t=TOKEN        → validate review token, return booking details
//                                      so the /review.html form can prefill
//   POST /api/reviews                → submit a review (body includes { t, rating, text, author })
//
// The submission flow is trust-gated by the signed token (see _lib/review-token.js).
// Only tokens that correspond to a real booking in KV are auto-published.

import { listReviews, saveReview, getBooking, updateBooking } from './_lib/store.js';
import { verifyReviewToken } from './_lib/review-token.js';
import { sendEmail } from './_lib/emails.js';

export const maxDuration = 10;

/** Escape for inline-HTML text (used for the private-feedback email to the owner). */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function findExistingReviewForRef(ref) {
  if (!ref) return null;
  const all = await listReviews({ limit: 500 });
  return all.find(r => r.bookingRef === ref) || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ---------- GET ----------
  if (req.method === 'GET') {
    const token = req.query.t;

    // Submission-form prefill: token present → validate + return booking info
    if (token) {
      res.setHeader('Cache-Control', 'no-store');
      const payload = verifyReviewToken(token);
      if (!payload) return res.status(200).json({ ok: false, reason: 'invalid_or_expired' });
      const existing = await findExistingReviewForRef(payload.ref);
      return res.status(200).json({
        ok: true,
        name: payload.name || '',
        checkin: payload.checkin || '',
        checkout: payload.checkout || '',
        reference: payload.ref || '',
        alreadySubmitted: !!existing,
        existing: existing ? {
          id: existing.id,
          rating: existing.rating,
          ratingDisplay: existing.ratingDisplay,
          text: existing.text,
          date: existing.date
        } : null
      });
    }

    // Public reviews list — cacheable
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    try {
      const reviews = await listReviews({ limit: 50, onlyVisible: true });
      return res.status(200).json({ reviews });
    } catch (err) {
      console.warn('reviews list error, returning empty:', err.message);
      return res.status(200).json({ reviews: [], error: err.message });
    }
  }

  // ---------- POST (submit) ----------
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const { t, rating, text, author, privateMessage } = req.body || {};
    const payload = verifyReviewToken(t);
    if (!payload) return res.status(400).json({ ok: false, error: 'invalid_or_expired_token' });

    const trimmed = String(text || '').trim();
    if (trimmed.length < 20) return res.status(400).json({ ok: false, error: 'text_too_short' });
    if (trimmed.length > 2000) return res.status(400).json({ ok: false, error: 'text_too_long' });
    const privateTrimmed = String(privateMessage || '').trim().slice(0, 2000);

    const ratingNum = Number(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 10) {
      return res.status(400).json({ ok: false, error: 'rating_out_of_range' });
    }

    const existing = await findExistingReviewForRef(payload.ref);

    // Only auto-publish if this token corresponds to a real booking in KV.
    // Preview/test emails carry a valid token but no real booking → mark
    // visible=false so they stay off the public list until Jan approves.
    let bookingExists = false;
    try { bookingExists = !!(await getBooking(payload.ref)); } catch {}

    const today = new Date().toISOString().slice(0, 10);
    const authorName = String(author || payload.name || 'Gast').slice(0, 80);
    const textI18n = { nl: trimmed, de: trimmed, en: trimmed };

    const record = {
      ...(existing || {}),
      id: existing?.id,
      author: authorName,
      date: existing?.date || today,
      rating: ratingNum,
      ratingDisplay: `${ratingNum}/10`,
      text: textI18n,
      visible: bookingExists,
      bookingRef: payload.ref,
      sourceEmail: payload.email,
      submittedAt: new Date().toISOString()
    };

    try {
      const saved = await saveReview(record);
      // Stash the private feedback (if any) on the booking and email the owner.
      if (privateTrimmed) {
        try {
          const booking = await getBooking(payload.ref);
          if (booking) {
            const existingFeedback = Array.isArray(booking.privateFeedback) ? booking.privateFeedback : [];
            await updateBooking(payload.ref, {
              reviewId: saved.id,
              reviewSubmittedAt: record.submittedAt,
              privateFeedback: [...existingFeedback, { at: record.submittedAt, text: privateTrimmed }]
            });
          }
          // Email the owner so private feedback doesn't just sit in KV unread
          const ownerEmail = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';
          const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#2d3436">
            <h2 style="color:#2d5016;font-family:Georgia,serif;margin:0 0 8px">Privé-bericht van gast bij beoordeling</h2>
            <p style="color:#636e72;margin:0 0 18px;font-size:13.5px">
              Van <strong>${esc(authorName)}</strong> — boeking ${esc(payload.ref)}${payload.email ? ` · <a href="mailto:${esc(payload.email)}" style="color:#2d5016">${esc(payload.email)}</a>` : ''}
            </p>
            <div style="background:#fdf8f0;border-left:4px solid #c9a96e;padding:14px 18px;border-radius:0 8px 8px 0;font-size:14.5px;line-height:1.6;white-space:pre-wrap">${esc(privateTrimmed)}</div>
            <p style="font-size:12px;color:#888;margin-top:20px">
              Dit is prive-feedback — niet gepubliceerd op de site. De openbare beoordeling (${ratingNum}/10) is
              ${bookingExists ? 'wel zichtbaar' : 'opgeslagen maar nog niet zichtbaar (preview/test)'}.
            </p>
          </body></html>`;
          await sendEmail({
            to: ownerEmail,
            subject: `💬 Privé-feedback van ${authorName} (${payload.ref})`,
            html,
            replyTo: payload.email || undefined
          });
        } catch (err) {
          console.error('private feedback handling failed (review itself saved OK):', err);
        }
      } else {
        // No private message — just annotate the booking with review metadata
        try {
          const booking = await getBooking(payload.ref);
          if (booking) {
            await updateBooking(payload.ref, { reviewId: saved.id, reviewSubmittedAt: record.submittedAt });
          }
        } catch {}
      }
      return res.status(200).json({ ok: true, id: saved.id, updated: !!existing });
    } catch (err) {
      console.error('review submit save failed:', err);
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
