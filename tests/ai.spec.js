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
    // Tells the function not to write this synthetic question to qa_log.
    headers: { 'X-Test-Request': 'true' },
    timeout: 90_000,
  });
  expect(res.ok(), `POST ${ENDPOINT} -> HTTP ${res.status()}`).toBeTruthy();

  const body = await res.json();
  expect(typeof body.answer, 'response JSON should carry an "answer" string').toBe('string');
  expect(body.answer.trim().length, 'answer should not be empty').toBeGreaterThan(0);
  // The model's citation line is for the function to read, never the reader.
  expect(body.answer, 'the USED_SOURCES line must be stripped').not.toMatch(/USED_SOURCES/i);
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
  // "Smithweyer" was the page's own misspelling, corrected to Smithmeyer in
  // 38d8858; the assertion outlived it and could only ever pass via "php".
  expect(answer).toMatch(/smithmeyer|php partners/i);
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

// Routing guard from the quick-reference card. In the Village of Pelham the
// Building Department issues building permits, not the Village Clerk: they
// share 200 Fifth Avenue but not a phone line, and the Clerk's 231-3320 was
// the number first proposed for this answer.
test('building permit — Village of Pelham goes to the Building Department, not the Clerk', async ({ request }) => {
  const answer = await ask(request, 'I live in the Village of Pelham. Who do I call about a building permit?');

  expect(
    answer,
    'expected the Building Department and its number, got: ' + answer.slice(0, 300),
  ).toMatch(/738-2258/);
  expect(answer, 'gave the Village Clerk\'s number for a building permit').not.toMatch(/231-3320/);
});

test('building permit — Pelham Manor goes to Village Hall at 4 Penfield Place', async ({ request }) => {
  const answer = await ask(request, 'how do I get a building permit in Pelham Manor?');

  expect(
    answer,
    'expected the Manor Village Hall number, got: ' + answer.slice(0, 300),
  ).toMatch(/738-8820/);
});

/* ── Source citations ──────────────────────────────────────────────────── */
// Sources are listed only for articles the model says it drew on. Before this,
// every retrieved article was appended, so an answer saying it had no
// information still cited candidate statements.

test('sources — the Community Church question never cites unrelated campaign statements', async ({ request }) => {
  // No Examiner coverage of the church sale is in the articles table; this
  // used to cite Kristen Burke's campaign statement via the EMS station tag.
  // Since site pages became citable, the answer may draw on the EMS issue
  // card (which mentions the April 2026 listing) and cite that card, which is
  // correct. What must never appear is an article that was not its source.
  const answer = await ask(request, 'What is the latest on the Community Church sale?');
  expect(answer).not.toMatch(/campaign statement/i);
  const sources = answer.split(/^Sources:\n/m)[1] || '';
  for (const line of sources.split('\n').filter((l) => l.startsWith('•'))) {
    expect(line, 'only this site may be cited here').toContain('pelhamengagementproject.org/');
  }
});

test('sources — bulk trash pickup gets no Sources block', async ({ request }) => {
  // "VOP" used to title-match a Neighborhood Party press release.
  const answer = await ask(request, 'What date is bulk trash pick up in VOP?');
  expect(answer).not.toMatch(/^Sources:/m);
  expect(answer).not.toMatch(/Village debt is about to increase/i);
});

test('sources — a question the coverage does answer still cites it', async ({ request }) => {
  // Guards the other direction: if the model stopped writing its citation
  // line, every Sources block would silently disappear.
  const answer = await ask(request, "What did Kristen Burke say in her campaign statement about why she's running for Village trustee?");
  expect(answer).toMatch(/^Sources:/m);
  expect(answer).toMatch(/pelhamexaminer\.com\/\d+/);
});

test('sanitation — bulk pickup question gets the Village of Pelham schedule', async ({ request }) => {
  const answer = await ask(request, 'When is bulk trash pickup in the Village of Pelham?');
  expect(answer).toMatch(/area a|area b|october 19|october 20|november 2|twice a month/i);
});

test('tax cap — answer separates sides and cites the issue card first', async ({ request }) => {
  const answer = await ask(request, 'Why did the Village of Pelham override the tax cap?');
  expect(answer).toMatch(/10\.1%|\$20\.5/);
  // The card is pinned as the first source for a contested issue.
  const sources = answer.split(/^Sources:\n/m)[1] || '';
  expect(sources.split('\n')[0]).toContain('pelhamengagementproject.org/issues#rising-property-taxes-village-debt');
  expect(answer).not.toMatch(/"might"/);
});

test('sanitation — Pelham Manor answer ends with the Manor refuse page', async ({ request }) => {
  const answer = await ask(request, 'When is bulk trash pickup in Pelham Manor?');
  expect(answer).toMatch(/pelhammanor\.gov\/242\/Refuse-Recycling/i);
});

test('sanitation — with no village named, it asks which village', async ({ request }) => {
  const answer = await ask(request, 'When is garbage pickup?');
  expect(answer).toMatch(/which village|village of pelham or (the village of )?pelham manor|pelham or pelham manor/i);
});

test('schools — AI and screen time are answered from the September 23 Board of Ed summary', async ({ request }) => {
  const answer = await ask(request, 'Do Pelham elementary schools use AI? How much screen time do kids get?');
  expect(answer).toMatch(/15 minutes/);
  expect(answer).not.toMatch(/don't have (that|this|any) information/i);
});

test('voting — "what should I know" cites this site\'s pages', async ({ request }) => {
  const answer = await ask(request, 'What should I know before voting on November 3?');
  const sources = answer.split(/^Sources:\n/m)[1] || '';
  expect(sources).toContain('pelhamengagementproject.org/elections');
});

test('public comment — Village of Pelham is floor-based, not a sign-in at the door', async ({ request }) => {
  const answer = await ask(request, 'How do I speak during public comment at a Village of Pelham board meeting?');
  expect(answer).toMatch(/raise your hand|stand/i);
  // Saying "no sign-in required" is right; telling the reader to sign in is
  // the error. Any line about signing in must be a denial.
  for (const line of answer.split('\n').filter((l) => /sign[- ]?(in|up)/i.test(l))) {
    expect(line, 'mentions of signing in must be denials').toMatch(/\b(no|not|don't|do not|never|without)\b/i);
  }
});

