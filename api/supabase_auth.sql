-- ─── Supabase Auth schema ────────────────────────────────────────────────────
-- Run this in the Supabase SQL editor before enabling the OAuth providers.
--
-- Supabase owns the identity records in auth.users (password hashing, OAuth
-- tokens, email confirmation, refresh tokens). This migration creates the
-- `profiles` row that every one of those identities gets, so a Google sign-in,
-- a Microsoft sign-in and an email sign-up all land on the same kind of record
-- with the plan/add-on columns the app reads.

create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  plan text not null default 'free',        -- free | premium_monthly | premium_yearly
  addons jsonb not null default '[]'::jsonb,
  is_admin boolean not null default false,
  two_fa boolean not null default false,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

-- ── Row Level Security: a user can only ever see their own profile ───────────
alter table profiles enable row level security;

drop policy if exists "profiles self read" on profiles;
create policy "profiles self read" on profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles self update" on profiles;
create policy "profiles self update" on profiles
  for update using (auth.uid() = id);

-- ── Auto-create the profile for every new identity ──────────────────────────
-- Fires for password sign-ups and OAuth sign-ins alike, so the app never has to
-- cope with a signed-in user that has no profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, 'member'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Grant the full-access Admin account ─────────────────────────────────────
-- 1. Sign up once with admin@mapmycams.dev (or via any provider).
-- 2. Then run this to give it every entitlement:
--
-- update profiles
--    set is_admin = true,
--        plan = 'premium_yearly',
--        addons = '["ai_pack","pdf_report","family","brands"]'::jsonb
--  where email = 'admin@mapmycams.dev';
