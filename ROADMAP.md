# Roadmap

Planned work that is not built yet. Each entry says why it is waiting, not
just what it is.

## Full meeting transcripts (privacy pass + name correction)

**Now:** each meeting's transcript section is a hand-picked excerpt of 8–14
lines (`content/meetings/*.transcript.html`), labelled "Transcript excerpt"
with a link to the official recording.

**Planned:** publish the full Whisper transcripts. They already exist in the
companion pipeline repo, `pelham-civic/output/*-transcript.md` — 17–93 KB,
295–1,087 lines each, one per published meeting (matched by source URL; the
two Pelham Manor files by date, since their source is a local video file).

**Why it is waiting:** the raw output cannot be published as-is.

- **Privacy.** Residents state their name and where they live during public
  comment. At least one summary tells readers the resident's name and address
  are withheld, and the raw transcript contains both. Resident names and
  addresses must be removed before publishing.
- **Accuracy.** Names are uncorrected Whisper output ("Teresa Rohan" for
  Theresa Mohan, "Kristen Berg" for Kristen Burke). Officials' names should be
  corrected against `content/officials.json`; anything unresolved gets the
  existing `[VERIFY]` marker.
- **No speaker labels.** Raw lines are `[h:mm:ss] text` only, so the speaker
  column would be empty.

**Shape of the work:**

1. An import step (run locally; the Netlify build cannot see the companion
   repo) that converts each `.md` into a transcript partial, one row per line.
2. A redaction pass for resident names and addresses, and a correction map
   for officials' names from the roster. Both reviewed by a person before
   publishing — this is the step that makes the rest safe.
3. Load each transcript only when its section is opened, rather than embedding
   all of them in `meetings.html` (about 400 KB together).
4. "Load more" already pages anything over 50 lines. The transcript test
   already derives its expectation from the real files, so it will require the
   button once real transcripts are long enough.

**Also found:** the pipeline's September 15, 2026 Town Council work session
produced an empty transcript, and its "summaries" are the model reporting that
no notes were provided. That meeting is not on the site, but the pipeline
failure is worth fixing at the source.
