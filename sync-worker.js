// sync-worker.js
// Everything about getting data between this terminal and the cloud:
//   - writing new records locally + queuing them for sync, atomically
//   - detecting REAL connectivity, not just navigator.onLine
//   - flushing the outbox with idempotent upserts + exponential backoff
//   - pulling catalog/user updates down from the cloud
//
// Assumes a Supabase project and calls supabase-js directly from the
// terminal (see README.md for why that's the leanest path on a free-tier
// stack). If you're using Turso or a custom API instead, everything above
// "PUSH" is unchanged — swap the supabase.from(...) calls in pushOne() and
// pullCatalog() for fetch() calls to your own endpoints.

import { createClient } from '@supabase/supabase-js';
import { db, getTerminalId, getSyncMeta, setSyncMeta } from './local-db.js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// ---------------------------------------------------------------------------
// LOCAL WRITES — instant, always succeed even with no network
// ---------------------------------------------------------------------------
// Every write below follows the same shape: write the real row(s) AND an
// outbox entry in one Dexie transaction, so the two can never drift apart —
// no sale can exist locally without a queued copy, and vice versa.

async function enqueue(entity_type, entity_id, payload) {
  await db.outbox_queue.add({
    id: crypto.randomUUID(),
    entity_type,
    entity_id,
    payload,
    status: 'pending',
    retry_count: 0,
    created_at: new Date().toISOString()
  });
}

export async function completeSale({
  cashier_id, shift_id, cart, payment_method,
  amount_tendered = null, discount_amount = 0, tax_amount = 0
}) {
  const sale_id = crypto.randomUUID(); // 128-bit UUIDv4 — collision odds are astronomically small even syncing many terminals
  const terminal_id = await getTerminalId();
  const client_created_at = new Date().toISOString();

  const subtotal = round2(cart.reduce((sum, line) => sum + line.line_total, 0));
  const total_amount = round2(subtotal - discount_amount + tax_amount);
  const change_amount = amount_tendered != null ? round2(amount_tendered - total_amount) : null;

  const sale = {
    id: sale_id, terminal_id, cashier_id, shift_id,
    subtotal, discount_amount, tax_amount, total_amount,
    payment_method, amount_tendered, change_amount,
    status: 'completed', client_created_at
  };

  const items = cart.map((line) => ({
    id: crypto.randomUUID(),
    sale_id,
    product_id: line.product_id,
    sku_snapshot: line.sku_snapshot,
    name_snapshot: line.name_snapshot,
    unit_price_snapshot: line.unit_price_snapshot,
    quantity: line.quantity,
    line_discount: line.line_discount ?? 0,
    line_total: line.line_total,
    voided_at: null,
    voided_by: null
  }));

  const movements = cart.map((line) => ({
    id: crypto.randomUUID(),
    product_id: line.product_id,
    terminal_id,
    delta: -Math.abs(line.quantity), // a sale is always stock OUT
    reason: 'sale',
    reference_id: sale_id,
    actor_id: cashier_id,
    client_created_at
  }));

  await db.transaction('rw', db.sales, db.sale_items, db.stock_movements, db.products, db.outbox_queue, async () => {
    await db.sales.add(sale);
    await db.sale_items.bulkAdd(items);
    await db.stock_movements.bulkAdd(movements);

    // Apply the delta to the LOCAL catalog copy immediately, so the very
    // next sale on this same terminal already sees the updated stock
    // without waiting on a round trip to the cloud.
    for (const m of movements) {
      const product = await db.products.get(m.product_id);
      if (product) {
        await db.products.update(m.product_id, { stock_quantity: round3(product.stock_quantity + m.delta) });
      }
    }

    await enqueue('sale', sale_id, { sale, items, movements });
  });

  return sale_id;
}

export async function voidSaleItem({ sale_item_id, actor_id, approver_id, reason }) {
  const item = await db.sale_items.get(sale_item_id);
  if (!item || item.voided_at) return;

  const terminal_id = await getTerminalId();
  const client_created_at = new Date().toISOString();
  const movement_id = crypto.randomUUID();
  const audit_id = crypto.randomUUID();

  const movement = {
    id: movement_id,
    product_id: item.product_id,
    terminal_id,
    delta: Math.abs(item.quantity), // voiding restores stock
    reason: 'void_restock',
    reference_id: item.sale_id,
    actor_id,
    client_created_at
  };

  const updatedItem = { ...item, voided_at: client_created_at, voided_by: approver_id };

  const audit = {
    id: audit_id,
    terminal_id,
    actor_id,
    approver_id,
    action_type: 'void_item',
    entity_type: 'sale_item',
    entity_id: sale_item_id,
    details: { reason, product_id: item.product_id, quantity: item.quantity },
    client_created_at
  };

  await db.transaction('rw', db.sale_items, db.stock_movements, db.products, db.audit_logs, db.outbox_queue, async () => {
    await db.sale_items.put(updatedItem);
    await db.stock_movements.add(movement);

    const product = await db.products.get(item.product_id);
    if (product) {
      await db.products.update(item.product_id, { stock_quantity: round3(product.stock_quantity + movement.delta) });
    }

    await db.audit_logs.add(audit);
    await enqueue('sale_item', sale_item_id, updatedItem);
    await enqueue('stock_movement', movement_id, movement);
    await enqueue('audit_log', audit_id, audit);
  });
}

// The admin app calls these two — same local-write-then-enqueue shape as
// everything above, which is what lets Inventory be edited fully offline
// and sync later, instead of going blank without a connection.

export async function saveProduct(fields) {
  const isNew = !fields.id;
  const id = fields.id ?? crypto.randomUUID();
  const existing = isNew ? null : await db.products.get(id);

  // stock_quantity is deliberately NEVER set here, even for edits — it
  // always carries forward the currently-known value. The only path that
  // changes it is adjustStock() below, so every stock change (whether from
  // a sale, a void, or an admin's manual count) goes through the same
  // stock_movements ledger and the same split-brain-safe delta apply.
  const product = {
    id,
    sku: fields.sku,
    barcode: fields.barcode || null,
    name: fields.name,
    category: fields.category,
    unit: fields.unit,
    unit_price: fields.unit_price,
    cost_price: fields.cost_price ?? null,
    stock_quantity: existing ? existing.stock_quantity : 0,
    reorder_level: fields.reorder_level ?? 0,
    is_active: fields.is_active ?? true,
    updated_at: new Date().toISOString()
  };

  await db.transaction('rw', db.products, db.outbox_queue, async () => {
    await db.products.put(product);
    await enqueue('product', id, product);
  });

  return id;
}

export async function adjustStock({ product_id, delta, reason, actor_id, note = null }) {
  const terminal_id = await getTerminalId(); // "terminal" here just means "this device", admin included
  const movement_id = crypto.randomUUID();
  const client_created_at = new Date().toISOString();
  const movement = { id: movement_id, product_id, terminal_id, delta, reason, reference_id: null, actor_id, client_created_at, note };

  await db.transaction('rw', db.stock_movements, db.products, db.outbox_queue, async () => {
    await db.stock_movements.add(movement);
    const product = await db.products.get(product_id);
    if (product) {
      await db.products.update(product_id, { stock_quantity: round3(product.stock_quantity + delta) });
    }
    await enqueue('stock_movement', movement_id, movement);
  });
}

export async function logFailedPinAttempt({ actor_id = null, context = {} }) {
  const terminal_id = await getTerminalId();
  const audit = {
    id: crypto.randomUUID(),
    terminal_id,
    actor_id,
    approver_id: null,
    action_type: 'failed_pin_attempt',
    entity_type: context.entity_type ?? null,
    entity_id: context.entity_id ?? null,
    details: context,
    client_created_at: new Date().toISOString()
  };
  await db.transaction('rw', db.audit_logs, db.outbox_queue, async () => {
    await db.audit_logs.add(audit);
    await enqueue('audit_log', audit.id, audit);
  });
}

export async function openShift({ cashier_id, opening_cash }) {
  const terminal_id = await getTerminalId();
  const shift = {
    id: crypto.randomUUID(),
    terminal_id,
    cashier_id,
    started_at: new Date().toISOString(),
    ended_at: null,
    opening_cash,
    expected_cash: null,
    counted_cash: null,
    cash_discrepancy: null,
    status: 'open'
  };
  await db.transaction('rw', db.shift_logs, db.outbox_queue, async () => {
    await db.shift_logs.add(shift);
    await enqueue('shift_log', shift.id, shift);
  });
  return shift.id;
}

export async function closeShift({ shift_id, counted_cash }) {
  const shift = await db.shift_logs.get(shift_id);
  if (!shift) throw new Error('Shift not found');

  // Expected cash = opening float + cash sales during this shift. Computed
  // here, never shown to the cashier before they submit counted_cash —
  // that's what makes the count "blind".
  const cashSales = await db.sales
    .where({ shift_id })
    .and((s) => s.status === 'completed' && s.payment_method === 'cash')
    .toArray();
  const cashTotal = cashSales.reduce((sum, s) => sum + s.total_amount, 0);
  const expected_cash = round2(shift.opening_cash + cashTotal);
  const cash_discrepancy = round2(counted_cash - expected_cash);
  const ended_at = new Date().toISOString();

  const updated = { ...shift, ended_at, expected_cash, counted_cash, cash_discrepancy, status: 'closed' };

  const audit = Math.abs(cash_discrepancy) > 0 ? {
    id: crypto.randomUUID(),
    terminal_id: shift.terminal_id,
    actor_id: shift.cashier_id,
    approver_id: null,
    action_type: 'shift_close_discrepancy',
    entity_type: 'shift_log',
    entity_id: shift_id,
    details: { expected_cash, counted_cash, cash_discrepancy },
    client_created_at: ended_at
  } : null;

  await db.transaction('rw', db.shift_logs, db.audit_logs, db.outbox_queue, async () => {
    await db.shift_logs.put(updated);
    await enqueue('shift_log', shift_id, updated);
    if (audit) {
      await db.audit_logs.add(audit);
      await enqueue('audit_log', audit.id, audit);
    }
  });

  return updated;
}

// ---------------------------------------------------------------------------
// CONNECTIVITY — navigator.onLine only tells you a network interface is up,
// not that it can reach Supabase (a captive Wi-Fi portal with no real
// internet still reports "online"). Treat the browser events as a fast
// trigger to re-check, then confirm for real with a short, timeout-bounded
// request before attempting a full flush.
// ---------------------------------------------------------------------------

let isOnline = false;

async function checkRealConnectivity() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res.ok || res.status === 404; // reachability is what matters; exact status depends on project config
  } catch {
    return false;
  }
}

export function startConnectivityWatcher(onChange) {
  const recheck = async () => {
    const nowOnline = await checkRealConnectivity();
    if (nowOnline !== isOnline) {
      isOnline = nowOnline;
      onChange(isOnline);
    }
  };

  window.addEventListener('online', recheck);
  window.addEventListener('offline', () => { isOnline = false; onChange(false); });
  const interval = setInterval(recheck, 20_000);
  recheck();

  return () => {
    window.removeEventListener('online', recheck);
    clearInterval(interval);
  };
}

// ---------------------------------------------------------------------------
// OUTBOX FLUSH — local -> cloud, idempotent upserts, exponential backoff
// ---------------------------------------------------------------------------

const MAX_RETRY_COUNT = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60_000;

function backoffDelay(retryCount) {
  const cap = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
  return cap / 2 + Math.random() * (cap / 2); // jitter: 50%-100% of the cap, avoids synchronized retries across terminals
}

// Tables that represent immutable historical events: once synced, a retried
// push should be a silent no-op, never an overwrite. sales / sale_items /
// shift_logs are inserted once but CAN legitimately change later (a sale
// gets voided, a shift gets closed), so those merge instead of ignoring.
const IMMUTABLE_TABLES = new Set(['stock_movements', 'audit_logs']);
const ENTITY_TABLE = {
  shift_log: 'shift_logs',
  audit_log: 'audit_logs',
  stock_movement: 'stock_movements',
  sale_item: 'sale_items',
  product: 'products' // written by the admin app, not the POS terminal — see saveProduct()/adjustStock() above
};

async function pushOne(item) {
  try {
    if (item.entity_type === 'sale') {
      const { sale, items, movements } = item.payload;
      const [r1, r2, r3] = await Promise.all([
        supabase.from('sales').upsert(sale, { onConflict: 'id' }),
        supabase.from('sale_items').upsert(items, { onConflict: 'id' }),
        supabase.from('stock_movements').upsert(movements, { onConflict: 'id', ignoreDuplicates: true })
      ]);
      return !r1.error && !r2.error && !r3.error;
    }

    const table = ENTITY_TABLE[item.entity_type];
    if (!table) return false;

    const { error } = await supabase
      .from(table)
      .upsert(item.payload, { onConflict: 'id', ignoreDuplicates: IMMUTABLE_TABLES.has(table) });
    return !error;
  } catch {
    return false;
  }
}

let flushing = false;

export async function flushOutbox() {
  if (flushing) return; // never run two flushes concurrently
  flushing = true;
  try {
    const pending = await db.outbox_queue.where('status').equals('pending').toArray();

    for (const item of pending) {
      const due = item.last_attempt_at
        ? new Date(item.last_attempt_at).getTime() + backoffDelay(item.retry_count)
        : 0;
      if (Date.now() < due) continue; // not due for retry yet

      const ok = await pushOne(item);
      if (ok) {
        await db.outbox_queue.delete(item.id);
        continue;
      }

      const retry_count = item.retry_count + 1;
      const last_attempt_at = new Date().toISOString();
      if (retry_count >= MAX_RETRY_COUNT) {
        // Give up automatically retrying — this needs a human to look at
        // it. Surface a "N sync errors" indicator in your admin UI rather
        // than retrying forever against, say, a row that fails a CHECK
        // constraint every single time.
        await db.outbox_queue.update(item.id, { status: 'failed', retry_count, last_attempt_at });
      } else {
        await db.outbox_queue.update(item.id, { retry_count, last_attempt_at });
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// CATALOG PULL — cloud -> local, one-directional. Cloud always wins.
// ---------------------------------------------------------------------------

export async function pullCatalog() {
  const since = await getSyncMeta('products_pulled_at', '1970-01-01T00:00:00Z');

  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .gt('updated_at', since)
    .order('updated_at', { ascending: true });

  if (error) return false;
  if (products?.length) {
    await db.products.bulkPut(products);
    await setSyncMeta('products_pulled_at', products.at(-1).updated_at);
  }

  const { data: users } = await supabase.from('users').select('*');
  if (users) await db.users.bulkPut(users);

  return true;
}

// ---------------------------------------------------------------------------
// BACKGROUND LOOP
// ---------------------------------------------------------------------------

let stopWatcher = null;
let flushInterval = null;
let pullInterval = null;

export function startSyncWorker({ onStatusChange } = {}) {
  stopWatcher = startConnectivityWatcher(async (online) => {
    onStatusChange?.(online ? 'online' : 'offline');
    if (online) {
      await flushOutbox();
      await pullCatalog();
    }
  });

  flushInterval = setInterval(flushOutbox, 15_000); // no-ops instantly while offline or empty
  pullInterval = setInterval(pullCatalog, 60_000);
}

export function stopSyncWorker() {
  stopWatcher?.();
  clearInterval(flushInterval);
  clearInterval(pullInterval);
}
