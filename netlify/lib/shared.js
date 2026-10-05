// Helpers shared by the unsubscribe and digest-approve functions. Kept outside
// netlify/functions/ so Netlify does not deploy it as a function of its own;
// the bundler follows the relative require() from each function.

const crypto = require('crypto');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A small self-contained page in the site's colours. These responses can
// carry a token or secret in the URL, so they are never cached, never
// indexed, and send no Referer when a link on them is followed.
function htmlPage(statusCode, title, bodyHtml) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — The Pelham Engagement Project</title></head>
<body style="font-family:'IBM Plex Sans',system-ui,sans-serif;background:#f7f3ec;color:#1a2744;margin:0;padding:64px 24px;text-align:center;line-height:1.55;">
<div style="max-width:560px;margin:0 auto;">
${bodyHtml}
</div>
</body></html>`;
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    },
    body: html,
  };
}

const message = (text) => `<p style="font-size:18px;margin:0 0 24px;">${text}</p>`;
const button = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#c8973a;color:#1a2744;padding:12px 24px;font-weight:600;text-decoration:none;margin:4px;">${esc(label)}</a>`;
const secondary = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;color:#1a2744;padding:12px 16px;font-weight:600;margin:4px;">${esc(label)}</a>`;
// The state-changing step is always a POST from a button on a page a person
// is looking at. A GET only ever shows that page: email security scanners
// open every link in a message, and a GET that changed something would let
// them unsubscribe readers or approve a digest no one has read.
const postButton = (action, label, hidden = {}) =>
  `<form method="post" action="${esc(action)}" style="margin:0 0 16px;">`
  + Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  + `<button type="submit" style="background:#c8973a;color:#1a2744;border:none;padding:12px 24px;font:inherit;font-weight:600;cursor:pointer;">${esc(label)}</button></form>`;

// Query string plus, for a POST, a urlencoded form body (Netlify may base64
// it). Body values win over the query string.
function readParams(event) {
  const params = { ...(event.queryStringParameters || {}) };
  if (event.httpMethod === 'POST' && event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  }
  return params;
}

// Constant-time comparison; hashing first makes the lengths equal, which
// timingSafeEqual requires.
function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

function normalizeSupabaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return trimmed.replace(/\/rest\/v\d+$/, '');
}

// Service-role client: these functions update rows, which the public anon
// key deliberately cannot. SUPABASE_SERVICE_KEY must never reach a browser;
// it is read here, server side, and nowhere else on the site.
function serviceClient() {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (err) {
    console.warn('[supabase] could not build service client:', String(err));
    return null;
  }
}

module.exports = {
  esc, UUID_RE, htmlPage, message, button, secondary, postButton,
  readParams, secretMatches, serviceClient,
};
