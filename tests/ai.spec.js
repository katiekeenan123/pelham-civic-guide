// AI tests for the Pelham Civic Guide — exercise the live `/api/ask` endpoint,
// which the Netlify function forwards to Anthropic with the civic system prompt.
//
// Contract (see netlify/functions/ask-pelham.js):
//   POST /api/ask   body: { messages: [{ role: 'user', content: '...' }] }
//   200 -> { answer: "<text>" }
//
// These call a real LLM, so responses vary run-to-run. Assertions check for
// load-bearing facts / omissions, not exact wording.

const { test, expect } = require('@playwright/test');

const ENDPOINT = '/api/ask';

/** POST a single user question to the live endpoint and return the answer text. */
async function ask(request, question) {
  const res = await request.post(ENDPOINT, {
    data: { messages: [{ role: 'user', content: question }] },
    timeout: 90_000,
  });
  expect(res.ok(), `POST ${ENDPOINT} -> HTTP ${res.status()}`).toBeTruthy();

  const body = await res.json();
  expect(typeof body.answer, 'response JSON should carry an "answer" string').toBe('string');
  expect(body.answer.trim().length, 'answer should not be empty').toBeGreaterThan(0);
  return body.answer;
}

test.describe.configure({ mode: 'parallel' });

test('connectivity — the AI endpoint returns a response', async ({ request }) => {
  const answer = await ask(request, 'What does the Village of Pelham government do?');
  expect(answer.length).toBeGreaterThan(20);
});

test('election date — next Village of Pelham election is in November, not March', async ({ request }) => {
  const answer = await ask(request, 'when is the next village of pelham election?');
  expect(answer).toMatch(/november/i);
  expect(answer).not.toMatch(/march/i);
});

test('mayor — names Chance Mullen', async ({ request }) => {
  const answer = await ask(request, 'who is the mayor of pelham?');
  expect(answer).toContain('Chance Mullen');
});

test('scoping — an off-topic pizza question is redirected to civic topics', async ({ request }) => {
  const answer = (await ask(request, 'what is the best pizza recipe?')).toLowerCase();
  expect(answer).not.toContain('mozzarella');
  expect(answer).not.toContain('dough');
  // Should steer back to what it actually covers.
  expect(answer).toMatch(/pelham|civic|local government|election|budget|tax|public meeting|get involved/);
});

test('picture house — summarizes the redevelopment story', async ({ request }) => {
  const answer = await ask(request, 'what happened with the picture house?');
  expect(answer).toMatch(/picture house/i);
  expect(answer).toMatch(/smithweyer|php/i);
});

test('officials — lists the Village of Pelham trustees', async ({ request }) => {
  const answer = await ask(request, 'who are the village of pelham trustees?');
  const names = ['Carpenter', 'Eldahry', 'Howell', 'Anderson', 'Otondi', 'Solomon'];
  const found = names.filter((n) => answer.includes(n));
  expect(
    found.length,
    `expected at least 3 trustee surnames, found: ${found.join(', ') || '(none)'}`,
  ).toBeGreaterThanOrEqual(3);
});
