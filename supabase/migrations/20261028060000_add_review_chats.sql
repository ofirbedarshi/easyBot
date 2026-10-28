-- Owner review-chats mode state (parallel to lead_intake).
-- APPROVAL REQUIRED before applying to live Supabase.
-- Do not run from the agent.

alter table public.easybot_sessions
  add column if not exists review_chats jsonb;
