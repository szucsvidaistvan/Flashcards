-- Futtasd a Supabase SQL Editorban (egyszer)
create table if not exists decks (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists cards (
  id text primary key,
  deck_id text not null references decks(id) on delete cascade,
  front text not null,
  back text not null,
  ease double precision not null default 2.5,
  interval_days integer not null default 0,
  reps integer not null default 0,
  due bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists cards_deck_idx on cards(deck_id);

-- Auth nélküli, egyfelhasználós használathoz: az anon kulcs teljes hozzáférést kap.
alter table decks enable row level security;
alter table cards enable row level security;

create policy "anon all decks" on decks for all to anon using (true) with check (true);
create policy "anon all cards" on cards for all to anon using (true) with check (true);
