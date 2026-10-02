// Netlify serverless function: email signup for Pelham civic updates.
//
// The browser POSTs { email, source, website } to /api/subscribe (rewritten
// to this function by netlify.toml). The address is validated, lowercased and
// INSERTed into the Supabase `subscribers` table. Returns { ok: true } or an
// error with a non-2xx status.
//
// Uses the same SUPABASE_URL and SUPABASE_ANON_KEY as ask-pelham.js. The anon
// role can INSERT email and source into `subscribers` and nothing else -- no
// SELECT, no `confirmed` -- see supabase/grants.sql. Because the function
// cannot read the table, duplicates are detected from the unique-constraint
// error on insert rather than by looking the address up first.
//
// An address that is already on the list gets the same { ok: true } as a new
// one. That is the "already subscribed is success" rule, and it also means
// the endpoint cannot be used to test whether someone has signed up.
//
// `website` is a honeypot: a field hidden from people that naive form-filling
// bots fill in. A filled honeypot gets { ok: true } and nothing is stored.

const MAX_EMAIL = 254;
// Deliberately loose: one @, something on each side, a dot in the domain, no
// spaces. Stricter patterns reject real addresses; delivery is the only true
// test, which is what the `confirmed` column is reserved for.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Where the form appears. Anything else is stored as null rather than
// trusting arbitrary text from the client.
const SOURCES = ['home', 'get-involved'];
// Postgres unique_violation.
const UNIQUE_VIOLATION = '23505';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return null;
  return email;
}

// The handler takes its Supabase client from `getClient` so tests can pass a
// stub; the deployed export below wires in the real one.
function createHandler(getClient) {
  return async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' });

    if (typeof body.website === 'string' && body.website.trim()) return json(200, { ok: true });

    const email = normalizeEmail(body.email);
    if (!email) return json(400, { error: 'Please enter a valid email address.' });
    const source = SOURCES.includes(body.source) ? body.source : null;

    const supabase = getClient();
    if (!supabase) {
      return json(500, { error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY' });
    }

    try {
      const { error } = await supabase.from('subscribers').insert({ email, source });
      if (error && error.code !== UNIQUE_VIOLATION) {
        console.warn('[subscribe]', error.message);
        return json(502, { error: 'Could not save your signup' });
      }
    } catch (err) {
      console.warn('[subscribe] insert failed:', String(err));
      return json(502, { error: 'Could not save your signup' });
    }
    return json(200, { ok: true });
  };
}

// Same normalisation and lazy construction as ask-pelham.js, which explains
// both: SUPABASE_URL is often pasted with a trailing /rest/v1, and building
// the client lazily keeps a misconfiguration from crashing the module.
function normalizeSupabaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return trimmed.replace(/\/rest\/v\d+$/, '');
}

function getSupabase() {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (err) {
    console.warn('[supabase] could not build client:', String(err));
    return null;
  }
}

exports.handler = createHandler(getSupabase);
exports.createHandler = createHandler;
exports.normalizeEmail = normalizeEmail;
