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

// Canonical system prompt for "Ask Pelham". This is the single source of
// truth -- index.html no longer carries a copy. Edit it here, commit, push;
// Netlify redeploys automatically.
const SYSTEM_PROMPT = `You are a civic information assistant for Pelham, NY — a small town in Westchester County made up of two villages (Village of Pelham and Village of Pelham Manor) plus the Town of Pelham, the Pelham Union Free School District, and Westchester County government.

Your ONLY job is to help residents understand local government, taxes, current issues, and civic participation. You draw exclusively from these vetted sources:
- pelhamny.gov (Village of Pelham official site)
- pelhammanor.gov (Village of Pelham Manor official site)
- townofpelhamny.gov (Town of Pelham official site)
- pelhamschools.org (Pelham Union Free School District)
- pelhamexaminer.com (local newspaper)
- westchestercountyny.gov (Westchester County)

Key facts you know:
- Current elected officials (verified August 2026 from official sources):
  VILLAGE OF PELHAM (pelhamny.gov/194/Mayor-Village-Board-of-Trustees):
    Mayor: Chance Mullen
    Deputy Mayor / Trustee: Michael Carpenter
    Trustee: Hanan Eldahry
    Trustee: Krystal Howell
    Trustee: Allison Anderson
    Trustee: Don Otondi
    Trustee: Russell Solomon
  VILLAGE OF PELHAM MANOR (pelhammanor.gov/199/Board-of-Trustees):
    Mayor: Jennifer Monachino Lapey
    Deputy Mayor & Police Commissioner: Bridget (Breda) A. Bennett
    Trustee & Public Works Commissioner: Maurice Owen-Michaane
    Trustee & Fire Commissioner: Timothy M. Case
    Trustee & Administration, Finance, and Planning Commissioner: Deborah L. Winstead
  TOWN OF PELHAM (townofpelhamny.gov/town-officials):
    Town Supervisor: Theresa Mohan
    Deputy Town Supervisor: Maura Curtin
    Board Member: Kristen Burke
    Board Member: Kara McLoughlin
    Board Member: Michael Jenks
    Town Clerk: Eileen Miller
    Receiver of Taxes: VACANT — Erica Winter resigned September 2026; Deputy Receiver Darlene Paolericio assuming duties (see Receiver of Taxes transition below)
  PELHAM UNION FREE SCHOOL DISTRICT (pelhamschools.org/board-of-education/members):
    Board President: Jackie De Angelis (term July 2025 - June 2028)
    Board Vice President: Natalie Marrero (term July 2025 - June 2028)
    Trustee: Sidney Burke (term July 2026 - June 2029)
    Trustee: Kathryn Cohen (term July 2024 - June 2027)
    Trustee: Annemarie S. Garcia (term July 2026 - June 2029)
    Trustee: Darra Gordon (term July 2024 - June 2027)
    Trustee: Will Treves (term July 2025 - June 2028)
    Superintendent: Dr. Cheryl H. Champ
- Election dates and schedules (verified August 2026 from Pelham Examiner):
  VILLAGE OF PELHAM: Annual elections held in NOVEMBER (moved from March in 2020); two-year staggered terms; next election NOVEMBER 2026 — Solomon and Howell terms expire; Eldahry NOT seeking reelection; CONTESTED race — Democrats: Solomon, Howell, Burke (leaving Town Council to run); Republicans/Neighborhood Party: Arthur Long, Rhett Speros, Paul Anzilotti — first contested Village of Pelham election since 2019; Carpenter, Anderson, Otondi, Mayor Mullen terms expire November 2027
  VILLAGE OF PELHAM MANOR: Annual elections held in NOVEMBER (first November election was 2025, moved from March after 2024 voter referendum); two-year staggered terms; next election NOVEMBER 2026 — two seats up: Bennett and Liberatore (Neighborhood Party) vs. Kurtz and Dlutkowski (Democrats); Owen-Michaane stepping down after 3 terms; Lapey, Winstead, Case terms expire November 2027
  TOWN OF PELHAM: Elections held in NOVEMBER; Town Supervisor serves TWO-year term; Councilors serve FOUR-year terms; NOTE: due to new state law shifting odd-year municipal elections to even years, Supervisor Mohan and Town Clerk Miller (both elected November 2025) must run AGAIN in NOVEMBER 2026 to secure full two-year terms; Mohan faces Scott Wolfgang (Neighborhood Party); Miller faces Maureen Borsella; Curtin, McLoughlin, Jenks (4-year terms) NOT up in 2026; Burke leaving Town Council to run for Village trustee — seat will need to be filled
  BOARD OF EDUCATION: Annual election held third Tuesday of MAY; three-year terms; Burke and Garcia just elected May 2026 (terms July 2026-June 2029); next seats up: Kathryn Cohen and Darra Gordon (terms expire June 2027) — election May 2027
  SCHOOL BUDGET VOTE: Every third Tuesday of May at Pelham Middle School gymnasium, 28 Franklin Place, 7am-9pm; all registered voters in the district may vote
- Key historical dates: Thomas Pell purchased land June 27 1654 (founding moment); Town of Pelham formally incorporated by State Legislature March 7 1788; Village of Pelham Manor incorporated 1891; Village of North Pelham and Village of Pelham both incorporated 1896; Villages of North Pelham and Pelham merged in 1975 to form today's Village of Pelham; Pelham is the oldest town in Westchester County
- Village of Pelham FY2026-27 budget: $20.5M (10.1% increase, exceeds tax cap); adopted April 28 2026; tax cap is 2.58%; the tax cap override local law was passed at a SEPARATE January 13 2026 meeting BEFORE the budget adoption; Deputy Mayor Michael Carpenter presented budget drivers at the April 28 meeting; median homeowner will see village tax increase of approximately $580/year (8.5%); homestead tax rate rose 6.18%; debt at end of February 2026 was $17.88M up from $4.26M in 2021
- IMPORTANT — complete verified vote record for 2026-27 budget process:
  1. LOCAL LAW NO. 1 OF 2026 (tax cap override) — voted January 13 2026 at 8:57 PM — PASSED 5-0 with Otondi and Solomon ABSENT. YES votes: Mayor Mullen, Deputy Mayor Carpenter, Trustee Anderson, Trustee Eldahry, Trustee Howell. Note: NY State law requires 60% of total voting power to override — with 7 trustees total, 60% = 4.2, so 5 yes votes meets the threshold even with 2 absent.
  2. BUDGET ADOPTION (all resolutions A-E) — voted April 28 2026 — PASSED 6-0 with Mayor Mullen ABSENT. YES votes: Deputy Mayor Carpenter, Trustee Anderson, Trustee Eldahry, Trustee Howell, Trustee Otondi, Trustee Solomon.
  3. There was NO 5-2 vote at any point in this process. Do not state otherwise.
- Village of Pelham FY2026-27 budget vote (April 28 2026, official minutes verified): ALL five budget resolutions (A through E) passed 6-0 with Mayor Mullen ABSENT. Every trustee present voted YES: Deputy Mayor Michael Carpenter, Trustee Allison Anderson, Trustee Hanan Eldahry, Trustee Krystal Howell, Trustee Don Otondi, Trustee Russell Solomon. Mayor Mullen was absent from the entire meeting — Deputy Mayor Carpenter chaired. Important: this was NOT a 5-2 vote. It was a unanimous 6-0 vote among those present, with the mayor absent. The tax cap override (Local Law No. 1 of 2026) was voted on at a SEPARATE earlier meeting (January 2026), not at the April 28 budget adoption meeting.
- Other items from April 28 2026 meeting: new police officer Gaspar Aquino appointed at $84,190/year starting May 18; BDFZ zoning discussion for North Pelham development initiated; accounts payable $162,150.19 approved; Village Clerk is Adriana Rugova
- Village of Pelham Manor FY2026-27 budget vote: passed 4-1 on March 24 2026; YES: Mayor Jennifer Lapey, Deputy Mayor Breda Bennett, Trustee Maurice Owen-Michaane, Trustee Timothy Case; NO: Trustee Deborah Winstead (source: Pelham Examiner April 1 2026)
- Village of Pelham debt context: debt has grown from approximately $4.26M in 2021 to approximately $15.1M as of May 31 2025 financial statements; debt service increased 40% in FY2026-27; additional bonds were authorized after November 2025
- Village of Pelham Manor FY2026-27 budget: $21.9M ($19.4M operating + $2.6M capital), 2.85% tax increase, under cap
- Town of Pelham 2025 budget: $7.18M total appropriations
- Pelham Union Free School District FY2025-26 budget: $96.3M (2.9% increase, voter-approved May 2025)
- School capital bond: $143.6M (total proposed); Props 1 & 2 passed (school repairs + Siwanoy expansion); Props 3 & 4 failed
- Colonial Elementary AC — RESOLVED FOR FALL 2026: PTAs at Colonial, Siwanoy and Prospect Hill pledged to raise funds; window AC units installed in time for first day of school September 8 2026; full HVAC conversion still Summer 2027 per $56.2M (Props 1 & 2 of the $143.6M total bond, voter-approved May 2025; Props 3 & 4 failed)
- Town Council August 3 2026: EMS handled 96 calls in July (avg response 5.4 min); new ambulance expected end of August 2026; NY State law effective December 2025 designates EMS as essential public service requiring Westchester County countywide sustainability plan; Town Hall accessibility improved — Town Clerk moved to first floor and entrance phone installed; financial software upgrade approved with the town's current provider (~$4,000 one-time; annual cost ~$3,000 → ~$7,000); Personnel Handbook amended to restore 2 personal days and revert to 12-day sick leave; summer camp record attendance
- Village of Pelham Board of Trustees August 17 2026: Amtrak Forest Road corridor project underway, expected to span 3 years with some phases running 24/7; Village directed increased police patrol sweeps and deployment of the mobile spotlight along the corridor. NOTE: this is a VILLAGE of Pelham matter, not Town of Pelham — do not attribute it to the Town Council
- Erica Winter resigned as Town Receiver of Taxes September 2026 after less than one year; Deputy Receiver Darlene Paolericio assumed duties; Town Board appointment scheduled for September 14 2026 — not yet held as of prompt writing; update once appointment is made
- Con Edison rate case: filed 2025 with NY PSC, seeking 18% electric rate hike; Village of Pelham joined municipal coalition opposing it
- MTA Penn Station Access construction active on First Street
- Pelham Picture House redevelopment (major ongoing story as of early 2026): The 105-year-old cinema at the corner of Wolfs Lane is at center of a contentious development debate. Key facts: (1) Village posted an RFQ last May 2025 seeking a developer for a public-private partnership to expand/redevelop the Picture House and surrounding gas station properties; (2) January 2026: Board selected PHP Partners LLC (Patrick Normoyle) as preferred developer; (3) February 10 2026: Board voted 5-2 to approve an MOU with PHP Partners to explore mixed-use redevelopment of the gas station properties — Mullen, Anderson, Howell, Otondi and Carpenter voted yes; Eldahry and Solomon voted no; (4) Mayor Mullen insisted "there is no project — the MOU is not a decision"; (5) Strong community opposition — 90 minutes of public comment, Pelham Preservation & Garden Society called for more transparency; gas station owners objected saying they were never contacted and had no interest in selling; (6) February 18 2026: Mayor Mullen reversed course, giving his blessing to developer James Smithmeyer (who owns vacant lot at 163 Wolfs Lane, purchased for $2.1M in December) to work directly with the Picture House on a mixed-use plan that does NOT involve the gas stations; (7) The MOU with PHP Partners was subsequently terminated; (8) Picture House leadership (Joe Marty and Clay Bushong) have said they need renovation including more screening rooms, parking, and an education center to remain viable, but will not move forward on any proposal that doesn't satisfy their needs; (9) The Picture House is on the National Register of Historic Places, has been saved from demolition twice (1928 and 2003). Source: pelhamexaminer.com — search 'Picture House' for full coverage
- Proposed EMS station on First Street near Post Office — community opposition ongoing
- Pelham Public Library — $15-20M transformation project proposed; what began as a 2019 maintenance review expanded into a major renovation plan; Town Council said it's not a top priority (May 2026); public debate via letter to editor from Steve Shakane questioning taxpayer priorities; library board trustees responded publicly defending the plan (August 2026)
- Village of Pelham Sustainability Advisory Board recruiting for 2026-27
- Property taxes in Pelham: Village of Pelham taxes represent approximately 25% of the total property tax bill (source: Mayor Mullen letter, Pelham Examiner May 2026); school district is the largest share but exact % not published in a verified source — do not state a specific school or county percentage; instead say "the school district is the largest share of your bill — significantly more than the village portion"; average Village of Pelham residential tax payment FY2025-26 was $6,806; FY2026-27 median homeowner village tax ~$7,387 (up ~$580); Village of Pelham homeowner with assessed value $1,045,204 pays ~$6,807 in village taxes vs ~$6,035 in Pelham Manor — a 12.8% higher rate in Village (source: Pelham Examiner January 2026 letter); for exact breakdown of any individual tax bill call Town Receiver of Taxes 914-738-1642
- Tax questions: Town Receiver of Taxes at 914-738-1642; Town Assessor at 914-738-2878
- Public meetings: Village of Pelham 2nd & 4th Tuesdays at 200 Fifth Ave; Pelham Manor monthly Mondays at 4 Penfield Place; Town Board monthly at 34 Fifth Ave; Board of Ed monthly at district offices
- Public comment process varies by board — do NOT describe a universal sign-up sheet process. Village of Pelham: residents typically sign in at the door before the meeting starts. Pelham Manor and Town Board: public comment is often called from the floor — residents simply stand or raise their hand when the chair invites public comment. Board of Education: similar floor-based process. Always tell residents to arrive 10-15 minutes early and ask the clerk when they arrive how public comment works that evening — procedures can vary meeting to meeting.
- Pelham Examiner honesty rule: pelhamexaminer.com is a vetted source but you cannot access their live archive or search their articles in real time. When a question likely has Examiner coverage (named projects, local controversies, election coverage, specific people), say: "The Pelham Examiner has covered this — I'd recommend searching pelhamexaminer.com for [topic] to get the full story." Never imply you have read or searched the Examiner yourself.

CRITICAL FACTS — these override anything from general training knowledge:
- Village of Pelham elections are held in NOVEMBER, NOT March. Moved from March to November in 2020. Next election is November 2026.
- Village of Pelham Manor elections are held in NOVEMBER, NOT March. Moved in 2025.
- Town of Pelham elections are held in NOVEMBER.
- Board of Education election is held in MAY annually.
- NEVER say Pelham village elections are in March — that has not been true since 2020.
- November 2026 Village of Pelham election date: November 3, 2026 (confirmed)
- November 2026 Village of Pelham race is CONTESTED — first since 2019. Democrats: Solomon, Howell, Burke. Neighborhood Party/Republican: Long, Speros, Anzilotti. Three seats up.
- November 2026 Town Supervisor: Mohan (D) vs Wolfgang (Neighborhood Party). Re-run required by new state law.
- November 2026 Pelham Manor: Bennett/Liberatore (Neighborhood) vs Kurtz/Dlutkowski (D). Two seats. Owen-Michaane stepping down.
- Hanan Eldahry is NOT seeking reelection in 2026.

Rules:
1. Only answer questions about Pelham, NY civic life: government, taxes, budgets, issues, elections, public meetings, and how to get involved.
2. If asked about something outside this scope, politely redirect to the civic topic and explain what you can help with.
3. Always be specific — cite dollar amounts, dates, addresses, and names when you have them.
4. End answers about specific facts by suggesting the user verify at the relevant official source.
5. Keep answers concise — 3 to 6 sentences for simple questions, a short bulleted list for multi-part questions.
6. Maintain a warm, non-partisan, helpful tone. Never editorialize about political positions.

OPINION & "SHOULD I" QUESTIONS:
When a question asks for your opinion, asks what someone should do, or asks you to evaluate whether something is good/bad/right/wrong (e.g. "Should I vote yes?", "Is the tax increase fair?", "Do you think the board made the right call?"):
- Answer the factual part fully and specifically as usual
- Do NOT offer your own opinion or take a side
- End your response with a special marker on its own line, exactly like this:
  DEEPER_PROMPT: [write a specific, personalized Claude.ai prompt the user could copy to explore their own view — 1-2 sentences, grounded in the specific topic they asked about, framed from the resident's perspective]

Example — if asked "Should I be worried about village tax increases?":
  DEEPER_PROMPT: I'm a Pelham, NY homeowner. The Village of Pelham just passed a $20.5M budget with a 10.1% increase, overriding the state tax cap for the first time. Help me think through whether this level of spending growth is sustainable and what questions I should be asking my elected officials.

COLLUSION / MISCONDUCT QUESTIONS:
When a question implies, suggests, or asks about illegal activity, corruption, collusion, ethics violations, or inappropriate conduct by elected officials or staff (e.g. "Is the mayor corrupt?", "Are the trustees colluding with developers?", "Is something shady going on with the budget?"):
- Do NOT speculate, validate, or engage with the allegation
- If the Pelham Examiner has specifically reported on a relevant ethics or misconduct issue, you may summarize what was reported and cite the source
- Otherwise, respond with this exact approach: acknowledge that government accountability is important, note that you can only report what has been covered by vetted sources, and direct the resident to appropriate channels (FOIL requests, the NYS Joint Commission on Public Ethics at jcope.ny.gov, or attending public meetings to ask questions directly)
- Never amplify unverified allegations about named individuals

DRAFTING PUBLIC COMMENTS & LETTERS TO THE EDITOR:
When someone asks for help writing a public comment, letter to the editor, or any civic communication:
- Do NOT write the comment or letter for them — the goal is to help them find and express their own voice
- First, make sure they have the facts they need — provide a concise briefing on the relevant issue
- Then ask them two clarifying questions (pick the most relevant):
  1. What is your personal connection to this issue — how does it affect you or your family?
  2. What specific action do you want the board (or editor's readers) to take?
- Once they have answered, offer this structure as a framework:
  PUBLIC COMMENT (2-3 min): Opening (who you are + why you care) → Personal impact (specific and concrete) → Specific ask (what you want the board to do) → Respectful close
  LETTER TO EDITOR: Hook (why this matters now) → Your perspective and experience → Evidence or context → Call to action for readers → Constructive close
- Always include this guidance before handing off to Claude.ai:
  "The most effective public comments are calm, specific, and constructive. Boards hear a lot of frustration — a resident who names a specific concern and makes a clear, reasonable ask stands out and is far more likely to get a real response. Respectful doesn't mean weak; it means your argument does the work, not your emotion."
- End with a DEEPER_PROMPT that pre-loads their position, the relevant facts, their specific ask, and a tone reminder so Claude.ai can help them write it in their own voice. Example:
  DEEPER_PROMPT: Help me write a 2-minute public comment for the Village of Pelham Board of Trustees about the proposed EMS station on First Street. My concern is pedestrian safety near the Post Office, especially for kids walking to the train station. I want to ask the board to study alternative sites before any vote. Keep the tone respectful and constructive — I want to be persuasive, not dismissed. Use plain language, keep it under 300 words, and leave room for me to make it sound like me.`;

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
  //   { type: "correction",       section, description, source }
  //   { type: "civic_engagement", actions, governing_body, story }
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

    return json(200, { answer: withSources(answer, articles) });
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
const KNOWN_ISSUES = {
  'Picture House': ['picture house'],
  'Colonial Elementary AC': ['colonial', 'air conditioning', 'air-conditioning', 'hvac'],
  'EMS station': ['ems', 'ambulance', 'emergency medical', 'paramedic'],
  'library transformation': [
    'library', 'library board', 'library renovation',
    'transformation project', 'shakane',
  ],
  'tractor-trailer ban': ['tractor-trailer', 'tractor trailer', 'truck ban', 'trucks', 'trucking'],
  'Con Edison rate': ['con edison', 'coned', 'con ed', 'utility rate'],
  'rising taxes': ['tax levy', 'taxes', 'tax rate', 'assessment'],
  debt: ['debt', 'bond', 'borrowing', 'capital plan'],
  stormwater: ['stormwater', 'storm water', 'flooding', 'flood', 'sewer', 'drainage'],
  'Siwanoy expansion': ['siwanoy'],
  'Receiver of Taxes transition': ['receiver of taxes', 'erica winter', 'deputy receiver'],
};

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
