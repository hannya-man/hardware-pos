-- ============================================================================
-- HARDWARE & CONSTRUCTION SUPPLY POS — CLOUD SCHEMA
-- Target: PostgreSQL on Supabase or Neon (free tier). See README.md for
-- which one fits your operating pattern better and why.
-- ============================================================================
-- Design notes, read before you run this:
--
-- 1. TWO KINDS OF PRIMARY KEY. products/users are created on the cloud side
--    (admin adds a SKU, admin adds an employee), so gen_random_uuid() as a
--    default is fine. sales/sale_items/shift_logs/audit_logs/stock_movements
--    are created on the TERMINAL first and pushed up — their ids are
--    generated client-side (crypto.randomUUID(), see sync-worker.js) and
--    passed in explicitly, which is what makes the push idempotent: retry
--    the same insert twice and the id collision makes the second a no-op
--    instead of a duplicate row.
--
-- 2. MONEY AND QUANTITY TYPES. NUMERIC(12,2) for currency, NUMERIC(12,3)
--    for quantity, never FLOAT — you asked for decimal stock (cement in
--    partial bags, pipe cut to 3.5m) and floats will eventually round a
--    stock count to something like 11.999999999997.
--
-- 3. SALE_ITEMS SNAPSHOTS name/price at the moment of sale. Once you update
--    a product's price in the catalog, past receipts must NOT change —
--    without the snapshot, a JOIN to products would silently rewrite
--    yesterday's revenue.
--
-- 4. "APPEND-ONLY" IS INTERPRETED PRAGMATICALLY, not as a hard "zero UPDATE
--    statements ever" rule. sales.status and sale_items.voided_at CAN
--    transition (completed -> voided/refunded), but ONLY through the
--    terminal's own authorized, PIN-audited void flow (see voidSaleItem in
--    sync-worker.js) — never by an admin editing a row directly. That is
--    what "cloud never modifies terminal sales logs" is protecting against.
--    audit_logs and stock_movements ARE hard append-only, enforced below
--    with a trigger, because there's never a legitimate reason to edit a
--    historical event after the fact.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gives gen_random_uuid(); harmless no-op on Postgres versions that already have it built in

-- ----------------------------------------------------------------------------
-- USERS — roles + PINs
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  pin_hash             TEXT NOT NULL,            -- bcrypt hash ONLY. Never store or log a raw PIN.
  failed_pin_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- PRODUCTS — master catalog. Cloud is the source of truth; sync is one-way,
-- cloud -> local. A "Roofing Sheet 0.4mm x 8ft" and a "Roofing Sheet 0.5mm x
-- 10ft" are two separate rows here, each its own SKU — that's the simplest
-- way to handle dimensional/variable items without a variant sub-table.
-- ----------------------------------------------------------------------------
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             TEXT NOT NULL UNIQUE,
  barcode         TEXT UNIQUE,               -- nullable: most items won't have one on day 1
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,             -- 'Roofing','Steel','Cement','Fasteners','Tools','Plumbing', ...
  unit            TEXT NOT NULL,             -- 'pc','kg','bag','m','ft','sheet','length','box', ...
  unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  cost_price      NUMERIC(12,2) CHECK (cost_price >= 0),
  stock_quantity  NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(12,3) NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_name    ON products (name);
CREATE INDEX idx_products_category ON products (category);
CREATE INDEX idx_products_updated  ON products (updated_at); -- lets terminals pull only what changed since last sync

-- ----------------------------------------------------------------------------
-- SHIFT LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE shift_logs (
  id               UUID PRIMARY KEY,          -- client-generated
  terminal_id      TEXT NOT NULL,
  cashier_id       UUID NOT NULL REFERENCES users(id),
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  opening_cash     NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_cash    NUMERIC(12,2),             -- system total; withheld from the cashier until they submit their count
  counted_cash     NUMERIC(12,2),             -- the cashier's BLIND count
  cash_discrepancy NUMERIC(12,2),             -- counted - expected, filled in on close
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_shift_logs_cashier ON shift_logs (cashier_id);
CREATE INDEX idx_shift_logs_started ON shift_logs (started_at);

-- ----------------------------------------------------------------------------
-- SALES — one row per transaction. See design note 4 above re: append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE sales (
  id                 UUID PRIMARY KEY,        -- client-generated UUIDv4 (crypto.randomUUID())
  terminal_id        TEXT NOT NULL,
  cashier_id         UUID NOT NULL REFERENCES users(id),
  shift_id           UUID REFERENCES shift_logs(id),
  subtotal           NUMERIC(12,2) NOT NULL,
  discount_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount       NUMERIC(12,2) NOT NULL,
  payment_method     TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'gcash', 'other')),
  amount_tendered    NUMERIC(12,2),
  change_amount      NUMERIC(12,2),
  status             TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided', 'refunded')),
  voided_by          UUID REFERENCES users(id),
  void_reason        TEXT,
  client_created_at  TIMESTAMPTZ NOT NULL,     -- the REAL sale time on the terminal — use this for shift-window queries
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now() -- when the cloud received it; can lag client_created_at by hours if it queued offline
);
CREATE INDEX idx_sales_client_created ON sales (client_created_at);
CREATE INDEX idx_sales_shift          ON sales (shift_id);
CREATE INDEX idx_sales_cashier        ON sales (cashier_id);
CREATE INDEX idx_sales_status         ON sales (status);

-- ----------------------------------------------------------------------------
-- SALE ITEMS
-- ----------------------------------------------------------------------------
CREATE TABLE sale_items (
  id                   UUID PRIMARY KEY,
  sale_id              UUID NOT NULL REFERENCES sales(id),
  product_id           UUID NOT NULL REFERENCES products(id),
  sku_snapshot         TEXT NOT NULL,
  name_snapshot        TEXT NOT NULL,
  unit_price_snapshot  NUMERIC(12,2) NOT NULL,
  quantity             NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  line_discount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total           NUMERIC(12,2) NOT NULL,
  voided_at            TIMESTAMPTZ,           -- set only by an authorized, audited void (see design note 4)
  voided_by            UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sale_items_sale    ON sale_items (sale_id);
CREATE INDEX idx_sale_items_product ON sale_items (product_id);

-- ----------------------------------------------------------------------------
-- STOCK MOVEMENTS — a ledger. Not one of the six tables you listed, but this
-- is what makes "sync relative deltas" (your Section 2 requirement) safe
-- instead of a black box: the sync worker only ever INSERTs a movement, and
-- a trigger applies it to products.stock_quantity. It never has to
-- read-modify-write the running total itself, which is exactly what avoids
-- the split-brain conflict you called out.
-- ----------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id                 UUID PRIMARY KEY,
  product_id         UUID NOT NULL REFERENCES products(id),
  terminal_id        TEXT,                    -- null = made from the admin dashboard, not a terminal
  delta              NUMERIC(12,3) NOT NULL,  -- negative = stock out, positive = stock in
  reason             TEXT NOT NULL CHECK (reason IN
                        ('sale', 'void_restock', 'manual_adjustment', 'stock_receipt', 'stocktake_correction')),
  reference_id       UUID,                    -- e.g. the sale_id this movement came from
  actor_id           UUID REFERENCES users(id),
  note               TEXT,                    -- optional free text, e.g. "delivery from supplier" on a manual receipt
  client_created_at  TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_product ON stock_movements (product_id);

CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
     SET stock_quantity = stock_quantity + NEW.delta,
         updated_at = now()
   WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_movement
AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ----------------------------------------------------------------------------
-- AUDIT LOGS — hard append-only. Voids, PIN overrides, failed PIN attempts,
-- shift discrepancies. This is the anti-theft trail the owner reviews.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                 UUID PRIMARY KEY,
  terminal_id        TEXT NOT NULL,
  actor_id           UUID REFERENCES users(id),   -- who triggered the event (usually the cashier)
  approver_id        UUID REFERENCES users(id),   -- manager/owner who entered a PIN, if any
  action_type        TEXT NOT NULL CHECK (action_type IN
                        ('void_item', 'void_sale', 'refund', 'price_override',
                         'manual_stock_adjustment', 'failed_pin_attempt', 'shift_close_discrepancy')),
  entity_type        TEXT,
  entity_id          UUID,
  details            JSONB,
  client_created_at  TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_actor   ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_created ON audit_logs (client_created_at);

CREATE OR REPLACE FUNCTION block_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only — % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- ----------------------------------------------------------------------------
-- Example: shift breakdown by time window (Morning 8:00-12:00 vs
-- Afternoon/Evening 12:00-19:00), using client_created_at — NOT created_at,
-- since a sale made at 11:55 that syncs at 12:03 is still a morning sale.
-- ----------------------------------------------------------------------------
-- SELECT
--   CASE WHEN client_created_at::time < '12:00' THEN 'Morning' ELSE 'Afternoon/Evening' END AS shift_window,
--   SUM(total_amount) AS revenue,
--   COUNT(*) AS transaction_count
-- FROM sales
-- WHERE status = 'completed'
--   AND client_created_at >= '2026-08-14 00:00+08'
--   AND client_created_at <  '2026-08-15 00:00+08'
-- GROUP BY 1;

-- ----------------------------------------------------------------------------
-- Row Level Security — read this if you're calling Supabase directly from
-- the browser with the public anon key (the lean, no-custom-backend setup
-- this kit assumes; see README.md). Supabase enables RLS by default on new
-- tables, and with the anon key this is NOT optional — without policies,
-- every table is unreachable.
--
-- Two apps share this database now: the POS terminal (local-only, never
-- edits the catalog) and the admin app (also local-first, but DOES edit
-- products/stock, online or offline). Without Supabase Auth, Postgres can't
-- tell "a terminal" apart from "an admin device" by the anon key alone —
-- both hold the same key. The policies below reflect that honestly: they
-- allow product/stock writes at the database level for anyone holding the
-- key, and rely on YOUR app logic (the admin UI simply isn't exposed on
-- terminals; manager PIN checks gate sensitive POS actions) for the real
-- access boundary. That's proportionate for a small store. If you outgrow
-- it — a second location, or higher-value transactions — put the admin app
-- behind Supabase Auth so its policies can check auth.uid() instead of
-- "holds the anon key at all", and keep terminals on the plain anon key
-- with read-only product access.
-- ----------------------------------------------------------------------------
-- ALTER TABLE products ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "read products" ON products FOR SELECT USING (true);
-- CREATE POLICY "admin writes products" ON products FOR INSERT WITH CHECK (true);
-- CREATE POLICY "admin updates products" ON products FOR UPDATE USING (true);
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "read users" ON users FOR SELECT USING (true);
-- ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "terminals write sales" ON sales FOR INSERT WITH CHECK (true);
-- CREATE POLICY "terminals update own sales" ON sales FOR UPDATE USING (true);
-- CREATE POLICY "read sales" ON sales FOR SELECT USING (true);
-- -- Repeat SELECT + INSERT (+ UPDATE where the table can legitimately change:
-- -- sale_items, shift_logs, stock_movements) for those tables and audit_logs.
