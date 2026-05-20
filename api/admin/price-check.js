// Weekly competitive pricing analysis for De Putter.
//
// Single Claude call — uses market knowledge to analyze pricing.
// Completes in ~15s, well within Vercel Hobby's 60s limit.
//
// Triggered two ways:
//   1. Manual: GET /api/admin/price-check?secret=<ADMIN_SECRET>  (admin UI)
//   2. Cron:   weekly, Vercel sends Authorization: Bearer <CRON_SECRET>

import Anthropic from '@anthropic-ai/sdk';
import { authCheck, PROPERTY_CONTEXT } from './_pricing-shared.js';
import { savePriceReport, listPriceReports } from '../_lib/store.js';

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a vacation-rental pricing analyst helping the owner of **De Putter**, a forest cabin in the Vechtdal region of the Netherlands.

${PROPERTY_CONTEXT}

When comparing competitor rates, you MUST account for the all-inclusive difference. A competitor listing €100/night with standard extras has an effective total ~€25/night higher than De Putter at €100. Compare against effective total cost per night, not advertised rate.

Prefer conservative (±10%) adjustments unless the data clearly justifies more.

# Known competitors and market context

Use your knowledge of the vacation rental market in Ommen, Vechtdal, and eastern Overijssel. Reference real platforms (Natuurhuisje, Booking.com, Airbnb, Belvilla) and typical properties in the area. Consider:
- Cabins/boshuisjes for 2–6 persons near Ommen, Lemele, Vilsteren, Dalfsen, Hellendoorn
- Typical nightly rates for forest cabins on Natuurhuisje in Overijssel
- Seasonal pricing patterns in the Dutch vacation rental market
- The effect of amenities like hot tubs, saunas, etc. on pricing
- Recent market trends (post-pandemic domestic tourism, energy costs)`;

export default async function handler(req, res) {
  const auth = authCheck(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  // History mode: return saved reports
  if (req.query.history !== undefined) {
    try {
      const reports = await listPriceReports({ limit: 20 });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, reports });
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var not configured.' });
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const today = new Date().toISOString().slice(0, 10);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Run the competitive pricing analysis for today (${today}).

Based on your knowledge of the Ommen/Vechtdal vacation rental market, identify 4–6 comparable properties and analyse how De Putter's pricing compares.

Return ONLY a JSON code block:

\`\`\`json
{
  "analysisDate": "${today}",
  "marketSummary": "1–2 paragraph plain-Dutch overview of De Putter's market position.",
  "competitors": [
    {
      "name": "Descriptive name",
      "platform": "natuurhuisje | airbnb | booking | belvilla | other",
      "location": "village/area",
      "capacity": 4,
      "bedrooms": 2,
      "highSeasonNightlyEUR": 120,
      "priceNotes": "basis for the price estimate",
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
      "reason": "Specific reasoning."
    }
  ],
  "overallRecommendation": "One-sentence actionable takeaway."
}
\`\`\``
        }
      ]
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const finalText = textBlocks.map((b) => b.text).join('\n\n');
    const report = parseJson(finalText);

    const generatedAt = new Date().toISOString();

    // Save to history
    if (report) {
      try { await savePriceReport(report, generatedAt); } catch (e) {
        console.error('Failed to save price report:', e);
      }
    }

    const payload = {
      ok: true,
      model: 'claude-sonnet-4-6',
      generatedAt,
      trigger: auth.isCron ? 'cron' : 'manual',
      report,
      rawText: report ? undefined : finalText,
      usage: response.usage
    };

    if (auth.isCron && process.env.RESEND_API_KEY && report) {
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
    return res.status(500).json({ error: String(err.message || err), type: err.constructor?.name });
  }
}

function parseJson(text) {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* fall through */ }
  }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* ignore */ }
  }
  return null;
}

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
      <td>${esc(c.name)}</td>
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

    <h2 style="color:#2d5016">Vergelijkbare huisjes (marktkennis)</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f0f5eb"><th>Naam</th><th>Platform</th><th>Locatie</th><th>Pers</th><th>Tarief (hoogseizoen)</th><th>Vergelijkbaar</th></tr>
      ${competitorRows}
    </table>

    <h2 style="color:#2d5016">Aanbeveling</h2>
    <p style="background:#fdf8f0;padding:12px;border-left:3px solid #c9a96e"><strong>${esc(r.overallRecommendation)}</strong></p>

    <p style="color:#999;font-size:11px;margin-top:24px">Gebaseerd op AI-marktkennis, niet op live prijzen. Controleer actuele tarieven op de platforms zelf.</p>
  </body></html>`;
}
