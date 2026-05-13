// Test-only utility: seeds 3 fake bookings with carefully calculated dates
// so that a single lifecycle-cron run triggers all three email templates.
// All emails go to OWNER_EMAIL so you can verify rendering.
//
// POST /api/admin/seed-test-bookings?secret=XXX
// DELETE /api/admin/seed-test-bookings?secret=XXX  (removes the 3 test entries)

import { saveBooking, deleteBooking } from '../_lib/store.js';

export const maxDuration = 15;

export default async function handler(req, res) {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const ownerEmail = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';
  const today = Date.now();
  const addDays = (n) => new Date(today + n * 86400000).toISOString().slice(0, 10);
  const iso = (offsetDays) => new Date(today + offsetDays * 86400000).toISOString();

  const testRefs = ['TESTPREARR', 'TESTCHKOUT', 'TESTREVIEW', 'TESTPAYREM'];

  if (req.method === 'DELETE') {
    for (const ref of testRefs) await deleteBooking(ref);
    return res.status(200).json({ ok: true, deleted: testRefs });
  }

  const common = {
    phone: '', notes: '(testboeking)', language: 'nl',
    guests: 2, nights: 4, subtotal: 480, discount: 0, discountPct: 0,
    cleaning: 75, total: 555, avgRate: 120, anyHighSeason: false,
    email: ownerEmail, t: today
  };

  // Scenario 1: paid, check-in in 3 days → triggers PRE-ARRIVAL email
  const b1 = {
    ...common,
    reference: 'TESTPREARR',
    name: 'Test Pre-Arrival',
    checkin: addDays(3),
    checkout: addDays(7),
    status: 'paid',
    acceptedAt: iso(-14),
    paidAt: iso(-7),
    sentEmails: {}
  };

  // Scenario 2: paid, checkout today → triggers CHECKOUT-DAY farewell email
  const b1b = {
    ...common,
    reference: 'TESTCHKOUT',
    name: 'Test Checkout Day',
    checkin: addDays(-4),
    checkout: addDays(0),
    status: 'paid',
    acceptedAt: iso(-14),
    paidAt: iso(-7),
    sentEmails: { preArrival: iso(-7) }
  };

  // Scenario 3: paid, checked out yesterday → triggers REVIEW REQUEST
  const b2 = {
    ...common,
    reference: 'TESTREVIEW',
    name: 'Test Review',
    checkin: addDays(-5),
    checkout: addDays(-1),
    status: 'paid',
    acceptedAt: iso(-20),
    paidAt: iso(-10),
    sentEmails: { preArrival: iso(-8) } // pretend already sent
  };

  // Scenario 4: awaiting payment, deadline in 2 days → triggers PAYMENT REMINDER
  // Deadline = min(checkin - 7, acceptedAt + 7)
  // Want deadline = today + 2, so acceptedAt = today - 5 (gives acceptedAt + 7 = +2)
  // checkin = today + 12 (gives checkin - 7 = +5, so min wins on acceptedAt + 7)
  const b3 = {
    ...common,
    reference: 'TESTPAYREM',
    name: 'Test Payment Reminder',
    checkin: addDays(12),
    checkout: addDays(16),
    status: 'awaiting_payment',
    acceptedAt: iso(-5),
    paidAt: null,
    sentEmails: {}
  };

  for (const b of [b1, b1b, b2, b3]) await saveBooking(b);

  return res.status(200).json({
    ok: true,
    created: [
      { ref: b1.reference, trigger: 'pre_arrival', checkin: b1.checkin },
      { ref: b1b.reference, trigger: 'checkout_day', checkout: b1b.checkout },
      { ref: b2.reference, trigger: 'review_request', checkout: b2.checkout },
      { ref: b3.reference, trigger: 'payment_reminder', checkin: b3.checkin, expected_deadline: addDays(2) }
    ],
    nextStep: 'Now hit /api/cron/lifecycle?secret=<ADMIN_SECRET> to fire the cron'
  });
}
