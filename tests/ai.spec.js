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

// Regression guard for stale roster facts in SYSTEM_PROMPT. The prompt listed
// "Receiver of Taxes: Erica Winter" for weeks after she resigned, and nothing
// here noticed. Note the negative is deliberately NOT `not.toContain('Erica
// Winter')` — a correct answer names her as the person who stepped down. What
// must never happen is her being offered as the sitting officeholder.
test('receiver of taxes — reported vacant, with Paolericio acting', async ({ request }) => {
  const answer = await ask(request, 'who is the receiver of taxes in pelham?');

  expect(
    answer,
    'expected the acting receiver or an explicit vacancy, got: ' + answer.slice(0, 200),
  ).toMatch(/Paolericio|vacan|transition/i);

  if (/Erica Winter/i.test(answer)) {
    expect(
      answer,
      'named Erica Winter without noting she left — reads as if she still holds the office',
    ).toMatch(/resign|stepped down|former|no longer/i);
  }
});

// Body-attribution guard, and a cautionary tale. The Amtrak Forest Road project
// was raised at the VILLAGE OF PELHAM MANOR board on August 17 2026. It first
// arrived in a batch of Town Council facts and was filed under the Town; that
// was caught and "corrected" to the Village of Pelham (540122e) — still wrong,
// and fixed properly only when the Manor meeting itself was added.
//
// Pelham has three village/town boards with genuinely different remits and
// different contact details, so an answer naming the wrong one sends a resident
// to the wrong clerk. Asserting /Village/i is NOT enough here: "Village of
// Pelham" and "Village of Pelham Manor" both satisfy it, which is exactly why
// the earlier misattribution passed this test for two commits. Require Manor.
test('Amtrak on Forest Road — attributed to Pelham Manor, not the Village of Pelham or the Town', async ({ request }) => {
  const answer = await ask(request, 'who is handling the Amtrak construction concerns on Forest Road?');

  expect(
    answer,
    'expected Pelham Manor named as the responsible body, got: ' + answer.slice(0, 300),
  ).toMatch(/Manor/i);

  // Deliberately not a bare `not.toContain`: a good answer may name the other
  // boards precisely to rule them out. What must never happen is one of them
  // being described as handling the project.
  expect(
    answer,
    'attributed the Forest Road project to the Town — it is a Pelham Manor matter',
  ).not.toMatch(
    /(Town Council|Town of Pelham|Town Board)\s+(is|are|was|were|has|have|will)?\s*(currently\s+)?(handling|addressing|leading|overseeing|managing|responsible for|in charge of)/i,
  );
  // "Village of Pelham" without "Manor" is the specific mistake made twice.
  expect(
    answer,
    'attributed the project to the Village of Pelham board rather than Pelham Manor',
  ).not.toMatch(
    /Village of Pelham(?! Manor)\s+(Board|board|Board of Trustees)\s+(is|are|was|has|will)?\s*(currently\s+)?(handling|addressing|leading|overseeing|managing|responsible for|in charge of)/i,
  );
});
