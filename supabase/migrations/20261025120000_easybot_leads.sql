-- "Get this bot for my business" leads (one per sender) + questionnaire state.

create table if not exists public.easybot_leads (
  id bigserial primary key,
  sender_id text not null unique references public.easybot_senders (id) on delete cascade,
  business_name text,
  answers jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.easybot_sessions add column if not exists lead_intake jsonb;
