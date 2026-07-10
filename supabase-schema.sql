-- ============================================================
-- Kortes Trip 2026 — Gedeelde checklist schema (Supabase/Postgres)
-- ============================================================
-- Scope: ALLEEN gedeelde checklist-status. Geen reisdata, geen
-- boekingen, geen SoT. dashboard-data.json blijft de bron van
-- checklist-DEFINITIES (labels/categorieën); deze database bevat
-- alleen de MUTABELE voortgang (wie heeft wat afgevinkt, wanneer).
-- ============================================================

create extension if not exists "uuid-ossp";

-- Eén workspace = één reis. Toekomstbestendig als je dit ooit
-- voor meerdere reizen hergebruikt.
create table if not exists trip_workspaces (
  id uuid primary key default uuid_generate_v4(),
  slug text unique not null,              -- bv. 'kortes-2026'
  name text not null,                     -- bv. 'Japan & Vietnam 2026'
  created_at timestamptz not null default now()
);

-- Gezinsleden die toegang hebben tot deze workspace.
-- user_id verwijst naar auth.users (Supabase Auth).
create table if not exists trip_members (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references trip_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,             -- 'Henk Jan' | 'Jessica' | 'Oscar' | 'Lucas'
  role text not null default 'member',    -- 'owner' | 'member'
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

-- Gedeelde checklist-status per item_id (item_id komt uit
-- dashboard-data.json, bv. 'sim-japan-esim').
create table if not exists checklist_state (
  workspace_id uuid not null references trip_workspaces(id) on delete cascade,
  item_id text not null,
  status text not null default 'TO_DO',   -- 'TO_DO' | 'DONE' | 'NOT_APPLICABLE'
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, item_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table trip_workspaces enable row level security;
alter table trip_members enable row level security;
alter table checklist_state enable row level security;

-- Alleen leden van een workspace mogen die workspace zien.
create policy "members can view own workspace"
  on trip_workspaces for select
  using (
    id in (select workspace_id from trip_members where user_id = auth.uid())
  );

-- Leden zien alleen het ledenlijstje van hun eigen workspace
-- (niet nodig om elkaars e-mail te tonen, alleen display_name).
create policy "members can view co-members"
  on trip_members for select
  using (
    workspace_id in (select workspace_id from trip_members where user_id = auth.uid())
  );

-- Checklist: leden mogen ALLEEN rijen van hun eigen workspace lezen/schrijven.
create policy "members can view checklist state"
  on checklist_state for select
  using (
    workspace_id in (select workspace_id from trip_members where user_id = auth.uid())
  );

create policy "members can upsert checklist state"
  on checklist_state for insert
  with check (
    workspace_id in (select workspace_id from trip_members where user_id = auth.uid())
  );

create policy "members can update checklist state"
  on checklist_state for update
  using (
    workspace_id in (select workspace_id from trip_members where user_id = auth.uid())
  )
  with check (
    workspace_id in (select workspace_id from trip_members where user_id = auth.uid())
  );

-- Geen delete-policy: gezinsleden kunnen status wijzigen (TO_DO/DONE)
-- maar rijen niet verwijderen. Voorkomt per ongeluk data-verlies.

-- ============================================================
-- REALTIME
-- ============================================================
-- Zet 'checklist_state' aan voor Realtime in Supabase Dashboard:
-- Database > Replication > supabase_realtime > checklist_state aanvinken.
-- (Kan niet volledig via SQL alleen; zie SUPABASE-SETUP.md stap 6.)

-- ============================================================
-- SEED — pas slug/naam aan indien gewenst
-- ============================================================
insert into trip_workspaces (slug, name)
values ('kortes-2026', 'Japan & Vietnam 2026')
on conflict (slug) do nothing;
