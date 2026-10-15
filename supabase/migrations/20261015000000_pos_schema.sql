-- RRC Merchandise POS: the database tables, for Supabase (Postgres).
--
-- Run once on a new Supabase project, in the SQL Editor, then run
-- 20261015000001_pos_api.sql and ../seed.sql. This replaces the Laravel
-- migrations; the tables and columns are the same ones the app already uses.
--
-- None of these tables can be read or written with the public key the app
-- ships with: Row Level Security is on with no policies, and the anon and
-- authenticated roles have no grants. The app only calls the pos_* functions
-- in the API file, which check the terminal key or the person's sign-in
-- themselves, the way the Laravel controllers did.

create extension if not exists pgcrypto with schema extensions;

-- Internals and the owner's setup tools (pos.add_staff, pos.add_terminal).
-- The API never exposes this schema.
create schema if not exists pos;
revoke all on schema pos from public;

-- ---------------------------------------------------------------------------
-- Staff, devices, and sign-ins
-- ---------------------------------------------------------------------------

-- Cashiers have a 4-digit password, owners 6 digits (and optional two-factor
-- login). pin_hash and totp_secret sync down to provisioned terminals so the
-- till can sign people in offline.
create table public.users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  role text not null check (role in ('cashier', 'owner')),
  pin_hash text not null, -- bcrypt, never the password itself
  totp_secret text,
  totp_enabled boolean not null default false,
  failed_pin_attempts smallint not null default 0,
  locked_until timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_updated_at_idx on public.users (updated_at);

-- A registered device. The key itself is shown once (pos.add_terminal) and
-- only its sha256 is kept.
create table public.terminals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key_hash text not null unique,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A person's server sign-in, made from the password they typed at the till
-- (pos_login). Only the token's sha256 is kept; signing out deletes the row.
create table public.api_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  terminal_id text,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index api_tokens_user_id_idx on public.api_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Catalog and stock
-- ---------------------------------------------------------------------------

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index categories_updated_at_idx on public.categories (updated_at);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  barcode text unique,
  name text not null,
  category_id uuid not null references public.categories (id),
  unit text not null, -- pc, kg, bag, m, sheet, box...
  unit_price numeric(12, 2) not null,
  cost_price numeric(12, 2), -- never sent to terminals
  reorder_level numeric(12, 3) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_name_idx on public.products (name);
create index products_category_id_idx on public.products (category_id);
create index products_updated_at_idx on public.products (updated_at); -- terminals pull only what changed

-- Stock lives in batches, sold oldest first (FIFO by received_at). Damaged
-- units are kept apart and never sold.
create table public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  location text not null check (location in ('store', 'warehouse')),
  received_at timestamptz not null,
  qty_received numeric(12, 3) not null,
  qty_good_remaining numeric(12, 3) not null,
  qty_damaged numeric(12, 3) not null default 0,
  source text not null check (source in ('receiving', 'transfer_in', 'return_accepted', 'stocktake_correction')),
  reference_id uuid, -- the return or count that created this batch
  created_by uuid references public.users (id),
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_batches_fifo_idx on public.stock_batches (product_id, location, received_at);
create index stock_batches_updated_at_idx on public.stock_batches (updated_at);

-- ---------------------------------------------------------------------------
-- Shifts, customers, and sales
-- ---------------------------------------------------------------------------

-- One person's clock-in to clock-out on one terminal. The id is made on the
-- terminal.
create table public.shift_logs (
  id uuid primary key,
  terminal_id text not null,
  cashier_id uuid not null references public.users (id),
  started_at timestamptz not null,
  ended_at timestamptz,
  opening_cash numeric(12, 2) not null default 0,
  expected_cash numeric(12, 2),
  counted_cash numeric(12, 2), -- the person's blind count
  cash_discrepancy numeric(12, 2),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shift_logs_cashier_id_idx on public.shift_logs (cashier_id);
create index shift_logs_started_at_idx on public.shift_logs (started_at);

-- Someone who buys on credit ("utang"). Created at the register, offline.
create table public.customers (
  id uuid primary key,
  name text not null,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_name_idx on public.customers (name);
create index customers_updated_at_idx on public.customers (updated_at);

create table public.sales (
  id uuid primary key, -- made on the terminal
  terminal_id text not null,
  cashier_id uuid not null references public.users (id),
  shift_id uuid references public.shift_logs (id),
  subtotal numeric(12, 2) not null,
  discount_amount numeric(12, 2) not null default 0,
  tax_amount numeric(12, 2) not null default 0,
  total_amount numeric(12, 2) not null,
  payment_method text not null default 'cash' check (payment_method in ('cash', 'gcash', 'bank', 'credit', 'card', 'other')),
  amount_tendered numeric(12, 2),
  change_amount numeric(12, 2),
  amount_paid numeric(12, 2), -- paid at the counter; on a credit sale the rest is owed
  payment_reference text, -- GCash / bank reference number
  customer_id uuid references public.customers (id),
  status text not null default 'completed' check (status in ('completed', 'voided', 'refunded')),
  voided_by uuid references public.users (id),
  void_reason text,
  client_created_at timestamptz not null, -- when the sale happened; created_at is when it synced
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sales_client_created_at_idx on public.sales (client_created_at);
create index sales_shift_id_idx on public.sales (shift_id);
create index sales_cashier_id_idx on public.sales (cashier_id);
create index sales_customer_id_idx on public.sales (customer_id);
create index sales_status_idx on public.sales (status);
create index sales_updated_at_idx on public.sales (updated_at);

create table public.sale_items (
  id uuid primary key,
  seq bigint generated always as identity, -- keeps the lines in the order they were rung up
  sale_id uuid not null references public.sales (id),
  product_id uuid not null references public.products (id),
  sku_snapshot text not null,
  name_snapshot text not null,
  unit_price_snapshot numeric(12, 2) not null,
  quantity numeric(12, 3) not null,
  line_discount numeric(12, 2) not null default 0,
  line_total numeric(12, 2) not null,
  voided_at timestamptz,
  voided_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sale_items_sale_id_idx on public.sale_items (sale_id);
create index sale_items_product_id_idx on public.sale_items (product_id);

-- Every change to stock, as a ledger. Negative = out, positive = in.
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  batch_id uuid references public.stock_batches (id),
  terminal_id text, -- null: made on the server, not at a terminal
  delta numeric(12, 3) not null,
  reason text not null check (reason in (
    'sale', 'void_restock', 'manual_adjustment', 'stock_receipt',
    'stocktake_correction', 'transfer_out', 'transfer_in', 'damage')),
  reference_id uuid, -- e.g. the sale this movement came from
  actor_id uuid references public.users (id),
  note text,
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_movements_product_id_idx on public.stock_movements (product_id);
create index stock_movements_batch_id_idx on public.stock_movements (batch_id);
create index stock_movements_reference_id_idx on public.stock_movements (reference_id);
create index stock_movements_reason_time_idx on public.stock_movements (reason, client_created_at);

-- Money a credit customer paid back. Append-only: a mistake is fixed with
-- another entry, never by editing history.
create table public.credit_payments (
  id uuid primary key,
  customer_id uuid not null references public.customers (id),
  amount numeric(12, 2) not null,
  payment_method text not null, -- cash, gcash, bank
  reference text,
  note text,
  terminal_id text,
  shift_id uuid references public.shift_logs (id),
  received_by uuid not null references public.users (id),
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credit_payments_customer_idx on public.credit_payments (customer_id, client_created_at);
create index credit_payments_shift_id_idx on public.credit_payments (shift_id);

-- A pick list for the stockroom. Every sale makes one (sale_id, with no
-- foreign key so a list still arrives if its sale is slow to sync); one can
-- also be sent without charging. Status: pending, fulfilled, cancelled.
create table public.material_requests (
  id uuid primary key,
  terminal_id text,
  sale_id uuid,
  requested_by uuid not null,
  items jsonb not null default '[]', -- [{product_id, sku_snapshot, name_snapshot, unit_snapshot, quantity_requested}]
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  notes text,
  fulfilled_by uuid,
  fulfilled_at timestamptz,
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index material_requests_status_idx on public.material_requests (status);
create index material_requests_sale_id_idx on public.material_requests (sale_id);
create index material_requests_client_created_at_idx on public.material_requests (client_created_at);

create table public.sales_returns (
  id uuid primary key,
  original_sale_item_id uuid references public.sale_items (id),
  product_id uuid not null references public.products (id),
  quantity_returned numeric(12, 3) not null,
  condition text not null check (condition in ('good', 'damaged')),
  processed_by uuid not null references public.users (id), -- an owner
  reason text,
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sales_returns_product_id_idx on public.sales_returns (product_id);

-- Voiding a sale takes two owners within 10 minutes. Every request and every
-- yes is kept, so the history shows who agreed to what.
create table public.void_requests (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id),
  requested_by uuid not null references public.users (id),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  resolved_by uuid references public.users (id), -- who said no or cancelled it
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index void_requests_status_idx on public.void_requests (status, expires_at);
-- At most one open request per sale, even if two owners ask at once.
create unique index void_requests_one_pending_per_sale on public.void_requests (sale_id) where status = 'pending';

create table public.void_request_approvals (
  id bigint generated always as identity primary key,
  void_request_id uuid not null references public.void_requests (id) on delete cascade,
  user_id uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (void_request_id, user_id) -- one yes per owner
);

-- ---------------------------------------------------------------------------
-- Logs (append-only)
-- ---------------------------------------------------------------------------

-- Events that need an owner's eyes: voids, cash differences, oversold
-- batches, returns, clamped clocks.
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  terminal_id text not null,
  actor_id uuid references public.users (id),
  approver_id uuid references public.users (id),
  action_type text not null check (action_type in (
    'void_item', 'void_sale', 'admin_void', 'refund', 'price_override',
    'manual_stock_adjustment', 'failed_pin_attempt', 'shift_close_discrepancy',
    'return_accepted', 'damage_reported', 'stock_transfer',
    'cycle_count_correction', 'day_close_discrepancy',
    'batch_oversold', 'timestamp_anomaly_clamped')),
  entity_type text,
  entity_id uuid,
  details jsonb,
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_logs_actor_id_idx on public.audit_logs (actor_id);
create index audit_logs_client_created_at_idx on public.audit_logs (client_created_at);

-- Everything each person did, shown on a shift's timeline.
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  terminal_id text not null,
  ip_address text, -- from the connection, never from the device
  actor_id uuid not null references public.users (id),
  shift_id uuid references public.shift_logs (id),
  event_type text not null,
  entity_type text,
  entity_id uuid,
  details jsonb,
  client_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index activity_log_actor_idx on public.activity_log (actor_id, client_created_at);
create index activity_log_shift_id_idx on public.activity_log (shift_id);

-- ---------------------------------------------------------------------------
-- updated_at, append-only logs, and locking the tables away from the API
-- ---------------------------------------------------------------------------

-- Bumps updated_at when a row really changes, which is what lets terminals
-- pull only what changed since their last sync.
create or replace function pos.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new is distinct from old then
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function pos.append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only: its rows are never changed or deleted', tg_table_name;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'terminals', 'categories', 'products', 'stock_batches', 'shift_logs',
    'customers', 'sales', 'sale_items', 'stock_movements', 'credit_payments',
    'material_requests', 'sales_returns', 'void_requests', 'void_request_approvals',
    'audit_logs', 'activity_log'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function pos.touch_updated_at()', t || '_touch', t);
  end loop;

  foreach t in array array['audit_logs', 'activity_log', 'credit_payments'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function pos.append_only()', t || '_append_only', t);
  end loop;

  foreach t in array array[
    'users', 'terminals', 'api_tokens', 'categories', 'products', 'stock_batches',
    'shift_logs', 'customers', 'sales', 'sale_items', 'stock_movements',
    'credit_payments', 'material_requests', 'sales_returns', 'void_requests',
    'void_request_approvals', 'audit_logs', 'activity_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on sequence public.api_tokens_id_seq, public.sale_items_seq_seq, public.void_request_approvals_id_seq
  from anon, authenticated;
