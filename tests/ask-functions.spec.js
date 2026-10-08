// Unit tests for source citation and retrieval routing in
// netlify/functions/ask-pelham.js. No network: these call the pure helpers it
// exports for testing.

const { test, expect } = require('@playwright/test');
const { parseUsedSources, withSources, extractSearchTerms, extractProperNouns, buildSearchPlan } =
  require('../netlify/functions/ask-pelham')._test;

const ARTICLES = [
  { title: 'First article', url: 'https://pelhamexaminer.com/1/' },
  { title: 'Second article', url: 'https://pelhamexaminer.com/2/' },
  { title: 'Third article', url: 'https://pelhamexaminer.com/3/' },
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
  expect(out).toContain('Sources:\n• Second article — https://pelhamexaminer.com/2/');
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
