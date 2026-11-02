// Unit tests for the vetted-source allowlist (netlify/functions/allowed-sources.js)
// and the retrieval- and citation-time gates in ask-pelham.js. No network.

const { test, expect } = require('@playwright/test');
const { isAllowedSource, EXAMINER_SECTION_FILTER } = require('../netlify/functions/allowed-sources');
const { withSources, stripUnvettedUrls } = require('../netlify/functions/ask-pelham')._test;

const LETTER = 'https://pelhamexaminer.com/85498/letters-to-the-editor/lifelong-democrats-endorse-long-speros-and-anzilotti-urge-vote-for-fiscal-responsibility/';

test('allowlist — official, state and site hosts are allowed, with or without www', () => {
  for (const u of [
    'https://pelhamengagementproject.org/elections',
    'https://www.pelhamny.gov/173/Adopted-Village-Budgets',
    'https://pelhamny.gov/AgendaCenter',
    'https://www.pelhammanor.gov/209/Budgets-Financial-Statements',
    'https://townofpelhamny.gov/town-officials/',
    'https://www.pelhamschools.org/board-of-education',
    'https://www.westchestercountyny.gov/boe',
    'https://www.osc.ny.gov/press/releases/2026/09/x',
    'https://elections.ny.gov/registration-and-voting-deadlines',
    'https://lwvw.org/',
    'http://pelhamny.gov/',
  ]) expect(isAllowedSource(u), u).toBe(true);
});

test('allowlist — Pelham Examiner news sections only', () => {
  expect(isAllowedSource('https://pelhamexaminer.com/85509/latest-news/candidates-debate/')).toBe(true);
  expect(isAllowedSource('https://www.pelhamexaminer.com/84000/schools/board-of-ed-story/')).toBe(true);
  expect(isAllowedSource('https://pelhamexaminer.com/84000/Latest-News/case-insensitive/')).toBe(true);
  for (const u of [
    LETTER,
    'https://pelhamexaminer.com/84934/showcase/russell-solomons-campaign-statement/',
    'https://pelhamexaminer.com/85421/candidate-statements/the-neighborhood-party-alternative/',
    'https://pelhamexaminer.com/84905/announcing/vop-trustee-candidates/',
    'https://pelhamexaminer.com/85000/obituaries/someone/',
    'https://pelhamexaminer.com/85001/letter-to-readers/x/',
    'https://pelhamexaminer.com/85002/opinion/x/',
    // A section that does not exist yet is excluded automatically.
    'https://pelhamexaminer.com/90000/brand-new-section/x/',
    'https://pelhamexaminer.com/',
    'https://pelhamexaminer.com/85509/',
    'https://pelhamexaminer.com/?s=latest-news',
  ]) expect(isAllowedSource(u), u).toBe(false);
});

test('allowlist — look-alikes, subdomains, recording hosts and junk are refused', () => {
  for (const u of [
    'https://pelhamny.gov.evil.example/x',
    'https://evilpelhamny.gov/x',
    'https://pelhamny.portal.civicclerk.com/event/2542/overview',
    'https://pelhampublicschoolsny.new.swagit.com/videos/404834',
    'https://vimeo.com/1239665290',
    'https://www.youtube.com/watch?v=Wi_TWjQ-0HE',
    'https://pelhamexaminer.com.evil.example/1/latest-news/x/',
    'https://user:pass@pelhamny.gov/x',
    'ftp://pelhamny.gov/x',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
  ]) expect(isAllowedSource(u), String(u)).toBe(false);
});

test('retrieval — the database filter asks only for the allowed Examiner sections', () => {
  expect(EXAMINER_SECTION_FILTER).toBe('url.ilike.%pelhamexaminer.com/%/latest-news/%,url.ilike.%pelhamexaminer.com/%/schools/%');
});

test('citation — an unvetted article is never listed, and is reported as blocked', () => {
  const articles = [
    { title: 'News', url: 'https://pelhamexaminer.com/1/latest-news/news/' },
    { title: 'Letter', url: LETTER },
  ];
  const blocked = [];
  const out = withSources('Answer.\nUSED_SOURCES: issues#rising-property-taxes-village-debt, 1, 2', articles, [], (u) => blocked.push(u));
  expect(out).toContain('• News — https://pelhamexaminer.com/1/latest-news/news/');
  expect(out).not.toContain('letters-to-the-editor');
  expect(out).not.toContain('Letter —');
  expect(blocked).toEqual([LETTER]);
});

test('citation — unvetted URLs written into the answer text are removed and reported', () => {
  const blocked = [];
  const text = stripUnvettedUrls(`Per ${LETTER}, and see https://www.pelhamny.gov/173/Budgets.`, (u) => blocked.push(u));
  expect(text).toBe('Per [non-vetted link removed], and see https://www.pelhamny.gov/173/Budgets.');
  expect(blocked).toEqual([LETTER]);
  // The whole answer path applies it too.
  const out = withSources(`See ${LETTER}\nUSED_SOURCES: none`, []);
  expect(out).not.toContain('pelhamexaminer.com');
});
