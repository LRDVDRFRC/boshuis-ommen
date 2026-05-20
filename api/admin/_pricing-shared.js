// Shared constants and helpers for the two-phase pricing analysis.

export const PROPERTY_CONTEXT = `# Property: De Putter

- Name: De Putter (named after the European goldfinch / putter)
- Address: Koelandweg 12, 7735 KW Arriën (municipality of Ommen, Overijssel)
- Setting: forest cabin on 1334 m² of private grounds, directly adjacent to the Junner Koeland protected nature reserve
- Capacity: 4 guests, 2 bedrooms (1 double + 1 bunk bed)
- Living space: 84 m²
- Key features: wood-burning stove, covered terrace, fenced garden, BBQ, trampoline, WiFi, private parking, 4 km from Ommen centre, 2 km from the Vecht river
- Current rating: 8.7/10 from 28 Natuurhuisje reviews
- Booked via: Natuurhuisje (listing ID 68313) + direct booking website (boshuisdeputter.nl)

# Current pricing (EUR per night)

| Period | Rate |
|---|---|
| Low winter (Nov 2 – Dec 19 & Jan 6 – Feb 14) | €85 |
| Shoulder / midseason (Mar 6 – Apr 23, Sep 1 – Oct 14) | €119 |
| School holidays (Voorjaar, Herfst, Hemelvaart, Pinksteren) | €125 |
| Meivakantie (Apr 24 – May 10) | €130 |
| Summer (Jul 1 – Aug 31) | €135 |
| Kerst / Oud & Nieuw (Dec 20 – Jan 5) | €135 |

Plus: €15/night weekend surcharge (Fri + Sat), €75 cleaning fee, minimum 2 nights year-round.

# CRITICAL: De Putter is ALL-INCLUSIVE

Most comparable cabins charge the guest separately for:
- Bed linen: typically €7–10/person (~€30 for 4 guests)
- Towels: typically €5/person (~€20 for 4 guests)
- Firewood: typically €10–25/stay
- Tourist tax (toeristenbelasting): Ommen ~€1.50/person/night (~€24 for 4 people × 4 nights)

De Putter INCLUDES all of these at no extra cost. On a typical 4-night stay this means De Putter's advertised rate is effectively €70–100 cheaper than a competitor at the same nightly price.`;

export function authCheck(req) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) {
    return { status: 500, error: 'ADMIN_SECRET env var not configured' };
  }

  const providedSecret = req.query?.secret || '';
  const authHeader = req.headers?.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (bearerToken !== ADMIN_SECRET && providedSecret !== ADMIN_SECRET) {
    return { status: 401, error: 'unauthorized' };
  }

  return { ok: true, isCron: bearerToken === ADMIN_SECRET };
}
