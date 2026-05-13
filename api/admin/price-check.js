// Weekly competitive pricing analysis for De Putter.
//
// Uses Claude Opus 4.7 with web search to find comparable vacation rentals
// in the Ommen/Vechtdal area and suggest competitive pricing adjustments.
//
// Triggered two ways:
//   1. Manual: GET /api/admin/price-check?secret=<ADMIN_SECRET>  (admin UI)
//   2. Cron:   weekly, Vercel sends Authorization: Bearer <CRON_SECRET>
//
// Required env vars:
//   ANTHROPIC_API_KEY    — Claude API key (required)
//   ADMIN_SECRET         — shared secret for manual UI + cron (required)
//
// Optional env vars:
//   RESEND_API_KEY       — if set, the cron run emails the report
//   OWNER_EMAIL          — recipient address (defaults to janvanwaveren@gmail.com)

import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60; // seconds — Claude + web search can take ~30-50s

const SYSTEM_PROMPT = `You are a vacation-rental pricing analyst helping the owner of **De Putter**, a forest cabin in the Vechtdal region of the Netherlands. Your job is to help the owner stay competitively priced.

# Property

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

Most comparable cabins on Natuurhuisje / Booking.com / Airbnb charge the guest **separately** for:
- Bed linen: typically €7–10/person (~€30 for 4 guests)
- Towels: typically €5/person (~€20 for 4 guests)
- Firewood: typically €10–25/stay
- Tourist tax (toeristenbelasting): Ommen ~€1.50/person/night (~€24 for 4 people × 4 nights)

**De Putter INCLUDES all of these at no extra cost.** On a typical 4-night stay, this means De Putter's advertised rate is effectively **€70–100 cheaper** than a competitor at the same nightly price.

**When you compare competitor rates, you MUST account for this.** A competitor listing €100/night with standard extras has an effective total that's ~€25/night higher than De Putter at €100. In your \`marketMedian\` calculation and pricing suggestions, compare against **effective total cost per night** — not just advertised nightly rate. If a competitor shows €100/night but typically adds ~€25/night in extras, treat them as €125 effective for comparison purposes.

If a competitor explicitly advertises "alles inbegrepen" or "no extra fees" (rare), note that in the competitor entry and do NOT apply the adjustment for them.

# Your task

Use the \`web_search\` tool to find **5 to 8 comparable vacation rentals** to De Putter. Prioritise listings in the Ommen / Vechtdal / eastern Overijssel / Drenthe border area that match as many of these criteria as possible:

- Sleeps 3–5 people
- Rural, forest, or nature-adjacent setting
- 2 bedrooms or open floor plan equivalent
- Similar platforms: **Natuurhuisje.nl** (highest priority — the owner's main channel), Booking.com, Airbnb, Vrbo, Belvilla, Nature.house

For each competitor, extract:
- Name & direct URL
- Platform
- Capacity
- Specific location (village/area)
- **Nightly rate for a representative high-season week (e.g. mid-July 2026)** — if listed as weekly, divide by 7
- Key amenities worth comparing (wood stove, garden, hot tub, etc.)
- How comparable it really is (high / medium / low)

Then analyse the data and return **one JSON object** inside a \`\`\`json code block. No prose outside the code block. The JSON must follow this exact shape:

\`\`\`json
{
  "analysisDate": "YYYY-MM-DD",
  "marketSummary": "1–2 paragraph plain-Dutch overview of what you found and how De Putter compares.",
  "competitors": [
    {
      "name": "...",
      "url": "https://...",
      "platform": "natuurhuisje | airbnb | booking | belvilla | natuurhuisje | vrbo | other",
      "location": "...",
      "capacity": 4,
      "bedrooms": 2,
      "highSeasonNightlyEUR": 120,
      "priceNotes": "e.g. '€840/week in July, divided by 7'",
      "amenities": ["houtkachel", "tuin"],
      "comparability": "high | medium | low",
      "whyComparable": "one sentence"
    }
  ],
  "pricingSuggestions": [
    {
      "season": "summer | low-winter | spring | autumn | holidays | weekend-surcharge | cleaning-fee | general",
      "currentRate": 135,
      "suggestedRate": 125,
      "direction": "increase | decrease | hold",
      "confidence": "high | medium | low",
      "reason": "Specific, concrete — reference competitors by name if relevant."
    }
  ],
  "overallRecommendation": "One-sentence actionable takeaway for this week."
}
\`\`\`

Be specific. Use real listing URLs. If you can't find strong comparables for a particular season, note it in \`marketSummary\` and set \`confidence: "low"\` on relevant suggestions. Prefer conservative (±10%) adjustments over aggressive ones unless the data clearly justifies more.`;

export default async function handler(req, res) {
  // --- Auth ---
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SECRET env var not configured' });
  }

  const providedSecret = req.query.secret || '';
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isCron = bearerToken === ADMIN_SECRET;
  const isAdminUI = providedSecret === ADMIN_SECRET;

  if (!isCron && !isAdminUI) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // --- API key ---
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY env var not configured. Set it in Vercel project settings.'
    });
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 8,
          user_location: {
            type: 'approximate',
            country: 'NL',
            region: 'Overijssel',
            city: 'Ommen'
          }
        }
      ],
      messages: [
        {
          role: 'user',
          content: `Run the weekly competitive pricing analysis for today (${new Date().toISOString().slice(0, 10)}). Return only the JSON code block, no other prose.`
        }
      ]
    });

    // Extract the final text block (after any thinking/server_tool_use blocks)
    const textBlocks = response.content.filter((b) => b.type === 'text');
    const finalText = textBlocks.map((b) => b.text).join('\n\n');

    // Try to parse JSON out of the response
    let report = null;
    const jsonMatch = finalText.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        report = JSON.parse(jsonMatch[1]);
      } catch (e) {
        // fall through; return raw text as fallback
      }
    }
    if (!report) {
      // try to find a bare JSON object
      const braceMatch = finalText.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { report = JSON.parse(braceMatch[0]); } catch (e) { /* ignore */ }
      }
    }

    const payload = {
      ok: true,
      model: 'claude-opus-4-7',
      generatedAt: new Date().toISOString(),
      trigger: isCron ? 'cron' : 'manual',
      report,
      rawText: report ? undefined : finalText,
      usage: response.usage
    };

    // --- Email on cron runs if configured ---
    if (isCron && process.env.RESEND_API_KEY && report) {
      try {
        await sendEmailReport(report, payload.generatedAt);
        payload.emailed = true;
      } catch (emailErr) {
        payload.emailed = false;
        payload.emailError = String(emailErr.message || emailErr);
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('price-check error:', err);
    return res.status(500).json({
      error: String(err.message || err),
      type: err.constructor?.name
    });
  }
}

/** Minimal Resend email sender — no SDK dependency. */
async function sendEmailReport(report, generatedAt) {
  const to = process.env.OWNER_EMAIL || 'janvanwaveren@gmail.com';
  const html = renderReportHtml(report, generatedAt);

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'De Putter · Admin <admin@boshuisdeputter.nl>',
      to: [to],
      subject: `🌲 Wekelijkse prijsanalyse — ${new Date(generatedAt).toLocaleDateString('nl-NL')}`,
      html
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend ${resp.status}: ${text}`);
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderReportHtml(r, generatedAt) {
  const competitorRows = (r.competitors || []).map(c => `
    <tr>
      <td><a href="${esc(c.url)}">${esc(c.name)}</a></td>
      <td>${esc(c.platform)}</td>
      <td>${esc(c.location)}</td>
      <td>${esc(c.capacity)} pers</td>
      <td><strong>€${esc(c.highSeasonNightlyEUR)}</strong><br><small>${esc(c.priceNotes || '')}</small></td>
      <td>${esc(c.comparability)}</td>
    </tr>
  `).join('');

  const suggestionRows = (r.pricingSuggestions || []).map(s => {
    const arrow = s.direction === 'increase' ? '▲' : s.direction === 'decrease' ? '▼' : '●';
    const color = s.direction === 'increase' ? '#0b6e2f' : s.direction === 'decrease' ? '#c0392b' : '#888';
    return `
    <tr>
      <td><strong>${esc(s.season)}</strong></td>
      <td>€${esc(s.currentRate)}</td>
      <td style="color:${color}">${arrow} €${esc(s.suggestedRate)}</td>
      <td>${esc(s.confidence)}</td>
      <td>${esc(s.reason)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#2d3436">
    <h1 style="color:#2d5016;font-family:Georgia,serif">🌲 Wekelijkse prijsanalyse — De Putter</h1>
    <p style="color:#888;font-size:12px">Gegenereerd: ${new Date(generatedAt).toLocaleString('nl-NL')}</p>

    <h2 style="color:#2d5016">Samenvatting</h2>
    <p>${esc(r.marketSummary)}</p>

    <h2 style="color:#2d5016">Prijsaanbevelingen</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f0f5eb"><th>Seizoen</th><th>Huidig</th><th>Voorgesteld</th><th>Zekerheid</th><th>Reden</th></tr>
      ${suggestionRows}
    </table>

    <h2 style="color:#2d5016">Vergelijkbare huisjes</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f0f5eb"><th>Naam</th><th>Platform</th><th>Locatie</th><th>Pers</th><th>Tarief (hoogseizoen)</th><th>Vergelijkbaar</th></tr>
      ${competitorRows}
    </table>

    <h2 style="color:#2d5016">Aanbeveling</h2>
    <p style="background:#fdf8f0;padding:12px;border-left:3px solid #c9a96e"><strong>${esc(r.overallRecommendation)}</strong></p>
  </body></html>`;
}
