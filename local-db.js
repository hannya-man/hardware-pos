// local-db.js
// The terminal's own copy of the world: a mirror of the cloud catalog/users
// (synced DOWN, read-only from the terminal's point of view) plus this
// terminal's own transactions (written instantly, pushed UP later). See
// sync-worker.js for how the two directions are kept honest.
//
// Field names use snake_case throughout, matching the Postgres columns in
// schema.sql exactly — a row can move local -> cloud or cloud -> local with
// zero mapping/translation code. It's not idiomatic JS, but a thin sync
// layer that mirrors DB rows 1:1 is exactly the case where that trade-off
// is worth it: one less place for a typo to silently drop a field.

import Dexie from 'dexie';

export const db = new Dexie('hardware_pos');

// Dexie's schema string: first field is the primary key, the rest are
// indexes. IDs are app-generated UUID strings (not auto-increment), so no
// '++' prefix anywhere.
db.version(1).stores({
  // ---- Synced DOWN from the cloud. The terminal never writes these. ----
  products: 'id, sku, barcode, category, name, updated_at',
  users: 'id, role',

  // ---- Written here first, pushed UP via the outbox. ----
  sales: 'id, shift_id, client_created_at, status',
  sale_items: 'id, sale_id, product_id',
  shift_logs: 'id, status, started_at',
  audit_logs: 'id, actor_id, client_created_at',
  stock_movements: 'id, product_id, reference_id',

  // ---- Sync machinery only. Never leaves this device. ----
  outbox_queue: 'id, status, entity_type, created_at',
  sync_meta: 'key'
});

// Every physical terminal needs a stable identity across restarts (it's
// what terminal_id on sales/shift_logs/audit_logs points back to). Generated
// once on first run, then persisted.
export async function getTerminalId() {
  const existing = await db.sync_meta.get('terminal_id');
  if (existing) return existing.value;
  const id = crypto.randomUUID();
  await db.sync_meta.put({ key: 'terminal_id', value: id });
  return id;
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
