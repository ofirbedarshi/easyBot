-- Sender E.164 + append-only conversation log + RLS lockdown + 120s reclaim.
-- APPROVAL REQUIRED before applying to live Supabase.
-- Truncates all easybot_* rows (disposable demo data; no backfill).

-- 1. Wipe disposable state so phone_e164 can be NOT NULL on an empty table.
truncate table
  public.easybot_inbound_messages,
  public.easybot_leads,
  public.easybot_sessions,
  public.easybot_business_profiles,
  public.easybot_senders
restart identity cascade;

-- 2. Phone on existing senders (Twilio From stays `id`).
alter table public.easybot_senders
  add column if not exists phone_e164 text;

alter table public.easybot_senders
  drop constraint if exists easybot_senders_phone_e164_check;

alter table public.easybot_senders
  add constraint easybot_senders_phone_e164_check
  check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

create unique index if not exists easybot_senders_phone_e164_key
  on public.easybot_senders (phone_e164);

alter table public.easybot_senders
  alter column phone_e164 set not null;

-- 3. Append-only transcript (independent of session JSONB history).
create table if not exists public.easybot_messages (
  id bigserial primary key,
  sender_id text not null references public.easybot_senders (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null default '',
  twilio_message_sid text,
  mode text not null check (mode in (
    'opening', 'builder', 'test', 'menu', 'lead', 'command', 'limit', 'error'
  )),
  in_reply_to_sid text,
  created_at timestamptz not null default now()
);

create unique index if not exists easybot_messages_twilio_sid_key
  on public.easybot_messages (twilio_message_sid)
  where twilio_message_sid is not null;

create index if not exists easybot_messages_sender_created_idx
  on public.easybot_messages (sender_id, created_at);

create index if not exists easybot_messages_in_reply_to_idx
  on public.easybot_messages (in_reply_to_sid)
  where in_reply_to_sid is not null;

-- 4. Claim: per-sender serial; reclaim processing older than 120s with no outbound.
create or replace function public.easybot_claim_next_inbound()
returns setof public.easybot_inbound_messages
language plpgsql
set search_path = public
as $$
declare
  claimed public.easybot_inbound_messages;
begin
  select m.* into claimed
  from public.easybot_inbound_messages m
  where (
      m.status = 'received'
      and not exists (
        select 1
        from public.easybot_inbound_messages p
        where p.sender_id = m.sender_id
          and p.status = 'processing'
      )
    )
    or (
      m.status = 'processing'
      and m.claimed_at < now() - interval '120 seconds'
    )
  order by m.created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.easybot_inbound_messages
  set status = 'processing', claimed_at = now()
  where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$$;

create or replace function public.easybot_sender_message_count(
  p_sender_id text,
  p_since timestamptz
)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
  from public.easybot_inbound_messages
  where sender_id = p_sender_id
    and created_at >= p_since;
$$;

-- 5. RLS: Data API (anon / authenticated) sees nothing. App uses service_role.
alter table public.easybot_senders enable row level security;
alter table public.easybot_sessions enable row level security;
alter table public.easybot_business_profiles enable row level security;
alter table public.easybot_inbound_messages enable row level security;
alter table public.easybot_leads enable row level security;
alter table public.easybot_messages enable row level security;

revoke all on table public.easybot_senders from anon, authenticated;
revoke all on table public.easybot_sessions from anon, authenticated;
revoke all on table public.easybot_business_profiles from anon, authenticated;
revoke all on table public.easybot_inbound_messages from anon, authenticated;
revoke all on table public.easybot_leads from anon, authenticated;
revoke all on table public.easybot_messages from anon, authenticated;

revoke all on sequence public.easybot_inbound_messages_id_seq from anon, authenticated;
revoke all on sequence public.easybot_leads_id_seq from anon, authenticated;
revoke all on sequence public.easybot_messages_id_seq from anon, authenticated;

revoke all on function public.easybot_claim_next_inbound() from public, anon, authenticated;
revoke all on function public.easybot_sender_message_count(text, timestamptz) from public, anon, authenticated;

grant all on table public.easybot_senders to service_role, postgres;
grant all on table public.easybot_sessions to service_role, postgres;
grant all on table public.easybot_business_profiles to service_role, postgres;
grant all on table public.easybot_inbound_messages to service_role, postgres;
grant all on table public.easybot_leads to service_role, postgres;
grant all on table public.easybot_messages to service_role, postgres;
grant all on sequence public.easybot_inbound_messages_id_seq to service_role, postgres;
grant all on sequence public.easybot_leads_id_seq to service_role, postgres;
grant all on sequence public.easybot_messages_id_seq to service_role, postgres;
grant execute on function public.easybot_claim_next_inbound() to service_role, postgres;
grant execute on function public.easybot_sender_message_count(text, timestamptz) to service_role, postgres;
