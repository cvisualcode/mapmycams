-- ─── MapMyCams database schema (Supabase / Postgres) ────────────────────────
-- Run in the Supabase SQL editor. Row Level Security keeps every user's data
-- isolated; the service key bypasses RLS for server-side operations.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  password_hash text,                -- PBKDF2 (null for OAuth-only accounts)
  oauth_provider text,               -- google | apple | microsoft
  plan text not null default 'free', -- free | premium_monthly | premium_yearly
  addons jsonb not null default '[]'::jsonb,
  stripe_customer_id text,
  is_admin boolean not null default false,
  two_fa boolean not null default false,
  email_verified boolean not null default false,   -- must be true before sign-in
  verification_code_hash text,                     -- PBKDF2 hash of the emailed code
  verification_expires timestamptz,                -- code lifetime (10 minutes)
  verification_attempts int not null default 0,    -- wrong-code counter
  verification_sent_at timestamptz,                -- drives the resend cooldown
  created_at timestamptz not null default now()
);

-- ── Migration: bring an older database up to date ────────────────────────────
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists verification_code_hash text;
alter table users add column if not exists verification_expires timestamptz;
alter table users add column if not exists verification_attempts int not null default 0;
alter table users add column if not exists verification_sent_at timestamptz;

-- Accounts created before verification existed have no pending code, so they are
-- grandfathered in rather than locked out. Only new signups must confirm.
update users set email_verified = true
where email_verified = false and verification_code_hash is null;

create table if not exists floorplans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null default 'Untitled plan',
  data jsonb not null default '{}'::jsonb,   -- walls, cameras, objects, wires
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists floorplans_owner_idx on floorplans(owner_id);

create table if not exists billing_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  stripe_event_id text,
  item text not null,                -- plan key or add-on key
  kind text not null,                -- subscription | addon
  amount_cents int,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists analytics_events (
  id bigserial primary key,
  event text not null,
  props jsonb not null default '{}'::jsonb,
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists analytics_event_idx on analytics_events(event);

create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table users enable row level security;
alter table floorplans enable row level security;
alter table billing_history enable row level security;

create policy "users read own" on users for select using (auth.uid() = id);
create policy "floorplans owner only" on floorplans for all using (auth.uid() = owner_id);
create policy "billing owner only" on billing_history for select using (auth.uid() = user_id);

-- Seed the Admin super-user (password: Admin1 — change immediately in prod).
-- Generate the PBKDF2 hash with api/_lib.js hashPassword() and paste it below.
insert into users (email, name, is_admin, plan, addons, email_verified)
values ('admin@mapmycams.dev', 'Administrator', true, 'premium_yearly', '["ai_pack","pdf_report","family","brands"]'::jsonb, true)
on conflict (email) do nothing;
