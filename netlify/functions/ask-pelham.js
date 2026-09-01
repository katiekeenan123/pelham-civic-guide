// Netlify serverless function: proxies the browser's chat request to the
// Anthropic API so the API key stays server-side.
//
// The browser POSTs { system, messages } to /api/ask (rewritten to this
// function by netlify.toml). This function adds the model, max_tokens, and
// the ANTHROPIC_API_KEY environment variable, then returns Anthropic's
// JSON response unchanged so the front-end can read data.content[0].text.
//
// Set ANTHROPIC_API_KEY in: Netlify site → Site configuration →
// Environment variables. It must NOT be committed to the repo.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';   // civic Q&A; change here if you want a different model
const MAX_TOKENS = 1000;
const MAX_MESSAGES = 40;             // simple abuse guard on conversation length

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server is missing ANTHROPIC_API_KEY' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { system, messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'messages must be a non-empty array' });
  }
  if (messages.length > MAX_MESSAGES) {
    return json(400, { error: 'Conversation too long' });
  }

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: typeof system === 'string' ? system : undefined,
        messages,
      }),
    });

    const data = await upstream.json();
    // Pass Anthropic's status and payload straight through.
    return json(upstream.status, data);
  } catch (err) {
    return json(502, { error: 'Upstream request failed', detail: String(err) });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
