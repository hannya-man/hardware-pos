// local-db.js — this terminal's offline copy (IndexedDB via Dexie).
// Catalog tables (products, categories, users, stock_batches, customers) are
// synced down from the server; sales, shifts, payments, logs and stock
// movements are written here first and pushed up through the outbox.
//
// sync_meta holds two different credentials:
//   terminal_key — set once when the device is provisioned; used for sync.
//   auth_token   — a per-person token, fetched only when a screen needs to
//                  read the server (see session.js).

import Dexie from 'dexie';

export const db = new Dexie('hardware_pos');

const schemaV2 = {
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
  outbox_queue: 'id, status, entity_type, created_at',
  sync_meta: 'key',
};

// v2 changed the product shape; re-pulling the catalog beats migrating it.
db.version(2).stores(schemaV2).upgrade((tx) => tx.table('products').clear());
db.version(3).stores({ ...schemaV2, material_requests: 'id, requested_by, status, client_created_at' });

// v4 adds credit customers and their payments. It also re-sends every shift
// this device has, once: before the server kept the terminal's ids, shifts
// were saved under different ones, so every sale and log pointing at them
// was rejected. Re-sending them, and retrying what had given up, lets that
// backlog through.
db.version(4).stores({
  customers: 'id, name, phone',
  credit_payments: 'id, customer_id, shift_id, client_created_at',
  shift_logs: 'id, status, started_at, terminal_id, cashier_id',
}).upgrade(async (tx) => {
  const outbox = tx.table('outbox_queue');
  for (const shift of await tx.table('shift_logs').toArray()) {
    await outbox.add({
      id: crypto.randomUUID(), entity_type: 'shift_log', entity_id: shift.id, payload: shift,
      status: 'pending', retry_count: 0, created_at: '1970-01-01T00:00:00.000Z',
    });
  }
  await outbox.where('status').equals('failed').modify({ status: 'pending', retry_count: 0, last_attempt_at: null });
});

export async function getSyncMeta(key, fallback = null) {
  const row = await db.sync_meta.get(key);
  return row ? row.value : fallback;
}

export const setSyncMeta = (key, value) => db.sync_meta.put({ key, value });

export async function getTerminalId() {
  let id = await getSyncMeta('terminal_id');
  if (!id) {
    id = crypto.randomUUID();
    await setSyncMeta('terminal_id', id);
  }
  return id;
}

export const getTerminalKey = () => getSyncMeta('terminal_key');
export const setTerminalKey = (key) => setSyncMeta('terminal_key', key);
export const isProvisioned = async () => (await getTerminalKey()) !== null;

export const getAuthToken = () => getSyncMeta('auth_token');
export const setAuthToken = (token) => setSyncMeta('auth_token', token);
export const clearAuthToken = () => db.sync_meta.delete('auth_token');

// One person's open shift on this terminal (resumed after a break or refresh).
export const getOpenShift = (terminal_id, cashier_id) => db.shift_logs
  .where('status').equals('open')
  .filter((s) => s.terminal_id === terminal_id && s.cashier_id === cashier_id)
  .first();

// The cash counted when this terminal's last shift ended: the next shift's
// starting cash, since the money stays in the drawer.
export async function lastCountedCash(terminal_id) {
  const closed = await db.shift_logs.where('terminal_id').equals(terminal_id)
    .filter((s) => s.status === 'closed' && s.counted_cash != null)
    .sortBy('ended_at');
  return closed.at(-1)?.counted_cash ?? 0;
}
