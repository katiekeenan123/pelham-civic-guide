# Pelham Civic Guide — working rules

See README.md for the full commands table and where content lives.

## Before committing

1. `npm run build:check` — must pass. If it fails, run `npm run build` and
   commit the generated output; never edit `index.html` by hand.
2. `npm run test:local` — must pass.
3. `npm run verify:sources` — **always run before pushing.** It exits 0 even
   when it finds problems, so read the summary. Investigate any new 404 or
   homepage-only citation before committing: fix the URL, or say in the
   commit message why it stays.

## Village site verification

pelhamny.gov and pelhammanor.gov block some automated tools, so
`verify:sources` reports them as `403 Forbidden` rather than checking them.
Route verification of those pages through Claude Code, not the chat
interface: do it here, where the result can be checked against the content
files and committed together with any correction.

## Editorial workflow

When making site updates in response to Pelham Examiner articles (candidate
profiles, issue cards, etc.):

1. Make the site change (edit JSON, run build, test, commit, push)
2. Mark the article as actioned in the pipeline:

   ```
   cd C:\Users\kathe\pelham-civic
   python check_examiner.py --mark-actioned <article-id> --note "brief description of what was updated"
   ```

The article ID appears in the daily Examiner digest email and in
`python check_examiner.py --pending`. It is the pipeline's ID (a UUID, or its
first 8+ characters), not the number in the Examiner URL.

Never leave an actioned update without marking it in the pipeline — the
Sunday editorial review depends on it.

## Candidate profile update standard

Candidate profiles are updated ONLY from these sources:

1. Published Pelham Examiner articles
2. Official public records (election results, official rosters, meeting minutes)

Campaign websites are NOT used as sources — they are self-published and
unverified.

Direct candidate outreach is a tip to investigate, not a source. When a
candidate contacts the site with a correction:

1. Search the Examiner and public records to verify the claim
2. If verified, update the profile and cite the published source
3. If unverified, respond asking them to publish a statement in the Examiner
   first

Never update a candidate profile based solely on direct outreach without a
published source.

## Election results update standard

Applies whenever results are added or changed, whatever the source article
says or how it frames the outcome. (The same list is `RESULTS_STANDARDS` in
`pelham-civic/check_examiner.py`, which appends it to every suggested
results update; keep the two in step.)

- **Replace** the existing results paragraph on the November 2026 elections
  issue card (`issues.json`, id `november-2026-elections`); never append a
  second one.
- **Results only:** every total in the article, for every contest, with
  outcomes attributed to the Examiner ("the Examiner reported that X
  defeated Y"), labeled unofficial and not certified.
- **Never include** party labels, "sweep", "blue wave", national-politics
  framing, candidate quotes, or remarks explaining why the results came out
  as they did (voter motivation, political commentary, the
  voter-registration investigation), even when the article has them.
  Factual caveats attributed to the Examiner, such as outstanding absentee
  ballots, and direct consequences such as the Town Council vacancy, stay.
- **Status label stays neutral:** "Unofficial results reported in all races —
  not yet certified by the County Board of Elections".
- **One commit updates everything that carries the results:** the AI results
  rule (`content/prompt-template.md`, and `RESULTS_REMINDER` in
  `netlify/functions/ask-pelham.js`); the single snapshot date
  (`facts.json` `election-results-snapshot-2026`, read by the card, the AI
  rule, the home banner and the Elections page); the home banner
  (`elections.json` `results_banner`, `scripts/build.js`
  `generateElectionsBanner`); the Elections page Results box
  (`elections.json` `voter_info`); and the tests (`tests/ask-functions.spec.js`,
  `tests/ui.spec.js`).
- **Verify every number** against the article's tables before committing.
