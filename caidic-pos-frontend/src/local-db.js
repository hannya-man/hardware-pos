// local-db.js
// Same shape as before — a mirror of the cloud catalog (synced DOWN,
// read-only from the terminal's point of view) plus this terminal's own
// transactions (written instantly, pushed UP later).
//
// Two credentials now live in sync_meta, and they mean different things:
//   - terminal_key: set ONCE, during this device's initial setup, by
//     whoever configures a new till. Persists forever, unrelated to who's
//     logged in. This is what lets catalog pulls and outbox pushes work
//     regardless of whether a fresh Sanctum token happens to exist.
//   - auth_token: a per-USER Sanctum token, fetched on demand right before
//     an owner-gated action (Returns, Reconciliation, Analytics, Activity
//     log) — never required just to log in and start billing.

import Dexie from 'dexie';

export const db = new Dexie('hardware_pos');

db.version(2).stores({
  // ---- Synced DOWN from the cloud. The terminal never writes these. ----
  products: 'id, sku, barcode, category_id, name, updated_at',
  categories: 'id, name',
  users: 'id, role',
  stock_batches: 'id, product_id, location, received_at, qty_good_remaining, updated_at',

  // ---- Written here first, pushed UP via the outbox. ----
  sales: 'id, shift_id, client_created_at, status',
  sale_items: 'id, sale_id, product_id',
  shift_logs: 'id, status, started_at',
  audit_logs: 'id, actor_id, client_created_at',
  activity_log: 'id, actor_id, shift_id, client_created_at',
  stock_movements: 'id, product_id, batch_id, reference_id',

  // ---- Sync machinery only. Never leaves this device. ----
  outbox_queue: 'id, status, entity_type, created_at',
  sync_meta: 'key'
}).upgrade(async (tx) => {
  await tx.table('products').clear(); // v1 -> v2 shape changed enough that a fresh pullCatalog() is simpler than migrating field-by-field
});

// v3 — adds material_requests (Material Pick Lists). No shape change to
// any existing table, so no upgrade() callback needed: Dexie just creates
// the new, empty object store.
db.version(3).stores({
  products: 'id, sku, barcode, category_id, name, updated_at',
  categories: 'id, name',
  users: 'id, role',
  stock_batches: 'id, product_id, location, received_at, qty_good_remaining, updated_at',

  sales: 'id, shift_id, client_created_at, status',
  sale_items: 'id, sale_id, product_id',
  shift_logs: 'id, status, started_at',
  audit_logs: 'id, actor_id, client_created_at',
  activity_log: 'id, actor_id, shift_id, client_created_at',
  stock_movements: 'id, product_id, batch_id, reference_id',
  material_requests: 'id, requested_by, status, client_created_at',

  outbox_queue: 'id, status, entity_type, created_at',
  sync_meta: 'key'
});

export async function getTerminalId() {
  const existing = await db.sync_meta.get('terminal_id');
  if (existing) return existing.value;
  const id = crypto.randomUUID();
  await db.sync_meta.put({ key: 'terminal_id', value: id });
  return id;
}

// Device-level credential — see the file header. isProvisioned() is what
// the app checks on startup to decide whether to show a one-time setup
// screen (enter the key an owner got from `php artisan terminal:provision`)
// versus going straight to the staff PIN pad.
export async function getTerminalKey() {
  const row = await db.sync_meta.get('terminal_key');
  return row ? row.value : null;
}

export async function setTerminalKey(key) {
  await db.sync_meta.put({ key: 'terminal_key', value: key });
}

export async function isProvisioned() {
  return (await getTerminalKey()) !== null;
}

// Per-user credential — see the file header. Short-lived in practice: it's
// only fetched right before a gated action and it's fine if it's missing
// most of the time.
export async function getAuthToken() {
  const row = await db.sync_meta.get('auth_token');
  return row ? row.value : null;
}

export async function setAuthToken(token) {
  await db.sync_meta.put({ key: 'auth_token', value: token });
}

export async function clearAuthToken() {
  await db.sync_meta.delete('auth_token');
}

export async function getOpenShift(terminal_id) {
  return db.shift_logs.where({ terminal_id, status: 'open' }).first();
}

export async function getSyncMeta(key, fallback = null) {
  const row = await db.sync_meta.get(key);
  return row ? row.value : fallback;
}

export async function setSyncMeta(key, value) {
  await db.sync_meta.put({ key, value });
}
