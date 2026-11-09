// Netlify serverless function: proxies the browser's chat request to the
// Anthropic API so the API key AND the system prompt stay server-side.
//
// The browser POSTs { messages } to /api/ask (rewritten to this function by
// netlify.toml). This function supplies the model, max_tokens, the system
// prompt (SYSTEM_PROMPT below), and the secret ANTHROPIC_API_KEY, then
// returns { answer: "<text>" } to the page. The client cannot see or change
// the key or the prompt.
//
// Set ANTHROPIC_API_KEY in: Netlify site -> Site configuration ->
// Environment variables. It must NOT be committed to the repo.
//
// This function also records 👍/👎 feedback on assistant answers. A feedback
// POST looks like { type: "feedback", vote: "up"|"down", question, answer_snippet }
// and is INSERTed into the Supabase `feedback` table. Requires two more
// environment variables in the same Netlify screen:
//   SUPABASE_URL       - your project URL (https://xxxx.supabase.co)
//   SUPABASE_ANON_KEY  - the project "anon"/public API key
// If those are absent the chat path still works; only feedback writes fail.
//
// Q&A logging. Every answered question is also written to the Supabase
// `qa_log` table with the full answer and the caller's per-page-load
// session_id, so real traffic can be read back and used to find gaps in the
// content. It is the one table here that records what residents asked rather
// than what they chose to submit. It began as a launch-period diagnostic with
// a hard end date; in November 2026 the end date was removed and logging
// continues with no cutoff. Test traffic (X-Test-Request) is never logged.
// See logQa() below.
//
// RETRIEVAL (RAG): before calling Anthropic, the newest user question is
// matched against the Supabase `articles` table -- Pelham Examiner coverage
// tagged nightly by the check_examiner.py pipeline in the companion repo. Any
// hits are prepended to that question as context and listed back to the reader
// as "Sources:". The whole retrieval path is best-effort: a missing env var, a
// slow database or an empty result set all fall through to the plain answer,
// and the reader never sees an error from it. The anon key is enough here
// because this is a read of an already-public table.
//
// VETTED SOURCES ONLY: every retrieved article and every cited URL is checked
// against the allowlist in ./allowed-sources.js (official government sites,
// this site, and Pelham Examiner news sections only). Anything else is dropped
// at retrieval time and again at citation time, and each blocked URL is logged
// with the question that triggered it (see logBlocked below).

const { isAllowedSource, EXAMINER_SECTION_FILTER } = require('./allowed-sources');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';   // civic Q&A; change here if you want a different model
const MAX_TOKENS = 1000;
const MAX_MESSAGES = 40;             // simple abuse guard on conversation length

// --- Retrieval tuning ------------------------------------------------------ #
const RAG_LIMIT = 3;        // articles injected per answer
const RAG_MIN_RELEVANCE = 3; // articles.relevance_score floor (1-5 scale)
// Stricter floor for the topic-tag tier only. Issue and candidate matches are
// exact values a model already vetted per article; a tag is a much looser
// signal, so a single shared tag plus a middling relevance score was enough to
// staple an unrelated article to an otherwise correct answer -- a question
// about Amtrak work on Forest Road cited a candidate platform story, because
// "construction" tags as Development and so did the platform piece.
const RAG_MIN_RELEVANCE_TAG = 4;
const RAG_TIMEOUT_MS = 2500; // budget for the whole search; Anthropic needs the rest

// Canonical system prompt for "Ask Pelham". GENERATED — the text lives in
// content/prompt-template.md plus content/*.json, and `npm run build`
// renders it into system-prompt.js. Do not edit the prompt here; edit the
// template or the data and rebuild.
//
// Required as a module rather than read as a .txt at runtime: Netlify's
// function bundler follows require() but does not include arbitrary sibling
// files, so a readFileSync would work locally and throw ENOENT once deployed.
const SYSTEM_PROMPT = require('./system-prompt');

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

  // Supabase write paths — handled before the chat validation below so they
  // never touch Anthropic:
  //   { type: "feedback",         vote, question, answer_snippet }
  //   { type: "correction",       section, description, source, contact }
  //   { type: "civic_engagement", feedback_type, actions, governing_body, story, email }
  if (body && (body.type === 'feedback' || body.type === 'correction' || body.type === 'civic_engagement')) {
    return recordSubmission(body);
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'messages must be a non-empty array' });
  }
  if (messages.length > MAX_MESSAGES) {
    return json(400, { error: 'Conversation too long' });
  }

  // Retrieval step. Never throws: on any failure `articles` is [] and the
  // request proceeds as an ordinary prompt-only answer. A contested election
  // issue cites its issue card's own sources, which carry both sides, and
  // always lists the card first.
  const question = latestQuestion(messages);
  const contested = contestedIssueFor(question);
  const retrieved = contested
    ? contested.sources
    : await findExaminerCoverage(question);
  // Retrieval-time gate: only vetted sources reach the model.
  const blocked = [];
  const articles = retrieved.filter((a) => {
    if (a && isAllowedSource(a.url)) return true;
    blocked.push({ url: a && a.url, stage: 'retrieval' });
    return false;
  });

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
        system: `${todayLine()}\n\n${SYSTEM_PROMPT}`,
        messages: withExaminerContext(messages, articles, contested, isResultsQuestion(question), isScheduleQuestion(question), isLookupQuestion(question)),
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      // Surface Anthropic's status and error payload for debugging.
      return json(upstream.status, { error: 'Anthropic API error', detail: data });
    }

    const answer =
      Array.isArray(data.content) && data.content[0] && data.content[0].text
        ? data.content[0].text
        : '';

    // Citation-time gate: withSources drops any citation, or URL written into
    // the answer, that is not a vetted source, and reports each one here.
    // A results question always cites the Elections page results section,
    // and a contested issue its card, whatever the model listed.
    const pinned = [
      ...(contested ? [contested.anchor] : []),
      ...(isResultsQuestion(question) ? ['elections#results'] : []),
    ];
    const delivered = withSources(answer, articles, pinned,
      (url) => blocked.push({ url, stage: 'citation' }));
    await Promise.all([
      logQa(question, delivered, body.session_id, event.headers),
      logBlocked(blocked, question, event.headers),
    ]);
    return json(200, { answer: delivered });
  } catch (err) {
    return json(502, { error: 'Upstream request failed', detail: String(err) });
  }
};

// Q&A logging (no end date; see the header comment).
//
// Records the question and the answer exactly as delivered to the reader,
// including the "Sources:" block, so the log shows what was actually said
// rather than a reconstruction.
//
// Awaited rather than fired and forgotten. Lambda freezes the container the
// instant the handler returns, so an un-awaited insert is silently dropped
// whenever it has not already landed — which, for a log whose whole purpose
// is completeness, is the worst of both worlds. The race below bounds what
// the await can cost: if Supabase is slow or down the answer still goes out
// on time and the log entry is the thing that is lost, which is the right way
// round. Nothing in here can fail the request.
const QA_LOG_TIMEOUT_MS = 1500;

async function logQa(question, answer, sessionId, headers) {
  try {
    // tests/ai.spec.js sends X-Test-Request so its synthetic questions stay
    // out of the log. Netlify lowercases incoming header names.
    if (headers && headers['x-test-request']) return;
    const supabase = getSupabase();
    if (!supabase || !question || !answer) return;
    // Generous caps, not the 2000-char clip the submission forms use: the
    // point of this table is the FULL answer.
    const row = {
      question: String(question).slice(0, 8000),
      answer: String(answer).slice(0, 20000),
      session_id: typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.slice(0, 100)
        : null,
    };
    const result = await Promise.race([
      supabase.from('qa_log').insert(row),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), QA_LOG_TIMEOUT_MS)),
    ]);
    if (result && result.timedOut) console.warn('[qa_log] insert timed out');
    else if (result && result.error) console.warn('[qa_log]', result.error.message);
  } catch (err) {
    console.warn('[qa_log] write failed:', String(err));
  }
}

// Blocked-source log. Every URL dropped by the vetted-source gate, with the
// question that triggered it and the stage (retrieval or citation), goes to
// the Supabase `blocked_sources` table (see supabase/grants.sql) and to the
// Netlify function log. `npm run blocked-log` downloads the table to a CSV.
// Bounded and best-effort, like logQa: nothing here can fail the request, and
// test traffic (X-Test-Request) is not recorded in the table.
async function logBlocked(entries, question, headers) {
  if (!entries.length) return;
  for (const e of entries) console.warn(`[blocked-source] ${e.stage} ${e.url} :: ${String(question || '').slice(0, 200)}`);
  try {
    const h = headers || {};
    if (h['x-test-request'] || h['X-Test-Request']) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const rows = entries.map((e) => ({
      url: String(e.url || '').slice(0, 2000),
      stage: e.stage,
      question: String(question || '').slice(0, 4000),
    }));
    const result = await Promise.race([
      supabase.from('blocked_sources').insert(rows),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), QA_LOG_TIMEOUT_MS)),
    ]);
    if (result && result.timedOut) console.warn('[blocked_sources] insert timed out');
    else if (result && result.error) console.warn('[blocked_sources]', result.error.message);
  } catch (err) {
    console.warn('[blocked_sources] write failed:', String(err));
  }
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/**
 * Normalize whatever is in SUPABASE_URL down to the project origin.
 *
 * supabase-js appends `/rest/v1/<table>` itself, so the env var has to be the
 * bare origin (https://<ref>.supabase.co). The dashboard's API page displays
 * the full REST endpoint ending in /rest/v1, which is an easy thing to copy by
 * mistake; that yields a request path of /rest/v1/rest/v1/<table>, and the
 * Supabase API gateway rejects it with "Invalid path specified in request URL"
 * before PostgREST is ever reached.
 *
 * Trailing slashes and stray whitespace are already handled inside
 * createClient, so they are not the failure mode -- a duplicated path prefix
 * is. Only that suffix is stripped rather than the whole path, so a
 * self-hosted Supabase mounted under a sub-path keeps working.
 */
function normalizeSupabaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return trimmed.replace(/\/rest\/v\d+$/, '');
}

// Lazily build a Supabase client so a bundling miss or missing env vars only
// affects the feedback path, never the chat proxy above.
function getSupabase() {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (err) {
    // createClient throws on a malformed URL (e.g. a missing scheme). Log the
    // reason -- the caller only sees null and would otherwise report it as a
    // missing environment variable.
    console.warn('[supabase] could not build client:', String(err));
    return null;
  }
}

// Validate a submission payload by its `type` and INSERT one row into the
// matching Supabase table (feedback / corrections / civic_engagement).
async function recordSubmission(body) {
  const supabase = getSupabase();
  if (!supabase) {
    return json(500, { error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY' });
  }

  const clip = (v) => (typeof v === 'string' && v.trim() ? v.slice(0, 2000) : null);

  let table;
  let row;

  if (body.type === 'feedback') {
    if (body.vote !== 'up' && body.vote !== 'down') {
      return json(400, { error: "feedback 'vote' must be 'up' or 'down'" });
    }
    table = 'feedback';
    row = {
      vote: body.vote,
      question: clip(body.question),
      answer_snippet: clip(body.answer_snippet),
    };
  } else if (body.type === 'correction') {
    if (!clip(body.description)) {
      return json(400, { error: "correction 'description' is required" });
    }
    table = 'corrections';
    row = {
      section: clip(body.section),
      description: clip(body.description),
      source: clip(body.source),
      // Optional email for a reply; null when the reader leaves it blank.
      contact: clip(body.contact),
    };
  } else if (body.type === 'civic_engagement') {
    table = 'civic_engagement';
    row = {
      actions: Array.isArray(body.actions)
        ? body.actions.filter((a) => typeof a === 'string').map((a) => a.slice(0, 100))
        : null,
      governing_body: clip(body.governing_body),
      story: clip(body.story),
    };
    // "Missing topic or issue", "I want to help with this project", … Only
    // sent when chosen: PostgREST rejects a column it does not know even when
    // the value is null, so an unconditional key would fail every submission
    // until civic_engagement.feedback_type exists (supabase/grants.sql).
    if (clip(body.feedback_type)) row.feedback_type = clip(body.feedback_type);
    // Optional follow-up address. Sent only when given, for the same reason:
    // until civic_engagement.email exists, a blank field still saves.
    if (clip(body.email)) row.email = body.email.trim().slice(0, 320);
  } else {
    return json(400, { error: 'Unknown submission type' });
  }

  const { error } = await supabase.from(table).insert(row);
  if (error) {
    return json(502, { error: `Failed to record ${body.type}`, detail: error.message });
  }
  return json(200, { ok: true });
}

/* ========================================================================== *
 * RETRIEVAL — recent Pelham Examiner coverage from the Supabase `articles`
 * table.
 *
 * Rows are written by check_examiner.py (companion repo), which reads the
 * Examiner RSS feed and has Claude tag each article with topic tags, a
 * two-sentence summary, a 1-5 relevance score, and — the part that makes this
 * cheap — the canonical name of the known issue and/or known candidate the
 * article is actually about. Because those two columns hold exact canonical
 * strings, matching a question to coverage is an equality filter rather than a
 * similarity search, so no embeddings are involved.
 *
 * KNOWN_ISSUES and KNOWN_CANDIDATES below MUST stay spelled exactly as they are
 * in check_examiner.py. The values are written verbatim to
 * articles.matched_issue / articles.matched_candidate; a renamed entry here
 * silently stops matching every row already stored under the old spelling.
 * ========================================================================== */

// Canonical issue name -> keywords that suggest the reader means that issue.
// The keyword lists over-match on purpose; the longest keyword that hits wins
// (see matchIssue), which is what keeps "who is the receiver of taxes" on the
// "Receiver of Taxes transition" issue instead of the broader "rising taxes".
// Site pages and anchors the model may cite, and the contested issues whose
// citations come from their issue card. GENERATED from content/*.json by
// `npm run build` (generateSiteSources); do not edit by hand.
/* BUILD:site-sources */
const SITE_URL = "https://pelhamengagementproject.org";
const SITE_PAGES = {
  "issues": "Current Issues",
  "elections": "2026 Elections",
  "meetings": "Meeting Summaries",
  "get-involved": "How to Get Involved",
  "taxes": "Where Your Taxes Go",
  "gov-101": "Who Governs Pelham"
};
const SITE_ANCHORS = {
  "issues#rising-property-taxes-village-debt": "Rising Property Taxes & Village Debt",
  "issues#november-2026-elections": "November 2026 — First Contested Village Race Since 2019",
  "issues#picture-house": "Pelham Picture House — Future Still Uncertain",
  "issues#colonial-elementary-ac": "Colonial Elementary — AC Interim Fix in Place",
  "issues#public-library-transformation": "Pelham Public Library — Transformation Project",
  "issues#manor-tractor-trailer-ban": "Pelham Manor — Tractor-Trailer Ban on Boston Post Road",
  "issues#ems-station-first-street": "EMS Station & Community Church — First Street",
  "issues#receiver-of-taxes-vacancy": "Receiver of Taxes Vacancy — Appointment or Referendum Under Discussion",
  "issues#con-edison-rate-hike": "Con Edison Rate Case — Settlement Cuts the Increase",
  "issues#fini-park-fireworks": "Feeney Park — Nightly Illegal Fireworks",
  "issues#amtrak-forest-road": "Amtrak Forest Road Corridor Project — Pelham Manor",
  "elections#results": "Election results (unofficial, not certified)",
  "meetings#pelham-board-oct27-2026": "Meeting summary — Village of Pelham · Board of Trustees · October 27, 2026",
  "meetings#pelham-board-oct2026": "Meeting summary — Village of Pelham · Board of Trustees · October 13, 2026",
  "meetings#pelham-board-sep22-2026": "Meeting summary — Village of Pelham · Board of Trustees · September 22, 2026",
  "meetings#pelham-board-sep2026": "Meeting summary — Village of Pelham · Board of Trustees · September 8, 2026",
  "meetings#pelham-board-jul2026": "Meeting summary — Village of Pelham · Board of Trustees · July 14, 2026",
  "meetings#town-council-oct2026": "Meeting summary — Town of Pelham · Town Council · October 5, 2026",
  "meetings#town-council-sep2026": "Meeting summary — Town of Pelham · Town Council · September 14, 2026",
  "meetings#town-council-aug2026": "Meeting summary — Town of Pelham · Town Council · August 3, 2026",
  "meetings#manor-board-oct26-2026": "Meeting summary — Village of Pelham Manor · Board of Trustees · October 26, 2026",
  "meetings#manor-board-oct2026": "Meeting summary — Village of Pelham Manor · Board of Trustees · October 13, 2026",
  "meetings#manor-board-sep28-2026": "Meeting summary — Village of Pelham Manor · Board of Trustees · September 28, 2026",
  "meetings#manor-board-sep2026": "Meeting summary — Village of Pelham Manor · Board of Trustees · September 14, 2026",
  "meetings#manor-board-aug2026": "Meeting summary — Village of Pelham Manor · Board of Trustees · August 17, 2026",
  "meetings#board-of-ed-oct21-2026": "Meeting summary — Board of Education · Finance Work Session · October 21, 2026",
  "meetings#board-of-ed-oct2026": "Meeting summary — Board of Education · Business Meeting · October 7, 2026",
  "meetings#board-of-ed-sep2026": "Meeting summary — Board of Education · Business Meeting · September 23, 2026",
  "meetings#board-of-ed-aug2026": "Meeting summary — Board of Education · Business Meeting · August 26, 2026",
  "meetings#board-of-ed-jun2026": "Meeting summary — Board of Education · Business Meeting · June 24, 2026"
};
const CONTESTED_ISSUES = [
  {
    "anchor": "issues#rising-property-taxes-village-debt",
    "keywords": [
      "flood mitigation",
      "flood plan",
      "tax cap",
      "village debt",
      "debt",
      "borrowing",
      "contingency",
      "fiscal stress",
      "stress score"
    ],
    "sources": [
      {
        "title": "Pelham Examiner coverage",
        "url": "https://pelhamexaminer.com/82552/latest-news/village-board-passes-20-5-million-budget-most-homeowners-tax-bills-will-rise-10-board-discusses-updating-bdfz-9th-avenue-parking/",
        "published_at": "2026-04-29"
      },
      {
        "title": "NYS Comptroller — Fiscal Stress Scores announcement",
        "url": "https://www.osc.ny.gov/press/releases/2026/09/dinapoli-announces-latest-fiscal-stress-scores-local-governments",
        "published_at": "2026-09-24"
      },
      {
        "title": "NYS Comptroller — Fiscal Year 2025 Municipal Data (Excel)",
        "url": "https://www.osc.ny.gov/files/local-government/fiscal-monitoring/2025/excel/2025-munis-all-data-worksheet.xlsx",
        "published_at": "2026-09-24"
      }
    ]
  }
];
/* /BUILD:site-sources */

/**
 * "Today's date is Wednesday, November 4, 2026 (New York time)." Computed per
 * request, so the model knows whether an election or meeting is past without
 * the prompt being rebuilt.
 */
function todayLine(now = new Date()) {
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  return `Today's date is ${date} (New York time).`;
}

/** The contested issue a question is about (by its card's keywords), or null. */
function contestedIssueFor(question) {
  const low = typeof question === 'string' ? question.toLowerCase() : '';
  return CONTESTED_ISSUES.find((c) => c.keywords.some((k) => hasKeyword(low, k))) || null;
}

/* BUILD:known-issues */
const KNOWN_ISSUES = {
  'Picture House': ['picture house', 'php partners', 'smithmeyer', 'wolfs lane'],
  'Colonial Elementary AC': ['colonial', 'colonial elementary', 'air conditioning', 'air-conditioning', 'hvac', 'prospect hill'],
  'EMS station': ['ems', 'ems station', 'ambulance', 'emergency medical', 'paramedic', 'first street'],
  'library transformation': ['library', 'library board', 'library renovation', 'transformation project', 'shekane', 'shakane'],
  'tractor-trailer ban': ['tractor-trailer', 'tractor trailer', 'truck ban', 'trucks', 'trucking', 'boston post road', 'nys dot'],
  'Con Edison rate': ['con edison', 'coned', 'con ed', 'utility rate', 'rate hike', 'public service commission', 'electric rates'],
  'rising taxes': ['tax levy', 'taxes', 'tax rate', 'assessment', 'property taxes', 'tax cap override', 'village budget'],
  debt: ['debt', 'bond', 'borrowing', 'capital plan', 'debt service'],
  stormwater: ['stormwater', 'storm water', 'flooding', 'flood', 'sewer', 'drainage'],
  'Siwanoy expansion': ['siwanoy'],
  'Receiver of Taxes transition': ['receiver of taxes', 'erica winter', 'deputy receiver', 'darlene paolericio', 'tax collection', 'referendum'],
};
/* /BUILD:known-issues */

// Canonical candidate surnames, as stored in articles.matched_candidate.
const KNOWN_CANDIDATES = [
  'Solomon', 'Howell', 'Burke', 'Long', 'Speros', 'Anzilotti', 'Bennett',
  'Liberatore', 'Kurtz', 'Dlutkowski', 'Mohan', 'Wolfgang', 'Miller',
  'Borsella', 'Eldahry',
];

// Other spellings a reader may type, mapped to the canonical key above. The
// key stays as check_examiner.py stores it, so articles already tagged under
// it keep matching. The candidate spells his own name "Dlutowski" (campaign
// statement, Examiner October 5 2026); "Dlutkowski" came from an earlier
// announcement.
const CANDIDATE_ALIASES = { Dlutkowski: ['dlutowski'] };

// Surnames that are also ordinary English words. "How long is the meeting?"
// must not retrieve coverage of candidate Arthur Long, so these only count as a
// candidate when the reader actually capitalized them.
const AMBIGUOUS_SURNAMES = new Set(['Long']);

// Topic tag -> question keywords. Used only for the fallback search, so the
// tags must match the TOPIC_TAGS enum in check_examiner.py exactly.
const TOPIC_KEYWORDS = {
  Budget: ['budget', 'spending', 'levy', 'fiscal', 'appropriation', 'tax cap', 'deficit', 'surplus'],
  Elections: ['election', 'candidate', 'ballot', 'campaign', 'vote for', 'voting', 'running for', 'race'],
  Education: ['curriculum', 'classroom', 'teacher', 'student', 'board of education', 'superintendent'],
  Development: ['development', 'developer', 'zoning', 'redevelopment', 'construction', 'apartment', 'housing', 'building'],
  Transportation: ['traffic', 'parking', 'train', 'metro-north', 'mta', 'road', 'street', 'sidewalk', 'commute'],
  EMS: ['ems', 'ambulance', 'paramedic', 'emergency medical'],
  Environment: ['environment', 'sustainability', 'climate', 'tree', 'solar', 'recycling'],
  'Public Safety': ['police', 'crime', 'fire department', 'speeding', 'crosswalk', 'safety'],
  Library: ['library'],
  Schools: ['school', 'schools', 'district'],
  Recreation: ['park', 'recreation', 'pool', 'playground', 'field'],
  Personnel: ['resign', 'appointed', 'appointment', 'hired', 'retire', 'stepped down', 'vacancy'],
};

// Capitalized words that carry no signal as proper nouns here — question
// openers, plus the place names that appear in nearly every question asked.
const PROPER_NOUN_STOPWORDS = new Set([
  'The', 'What', 'When', 'Where', 'Who', 'Why', 'How', 'Does', 'Did', 'Can',
  'Should', 'Are', 'Was', 'Will', 'Would', 'Could', 'Has', 'Have', 'Pelham',
  'Manor', 'Village', 'Town', 'County', 'Westchester', 'New', 'York', 'Board',
  'Trustees', 'Trustee', 'Mayor', 'Examiner', 'And', 'But', 'For', 'This',
  'That', 'There', 'Here', 'Tell', 'Give', 'Please', 'Also',
  // Local abbreviations. "What date is bulk trash pick up in VOP?" title-matched
  // "VOP Trustee candidates: Village debt…" and cited it. (extractProperNouns
  // also skips every all-caps word of four letters or fewer; these are listed
  // so the intent survives if that rule changes.)
  'VOP', 'POM', 'TOP', 'DPW', 'EMS', 'BOE',
]);

// Phrases that name one specific thing, searched for in article titles ahead
// of the capitalized-word search. "community church" used to route through the
// EMS station issue tag, which answered a question about the church's sale
// with two candidate statements that mention EMS.
const TITLE_PHRASES = ['community church'];

/** The newest user message — the question retrieval should actually answer. */
function latestQuestion(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

// --- Step 1: keyword extraction -------------------------------------------- #

/** Pull the handful of terms worth searching on out of a free-text question. */
function extractSearchTerms(question) {
  const text = typeof question === 'string' ? question.slice(0, 1000) : '';
  const low = text.toLowerCase();
  const properNouns = extractProperNouns(text);
  return {
    issue: matchIssue(low),
    candidate: matchCandidate(low, properNouns),
    topics: matchTopics(low),
    titlePhrase: TITLE_PHRASES.find((phrase) => low.includes(phrase)) || null,
    properNouns,
  };
}

/**
 * Does `keyword` start a word in `text`?
 *
 * Deliberately NOT a substring test. "ems" appears inside "problems",
 * "systems" and "items", so a plain includes() sends anyone asking about
 * problems with the budget to the EMS station coverage. Anchoring the front to
 * a word boundary while leaving the tail open keeps the useful stemming —
 * "resign" still matches "resigned", "bond" still matches "bonds".
 */
function hasKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\w*`).test(text);
}

/**
 * Most specific issue wins: score each issue by its LONGEST matching keyword,
 * not by how many matched. "How do I appeal my tax assessment?" hits only
 * "rising taxes"; "who replaced the receiver of taxes?" hits both that and the
 * transition issue, and the longer phrase ("receiver of taxes") settles it.
 */
function matchIssue(low) {
  let best = null;
  let bestLength = 0;
  for (const [issue, keywords] of Object.entries(KNOWN_ISSUES)) {
    for (const keyword of keywords) {
      if (keyword.length > bestLength && hasKeyword(low, keyword)) {
        best = issue;
        bestLength = keyword.length;
      }
    }
  }
  return best;
}

/** First known surname in the question, on word boundaries. */
function matchCandidate(low, properNouns) {
  for (const name of KNOWN_CANDIDATES) {
    if (AMBIGUOUS_SURNAMES.has(name)) {
      if (properNouns.includes(name)) return name;
      continue;
    }
    if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(low)) return name;
    for (const alias of CANDIDATE_ALIASES[name] || []) {
      if (new RegExp(`\\b${alias}\\b`).test(low)) return name;
    }
  }
  return null;
}

/** Topic tags ranked by how many of their keywords the question hit. */
function matchTopics(low) {
  return Object.entries(TOPIC_KEYWORDS)
    .map(([tag, keywords]) => ({
      tag,
      hits: keywords.filter((k) => hasKeyword(low, k)).length,
    }))
    .filter((t) => t.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2)
    .map((t) => t.tag);
}

/**
 * Capitalized words that are not sentence openers or boilerplate. Restricted to
 * plain letters, which also means these are safe to drop into an ILIKE pattern
 * without escaping — no %, _ or backslash can survive the match.
 */
function extractProperNouns(text) {
  const found = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
  const unique = [];
  for (const word of found) {
    // An all-caps word of four letters or fewer is an abbreviation (VOP, DPW,
    // EMS, MTA), not a name. As a title search it matches any headline that
    // happens to use it; the keyword lists handle the subjects these stand for.
    if (/^[A-Z]{2,4}$/.test(word)) continue;
    if (!PROPER_NOUN_STOPWORDS.has(word) && !unique.includes(word)) unique.push(word);
  }
  return unique.slice(0, 3);
}

// --- Step 2: search --------------------------------------------------------- #

/**
 * Search `articles` for coverage matching the question. Returns [] rather than
 * throwing for every failure mode: no Supabase config, a network error, a
 * timeout, or simply nothing relevant.
 */
async function findExaminerCoverage(question) {
  try {
    const terms = extractSearchTerms(question);
    const plan = buildSearchPlan(terms);
    if (!plan.length) return [];

    const supabase = getSupabase();
    if (!supabase) return [];

    // One budget for the whole plan, not per attempt — a slow database must not
    // multiply into a Netlify function timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);
    try {
      for (const step of plan) {
        // runSearch over-fetches, so removing a duplicate cannot leave the
        // reader with fewer than RAG_LIMIT distinct articles.
        const rows = dedupeArticles(await runSearch(supabase, step, controller.signal)).slice(0, RAG_LIMIT);
        if (rows.length) return rows.map(withSourceLabel);
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

/**
 * Ordered list of steps to try, most precise first, stopping at the first that
 * returns anything. Issue and candidate are exact matches on columns a model
 * already vetted, so they beat the tag and title guesses below them.
 *
 * Each step is { narrow, minRelevance? }: `narrow` applies the filter, and the
 * looser tiers carry their own relevance floor (see RAG_MIN_RELEVANCE_TAG).
 * Precision of the filter and required relevance move together — the weaker the
 * match, the better the article has to be to earn a citation.
 */
function buildSearchPlan(terms) {
  const plan = [];
  if (terms.issue) plan.push({ narrow: (q) => q.eq('matched_issue', terms.issue) });
  if (terms.candidate) plan.push({ narrow: (q) => q.eq('matched_candidate', terms.candidate) });

  // A question that names something specific — a street, a building, an agency,
  // an official who is not on the ballot — gets the title search and nothing
  // else. If we have no coverage of the thing the reader named, the honest
  // answer is no sources at all; falling through to the topic tag below would
  // answer a question they did not ask. "Who is handling the Amtrak
  // construction on Forest Road?" tags as Development on the word
  // "construction" alone, which cited a candidate platform story.
  //
  // Note the tag tier cannot be salvaged by a relevance floor here:
  // relevance_score rates how important an article is, not whether it bears on
  // this question, so the miscited story scored the maximum 5.
  // A known phrase naming one specific thing: search titles for the phrase
  // itself, and stop there for the same reason as the proper-noun branch.
  if (terms.titlePhrase) {
    const phrase = terms.titlePhrase;
    plan.push({ narrow: (q) => q.ilike('title', `%${phrase}%`) });
    return plan;
  }

  if (terms.properNouns.length) {
    const noun = terms.properNouns[0];
    plan.push({ narrow: (q) => q.ilike('title', `%${noun}%`) });
    return plan;
  }

  // Nothing named: a topic tag is the best guess left, held to a higher bar.
  for (const tag of terms.topics) {
    plan.push({ narrow: (q) => q.contains('tags', [tag]), minRelevance: RAG_MIN_RELEVANCE_TAG });
  }
  return plan;
}

/**
 * One filtered read. Each query shape here has a matching index in the
 * pipeline repo's schema.sql: partial indexes on matched_issue and
 * matched_candidate, a GIN index on tags, and published_at desc for the sort.
 *
 * NOTE ON PERMISSIONS: `articles` has RLS enabled with no permissive policy,
 * because the ingest pipeline writes with the service role key (which bypasses
 * RLS). Under that setup the anon key used here reads ZERO rows and gets NO
 * error back — retrieval just looks permanently unlucky. Reading from the
 * browser-facing key requires a select policy for `anon` on the table.
 */
async function runSearch(supabase, step, signal) {
  // Built in a named step rather than awaited inline so the request path is
  // available to the error branch below.
  const query = step.narrow(
    supabase
      .from('articles')
      .select('title, url, summary, published_at')
      .gte('relevance_score', step.minRelevance || RAG_MIN_RELEVANCE)
      // Only Examiner news sections, so letters, campaign statements and press
      // releases never take one of the RAG_LIMIT slots. Rows are still checked
      // against the allowlist after this; see the handler.
      .or(EXAMINER_SECTION_FILTER),
  )
    .order('published_at', { ascending: false })
    // Twice the limit: the Examiner moves articles between sections and the
    // pipeline keeps both URLs, so one article can fill two rows.
    .limit(RAG_LIMIT * 2)
    .abortSignal(signal);

  const { data, error } = await query;

  if (error) {
    // Netlify function logs only — the reader still gets a normal answer. The
    // path is what distinguishes a misconfigured SUPABASE_URL (a doubled
    // /rest/v1 prefix) from a genuine query or permission problem; the API key
    // travels in a header, so nothing secret is logged here.
    let path = 'unknown';
    try {
      path = new URL(query.url.toString()).pathname;
    } catch { /* leave as unknown */ }
    console.warn(`[rag] articles search failed (path ${path}):`, error.message);
    return [];
  }
  return (data || []).filter((row) => row && row.url && row.title);
}

/**
 * One row per Examiner article. The Examiner sometimes moves an article
 * between sections (/announcing/ to /candidate-statements/), which changes
 * the URL but not the numeric id in it, and the pipeline stores both. Keyed on
 * that id, falling back to the full URL for anything without one; the first
 * (newest) row wins. Done before the articles are numbered for the model, so
 * USED_SOURCES indices and the Sources block can never list one twice.
 */
function examinerArticleKey(url) {
  const m = /pelhamexaminer\.com\/(\d+)(?:\/|$)/i.exec(String(url || ''));
  return m ? `examiner:${m[1]}` : String(url || '').replace(/\/+$/, '').toLowerCase();
}
/**
 * The label a retrieved article is shown under, both in the model's context
 * and in the reader's "Sources:" line. The stored title is the Examiner's
 * headline, which the pipeline overwrites when the Examiner edits a story,
 * and a headline can carry framing the site does not repeat. The label
 * replaces the title before the model sees it, so the headline cannot be
 * quoted into an answer either.
 *
 * SOURCE_LABEL_OVERRIDES is keyed by Examiner article id (the number in the
 * URL), so it covers every stored URL for that article, including section
 * moves. Any other stored title naming a party, or using a loaded word, gets
 * a neutral generic label with the publication date.
 */
const SOURCE_LABEL_OVERRIDES = {
  'examiner:85683': 'Pelham Examiner — election results report, November 5, 2026',
  'examiner:85639': 'Pelham Examiner report, November 4, 2026',
  'examiner:85777': 'Pelham Examiner report, November 8, 2026',
};
// The stored summary is written by the pipeline from the article's own
// framing, and is rewritten when the Examiner edits the story. An override
// here replaces it, whatever the pipeline stores.
const SUMMARY_OVERRIDES = {
  'examiner:85683': 'Examiner report of unofficial results in the Village of Pelham, Pelham Manor and Town of Pelham races, as posted by the County Board of Elections; not yet certified. Its Pelham Manor portion was superseded by the Examiner\'s November 8 report that the Manor race is not over.',
  // The pipeline's stored summary of 85777 carried a recount threshold, a
  // "contesting" characterization and party labels.
  'examiner:85777': 'Examiner report that the Pelham Manor trustee race is not over, with unofficial totals as of November 8, 2026; not yet certified.',
};
const LOADED_TITLE = /\b(democrat\w*|republican\w*|gop|neighborhood party|working families|conservative party|manor together|blue wave|red wave|sweep\w*|debacle)\b/i;

function sourceLabelFor(row) {
  const override = SOURCE_LABEL_OVERRIDES[examinerArticleKey(row && row.url)];
  if (override) return override;
  const title = String((row && row.title) || '');
  if (!LOADED_TITLE.test(title)) return title;
  const date = new Date((row && row.published_at) || '');
  return Number.isNaN(date.getTime())
    ? 'Pelham Examiner report'
    : `Pelham Examiner report, ${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`;
}

function summaryFor(row) {
  const override = SUMMARY_OVERRIDES[examinerArticleKey(row && row.url)];
  return override || (row && row.summary);
}

function withSourceLabel(row) {
  return { ...row, title: sourceLabelFor(row), summary: summaryFor(row) };
}

function dedupeArticles(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = examinerArticleKey(row.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Step 3: context injection ---------------------------------------------- #

/**
 * Prepend the retrieved coverage to the newest user message. The messages array
 * is copied rather than mutated, and anything unexpected (no user turn, a
 * non-string content block) falls through to the original conversation.
 */
function withExaminerContext(messages, articles, contested = null, results = false, schedule = false, lookup = false) {
  if (!articles.length && !contested && !results && !schedule && !lookup) return messages;

  const index = messages.map((m) => m && m.role).lastIndexOf('user');
  if (index === -1 || typeof messages[index].content !== 'string') return messages;

  const copy = messages.slice();
  copy[index] = {
    ...messages[index],
    content: `${articles.length ? `${buildContextBlock(articles)}\n\n` : ''}${contested ? `${CONTESTED_REMINDER}\n\n` : ''}${results ? `${RESULTS_REMINDER}\n\n` : ''}${schedule ? `${SCHEDULE_REMINDER}\n\n` : ''}${lookup ? `${LOOKUP_REMINDER}\n\n` : ''}${messages[index].content}`,
  };
  return copy;
}

// Added next to a contested question, where the model weighs it most: the
// system prompt's both-sides rule alone was followed in only some runs.
const CONTESTED_REMINDER = [
  'This question touches a contested election issue. Give each side in',
  'comparable length and detail, attributed by name: what Anzilotti, Long and',
  'Speros say, and the incumbent trustees\' (Solomon, Howell) response from',
  'your sources — or say "No public response is included in our sources".',
  'Never present one side alone, even if the question asks about one side.',
].join('\n');

// Added next to a question about the November 3 results, for the same
// reason: with the rule only in the system prompt, answers tied the totals to
// the Election Day ballot problem and volunteered the Examiner's remark about
// the voter-registration investigation.
/* BUILD:results-snapshot */
const RESULTS_SNAPSHOT = "Nov 5, 2026, updated throughout the day, per the Pelham Examiner";
const MANOR_SNAPSHOT = "Nov 8, 2026, per the Pelham Examiner";
/* /BUILD:results-snapshot */
const RESULTS_REMINDER = [
  'This question is about the November 3 election results. Give only the',
  'unofficial totals on the elections issue card, attributed: "unofficial',
  'results from the Westchester County Board of Elections, as reported by the',
  `Pelham Examiner", with each race's date (Village of Pelham and Town:`,
  `${RESULTS_SNAPSHOT}; Pelham Manor: ${MANOR_SNAPSHOT}). In every answer say`,
  'the results are unofficial, not yet certified, and that counting may not',
  'be complete, and point to westchestercountyny.gov/boe. Point to the full',
  'results tables on this site: pelhamengagementproject.org/elections#results',
  '(cite elections#results). Village of Pelham and Town outcomes only',
  'attributed, in this form: "The Pelham Examiner reported that [candidates]',
  'defeated [candidates], based on unofficial Board of Elections results".',
  'PELHAM MANOR IS NOT FINAL: say only that the Examiner reported on November 8',
  'that the race was not over and that its November 5 report of a Kurtz and',
  'Dlutowski win was premature, with the November 8 totals. Never say or imply',
  'who won, lost or leads in Pelham Manor; never say how far ahead or behind',
  'anyone is; never compute a margin or what anyone would need; never mention',
  'recounts; never speculate about remaining ballots. Only if asked about',
  'remaining ballots, give the Examiner\'s attributed estimate (more than 150,',
  'from an unnamed Neighborhood Party member\'s email) and say this site has',
  'not verified it.',
  'Never say "won", "lost", "defeated", "conceded" or "elected" in your own',
  'voice, never call a result final or official, and never use party framing,',
  '"sweep" or "blue wave". If a resident tells you a result that is not on',
  'the card, do not repeat it as fact. In this answer, do not mention the',
  'Election Day ballot problem, orange bags, delays, or the voter-registration',
  'investigation, unless the resident asks about them.',
].join('\n');

// Questions about who won, who leads or the count. Deliberately broad: the
// reminder only narrows what the answer may say.
const RESULTS_WORDS = /\b(won|win|wins|winning|winner|winners|lose|lost|losing|loser|results?|leading|leads?|ahead|behind|tally|tallies|totals?|vote counts?|count(ing)?|re-?counts?|beat|beaten|defeat(ed)?|conceded?|elected|re-?elected|projected)\b/i;
const RESULTS_CONTEXT = /\b(election|race|trustees?|supervisor|clerk|candidates?|ballots?|vote|votes|seats?|manor|village|town)\b/i;

// Added next to a question about when or where a board meets, for the same
// reason as the results reminder: with the rule only in the system prompt,
// answers gave the schedule but not always the reminder that it can move.
const SCHEDULE_REMINDER = [
  'This question is about when or where a board meets. Give only the schedule',
  'and place listed under "When the boards meet"; never guess a day, time,',
  'place or frequency that is not listed. End the answer with this sentence,',
  'in these words, naming that board\'s website: "Meetings can move; confirm on',
  'the board\'s calendar at <website>."',
].join('\n');

const SCHEDULE_WORDS = /\b(meet|meets|meeting|meetings|schedule|calendar)\b/i;
const SCHEDULE_CONTEXT = /\b(board|trustees?|council|town|village|manor|education|school)\b/i;

function isScheduleQuestion(question) {
  const q = typeof question === 'string' ? question : '';
  return SCHEDULE_WORDS.test(q) && SCHEDULE_CONTEXT.test(q);
}

// Added next to "where do I find" and "how do I contact" questions: with
// the rule only in the system prompt, answers gave the right link and then
// guessed what the page holds ("typically posted on the district's site").
const LOOKUP_REMINDER = [
  'This question asks where to find something or how to contact someone. Give',
  'only the links, phone numbers, emails, addresses and hours that are in this',
  'prompt. Describe each link only by its label: never say what a page',
  'contains, will have or links to, or where something is "typically posted".',
  'If a detail is not in the site\'s data, say so plainly and give the link to',
  'that body\'s website.',
].join('\n');

const LOOKUP_QUESTION = /\b(where (do|can|would|should) (i|we|you|one) (find|get|see|look|read|access)|where (is|are) (the )?(agendas?|minutes|calendar|records?|budgets?|notices?)|how (do|can|would|should) (i|we) (contact|reach|email|call|get in touch with)|contact (info|information|details)|phone number|email address|office hours|hours (of|for)|what are the [\w' ]*hours)\b/i;

function isLookupQuestion(question) {
  const q = typeof question === 'string' ? question : '';
  return LOOKUP_QUESTION.test(q);
}

function isResultsQuestion(question) {
  const q = typeof question === 'string' ? question : '';
  const names = KNOWN_CANDIDATES.concat(['Breda', 'Ryan', 'Chris', 'Dlutowski', 'Rhett']);
  const namesCandidate = names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(q));
  // A recount question is about the results whatever else it names.
  if (/\bre-?counts?\b/i.test(q)) return true;
  return RESULTS_WORDS.test(q) && (RESULTS_CONTEXT.test(q) || namesCandidate);
}

function buildContextBlock(articles) {
  const entries = articles.map((a, i) => [
    `${i + 1}. "${a.title}" — ${formatDate(a.published_at)}`,
    `   ${(a.summary || 'No summary available.').trim()}`,
    `   ${a.url}`,
  ].join('\n'));

  return [
    'Sources relevant to this question (Pelham Examiner coverage, or the sources',
    "listed on this site's issue card for a contested issue):",
    '',
    entries.join('\n\n'),
    '',
    'Use this context to inform your answer and cite these sources where relevant.',
    // Without this the system prompt's Examiner honesty rule applies and the
    // model hedges ("I can't search the Examiner") over articles it is holding.
    'These articles were retrieved and handed to you, so you may cite them',
    'directly — the standing rule about not having searched the Examiner',
    'yourself does not apply to these specific articles. Ignore any of them',
    'that turn out not to bear on the question, and do not list the sources at',
    'the end yourself; that is added for you.',
    // Repeated here from the system prompt's vetted-source rules, because the
    // model weighs instructions next to the question most heavily.
    'In your answer, refer to an article by its title, never by its number;',
    'if none of them bears on the question, do not mention them at all. Never',
    'suggest searching or checking pelhamexaminer.com: if the answer is not',
    'in your sources, say so and point to the relevant official government',
    'website.',
    '',
    // Read by parseUsedSources(). The full rule, including site pages, is in
    // the system prompt's "Citing your sources" section.
    'In your USED_SOURCES line, give the numbers of the articles above that',
    'your answer actually drew on, alongside any site pages, e.g.',
    'USED_SOURCES: issues#rising-property-taxes-village-debt, 2',
  ].join('\n');
}

function formatDate(value) {
  if (!value) return 'date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unknown';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// --- Step 4: source attribution --------------------------------------------- #

/**
 * Read and remove the model's "USED_SOURCES:" line (see buildContextBlock).
 * Returns the answer without it, and the 1-based numbers of the retrieved
 * articles to cite, in order, without repeats.
 *
 * Fails toward citing nothing: a missing line, "none", or anything that is not
 * a plain list of numbers cites no sources. Numbers outside 1..count are
 * dropped and the in-range ones kept. If the line appears more than once, the
 * last one counts, and every copy is removed from the text.
 */
const USED_SOURCES_LINE = /^[ \t]*\**USED_SOURCES\**:\**[ \t]*(.*?)[ \t]*$/gim;
function parseUsedSources(answer, count) {
  const raw = typeof answer === 'string' ? answer : '';
  const matches = [...raw.matchAll(USED_SOURCES_LINE)];
  const text = raw.replace(USED_SOURCES_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  const nothing = { text, used: [], pages: [] };
  if (!matches.length) return nothing;

  const value = matches[matches.length - 1][1].trim().replace(/[.\s]+$/, '');
  if (!value || /^none$/i.test(value)) return nothing;

  // Each item is an article number or a site page key ("elections",
  // "issues#<card id>", "meetings#<meeting id>"; see SITE_PAGES and
  // SITE_ANCHORS). An anchor that does not exist on a real page falls back to
  // the page. Anything else makes the whole line malformed: cite nothing.
  const used = [];
  const pages = [];
  for (const part of value.split(/\s*,\s*/)) {
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count && !used.includes(n)) used.push(n);
      continue;
    }
    const key = part.toLowerCase().replace(/^\/+/, '');
    const page = SITE_ANCHORS[key] || SITE_PAGES[key] ? key
      : (SITE_PAGES[key.split('#')[0]] && key.includes('#') ? key.split('#')[0] : null);
    if (!page) return nothing;
    if (!pages.includes(page)) pages.push(page);
  }
  return { text, used, pages };
}

/** "• <title> — <url>" for a site page key, e.g. "issues#rising-…". */
function sitePageLine(key) {
  const title = SITE_ANCHORS[key] || SITE_PAGES[key] || key;
  return `• Pelham Engagement Project — ${title} — ${SITE_URL}/${key}`;
}

/**
 * Append the sources the answer was given. Plain text, not markdown: the page
 * renders answers with escapeHtml() and a newline-to-<br> pass, so a markdown
 * link would show up as literal brackets.
 */
// A URL in answer text: stops at whitespace and at characters that cannot end a
// link in prose. Trailing punctuation is trimmed off before checking.
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Remove any URL from the answer text that is not a vetted source. The model
 * can still see some URLs in its instructions; this stops it repeating one.
 */
function stripUnvettedUrls(text, onBlocked) {
  return text.replace(URL_IN_TEXT, (match) => {
    const url = match.replace(/[.,;:!?]+$/, '');
    if (isAllowedSource(url)) return match;
    onBlocked(url);
    return '[non-vetted link removed]' + match.slice(url.length);
  });
}

// Editorial markers in the meeting summaries ([VERIFY], "[name unconfirmed
// …]") are for reviewers. The prompt says never to print them; this removes
// any that slip through anyway.
const SOURCE_MARKER = /[ \t]*\[(?:VERIFY|[^\]\n]{0,60}\b(?:unconfirmed|unverified)\b[^\]\n]{0,60})\]/gi;
function stripSourceMarkers(text) {
  return String(text || '').replace(SOURCE_MARKER, '');
}

function withSources(rawAnswer, articles, pinnedPages = [], onBlocked = () => {}) {
  const { text: parsed, used, pages } = parseUsedSources(rawAnswer, articles.length);
  const answer = stripSourceMarkers(stripUnvettedUrls(parsed, onBlocked));
  // Only the articles the model says it drew on. Retrieval returns the newest
  // matches, not the relevant ones, so citing everything retrieved listed
  // candidate statements under answers that said "I don't have that".
  // Citation-time gate: an unvetted source is never cited, however it got here.
  const cited = used.map((n) => articles[n - 1]).filter((a) => {
    if (a && isAllowedSource(a.url)) return true;
    onBlocked(a && a.url);
    return false;
  });
  // Site pages: any pinned by the caller (a contested issue's card) first,
  // then those the model named. A page's own anchor makes the bare page
  // redundant ("issues" beside "issues#rising-…").
  let keys = [...pinnedPages, ...pages].filter((k, i, all) => all.indexOf(k) === i);
  keys = keys.filter((k) => k.includes('#') || !keys.some((o) => o.startsWith(`${k}#`)));
  const lines = [...keys.map(sitePageLine), ...cited.map((a) => `• ${a.title} — ${a.url}`)];
  if (!lines.length || !answer.trim()) return answer;

  const block = ['Sources:', ...lines].join('\n');

  // index.html parses a trailing "DEEPER_PROMPT:" marker greedily to the end of
  // the string, so the block has to go BEFORE that line — appended after it,
  // the sources would be swallowed into the "Want to go deeper?" box and get
  // copied into the reader's Claude.ai prompt.
  const marker = answer.search(/\n?DEEPER_PROMPT:/);
  if (marker === -1) return `${answer.trimEnd()}\n\n${block}`;
  return `${answer.slice(0, marker).trimEnd()}\n\n${block}\n\n${answer.slice(marker).trim()}`;
}

// Pure helpers, exported for the unit tests in tests/ask-functions.spec.js.
// Netlify only calls `handler`.
exports._test = { isLookupQuestion, stripSourceMarkers, sourceLabelFor, summaryFor, isScheduleQuestion, withExaminerContext, todayLine, isResultsQuestion, parseUsedSources, withSources, stripUnvettedUrls, extractSearchTerms, extractProperNouns, buildSearchPlan, dedupeArticles, contestedIssueFor, sitePageLine };
