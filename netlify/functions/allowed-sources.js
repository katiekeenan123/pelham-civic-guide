// The vetted sources Ask Pelham may draw on and cite. One list, used by the
// function at retrieval time and citation time, and by the build when it
// writes the system prompt. Anything not allowed here is dropped.
//
// It is an ALLOWLIST: a URL is refused unless it matches. A new or renamed
// Pelham Examiner section is therefore excluded until someone adds it below.
//
// To add a source: put its host in ALLOWED_HOSTS (no "www.", no path), or, for
// the Examiner, the section name in EXAMINER_SECTIONS. To remove one, delete
// it. Then run `npm run build` (the prompt is filtered at build time) and
// `npm run test:local`.

// Exact hosts. "www." is ignored; other subdomains are NOT included, so
// pelhamny.portal.civicclerk.com does not count as pelhamny.gov.
const ALLOWED_HOSTS = [
  'pelhamengagementproject.org', // this site
  'pelhamny.gov',                // Village of Pelham
  'pelhammanor.gov',             // Village of Pelham Manor
  'townofpelhamny.gov',          // Town of Pelham
  'pelhamschools.org',           // Pelham Union Free School District
  'westchestercountyny.gov',     // Westchester County
  'osc.ny.gov',                  // NYS Comptroller (fiscal stress scores)
  'elections.ny.gov',            // NYS Board of Elections
  'lwvw.org',                    // League of Women Voters of Westchester
];

// The Pelham Examiner: news sections only. Its URLs look like
// https://pelhamexaminer.com/85509/latest-news/<slug>/ — the section is the
// path segment after the article number. Letters (/letters-to-the-editor/),
// campaign statements (/showcase/, /candidate-statements/), press releases
// (/announcing/) and every other section are excluded.
const EXAMINER_HOST = 'pelhamexaminer.com';
const EXAMINER_SECTIONS = ['latest-news', 'schools'];

function hostOf(u) {
  return u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** True if `url` is a vetted source. Anything unparseable is refused. */
function isAllowedSource(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = hostOf(u);
  if (host === EXAMINER_HOST) {
    const m = /^\/(?:\d+\/)?([^/]+)\//.exec(u.pathname);
    return Boolean(m) && EXAMINER_SECTIONS.includes(m[1].toLowerCase());
  }
  return ALLOWED_HOSTS.includes(host);
}

// PostgREST filter selecting only allowed Examiner sections, for the articles
// search, so blocked rows never use up a retrieval slot. Every row still goes
// through isAllowedSource() afterwards; this is an optimization, not the gate.
const EXAMINER_SECTION_FILTER = EXAMINER_SECTIONS
  .map((s) => `url.ilike.%${EXAMINER_HOST}/%/${s}/%`)
  .join(',');

module.exports = { isAllowedSource, ALLOWED_HOSTS, EXAMINER_HOST, EXAMINER_SECTIONS, EXAMINER_SECTION_FILTER };
