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
// Q&A logging active — review after 30 days and decide whether to keep.
// Every answered question is also written to the Supabase `qa_log` table with
// the full answer and the caller's per-page-load session_id, so the first
// month of real traffic can be read back and used to find gaps in the
// content. This is a launch-period diagnostic, not a permanent feature: it is
// the one table here that records what residents asked rather than what they
// chose to submit, so it should be switched off or justified once the thirty
// days are up. It stops on its own: logQa() holds a hard cutoff of October
// 24, 2026 and writes nothing after it. See logQa() below.
//
// RETRIEVAL (RAG): before calling Anthropic, the newest user question is
// matched against the Supabase `articles` table -- Pelham Examiner coverage
// tagged nightly by the check_examiner.py pipeline in the companion repo. Any
// hits are prepended to that question as context and listed back to the reader
// as "Sources:". The whole retrieval path is best-effort: a missing env var, a
// slow database or an empty result set all fall through to the plain answer,
// and the reader never sees an error from it. The anon key is enough here
// because this is a read of an already-public table.

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
  //   { type: "civic_engagement", feedback_type, actions, governing_body, story }
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
  // request proceeds as an ordinary prompt-only answer.
  const articles = await findExaminerCoverage(latestQuestion(messages));

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
        system: SYSTEM_PROMPT,
        messages: withExaminerContext(messages, articles),
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

    const delivered = withSources(answer, articles);
    // Q&A logging active — review after 30 days and decide whether to keep.
    await logQa(latestQuestion(messages), delivered, body.session_id, event.headers);
    return json(200, { answer: delivered });
  } catch (err) {
    return json(502, { error: 'Upstream request failed', detail: String(err) });
  }
};

// Q&A logging active — review after 30 days and decide whether to keep.
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

// 30-day Q&A logging period ends October 24, 2026 — review qa_log table and
// decide whether to extend or make permanent.
//
// A hard stop rather than a reminder. A comment asking someone to switch this
// off in a month only works if someone reads it in a month, and this is the
// one table that records what residents asked rather than what they chose to
// submit — so it should stop on its own and require a deliberate act to
// restart. Past the cutoff logQa returns before it builds a row; answers are
// unaffected, and the table simply stops growing.
//
// To extend, move this date. To make it permanent, delete the constant and
// the guard below, and say so in supabase/grants.sql.
//
// End of October 24 in Pelham's own timezone (EDT, UTC-4) rather than UTC
// midnight, which would cut four hours off the final day.
const QA_LOG_UNTIL = Date.parse('2026-10-25T04:00:00Z');

async function logQa(question, answer, sessionId, headers) {
  try {
    if (Date.now() >= QA_LOG_UNTIL) return;
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
/* BUILD:known-issues */
const KNOWN_ISSUES = {
  'Picture House': ['picture house', 'php partners', 'smithmeyer', 'wolfs lane'],
  'Colonial Elementary AC': ['colonial', 'colonial elementary', 'air conditioning', 'air-conditioning', 'hvac', 'prospect hill'],
  'EMS station': ['ems', 'ems station', 'ambulance', 'emergency medical', 'paramedic', 'first street', 'community church'],
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
]);

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
        const rows = await runSearch(supabase, step, controller.signal);
        if (rows.length) return rows;
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
      .gte('relevance_score', step.minRelevance || RAG_MIN_RELEVANCE),
  )
    .order('published_at', { ascending: false })
    .limit(RAG_LIMIT)
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

// --- Step 3: context injection ---------------------------------------------- #

/**
 * Prepend the retrieved coverage to the newest user message. The messages array
 * is copied rather than mutated, and anything unexpected (no user turn, a
 * non-string content block) falls through to the original conversation.
 */
function withExaminerContext(messages, articles) {
  if (!articles.length) return messages;

  const index = messages.map((m) => m && m.role).lastIndexOf('user');
  if (index === -1 || typeof messages[index].content !== 'string') return messages;

  const copy = messages.slice();
  copy[index] = {
    ...messages[index],
    content: `${buildContextBlock(articles)}\n\n${messages[index].content}`,
  };
  return copy;
}

function buildContextBlock(articles) {
  const entries = articles.map((a, i) => [
    `${i + 1}. "${a.title}" — ${formatDate(a.published_at)}`,
    `   ${(a.summary || 'No summary available.').trim()}`,
    `   ${a.url}`,
  ].join('\n'));

  return [
    'Recent Pelham Examiner coverage relevant to this question:',
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
 * Append the sources the answer was given. Plain text, not markdown: the page
 * renders answers with escapeHtml() and a newline-to-<br> pass, so a markdown
 * link would show up as literal brackets.
 */
function withSources(answer, articles) {
  if (!articles.length || !answer.trim()) return answer;

  const block = ['Sources:', ...articles.map((a) => `• ${a.title} — ${a.url}`)].join('\n');

  // index.html parses a trailing "DEEPER_PROMPT:" marker greedily to the end of
  // the string, so the block has to go BEFORE that line — appended after it,
  // the sources would be swallowed into the "Want to go deeper?" box and get
  // copied into the reader's Claude.ai prompt.
  const marker = answer.search(/\n?DEEPER_PROMPT:/);
  if (marker === -1) return `${answer.trimEnd()}\n\n${block}`;
  return `${answer.slice(0, marker).trimEnd()}\n\n${block}\n\n${answer.slice(marker).trim()}`;
}
