-- Shared client profiles: a lead WhatsApps bot-XXXXXXXX and talks only to
-- that business's customer-facing bot. No expiry. One code, many leads.
-- APPROVAL REQUIRED before applying to live Supabase.

create table if not exists public.easybot_clients (
  id uuid primary key default gen_random_uuid(),
  name text,
  business_name text not null,
  contact_channel text,
  status text not null default 'lead',
  code text unique not null,
  profile jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  constraint easybot_clients_status_check
    check (status in ('lead', 'demo', 'trial'))
);

alter table public.easybot_clients enable row level security;

revoke all on table public.easybot_clients from anon, authenticated;

grant all on table public.easybot_clients to service_role, postgres;

alter table public.easybot_sessions
  add column if not exists client_id uuid references public.easybot_clients (id);
