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

-- ── feedback: 👍/👎 on an AI answer ─────────────────────────────────────────
alter table public.feedback enable row level security;
grant insert on table public.feedback to anon;

drop policy if exists "anon can insert feedback" on public.feedback;
create policy "anon can insert feedback"
  on public.feedback for insert to anon
  with check (true);

-- ── corrections: "report a factual error" form ─────────────────────────────
alter table public.corrections enable row level security;
grant insert on table public.corrections to anon;

drop policy if exists "anon can insert corrections" on public.corrections;
create policy "anon can insert corrections"
  on public.corrections for insert to anon
  with check (true);

-- ── civic_engagement: "did this site help you take part?" form ─────────────
alter table public.civic_engagement enable row level security;
grant insert on table public.civic_engagement to anon;

drop policy if exists "anon can insert civic_engagement" on public.civic_engagement;
create policy "anon can insert civic_engagement"
  on public.civic_engagement for insert to anon
  with check (true);

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
