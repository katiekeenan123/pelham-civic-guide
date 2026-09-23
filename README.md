# Pelham Civic Guide

A guide to local government in Pelham, NY — how the two villages, the Town, the
school district and Westchester County fit together; where property taxes go;
current issues; AI-generated summaries of every public meeting; and an "Ask
Pelham" assistant backed by Claude.

Live at **pelhamengagementproject.netlify.app**. Planned work is in
[ROADMAP.md](ROADMAP.md).

---

## ⚠️ Never edit `index.html` by hand

`index.html` is **generated**. So is the AI's system prompt, and part of
`netlify/functions/ask-pelham.js`. Edit the JSON in `content/`, then run
`npm run build`. A hand edit inside a `<!-- BUILD:… -->` region is silently
overwritten on the next build, and `npm run build:check` will fail in the
meantime.

Everything *outside* those regions — page layout, CSS, the site's own
JavaScript — is hand-written and safe to edit directly.

---

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Regenerates `index.html`, the system prompt, and `KNOWN_ISSUES` from `content/` |
| `npm run build:check` | Generates in memory and exits non-zero if anything differs from what's committed. **The CI guard.** |
| `npm run test:local` | Builds, serves the working tree, runs the UI tests against it |
| `npm test` | Runs UI **and** AI tests against the deployed Netlify site |
| `npm run test:ai` | The AI tests only — live Anthropic calls, so slower and not free |

Use `test:local` while working; it's the only one that tests uncommitted
changes. `npm test` tests production.

---

## Where the content lives

```
content/
├── facts.json          every figure that appears more than once
├── bodies.json         the five governing bodies
├── officials.json      who holds which seat
├── issues.json         current-issue cards (+ AI retrieval keywords)
├── elections.json      races and candidates
├── meetings.json       meeting metadata
├── taxes.json          the tax-breakdown panel
├── sources.json        the vetted-source list
├── quick-reference.json  "who to call for what"
├── hero.json           the four hero statistics
├── prompt-template.md  hand-written half of the AI system prompt
├── meetings/           24 HTML partials — the meeting summaries themselves
└── schema/             one JSON Schema per data file
```

Every data file is validated against its schema on each build, so a typo'd
field name or a bad enum fails loudly rather than producing broken HTML.

**`facts.json` is the important one.** Any figure used in more than one place
lives there once and is referenced as `{{fact:village-budget-fy2627}}`. Change
the budget in `facts.json` and the hero stat, the issue card, the tax panel,
the Who Governs card and the AI's system prompt all update together. An unknown
token fails the build.

### Adding a meeting

1. Drop the three summary files into `content/meetings/` as
   `<id>.exec.html`, `<id>.detailed.html`, `<id>.transcript.html`
2. Add an entry to `content/meetings.json`
3. `npm run build`

Only the most recent meeting per board gets a selector button; older ones stay
in the page for the future archive. That's derived from the dates, so
publishing a newer meeting retires the previous one with no extra step.

---

## The Ask Pelham assistant

The browser POSTs to `/api/ask`, which `netlify.toml` rewrites to
`netlify/functions/ask-pelham.js`. That function holds the API key and the
system prompt; the browser never sees either.

Before answering, it matches the question against Pelham Examiner coverage
stored in Supabase and prepends anything relevant. Matching is an exact-string
lookup, not a similarity search — no embeddings involved.

Environment variables (Netlify → Site configuration → Environment variables):

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | the chat itself |
| `SUPABASE_URL` | article retrieval + form submissions |
| `SUPABASE_ANON_KEY` | same |

Without the Supabase pair the chat still works; only retrieval and the
feedback/correction forms fail.

---

## Related services

**The Examiner pipeline (separate repo).** `check_examiner.py` reads the
Pelham Examiner RSS feed on a schedule, has Claude tag each article with topic
tags, a two-sentence summary, a 1–5 relevance score, and the canonical name of
the issue or candidate it's about, then writes rows to the Supabase `articles`
table.

> ⚠️ **Coupling to know about.** The canonical issue names in `KNOWN_ISSUES`
> and the candidate surnames in `KNOWN_CANDIDATES` (both in
> `ask-pelham.js`) must match `check_examiner.py` **exactly**. They're stored
> verbatim in the database, so renaming one here silently stops matching every
> article already saved under the old spelling — and no test would catch it.
> `KNOWN_ISSUES` is now generated from `issues.json`, but the canonical strings
> themselves are still duplicated across the two repos.

> ⚠️ **Submission tables need INSERT granted to `anon`.** All three write
> paths fail with `permission denied for table …` until `supabase/grants.sql`
> has been run. Reads work regardless, so the chat looks healthy while every
> correction and 👍/👎 is discarded. The forms report the failure to the
> reader, but nothing is stored.

**Supabase** holds five tables: `articles` and `meetings` (the pipeline's
output), plus `feedback`, `corrections` and `civic_engagement` written by the
page.

`meetings` (593+ rows) tracks detection and draft status for all four boards —
what the pipeline has found and how far through processing it is. It is **not**
what the site reads. `content/meetings.json` and the HTML partials in
`content/meetings/` are the source of truth for what is actually published;
a row in the `meetings` table means the pipeline saw a meeting, not that it
appears on the site.

**Railway** runs five scheduled services: `check-examiner` (the article
tagger above, nightly) and one meeting watcher per board —
`check-meetings-village`, `check-meetings-town`, `check-meetings-boe`,
`check-meetings-manor`. The watchers detect new recordings and write them to
the Supabase `meetings` table; the run cadence is configured in Railway, not
in this repo.

---

## Deploy

Netlify builds from `main`: no build command, publish directory `.`.
`index.html` and the generated function files are committed, so the deploy is
a straight static publish.

Run `npm run build:check` before pushing. If it fails, someone edited
generated output by hand — run `npm run build` and commit the result.
