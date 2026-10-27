-- Owner display name for Adam's scripted copy. Not a business-profile field.
alter table public.easybot_sessions
  add column if not exists owner_name text;
