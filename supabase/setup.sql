-- GLB Viewer — Supabase setup. Run once in Supabase → SQL Editor.
--
-- BEFORE RUNNING: replace 00000000-0000-0000-0000-000000000000 below with your admin
-- user's UUID (Authentication → Users → your user → "User UID").
-- It appears in ONE place: the is_admin() function.

-- 1. Who is the admin? ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() = 'cf24ba8c-e71a-42ae-8964-03c6795adb6d'::uuid
$$;

-- 2. Tables -----------------------------------------------------------------------
create table if not exists public.models (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 120),
  path           text not null unique,              -- object path in the "models" bucket
  size_bytes     bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  thumbnail_path text,                              -- filled in later (gallery thumbnails)
  owner_id       uuid not null default auth.uid() references auth.users (id),
  created_at     timestamptz not null default now()
);

create table if not exists public.reels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  path        text not null unique,                 -- object path in the "reels" bucket
  size_bytes  bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  owner_id    uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now()
);

-- Table access for the API roles. New Supabase projects don't grant this automatically.
-- GRANT opens the door to the role; the RLS policies below decide which rows it can touch.
grant select on public.models, public.reels to anon, authenticated;
grant insert, delete on public.models, public.reels to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- 3. Row Level Security: everyone reads, only the admin writes ----------------------
alter table public.models enable row level security;
alter table public.reels  enable row level security;

create policy "Anyone can view models" on public.models
  for select to anon, authenticated using (true);
create policy "Admin can add models" on public.models
  for insert to authenticated with check ((select public.is_admin()) and owner_id = auth.uid());
create policy "Admin can delete models" on public.models
  for delete to authenticated using ((select public.is_admin()));

create policy "Anyone can view reels" on public.reels
  for select to anon, authenticated using (true);
create policy "Admin can add reels" on public.reels
  for insert to authenticated with check ((select public.is_admin()) and owner_id = auth.uid());
create policy "Admin can delete reels" on public.reels
  for delete to authenticated using ((select public.is_admin()));

-- 4. Storage buckets: public read, 50 MB per file, file types enforced by the server --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('models', 'models', true, 52428800, array['model/gltf-binary']),
  ('reels',  'reels',  true, 52428800, array['video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public buckets serve files by URL without a policy. Writing needs these:
-- upload = insert; delete = delete + select.
create policy "Admin can upload files" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('models', 'reels') and (select public.is_admin()));
create policy "Admin can see files" on storage.objects
  for select to authenticated
  using (bucket_id in ('models', 'reels') and (select public.is_admin()));
create policy "Admin can delete files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('models', 'reels') and (select public.is_admin()));
