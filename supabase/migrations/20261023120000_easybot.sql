-- easyBot personal demo: sender-isolated state + durable inbound queue
-- Project: easybot only. Does not touch other Supabase projects.

create table if not exists public.easybot_senders (
  id text primary key, -- WhatsApp From, e.g. whatsapp:+15551234567
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.easybot_sessions (
  sender_id text primary key references public.easybot_senders (id) on delete cascade,
  mode text not null default 'BUILD' check (mode in ('BUILD', 'TEST')),
  build_history jsonb not null default '[]'::jsonb,
  test_history jsonb not null default '[]'::jsonb,
  test_session_id text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.easybot_business_profiles (
  sender_id text primary key references public.easybot_senders (id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.easybot_inbound_messages (
  id bigserial primary key,
  message_sid text not null unique,
  sender_id text not null references public.easybot_senders (id) on delete cascade,
  body text not null default '',
  status text not null default 'received'
    check (status in ('received', 'processing', 'done', 'failed', 'skipped')),
  error text,
  reply_sid text,
  reply_body text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

create index if not exists easybot_inbound_pending_idx
  on public.easybot_inbound_messages (status, created_at)
  where status in ('received', 'processing');

create index if not exists easybot_inbound_sender_created_idx
  on public.easybot_inbound_messages (sender_id, created_at);

-- Claim next message that is ready: oldest received whose sender has no processing row.
create or replace function public.easybot_claim_next_inbound()
returns setof public.easybot_inbound_messages
language plpgsql
as $$
declare
  claimed public.easybot_inbound_messages;
begin
  select m.* into claimed
  from public.easybot_inbound_messages m
  where m.status = 'received'
    and not exists (
      select 1
      from public.easybot_inbound_messages p
      where p.sender_id = m.sender_id
        and p.status = 'processing'
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

-- Rate-limit helper: count recent messages for a sender
create or replace function public.easybot_sender_message_count(
  p_sender_id text,
  p_since timestamptz
)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.easybot_inbound_messages
  where sender_id = p_sender_id
    and created_at >= p_since;
$$;
