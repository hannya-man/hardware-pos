// sync-worker.js — everything that talks to the server, plus the local-first
// writes (sales, shifts, payments, stock, logs) that the outbox pushes up
// later.
//
// The server is Supabase: Postgres functions (supabase/migrations) called at
// /rest/v1/rpc/<name>. Routine sync authenticates as the TERMINAL (its key,
// set once when the device is provisioned), never as whoever is signed in.
// Screens that read the server use a per-person token instead (session.js).

import {
  db, getTerminalId, getSyncMeta, setSyncMeta,
  getTerminalKey, getAuthToken, setAuthToken, clearAuthToken,
} from './local-db.js';

// The project's address (https://<ref>.supabase.co) and its publishable key
// (or the older anon key). Both are public by design: the terminal key and
// each person's password, checked by the functions, are what protect the data.
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const serverConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// A legacy anon key is a JWT and also goes in Authorization; a publishable
// key (sb_publishable_...) only goes in apikey.
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  apikey: SUPABASE_KEY,
  ...(SUPABASE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
};

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const nowIso = () => new Date().toISOString();

class AuthRequiredError extends Error {
  constructor(kind) {
    super(`${kind} credential missing or rejected`);
    this.name = 'AuthRequiredError';
    this.kind = kind;
  }
}

// Sent with server calls so actions taken there land in the right shift.
let activeShiftId = null;
export const setActiveShift = (id) => { activeShiftId = id; };

// Calls one server function with { auth, args }. The terminal id and the
// shift go with every call, so actions taken there land in the right shift.
// mode 'terminal': device credential (catalog pull, outbox push, sign-in);
// terminalKey tries a key other than the saved one.
// mode 'user': per-person token for screens that read the server.
// A failure says why: err.offline when the server couldn't be reached (or
// is down), else err.status and the server's answer in err.body.
async function rpc(fn, args = {}, { mode = 'user', terminalKey = null } = {}) {
  if (!serverConfigured) {
    throw new Error('This copy of the app was built without its server address (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY).');
  }

  const auth = { terminal_id: await getTerminalId(), shift_id: activeShiftId };
  if (mode === 'terminal') {
    auth.terminal_key = terminalKey ?? await getTerminalKey();
    if (!auth.terminal_key) throw new AuthRequiredError('terminal');
  } else if (mode === 'user') {
    auth.token = await getAuthToken();
    if (!auth.token) throw new AuthRequiredError('user');
  }

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ auth, args }), signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach the server (${err.message}). Check the internet connection.`), { offline: true });
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  if (res.ok) return body;

  const message = body?.message ?? '';
  // PT401 / PT403: the functions refused this terminal's key or this person's sign-in.
  if (body?.code === 'PT401' || body?.code === 'PT403') {
    if (mode === 'user') await clearAuthToken(); // a rejected terminal key needs re-provisioning, not clearing
    throw new AuthRequiredError(mode);
  }
  // Supabase itself refused: a wrong project key, or the SQL was never run.
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Supabase refused the request (${message || res.status}). Check the project address and key this app was built with.`);
  }
  if (body?.code === 'PGRST202') {
    throw new Error('The server is missing the POS functions. Run the SQL files in the supabase folder on the Supabase project.');
  }
  // A refusal with a reason (wrong password, request expired, ...) is shown
  // as just that reason; anything else keeps the technical details.
  if (res.status < 500 && message) throw Object.assign(new Error(message), { status: res.status, body });
  throw Object.assign(new Error(`${fn} failed: ${res.status}${message ? `: ${message}` : ''}`), { status: res.status, body, offline: res.status >= 500 });
}

// Whether the server takes this terminal key: 'ok', 'rejected', or
// 'unknown' (no connection to ask). Checked before a typed key is saved.
export async function checkTerminalKey(key) {
  try {
    await rpc('pos_catalog', { since: '2999-01-01T00:00:00Z' }, { mode: 'terminal', terminalKey: key });
    return 'ok';
  } catch (err) {
    return err instanceof AuthRequiredError ? 'rejected' : 'unknown';
  }
}

// Swaps a person's password, and an owner's authenticator code when they use
// two-factor login, for a server token (the caller decides whether to keep
// it). The server checks the code: the till never has the secret. A refusal
// with err.body.code_required means the password was right and only the
// code is missing; two_factor_checked on success says the code was checked.
export const requestLogin = (user_id, password, code = null) =>
  rpc('pos_login', { user_id, pin: password, ...(code ? { code } : {}) }, { mode: 'terminal' });

export async function requestToken(user_id, password, code = null) {
  return (await requestLogin(user_id, password, code)).token;
}

export const saveServerLogin = (token) => setAuthToken(token);

// The server token belongs to whoever confirmed their PIN. It's revoked (when
// online) and forgotten at sign-out, so the next person never inherits it.
export async function forgetServerLogin() {
  if (await getAuthToken()) await rpc('pos_logout', {}, { mode: 'user' }).catch(() => {});
  await clearAuthToken();
}

// ---------------------------------------------------------------------------
// Local-first writes. Each one is saved on this device and queued in the
// outbox in the same transaction, whatever the connection is doing.
// ---------------------------------------------------------------------------

async function enqueue(entity_type, entity_id, payload) {
  await db.outbox_queue.add({
    id: crypto.randomUUID(), entity_type, entity_id, payload,
    status: 'pending', retry_count: 0, created_at: nowIso(),
  });
}

export async function logActivity({ actor_id, shift_id = null, event_type, entity_type = null, entity_id = null, details = {} }) {
  const activity = {
    id: crypto.randomUUID(), terminal_id: await getTerminalId(), actor_id, shift_id, event_type,
    entity_type, entity_id, details, client_created_at: nowIso(),
  };
  await db.transaction('rw', db.activity_log, db.outbox_queue, async () => {
    await db.activity_log.add(activity);
    await enqueue('activity_log', activity.id, activity);
  });
}

// A wrong password or authenticator code at the sign-in screen, for the
// owners' Audit log. Checked on this device, so it's recorded here and sent
// up like a sale: a till that's offline still reports it.
export async function recordFailedSignIn({ user_id, step, locked = false }) {
  const audit = {
    id: crypto.randomUUID(), terminal_id: await getTerminalId(), actor_id: null, approver_id: null,
    action_type: 'failed_pin_attempt', entity_type: 'user', entity_id: user_id,
    details: { step, locked, checked: 'device' }, client_created_at: nowIso(),
  };
  await db.transaction('rw', db.audit_logs, db.outbox_queue, async () => {
    await db.audit_logs.add(audit);
    await enqueue('audit_log', audit.id, audit);
  });
}

// FIFO: each sale line draws from this device's copy of the store's batches,
// oldest first, and tags every movement with the batch it came from (that is
// what lets a later void put the stock back). A shortfall (stale copy or a
// real oversell) is still recorded; the server flags it for the owner.
async function allocateSaleMovements({ line, terminal_id, sale_id, cashier_id, client_created_at }) {
  let remaining = round3(Math.abs(line.quantity));
  const movements = [];
  const movement = (batch_id, delta) => ({
    id: crypto.randomUUID(), product_id: line.product_id, batch_id, terminal_id,
    delta, reason: 'sale', reference_id: sale_id, actor_id: cashier_id, client_created_at,
  });

  const batches = await db.stock_batches
    .where('product_id').equals(line.product_id)
    .and((b) => b.location === 'store' && b.qty_good_remaining > 0)
    .sortBy('received_at');

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = round3(Math.min(remaining, batch.qty_good_remaining));
    if (take <= 0) continue;
    movements.push(movement(batch.id, -take));
    await db.stock_batches.update(batch.id, { qty_good_remaining: round3(batch.qty_good_remaining - take) });
    remaining = round3(remaining - take);
  }

  if (remaining > 0) {
    const last = movements.at(-1);
    if (last) last.delta = round3(last.delta - remaining);
    else movements.push(movement(null, -remaining));
  }

  return movements;
}

// No VAT is added here on purpose: this is not a BIR-accredited POS and the
// shelf price is the price paid, so the total is the sum of the lines.
//
// payment: { method: 'cash' | 'gcash' | 'credit', tendered, paid,
// reference, customer_id }. `paid` is what changed hands at the counter; on a
// credit sale the rest (total - paid) is what the customer owes.
export async function completeSale({ cashier_id, shift_id, cart, payment }) {
  const sale_id = crypto.randomUUID();
  const terminal_id = await getTerminalId();
  const client_created_at = nowIso();
  const total_amount = round2(cart.reduce((sum, line) => sum + line.line_total, 0));
  const { method, tendered = null, paid = total_amount, reference = null, customer_id = null } = payment;

  const sale = {
    id: sale_id, terminal_id, cashier_id, shift_id,
    subtotal: total_amount, discount_amount: 0, tax_amount: 0, total_amount,
    payment_method: method,
    amount_tendered: tendered,
    change_amount: method === 'cash' && tendered != null ? round2(tendered - total_amount) : null,
    amount_paid: round2(paid),
    payment_reference: reference,
    customer_id,
    status: 'completed', client_created_at,
  };

  const items = cart.map((line) => ({
    id: crypto.randomUUID(), sale_id, product_id: line.product_id,
    sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot,
    unit_price_snapshot: line.unit_price_snapshot, quantity: line.quantity,
    line_discount: line.line_discount ?? 0, line_total: line.line_total,
    voided_at: null, voided_by: null,
  }));

  // The stockroom gets the items ready: every sale goes to the pick lists,
  // saved together with the sale so one never exists without the other.
  const pickList = {
    id: crypto.randomUUID(), terminal_id, sale_id, requested_by: cashier_id, notes: null,
    items: cart.map((line) => ({
      product_id: line.product_id, sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot,
      unit_snapshot: line.unit_snapshot, quantity_requested: line.quantity,
    })),
    status: 'pending', client_created_at,
  };

  await db.transaction('rw', [db.sales, db.sale_items, db.stock_movements, db.stock_batches, db.material_requests, db.outbox_queue], async () => {
    await db.sales.add(sale);
    await db.sale_items.bulkAdd(items);

    const movements = [];
    for (const line of cart) {
      movements.push(...await allocateSaleMovements({ line, terminal_id, sale_id, cashier_id, client_created_at }));
    }

    await db.stock_movements.bulkAdd(movements);
    await enqueue('sale', sale_id, { sale, items, movements });
    await db.material_requests.add(pickList);
    await enqueue('material_request', pickList.id, pickList);
  });

  await logActivity({
    actor_id: cashier_id, shift_id, event_type: 'sale_completed', entity_type: 'sale', entity_id: sale_id,
    details: { total_amount, item_count: cart.length, payment_method: method },
  });

  return sale_id;
}

export async function receiveStock({ product_id, location, quantity, damaged_quantity = 0, actor_id }) {
  const client_created_at = nowIso();
  const batch = {
    id: crypto.randomUUID(), product_id, location, received_at: client_created_at,
    qty_received: quantity, qty_good_remaining: round3(quantity - damaged_quantity),
    qty_damaged: damaged_quantity, source: 'receiving', reference_id: null,
    created_by: actor_id, client_created_at,
  };
  const terminal_id = await getTerminalId();

  await db.transaction('rw', db.stock_batches, db.outbox_queue, async () => {
    await db.stock_batches.add(batch);
    await enqueue('stock_batch', batch.id, { ...batch, terminal_id });
  });

  return batch.id;
}

// Any staff member can send a pick list, from Billing or the Pick lists screen.
export async function submitMaterialRequest({ requested_by, shift_id = null, items, notes = null }) {
  const request = {
    id: crypto.randomUUID(), terminal_id: await getTerminalId(), requested_by, items, notes,
    status: 'pending', client_created_at: nowIso(),
  };

  await db.transaction('rw', db.material_requests, db.outbox_queue, async () => {
    await db.material_requests.add(request);
    await enqueue('material_request', request.id, request);
  });

  await logActivity({
    actor_id: requested_by, shift_id, event_type: 'material_request_sent',
    entity_type: 'material_request', entity_id: request.id, details: { item_count: items.length },
  });

  return request.id;
}

// Credit customers are created at the register, so this works offline.
export async function saveCustomer({ id = crypto.randomUUID(), name, phone = null }) {
  const customer = { id, name: name.trim(), phone: phone?.trim() || null, is_active: true };
  await db.transaction('rw', db.customers, db.outbox_queue, async () => {
    await db.customers.put(customer);
    await enqueue('customer', id, customer);
  });
  return customer;
}

export async function recordCreditPayment({ customer_id, amount, payment_method, reference = null, note = null, received_by, shift_id }) {
  const payment = {
    id: crypto.randomUUID(), customer_id, amount: round2(amount), payment_method, reference, note,
    terminal_id: await getTerminalId(), shift_id, received_by, client_created_at: nowIso(),
  };
  await db.transaction('rw', db.credit_payments, db.outbox_queue, async () => {
    await db.credit_payments.add(payment);
    await enqueue('credit_payment', payment.id, payment);
  });
  await logActivity({
    actor_id: received_by, shift_id, event_type: 'credit_payment_received',
    entity_type: 'customer', entity_id: customer_id, details: { amount: payment.amount, payment_method },
  });
  return payment;
}

// ---------------------------------------------------------------------------
// Shifts: one per person, from clock-in (sign-in) to clock-out (End shift).
// ---------------------------------------------------------------------------

export async function openShift({ cashier_id, opening_cash }) {
  const shift = {
    id: crypto.randomUUID(), terminal_id: await getTerminalId(), cashier_id,
    started_at: nowIso(), ended_at: null,
    opening_cash, expected_cash: null, counted_cash: null,
    cash_discrepancy: null, status: 'open',
  };
  await db.transaction('rw', db.shift_logs, db.outbox_queue, async () => {
    await db.shift_logs.add(shift);
    await enqueue('shift_log', shift.id, shift);
  });
  await logActivity({ actor_id: cashier_id, shift_id: shift.id, event_type: 'shift_started', entity_type: 'shift_log', entity_id: shift.id, details: { opening_cash } });
  return shift.id;
}

// The cash that should be in the drawer: what it started with, plus cash
// sales, down payments on credit sales, and cash credit payments taken.
export async function shiftCash(shift_id) {
  const shift = await db.shift_logs.get(shift_id);
  const sales = await db.sales.where('shift_id').equals(shift_id).filter((s) => s.status === 'completed').toArray();
  const payments = await db.credit_payments.where('shift_id').equals(shift_id).toArray();

  const cashIn = round2(
    sales.reduce((sum, s) => sum + (s.payment_method === 'cash' ? s.total_amount : s.payment_method === 'credit' ? s.amount_paid ?? 0 : 0), 0)
    + payments.reduce((sum, p) => sum + (p.payment_method === 'cash' ? p.amount : 0), 0),
  );
  return { opening: shift.opening_cash ?? 0, cashIn, expected: round2((shift.opening_cash ?? 0) + cashIn), salesCount: sales.length };
}

// Clock-out. counted_cash is the person's own blind count of the drawer;
// null when there was no cash to count.
export async function closeShift({ shift_id, counted_cash }) {
  const shift = await db.shift_logs.get(shift_id);
  if (!shift) throw new Error('Shift not found');

  const { expected } = await shiftCash(shift_id);
  const counted = counted_cash == null ? null : round2(counted_cash);
  const cash_discrepancy = counted == null ? null : round2(counted - expected);
  const ended_at = nowIso();
  const updated = { ...shift, ended_at, expected_cash: expected, counted_cash: counted, cash_discrepancy, status: 'closed' };

  const audit = cash_discrepancy ? {
    id: crypto.randomUUID(), terminal_id: shift.terminal_id, actor_id: shift.cashier_id,
    approver_id: null, action_type: 'shift_close_discrepancy', entity_type: 'shift_log',
    entity_id: shift_id, details: { expected_cash: expected, counted_cash: counted, cash_discrepancy }, client_created_at: ended_at,
  } : null;

  await db.transaction('rw', db.shift_logs, db.audit_logs, db.outbox_queue, async () => {
    await db.shift_logs.put(updated);
    await enqueue('shift_log', shift_id, updated);
    if (audit) {
      await db.audit_logs.add(audit);
      await enqueue('audit_log', audit.id, audit);
    }
  });
  await logActivity({ actor_id: shift.cashier_id, shift_id, event_type: 'shift_ended', entity_type: 'shift_log', entity_id: shift_id, details: { expected_cash: expected, counted_cash: counted } });

  return updated;
}

// ---------------------------------------------------------------------------
// Server reads (per-person token; see session.js)
// ---------------------------------------------------------------------------

// Empty filters are left out, as they were from a query string.
const filters = (params = {}) => Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''));

export const fetchDashboard = (period) => rpc('pos_dashboard', { period });
export const fetchStock = (includeArchived = false) => rpc('pos_stock', { include_archived: includeArchived });
export const fetchCategories = () => rpc('pos_categories');
export const fetchNextSku = (categoryId) => rpc('pos_next_sku', { category_id: categoryId });
export const createProduct = (payload) => rpc('pos_product_create', payload);
export const updateProduct = (id, payload) => rpc('pos_product_update', { ...payload, id });

export const fetchMaterialRequests = (params) => rpc('pos_material_requests', filters(params));
export const fulfillMaterialRequest = (id) => rpc('pos_material_request_fulfill', { id });

export const fetchSales = (params) => rpc('pos_sales', filters(params));
export const fetchSalesReport = (period, offset = 0) => rpc('pos_sales_report', { period, offset });
export const fetchShifts = (params) => rpc('pos_shifts', filters(params));
export const fetchShift = (id) => rpc('pos_shift', { id });
export const submitReturn = (payload) => rpc('pos_return_create', payload);

// Voids need two owners (voids.js).
export const requestVoid = (saleId, reason) => rpc('pos_void_request_create', { sale_id: saleId, reason });
export const fetchVoidRequests = () => rpc('pos_void_requests');
export const fetchVoidRequest = (id) => rpc('pos_void_request', { id });
export const approveVoid = (id) => rpc('pos_void_approve', { id });
export const approveVoidHere = (id, payload) => rpc('pos_void_approve_here', { ...payload, id });
export const rejectVoid = (id) => rpc('pos_void_reject', { id });

export const fetchCustomers = (params) => rpc('pos_customers', filters(params));
export const fetchCustomer = (id) => rpc('pos_customer', { id });

// Only active accounts unless includeArchived.
export const fetchUsers = (includeArchived = false) => rpc('pos_users', { include_archived: includeArchived });
export const createUser = (payload) => rpc('pos_user_create', payload);
export const updateUser = (id, payload) => rpc('pos_user_update', { ...payload, id });
export const setupTwoFactor = (id) => rpc('pos_two_factor_setup', { id });
export const verifyTwoFactor = (id, code) => rpc('pos_two_factor_verify', { id, code });
export const disableTwoFactor = (id) => rpc('pos_two_factor_disable', { id });

export const fetchAuditLog = (params) => rpc('pos_audit_log', filters(params));

// ---------------------------------------------------------------------------
// Connectivity, outbox push, catalog pull
// ---------------------------------------------------------------------------

// Whether Supabase answers at all. A project that's paused or failing (5xx)
// counts as offline; a network failure throws.
async function isServerReachable() {
  if (!serverConfigured) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pos_ping`, {
      method: 'POST', headers: HEADERS, body: '{}', signal: AbortSignal.timeout(4000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const MAX_RETRY_COUNT = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60_000;
const BATCH_SIZE = 50;
// Records others point at go first: a sale needs its shift and customer, and
// a pick list shows its sale's details once the sale is there.
const PUSH_ORDER = { customer: 0, shift_log: 1, sale: 2, material_request: 3 };

function backoffDelay(retryCount) {
  const cap = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
  return cap / 2 + Math.random() * (cap / 2);
}

// Gives items the outbox already gave up on another chance (Sync now).
export async function retryFailedOutbox() {
  return db.outbox_queue.where('status').equals('failed').modify({ status: 'pending', retry_count: 0, last_attempt_at: null });
}

// One push at a time. Asking while one runs waits for it, plus one more
// round for anything saved meanwhile, so "send what's waiting, then read the
// server" (Credit, Sales, Dashboard) always includes the sale just made.
let flushing = null;
let flushAgain = false;

export function flushOutbox(options = {}) {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false;
        await pushPending(options);
      } while (flushAgain);
      await reportUnsynced();
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// Records the server refused MAX_RETRY_COUNT times stop retrying on their
// own. They're never silent: the count goes to the screen (the status pill)
// until Sync now gets them through or an owner looks into it.
let onUnsynced = null;
async function reportUnsynced() {
  onUnsynced?.(await db.outbox_queue.where('status').equals('failed').count());
}

async function pushPending({ onNeedsProvisioning } = {}) {
  const pending = await db.outbox_queue.where('status').equals('pending').toArray();
  const due = pending
    .filter((item) => !item.last_attempt_at || Date.now() >= new Date(item.last_attempt_at).getTime() + backoffDelay(item.retry_count))
    .sort((a, b) => (PUSH_ORDER[a.entity_type] ?? 2) - (PUSH_ORDER[b.entity_type] ?? 2) || a.created_at.localeCompare(b.created_at));

  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const chunk = due.slice(i, i + BATCH_SIZE);

    let results;
    try {
      ({ results } = await rpc('pos_sync_push', {
        items: chunk.map(({ id, entity_type, payload }) => ({ id, entity_type, payload })),
      }, { mode: 'terminal' }));
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        onNeedsProvisioning?.();
        return;
      }
      console.warn('[sync] push failed, will retry:', err.message);
      continue;
    }

    for (const item of chunk) {
      const result = results[item.id];
      if (result?.ok) {
        await db.outbox_queue.delete(item.id);
        continue;
      }
      console.warn(`[sync] server rejected a "${item.entity_type}" item:`, result?.error ?? 'no error message', item.payload);
      const retry_count = item.retry_count + 1;
      await db.outbox_queue.update(item.id, {
        retry_count, last_attempt_at: nowIso(),
        status: retry_count >= MAX_RETRY_COUNT ? 'failed' : 'pending',
      });
    }
  }
}

const CATALOG_TABLES = ['products', 'categories', 'users', 'stock_batches', 'customers'];

// Incremental: only asks for what changed since the last pull. `fresh`
// replaces this device's copy entirely (Sync now), which also drops anything
// stale that an incremental pull can't fix.
export async function pullCatalog({ fresh = false } = {}) {
  const since = fresh ? '1970-01-01T00:00:00Z' : await getSyncMeta('catalog_pulled_at', '1970-01-01T00:00:00Z');

  let data;
  try {
    data = await rpc('pos_catalog', { since }, { mode: 'terminal' });
  } catch (err) {
    if (err instanceof AuthRequiredError) return false;
    throw err;
  }

  await db.transaction('rw', [...CATALOG_TABLES.map((t) => db[t]), db.sales], async () => {
    for (const table of CATALOG_TABLES) {
      if (fresh) await db[table].clear();
      if (data[table]?.length) await db[table].bulkPut(data[table]);
    }
    // Voids are approved on the server. Marking this device's copy keeps a
    // voided cash sale out of the drawer count at the end of the shift.
    if (data.voided_sales?.length) await db.sales.where('id').anyOf(data.voided_sales).modify({ status: 'voided' });
  });

  await setSyncMeta('catalog_pulled_at', data.server_time);
  return true;
}

export const forceFullSync = () => pullCatalog({ fresh: true });

export function startSyncWorker({ onStatusChange, onNeedsProvisioning, onUnsynced: reportTo } = {}) {
  let online = null;
  onUnsynced = reportTo ?? null;
  reportUnsynced();

  // A key the server stopped taking shows up here too, with nothing waiting to be sent.
  const pull = () => pullCatalog().then((ok) => { if (ok === false) onNeedsProvisioning?.(); }, () => {});

  const recheck = async () => {
    const now = await isServerReachable();
    if (now === online) return;
    online = now;
    onStatusChange?.(online);
    if (online) {
      await flushOutbox({ onNeedsProvisioning });
      await pull();
    }
  };

  window.addEventListener('online', recheck);
  window.addEventListener('offline', () => { online = false; onStatusChange?.(false); });
  setInterval(recheck, 20_000);
  recheck();

  setInterval(() => flushOutbox({ onNeedsProvisioning }), 15_000);
  setInterval(pull, 60_000);
}
