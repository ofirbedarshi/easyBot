-- 90-day TTL for message logs and inbound queue. Does not touch
-- senders, sessions, profiles, or leads.
-- Apply in the easybot Supabase SQL editor (or CLI) as a role that
-- can create extensions and cron jobs. Do not run from the app.

create extension if not exists pg_cron;

create or replace function public.easybot_purge_old_logs()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.easybot_messages
  where created_at < now() - interval '90 days';
  delete from public.easybot_inbound_messages
  where created_at < now() - interval '90 days';
end;
$$;

revoke all on function public.easybot_purge_old_logs() from public, anon, authenticated;
grant execute on function public.easybot_purge_old_logs() to postgres;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'easybot-purge-old-logs') then
    perform cron.unschedule('easybot-purge-old-logs');
  end if;
end $$;

select cron.schedule(
  'easybot-purge-old-logs',
  '15 4 * * *',
  $cron$select public.easybot_purge_old_logs()$cron$
);
