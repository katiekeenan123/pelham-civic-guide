// Unit tests for source citation and retrieval routing in
// netlify/functions/ask-pelham.js. No network: these call the pure helpers it
// exports for testing.

const { test, expect } = require('@playwright/test');
const { todayLine, isResultsQuestion, parseUsedSources, withSources, extractSearchTerms, extractProperNouns, buildSearchPlan, dedupeArticles, contestedIssueFor, sitePageLine } =
  require('../netlify/functions/ask-pelham')._test;
const { isAllowedSource } = require('../netlify/functions/allowed-sources');

const ARTICLES = [
  { title: 'First article', url: 'https://pelhamexaminer.com/1/latest-news/first-article/' },
  { title: 'Second article', url: 'https://pelhamexaminer.com/2/latest-news/second-article/' },
  { title: 'Third article', url: 'https://pelhamexaminer.com/3/latest-news/third-article/' },
];

/* ── USED_SOURCES parsing ──────────────────────────────────────────────── */

test('USED_SOURCES — a missing line cites nothing and leaves the answer alone', () => {
  const { text, used } = parseUsedSources('The board meets on Mondays.', 3);
  expect(used).toEqual([]);
  expect(text).toBe('The board meets on Mondays.');
});

test('USED_SOURCES — "none" cites nothing, and the line is removed', () => {
  const { text, used } = parseUsedSources("I don't have that information.\nUSED_SOURCES: none", 3);
  expect(used).toEqual([]);
  expect(text).toBe("I don't have that information.");
});

test('USED_SOURCES — valid indices are kept in order, without repeats', () => {
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 1,3', 3).used).toEqual([1, 3]);
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 3, 1', 3).used).toEqual([3, 1]);
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 2,2,1', 3).used).toEqual([2, 1]);
  // Markdown bold around the label, and a trailing full stop, are tolerated.
  expect(parseUsedSources('Answer.\n**USED_SOURCES:** 2.', 3).used).toEqual([2]);
});

test('USED_SOURCES — out-of-range numbers are dropped, in-range ones kept', () => {
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 2, 7, 0', 3).used).toEqual([2]);
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 4', 3).used).toEqual([]);
  expect(parseUsedSources('Answer.\nUSED_SOURCES: 1', 0).used).toEqual([]);
});

test('USED_SOURCES — anything malformed cites nothing', () => {
  for (const line of ['USED_SOURCES: 1 and 3', 'USED_SOURCES: article 1', 'USED_SOURCES: all',
    'USED_SOURCES: 1;2', 'USED_SOURCES:', 'USED_SOURCES: -1']) {
    const { text, used } = parseUsedSources(`Answer.\n${line}`, 3);
    expect(used, line).toEqual([]);
    expect(text, line).toBe('Answer.');
  }
});

test('USED_SOURCES — with several lines the last counts, and all are removed', () => {
  const { text, used } = parseUsedSources('Answer.\nUSED_SOURCES: 1\nMore.\nUSED_SOURCES: 2', 3);
  expect(used).toEqual([2]);
  expect(text).not.toContain('USED_SOURCES');
});

/* ── withSources ───────────────────────────────────────────────────────── */

test('withSources — an "I don\'t have that" answer gets no Sources block', () => {
  const out = withSources("I don't have that information in my records.\nUSED_SOURCES: none", ARTICLES);
  expect(out).toBe("I don't have that information in my records.");
});

test('withSources — only the articles the model names are listed', () => {
  const out = withSources('The answer.\nUSED_SOURCES: 2', ARTICLES);
  expect(out).toContain('Sources:\n• Second article — https://pelhamexaminer.com/2/latest-news/second-article/');
  expect(out).not.toContain('First article');
  expect(out).not.toContain('Third article');
  expect(out).not.toContain('USED_SOURCES');
});

test('withSources — no line at all means no sources, even with articles retrieved', () => {
  expect(withSources('The answer.', ARTICLES)).toBe('The answer.');
});

test('withSources — the line is stripped even when nothing was retrieved', () => {
  expect(withSources('The answer.\nUSED_SOURCES: 1', [])).toBe('The answer.');
});

test('withSources — Sources still go before the DEEPER_PROMPT line', () => {
  const out = withSources('The answer.\nUSED_SOURCES: 1\nDEEPER_PROMPT: Ask about X', ARTICLES);
  expect(out.indexOf('Sources:')).toBeLessThan(out.indexOf('DEEPER_PROMPT:'));
  expect(out.trim().endsWith('DEEPER_PROMPT: Ask about X')).toBe(true);
});

/* ── Retrieval routing ─────────────────────────────────────────────────── */

// Records the filters a search step would apply, in place of a query builder.
function stepFilters(step) {
  const calls = [];
  const q = {
    eq: (...a) => { calls.push(['eq', ...a]); return q; },
    ilike: (...a) => { calls.push(['ilike', ...a]); return q; },
    contains: (...a) => { calls.push(['contains', ...a]); return q; },
  };
  step.narrow(q);
  return calls;
}
const planFor = (question) => buildSearchPlan(extractSearchTerms(question)).map(stepFilters);

test('retrieval — abbreviations do not trigger a title search', () => {
  expect(extractProperNouns('bulk trash pick up in VOP')).toEqual([]);
  expect(extractProperNouns('Is the DPW, EMS, BOE, POM or TOP involved? And MTA?')).toEqual([]);
  // Real names still count.
  expect(extractProperNouns('What did Smithmeyer say?')).toEqual(['Smithmeyer']);

  const plan = planFor('What date is bulk trash pick up in VOP?');
  expect(plan.flat().some((c) => c[0] === 'ilike')).toBe(false);
  expect(plan).toEqual([]);
});

test('retrieval — "community church" searches titles, not the EMS station tag', () => {
  for (const q of ['What is the latest on Community Church sale?', 'is the community church for sale']) {
    expect(planFor(q), q).toEqual([[['ilike', 'title', '%community church%']]]);
  }
  // EMS questions still route to the EMS station issue.
  expect(planFor('where will the new ambulance station go?')[0]).toEqual([['eq', 'matched_issue', 'EMS station']]);
});

/* ── What the prompt carries ───────────────────────────────────────────── */

test('prompt — sanitation schedules and the Recreation Commission reach the AI', () => {
  const prompt = require('../netlify/functions/system-prompt');
  expect(prompt).toContain('Area A (Pelville, Chester Park): garbage Monday');
  expect(prompt).toContain('Area B: October 20, November 4 and 17, December 8 and 29');
  expect(prompt).toContain('north of Boston Post Road Mondays and Thursdays');
  expect(prompt).toContain('914-738-2015, option 2');
  expect(prompt).toContain('Want to serve on the Recreation Commission?');
  expect(prompt).toContain('Applications due November 6, 2026');
  expect(prompt).not.toMatch(/\bFini\b/);
});

/* ── Duplicate articles ────────────────────────────────────────────────── */

test('dedupe — one Examiner article moved between sections is listed once', () => {
  const rows = [
    { title: 'Statement (moved)', url: 'https://pelhamexaminer.com/84865/candidate-statements/kristen-burkes-campaign-statement/' },
    { title: 'Statement', url: 'https://pelhamexaminer.com/84865/showcase/kristen-burkes-campaign-statement/' },
    { title: 'Other', url: 'https://pelhamexaminer.com/84905/announcing/vop-trustee-candidates/' },
    { title: 'No id', url: 'https://townofpelhamny.gov/news/' },
    { title: 'No id again', url: 'https://townofpelhamny.gov/news' },
  ];
  expect(dedupeArticles(rows).map((r) => r.title)).toEqual(['Statement (moved)', 'Other', 'No id']);
});

/* ── Prompt guidance added October 8 ───────────────────────────────────── */

test('prompt — site pages, sanitation links, the tax cap question and assessments', () => {
  const prompt = require('../netlify/functions/system-prompt');
  for (const s of ['pelhamengagementproject.org/gov-101', 'pelhamengagementproject.org/taxes',
    'pelhamengagementproject.org/issues', 'pelhamengagementproject.org/meetings',
    'pelhamny.gov/164/Sanitation-Schedule-Information', 'pelhammanor.gov/242/Refuse-Recycling',
    'ask which village before', 'pelhamengagementproject.org/issues#rising-property-taxes-village-debt']) {
    expect(prompt, s).toContain(s);
  }
  // Verified figures come from facts.json, resolved, never as raw tokens.
  expect(prompt).toContain('the tax cap override (Local Law No. 1 of 2026) passed 5-0');
  expect(prompt).toContain('AA+ (stable outlook)');
  expect(prompt).toContain('designation of "No Designation"');
  // Claims sit under their attributions.
  const np = prompt.indexOf('Claims by Anzilotti, Long and Speros, who are running together');
  const inc = prompt.indexOf('Claims by the incumbent trustees');
  expect(np).toBeGreaterThan(-1);
  // Search from the section headings: both phrases also appear earlier, in the
  // issue card and candidate profiles.
  expect(prompt.indexOf('$780,000', np)).toBeLessThan(inc);
  expect(prompt.indexOf('No bond has been authorized', inc)).toBeGreaterThan(inc);
});

/* ── Site pages as sources; contested issues ───────────────────────────── */

test('USED_SOURCES — site pages and anchors are citable alongside article numbers', () => {
  const r = parseUsedSources('A.\nUSED_SOURCES: elections, issues#rising-property-taxes-village-debt, 2', 3);
  expect(r.used).toEqual([2]);
  expect(r.pages).toEqual(['elections', 'issues#rising-property-taxes-village-debt']);
  // An anchor that does not exist on a real page falls back to the page.
  expect(parseUsedSources('A.\nUSED_SOURCES: meetings#no-such-meeting', 0).pages).toEqual(['meetings']);
  // Unknown words still make the line malformed: nothing is cited.
  expect(parseUsedSources('A.\nUSED_SOURCES: elections, wikipedia', 0)).toMatchObject({ used: [], pages: [] });
});

test('withSources — voting answers cite site pages, not articles that were not the source', () => {
  const out = withSources('Here is what to know.\nUSED_SOURCES: elections, issues', ARTICLES);
  expect(out).toContain('Sources:\n• Pelham Engagement Project — 2026 Elections — https://pelhamengagementproject.org/elections');
  expect(out).toContain('https://pelhamengagementproject.org/issues');
  expect(out).not.toContain('pelhamexaminer.com');
});

test('withSources — a pinned issue card comes first, and makes the bare page redundant', () => {
  const out = withSources('Answer.\nUSED_SOURCES: issues, 1', ARTICLES, ['issues#rising-property-taxes-village-debt']);
  const lines = out.split('Sources:\n')[1].split('\n');
  expect(lines[0]).toBe(sitePageLine('issues#rising-property-taxes-village-debt'));
  expect(lines[0]).toContain('https://pelhamengagementproject.org/issues#rising-property-taxes-village-debt');
  expect(out).not.toMatch(/— https:\/\/pelhamengagementproject\.org\/issues$/m);
  expect(lines[1]).toBe('• First article — https://pelhamexaminer.com/1/latest-news/first-article/');
  // Pinned even when the model cites nothing.
  expect(withSources('Answer.\nUSED_SOURCES: none', ARTICLES, ['issues#rising-property-taxes-village-debt'])).toContain('Sources:');
});

test('contested — tax cap and debt questions use the issue card, with both sides', () => {
  for (const q of ['Why did the Village of Pelham override the tax cap?', 'How much debt does the Village of Pelham have?', 'What is the contingency fund?']) {
    const c = contestedIssueFor(q);
    expect(c, q).not.toBeNull();
    expect(c.anchor).toBe('issues#rising-property-taxes-village-debt');
    const urls = c.sources.map((x) => x.url).join(' ');
    // Only vetted sources: the challengers' statement (/announcing/) and the
    // incumbents' response (a letter) stay on the card but are not given to
    // the model.
    expect(c.sources.length, q).toBeGreaterThan(0);
    for (const x of c.sources) expect(isAllowedSource(x.url), x.url).toBe(true);
    expect(urls).not.toContain('pelhamexaminer.com/84905/');
    expect(urls).not.toContain('pelhamexaminer.com/84941/');
  }
  // Flood plan questions get the debt card, where both sides' flood claims are.
  expect(contestedIssueFor("What is the Neighborhood Party's position on flood mitigation?").anchor).toBe('issues#rising-property-taxes-village-debt');
  // Not contested: assessments and the school bond.
  expect(contestedIssueFor('How do I dispute my property tax assessment?')).toBeNull();
  expect(contestedIssueFor('What did the school bond vote decide?')).toBeNull();
});

test('prompt — latest meeting per board, floor-based public comment, citing and drafting rules', () => {
  const prompt = require('../netlify/functions/system-prompt');
  // Board of Education, October 21 finance work session: the latest school
  // board summary is in the prompt in full. Earlier meetings stay citable.
  expect(prompt).toContain('(cite as meetings#board-of-ed-oct21-2026)');
  expect(prompt).toContain('(cite as meetings#board-of-ed-oct2026)');
  expect(prompt).toContain('very, very lean');
  expect(prompt).toMatch(/Universal Pre-K is coming/);
  // Every board's latest summary is there.
  for (const id of ['pelham-board-oct27-2026', 'manor-board-oct26-2026', 'town-council-oct2026', 'board-of-ed-oct21-2026']) {
    expect(prompt, id).toContain(`### `);
    expect(prompt, id).toContain(`(cite as meetings#${id})`);
  }
  // Public comment: floor-based everywhere, never "sign in at the door".
  expect(prompt).not.toMatch(/sign in at the door before/i);
  expect(prompt).toContain('Nobody signs in at the door');
  // Citing and drafting.
  expect(prompt).toContain('## Citing your sources');
  expect(prompt).toContain('(cite as issues#rising-property-taxes-village-debt)');
  // The template wraps lines, so compare against whitespace-normalized text.
  const flat = prompt.replace(/\s+/g, ' ');
  expect(flat).toContain("put that issue card's vetted source URLs");
  expect(flat).toContain('the timestamp would strengthen your comment significantly');
  expect(prompt).not.toMatch(/&ldquo;might&rdquo;|"might" receive/);
  expect(prompt).toContain('in anticipation of future revenue the Village expected to receive');
});

test('prompt — library governance, the corrections URL and meeting coverage scope', () => {
  const prompt = require('../netlify/functions/system-prompt');
  const flat = prompt.replace(/\s+/g, ' ');
  expect(flat).toContain('The Town of Pelham appoints the Pelham Public Library Board of Trustees and funds the library. The Board of Trustees manages library operations independently.');
  expect(flat).not.toMatch(/Pelham Public Library \(Town-run\)|The library, recreation programs, and senior services are also Town-run/);
  expect(flat).toContain('pelhamengagementproject.org/about — scroll to the forms at the bottom of the page');
  expect(flat).toContain('Never say "if there\'s a contact form"');
  expect(flat).toContain('This site launched in fall 2026 and summarizes meetings going forward from mid-2026.');
});

/* ── Vetted sources in the prompt (November 2) ──────────────────────────── */

test('prompt — every URL is on the allowlist, and the neutrality rules are there', () => {
  const prompt = require('../netlify/functions/system-prompt');
  const urls = prompt.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) expect(isAllowedSource(u.replace(/[.,;:!?]+$/, '')), u).toBe(true);
  expect(prompt).not.toMatch(/\/(showcase|announcing|letters-to-the-editor|opinion)\//);
  expect(prompt).not.toMatch(/vimeo\.com|youtube\.com|swagit|civicclerk/i);
  const flat = prompt.replace(/\s+/g, ' ');
  expect(prompt).toContain('## Vetted sources and neutrality');
  expect(flat).toContain('Never name private residents');
  expect(flat).toContain('Never use national party labels');
  expect(flat).toContain('No public response is included in our sources');
  expect(flat).toContain('Never tell anyone how to vote');
  expect(flat).toContain('flagged "verify at [official site]"');
  // Party is given only under "Ballot lines", and incumbency is explicit.
  expect(prompt).toContain('Ballot lines (as reported). Use these only when a resident asks');
  expect(prompt).not.toContain('Russell Solomon (Democratic Party)');
  expect(prompt).toMatch(/Not incumbents in this race: [^.]*Kristen Burke/);
  // Private residents named in the coverage are not in the prompt.
  for (const name of ['Argento', 'Courtien', 'Rowe']) expect(prompt, name).not.toContain(name);
});

test('build — blocked-at-build.txt lists the URLs kept out of the prompt', () => {
  const fs = require('fs');
  const path = require('path');
  const txt = fs.readFileSync(path.join(__dirname, '..', 'blocked-at-build.txt'), 'utf8');
  const rows = txt.split('\n').filter((l) => l && !l.startsWith('#'));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const [url, where] = row.split('\t');
    expect(isAllowedSource(url), url).toBe(false);
    expect(where, url).toBeTruthy();
  }
});

test('prompt — budget structure only as the site states it; the 40% is reported, not verified', () => {
  const prompt = require('../netlify/functions/system-prompt');
  const flat = prompt.replace(/\s+/g, ' ');
  expect(flat).toContain("Never describe how a government's budget is structured");
  expect(flat).toContain('Attribute a claim only to the people your sources name for it; never add or substitute a speaker.');
  expect(flat).toContain('Village of Pelham FY2026–27 Budget: $20.5M general fund — no separate capital budget; capital items funded within the general fund');
  expect(flat).toContain('$21.9M total = $19.4M operating + about $2.5M capital');
  expect(flat).not.toMatch(/Derived: \$21\.9M/);
  expect(flat).toContain('Debt service is reported to have risen about 40%');
  expect(flat).not.toMatch(/Debt service rose 40%/);
  expect(flat).toContain('Never present either list as "the board\'s reasons"');
  expect(flat).toMatch(/debt service increase, FY2026-27: about 40% \[reported\]/);
});

/* ── Post-election (November 4) ─────────────────────────────────────────── */

test('todayLine — the date in New York, whatever the server clock zone', () => {
  // 03:30 UTC on November 4 is still November 3 in New York.
  expect(todayLine(new Date('2026-11-04T03:30:00Z'))).toBe("Today's date is Tuesday, November 3, 2026 (New York time).");
  expect(todayLine(new Date('2026-11-04T15:00:00Z'))).toBe("Today's date is Wednesday, November 4, 2026 (New York time).");
});

test('prompt — the election is over: no results, no logistics, attributed ballot-problem accounts', () => {
  const prompt = require('../netlify/functions/system-prompt');
  const flat = prompt.replace(/\s+/g, ' ');
  expect(prompt).toContain('### The November 3, 2026 election: results');
  // Preliminary totals only from the card: attributed, a snapshot, no winner
  // language, no projection, no link to the ballot problem.
  expect(flat).toContain('Preliminary, unofficial results are on the elections issue card');
  expect(flat).toContain('counting continued after it, so say the totals may have changed');
  expect(flat).toContain('Never use "won", "win", "lost", "lose", "defeated", "conceded", "projected", "advance" or "elected" in your own words.');
  expect(flat).toContain('"three seats are up, and the top three vote-getters fill them"');
  expect(flat).toContain('never comment on which candidates the Examiner did or did not describe that way');
  expect(flat).toContain('say plainly that you cannot predict the outcome');
  expect(flat).toContain("Never fold Jenkins's words into the Examiner's characterization");
  expect(flat).toContain("Arthur Long's account of Daronco Townhouse");
  // The snapshot comes from one fact, shared with the card and the function.
  const snap = 'posted late on November 4 and reported by the Pelham Examiner on November 5';
  expect(flat).toContain(`totals the Westchester County Board of Elections ${snap}`);
  const fn = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'ask-pelham.js'), 'utf8');
  expect(fn).toContain(`const RESULTS_SNAPSHOT = "${snap}";`);
  const card = require('../content/issues.json').issues.find((i) => i.id === 'november-2026-elections');
  expect(card.description).toContain('{{fact:election-results-snapshot-2026}}');
  expect(flat).toContain('without projecting, extrapolating or explaining the totals, and without linking them to the ballot problem or the voter-registration investigation');
  expect(flat).toContain('Never state results that are not on the card');
  expect(flat).not.toContain('No results are in this prompt');
  expect(flat).not.toContain('no results are in this prompt');
  expect(flat).not.toContain('preliminary results could come that afternoon');
  expect(flat).toContain('westchestercountyny.gov/boe');
  expect(flat).toContain('never speculate on the cause of the problem or its effect');
  expect(flat).toContain('These accounts have not been reconciled.');
  expect(flat).toContain("never attribute the Examiner's estimates to the Board of Elections");
  expect(flat).toContain('Do not say counting was delayed, or that the ballot problem changed the timetable, unless a source says so.');
  expect(flat).toContain('never give a specific date for a future year. Say it is typically held in mid-May, and to confirm the date at pelhamschools.org.');
  expect(flat).toContain('point residents to elections.ny.gov and the Westchester County Board of Elections');
  expect(flat).toContain('The general election was held November 3, 2026.');
  // Pre-election logistics are out of the Key facts.
  expect(flat).not.toContain('Polling hours on general election day');
  expect(flat).not.toContain('Voter registration deadline for the November 2026 election');
  expect(flat).not.toContain('Early voting period, November 2026 election');
});

test('prompt — earlier meetings carry their lead paragraph, so the model can route to them', () => {
  const prompt = require('../netlify/functions/system-prompt');
  const flat = prompt.replace(/\s+/g, ' ');
  expect(flat).toContain("(cite as meetings#board-of-ed-oct2026). Covered: A long business meeting built around three presentations: the district's approach to technology and screen time");
});

test('isResultsQuestion — results questions get the results reminder; others do not', () => {
  for (const q of ['Who won the Village of Pelham trustee race?', 'Who is leading in the Town Supervisor race?',
    'What are the Pelham Manor results?', 'Did Breda Bennett lose?', 'Is Ryan Kurtz going to win?',
    'I heard Arthur Long won. Is that right?', 'What were the vote totals?']) {
    expect(isResultsQuestion(q), q).toBe(true);
  }
  for (const q of ['When is bulk trash pickup in Pelham Manor?', 'What happened with the voting machines on Election Day?',
    'Can I still register to vote?', 'How do I dispute my property tax assessment?', 'What did the Board of Education discuss at its last meeting?']) {
    expect(isResultsQuestion(q), q).toBe(false);
  }
});
