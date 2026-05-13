// Admin API for reviews — CRUD + reply.
// GET    /api/admin/reviews?secret=XXX        → list all
// POST   /api/admin/reviews?secret=XXX        → create (body: JSON review data)
// PATCH  /api/admin/reviews?secret=XXX&id=XXX → update (body: partial review data)
// DELETE /api/admin/reviews?secret=XXX&id=XXX → delete
// POST   /api/admin/reviews?secret=XXX&id=XXX&action=seed → seed default reviews

import { listReviews, getReview, saveReview, deleteReview, seedDefaultReviews } from '../_lib/store.js';

export const maxDuration = 15;

export default async function handler(req, res) {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    // Seeding action
    if (req.method === 'POST' && req.query.action === 'seed') {
      const result = await seedDefaultReviews();
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'GET') {
      const reviews = await listReviews({ limit: 100 });
      return res.status(200).json({ ok: true, reviews });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!body.author || !body.date || !body.text) {
        return res.status(400).json({ error: 'author, date and text are required' });
      }
      const saved = await saveReview({
        author: String(body.author).slice(0, 80),
        date: String(body.date),
        rating: body.rating ? Number(body.rating) : null,
        ratingDisplay: body.ratingDisplay || (body.rating ? `${body.rating}/10` : ''),
        text: typeof body.text === 'string' ? { nl: body.text, de: body.text, en: body.text } : body.text,
        reply: body.reply || null,
        visible: body.visible !== false
      });
      return res.status(201).json({ ok: true, review: saved });
    }

    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const existing = await getReview(id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const updated = await saveReview({ ...existing, ...(req.body || {}), id });
      return res.status(200).json({ ok: true, review: updated });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await deleteReview(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admin/reviews error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
