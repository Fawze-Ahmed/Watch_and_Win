create extension if not exists pgcrypto;

drop table if exists support_messages cascade;
drop table if exists support_threads cascade;
drop table if exists redeem_requests cascade;
drop table if exists wallet_transactions cascade;
drop table if exists profiles cascade;

create table profiles (
  id uuid primary key default gen_random_uuid(),
  device_key text unique not null,
  email text unique,
  display_name text,
  role text not null default 'user' check (role in ('user', 'owner')),
  coin_balance integer not null default 0,
  created_at timestamptz not null default now()
);

create table wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  source text not null check (source in ('video', 'short_link', 'daily_bonus', 'redeem', 'admin_adjustment')),
  amount integer not null,
  status text not null default 'completed' check (status in ('pending', 'completed', 'approved', 'processing')),
  notes text,
  created_at timestamptz not null default now()
);

create table redeem_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  reward_type text not null check (reward_type in ('gift_card', 'featured_access')),
  coin_amount integer not null check (coin_amount > 0),
  payout_details text,
  network text default 'internal',
  status text not null default 'pending' check (status in ('pending', 'processing', 'approved', 'completed')),
  created_at timestamptz not null default now()
);

create table support_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  owner_id uuid references profiles(id) on delete set null,
  subject text default 'Support Chat',
  status text not null default 'open' check (status in ('open', 'needs_reply', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references support_threads(id) on delete cascade,
  sender_id uuid references profiles(id) on delete set null,
  sender_role text not null check (sender_role in ('user', 'owner')),
  message_text text not null,
  created_at timestamptz not null default now()
);

create or replace function prevent_negative_balance()
returns trigger
language plpgsql
as $$
declare
  current_balance integer;
begin
  select coin_balance into current_balance
  from profiles
  where id = new.user_id
  for update;

  if current_balance + new.amount < 0 then
    raise exception 'Insufficient balance for this transaction';
  end if;

  update profiles
  set coin_balance = coin_balance + new.amount
  where id = new.user_id;

  return new;
end;
$$;

create trigger wallet_transaction_balance_guard
before insert on wallet_transactions
for each row
execute function prevent_negative_balance();

create or replace function sync_thread_updated_at()
returns trigger
language plpgsql
as $$
begin
  update support_threads
  set updated_at = now()
  where id = new.thread_id;

  return new;
end;
$$;

create trigger support_message_touch_thread
after insert on support_messages
for each row
execute function sync_thread_updated_at();

create or replace function create_reward_redeem_request(
  p_user_id uuid,
  p_reward_label text,
  p_coin_amount integer default 500,
  p_network text default 'internal'
)
returns uuid
language plpgsql
as $$
declare
  request_id uuid;
begin
  insert into redeem_requests (user_id, reward_type, coin_amount, payout_details, network, status)
  values (p_user_id, 'featured_access', p_coin_amount, p_reward_label, p_network, 'pending')
  returning id into request_id;

  insert into wallet_transactions (user_id, source, amount, status, notes)
  values (p_user_id, 'redeem', -p_coin_amount, 'pending', 'Internal reward redeem request');

  return request_id;
end;
$$;

alter table profiles replica identity full;
alter table wallet_transactions replica identity full;
alter table redeem_requests replica identity full;
alter table support_threads replica identity full;
alter table support_messages replica identity full;

alter publication supabase_realtime add table profiles;
alter publication supabase_realtime add table wallet_transactions;
alter publication supabase_realtime add table redeem_requests;
alter publication supabase_realtime add table support_threads;
alter publication supabase_realtime add table support_messages;

alter table profiles disable row level security;
alter table wallet_transactions disable row level security;
alter table redeem_requests disable row level security;
alter table support_threads disable row level security;
alter table support_messages disable row level security;
