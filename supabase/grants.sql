-- Pelham Engagement Project — Supabase permissions for the three submission
-- tables written by the site.
--
-- WHY THIS EXISTS
--
-- Every 👍/👎 vote, correction and civic-engagement submission was failing in
-- production with:
--
--     permission denied for table feedback
--     permission denied for table corrections
--     permission denied for table civic_engagement
--
-- The `anon` role could read (the RAG lookup against `articles` works, which
-- is how we know the URL and key are correct) but had no INSERT privilege on
-- the three write tables. "permission denied for table" is a GRANT failure,
-- not a row-level-security rejection — RLS refusal reads "new row violates
-- row-level security policy" instead. So both are set below: the GRANT makes
-- the table reachable, the policy decides which rows are allowed.
--
-- Run this in the Supabase SQL editor.
--
-- STATUS: the three submission tables were run against production on 23
-- September 2026 and all three paths verified returning {"ok":true}. The
-- qa_log block at the bottom was added 24 September 2026. Completed — table
-- and policies are live in production. Keep this file — it is the setup step for any new Supabase
-- project, and the record of why the grants exist.
--
-- Re-running the whole file is safe: every statement is create-if-not-exists,
-- add-column-if-not-exists, or drop-then-create.

-- ── feedback: 👍/👎 on an AI answer ─────────────────────────────────────────
alter table public.feedback enable row level security;
grant insert on table public.feedback to anon;

drop policy if exists "anon can insert feedback" on public.feedback;
create policy "anon can insert feedback"
  on public.feedback for insert to anon
  with check (true);

-- ── corrections: "report a factual error" form ─────────────────────────────
-- `contact` is the form's optional reply email. Added directly in Supabase
-- when the field went on the form; `if not exists` makes rerunning harmless.
alter table public.corrections add column if not exists contact text;
alter table public.corrections enable row level security;
grant insert on table public.corrections to anon;

drop policy if exists "anon can insert corrections" on public.corrections;
create policy "anon can insert corrections"
  on public.corrections for insert to anon
  with check (true);

-- ── civic_engagement: community feedback form ─────────────────────────────
-- `feedback_type` is the form's "What's on your mind?" choice.
alter table public.civic_engagement add column if not exists feedback_type text;
alter table public.civic_engagement enable row level security;
grant insert on table public.civic_engagement to anon;

drop policy if exists "anon can insert civic_engagement" on public.civic_engagement;
create policy "anon can insert civic_engagement"
  on public.civic_engagement for insert to anon
  with check (true);

-- ── qa_log: every question asked and the full answer given ────────────────
-- Q&A logging active — review after 30 days and decide whether to keep.
--
-- Added for the launch period to find out what residents actually ask, and
-- where the content does not answer them. Unlike the three tables above this
-- records something the reader did not choose to submit, so it carries an
-- expiry by intention rather than by neglect, and the expiry is enforced in
-- code: logQa() in ask-pelham.js holds a hard cutoff of October 24, 2026 and
-- writes nothing after it, so the table stops growing whether or not anyone
-- remembers. Restarting it takes a deliberate edit. On or before that date,
-- either drop this table and the logQa() call, or move the cutoff and write
-- down why it is staying. `session_id` is a random per-page-load value
-- generated in the browser -- not a cookie, not stored, tied to no person.
create table if not exists public.qa_log (
  id bigserial primary key,
  question text not null,
  answer text not null,
  session_id text,
  created_at timestamptz not null default now()
);
alter table public.qa_log enable row level security;
grant insert on table public.qa_log to anon;

drop policy if exists "anon can insert qa_log" on public.qa_log;
create policy "anon can insert qa_log"
  on public.qa_log for insert to anon
  with check (true);

-- bigserial, so the sequence needs its own grant or every insert fails with
-- "permission denied for sequence qa_log_id_seq".
grant usage, select on sequence public.qa_log_id_seq to anon;

-- The digest reads this table back; the three above are read the same way.
grant select on table public.qa_log to service_role;

-- INSERT only, deliberately. No select policy is granted, so submissions
-- cannot be read back by the anon role — a resident reporting an error, or
-- describing how they got involved, should not be readable by anyone who
-- visits the site. Read them in the Supabase dashboard or with the service
-- role key, which never leaves the server.

-- If any of these tables uses a `serial` primary key rather than an identity
-- column, its sequence also needs a grant, or the insert fails with
-- "permission denied for sequence ..." :
--
--   grant usage, select on sequence public.feedback_id_seq to anon;
--   grant usage, select on sequence public.corrections_id_seq to anon;
--   grant usage, select on sequence public.civic_engagement_id_seq to anon;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- After running the above, from a shell:
--
--   curl -s -X POST https://pelhamengagementproject.netlify.app/api/ask \
--     -H 'Content-Type: application/json' \
--     -d '{"type":"feedback","vote":"up","question":"test","answer_snippet":"test"}'
--
-- Expect {"ok":true} and HTTP 200. Before the fix this returned HTTP 502 with
-- "permission denied for table feedback".
