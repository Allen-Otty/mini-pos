// POST /api/scan-invoice  { image: <base64 jpeg>, mime }  ->  { invoice: {...} }
// Reads a supplier invoice / delivery note / receipt photo with Claude (vision). Needs ANTHROPIC_API_KEY.
// If the key is missing the endpoint answers 503 and the app quietly falls back to on-device OCR.
const MODEL = process.env.INVOICE_SCAN_MODEL || 'claude-sonnet-5-5';
const MAX_B64 = 10 * 1024 * 1024;           // ~7.5 MB image
const hits = new Map();                      // user id -> [timestamps]  (simple per-user limit)
const LIMIT = Number(process.env.INVOICE_SCAN_PER_HOUR || 40);

const SYSTEM = 'You read photos of supplier invoices, delivery notes and till receipts for a shop in Kenya. ' +
  'Reply with ONE JSON object and nothing else (no markdown). Never invent values: use "" or null when something is not visible.';

const PROMPT = `Extract this document as JSON with exactly this shape:
{"supplier":{"name":"","phone":"","pin":""},"invoice_no":"","date":"YYYY-MM-DD","due_date":"YYYY-MM-DD or empty",
"items":[{"description":"","qty":0,"unit_cost":0,"total":0}],"subtotal":null,"vat":null,"total":null,"paid":null}
Rules: dates are day-first (13/10/2026 = 2026-10-13). Numbers are plain numbers (no currency, no thousands commas).
unit_cost is the unit price exactly as printed (do not add or remove VAT). total is the line amount as printed.
"paid" is true if the document shows payment received (cash, M-Pesa, change given), false if it is an invoice on credit terms, null if unclear.
Include every product line, not totals, tax summaries or notes.`;

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}

export async function scanInvoiceHandler(req, res) {
  try {
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) return res.status(503).json({ success: false, error: 'AI reading is not configured on this server.' });

    const uid = (req.admin && req.admin.id) || 'anon';
    const now = Date.now(), recent = (hits.get(uid) || []).filter(t => now - t < 3600e3);
    if (recent.length >= LIMIT) return res.status(429).json({ success: false, error: 'Scan limit reached for this hour.' });
    recent.push(now); hits.set(uid, recent);

    const image = req.body && req.body.image;
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(req.body && req.body.mime) ? req.body.mime : 'image/jpeg';
    if (typeof image !== 'string' || !image || image.length > MAX_B64) return res.status(400).json({ success: false, error: 'Send a base64 image under 7 MB.' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2500, system: SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
          { type: 'text', text: PROMPT }
        ] }]
      })
    });
    if (!r.ok) {
      console.error('[scan-invoice] Anthropic API error', r.status);
      return res.status(502).json({ success: false, error: 'The AI service could not read this image.' });
    }
    const out = await r.json();
    const text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return res.json({ success: true, invoice: parseJson(text) });
  } catch (e) {
    console.error('[scan-invoice]', e && e.message);
    return res.status(500).json({ success: false, error: 'Could not read the invoice.' });
  }
}
