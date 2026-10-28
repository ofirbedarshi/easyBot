-- Pre-built demo profiles keyed to a business WhatsApp number (or a one-time code).
-- APPROVAL REQUIRED before applying to live Supabase. Do not schedule pg_cron here.

create table if not exists public.easybot_demo_profiles (
  id uuid primary key default gen_random_uuid(),
  business_label text not null,
  business_phone text unique null, -- E.164 digits (leading +)
  code text unique not null,
  profile jsonb not null,
  source_url text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  claimed_by text null,
  claimed_at timestamptz null
);

alter table public.easybot_demo_profiles
  drop constraint if exists easybot_demo_profiles_business_phone_check;

alter table public.easybot_demo_profiles
  add constraint easybot_demo_profiles_business_phone_check
  check (
    business_phone is null
    or business_phone ~ '^\+[1-9][0-9]{7,14}$'
  );

alter table public.easybot_demo_profiles enable row level security;

revoke all on table public.easybot_demo_profiles from anon, authenticated;

grant all on table public.easybot_demo_profiles to service_role, postgres;

-- Suggested cleanup (do not schedule here). After enabling pg_cron:
-- SELECT cron.schedule(
--   'easybot-demo-profiles-expire',
--   '0 4 * * *',
--   $$DELETE FROM public.easybot_demo_profiles
--     WHERE claimed_by IS NULL AND expires_at < now()$$
-- );
