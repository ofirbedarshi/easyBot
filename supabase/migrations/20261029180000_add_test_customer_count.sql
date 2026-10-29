-- Count of successful Business Bot answers in the current TEST session (stop-reminder every 2).
-- APPROVAL REQUIRED before applying to live Supabase.
-- Do not run from the agent.

alter table public.easybot_sessions
  add column if not exists test_customer_count integer not null default 0;
