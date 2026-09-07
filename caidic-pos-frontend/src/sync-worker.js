// sync-worker.js
// Local-write-then-enqueue, real connectivity detection, backoff push,
// catalog pull — talking to the Laravel API. The one thing that changed
// since the last version of this file: sync now authenticates as the
// TERMINAL (X-Terminal-Key, set once at device setup), not as whichever
// staff member happens to be logged in. Login itself moved fully local —
// see input-handler.js's verifyStaffLogin(). A per-user Sanctum token
// still exists, but it's only fetched on demand, right before an
// owner-gated call (Returns, Reconciliation, Analytics, Activity log) —
// never required just to open the till.

import {
  db, getTerminalId, getSyncMeta, setSyncMeta,
  getTerminalKey, getAuthToken, setAuthToken, clearAuthToken
} from './local-db.js';

const API_BASE = import.meta.env.VITE_API_BASE; // e.g. https://api.caidichardware.example/api

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

class AuthRequiredError extends Error {
  constructor(kind) { super(`${kind} credential missing or rejected`); this.name = 'AuthRequiredError'; this.kind = kind; }
}

// mode: 'terminal' for routine catalog/sync traffic (device credential,
// always available once provisioned, works with no staff logged in at
// all). mode: 'user' for the owner-gated endpoints (per-user Sanctum
// token, fetched just-in-time — see loginWithPin()).
async function api(path, { method = 'GET', body, mode = 'terminal' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Terminal-Id': await getTerminalId() };

  if (mode === 'terminal') {
    const key = await getTerminalKey();
    if (!key) throw new AuthRequiredError('terminal'); // device was never provisioned — needs the one-time setup screen
    headers['X-Terminal-Key'] = key;
  } else if (mode === 'user') {
    const token = await getAuthToken();
    if (!token) throw new AuthRequiredError('user'); // no owner session yet — caller should prompt loginWithPin()
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    if (mode === 'user') await clearAuthToken(); // a rejected per-user token is worth clearing; a rejected terminal key needs re-provisioning, not clearing
    throw new AuthRequiredError(mode);
  }

  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

// PIN -> Sanctum token, fetched on demand right before an owner-gated
// action. Requires connectivity — that's an accepted limitation for these
// specific actions, established from the start, not a regression.
export async function loginWithPin(user_id, pin) {
  const { token } = await api('/auth/login', { method: 'POST', body: { user_id, pin }, mode: 'none' });
  await setAuthToken(token);
}

export async function logout() {
  try { await api('/auth/logout', { method: 'POST', mode: 'user' }); } catch { /* best-effort */ }
  await clearAuthToken();
}

// ---------------------------------------------------------------------------
// LOCAL WRITES — unchanged from the previous version. Sales/shifts/movements
// still write locally first, always, regardless of any credential's state.
// completeSale() still doesn't allocate against stock_batches yet — same
// flagged TODO as before, not silently resolved here.
// ---------------------------------------------------------------------------

async function enqueue(entity_type, entity_id, payload) {
  await db.outbox_queue.add({
    id: crypto.randomUUID(), entity_type, entity_id, payload,
    status: 'pending', retry_count: 0, created_at: new Date().toISOString()
  });
}

export async function completeSale({
  cashier_id, shift_id, cart, payment_method,
  amount_tendered = null, discount_amount = 0, tax_amount = 0
}) {
  const sale_id = crypto.randomUUID();
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
    id: crypto.randomUUID(), sale_id, product_id: line.product_id,
    sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot,
    unit_price_snapshot: line.unit_price_snapshot, quantity: line.quantity,
    line_discount: line.line_discount ?? 0, line_total: line.line_total,
    voided_at: null, voided_by: null
  }));

  // TODO: allocate against stock_batches, oldest received_at first, and
  // tag each movement with a batch_id — the architecture doc's allocateFifo(),
  // still not built. Recorded correctly in the ledger either way; just not
  // batch-aware yet.
  const movements = cart.map((line) => ({
    id: crypto.randomUUID(), product_id: line.product_id, batch_id: null,
    terminal_id, delta: -Math.abs(line.quantity), reason: 'sale',
    reference_id: sale_id, actor_id: cashier_id, client_created_at
  }));

  await db.transaction('rw', db.sales, db.sale_items, db.stock_movements, db.outbox_queue, async () => {
    await db.sales.add(sale);
    await db.sale_items.bulkAdd(items);
    await db.stock_movements.bulkAdd(movements);
    await enqueue('sale', sale_id, { sale, items, movements });
  });

  return sale_id;
}

export async function receiveStock({ product_id, location, quantity, damaged_quantity = 0, actor_id }) {
  const batch_id = crypto.randomUUID();
  const client_created_at = new Date().toISOString();
  const terminal_id = await getTerminalId();

  const batch = {
    id: batch_id, product_id, location, received_at: client_created_at,
    qty_received: quantity, qty_good_remaining: round3(quantity - damaged_quantity),
    qty_damaged: damaged_quantity, source: 'receiving', reference_id: null,
    created_by: actor_id, client_created_at
  };

  await db.transaction('rw', db.stock_batches, db.outbox_queue, async () => {
    await db.stock_batches.add(batch);
    await enqueue('stock_batch', batch_id, { ...batch, terminal_id });
  });

  return batch_id;
}

// Material Pick Lists — same local-write-then-enqueue pattern as
// completeSale()/receiveStock(). Any logged-in staff member can submit
// one; it's a routine terminal action, not an owner-gated one, so it
// syncs with the terminal key like everything else in this section.
export async function submitMaterialRequest({ requested_by, items, notes = null }) {
  const request_id = crypto.randomUUID();
  const terminal_id = await getTerminalId();
  const client_created_at = new Date().toISOString();

  const request = {
    id: request_id, terminal_id, requested_by, items, notes,
    status: 'pending', client_created_at
  };

  await db.transaction('rw', db.material_requests, db.outbox_queue, async () => {
    await db.material_requests.add(request);
    await enqueue('material_request', request_id, request);
  });

  return request_id;
}

export async function logFailedPinAttempt({ actor_id = null, context = {} }) {
  const terminal_id = await getTerminalId();
  const audit = {
    id: crypto.randomUUID(), terminal_id, actor_id, approver_id: null,
    action_type: 'failed_pin_attempt', entity_type: context.entity_type ?? null,
    entity_id: context.entity_id ?? null, details: context, client_created_at: new Date().toISOString()
  };
  await db.transaction('rw', db.audit_logs, db.outbox_queue, async () => {
    await db.audit_logs.add(audit);
    await enqueue('audit_log', audit.id, audit);
  });
}

export async function logActivity({ actor_id, shift_id = null, event_type, entity_type = null, entity_id = null, details = {} }) {
  const terminal_id = await getTerminalId();
  const activity = {
    id: crypto.randomUUID(), terminal_id, actor_id, shift_id, event_type,
    entity_type, entity_id, details, client_created_at: new Date().toISOString()
  };
  await db.transaction('rw', db.activity_log, db.outbox_queue, async () => {
    await db.activity_log.add(activity);
    await enqueue('activity_log', activity.id, activity);
  });
}

export async function openShift({ cashier_id, opening_cash }) {
  const terminal_id = await getTerminalId();
  const shift = {
    id: crypto.randomUUID(), terminal_id, cashier_id,
    started_at: new Date().toISOString(), ended_at: null,
    opening_cash, expected_cash: null, counted_cash: null,
    cash_discrepancy: null, status: 'open'
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
    id: crypto.randomUUID(), terminal_id: shift.terminal_id, actor_id: shift.cashier_id,
    approver_id: null, action_type: 'shift_close_discrepancy', entity_type: 'shift_log',
    entity_id: shift_id, details: { expected_cash, counted_cash, cash_discrepancy }, client_created_at: ended_at
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
// OWNER-GATED CALLS — the only functions in this file that require a
// per-user token. Each one assumes loginWithPin() already ran for the
// currently-logged-in owner; if the token's missing or was rejected, this
// throws AuthRequiredError('user') and the caller should re-prompt the PIN.
// ---------------------------------------------------------------------------

export async function submitReturn(payload) {
  return api('/returns', { method: 'POST', body: payload, mode: 'user' });
}

export async function fetchTodayReconciliation(date) {
  return api(`/reconciliation/today?date=${date}`, { mode: 'user' });
}

export async function submitReconciliation(payload) {
  return api('/reconciliation', { method: 'POST', body: payload, mode: 'user' });
}

export async function fetchMovers(days = 7) {
  return api(`/analytics/movers?days=${days}`, { mode: 'user' });
}

export async function fetchDashboard(period = 'today') {
  return api(`/dashboard?period=${period}`, { mode: 'user' });
}

export async function fetchStock(includeArchived = false) {
  return api(`/inventory/stock?include_archived=${includeArchived ? 1 : 0}`, { mode: 'user' });
}

export async function updateProduct(id, payload) {
  return api(`/products/${id}`, { method: 'PATCH', body: payload, mode: 'user' });
}

// Material Pick Lists — viewing/fulfilling only. Creation is
// submitMaterialRequest() above, which never touches this mode:'user' path.
export async function fetchMaterialRequests(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api(`/material-requests${qs ? `?${qs}` : ''}`, { mode: 'user' });
}

export async function fulfillMaterialRequest(id) {
  return api(`/material-requests/${id}/fulfill`, { method: 'PATCH', mode: 'user' });
}

// Supplier Orders
export async function fetchSuppliers() {
  return api('/suppliers', { mode: 'user' });
}

export async function createSupplier(payload) {
  return api('/suppliers', { method: 'POST', body: payload, mode: 'user' });
}

export async function fetchPurchaseOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api(`/purchase-orders${qs ? `?${qs}` : ''}`, { mode: 'user' });
}

export async function createPurchaseOrder(payload) {
  return api('/purchase-orders', { method: 'POST', body: payload, mode: 'user' });
}

export async function receivePurchaseOrder(id) {
  return api(`/purchase-orders/${id}/receive`, { method: 'PATCH', mode: 'user' });
}

export async function submitCycleCount(payload) {
  return api('/cycle-counts', { method: 'POST', body: payload, mode: 'user' });
}

export async function fetchActivityLog(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api(`/activity${qs ? `?${qs}` : ''}`, { mode: 'user' });
}

export async function fetchSales(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api(`/sales${qs ? `?${qs}` : ''}`, { mode: 'user' });
}

export async function voidSaleAsAdmin(saleId, reason) {
  return api(`/sales/${saleId}/void`, { method: 'POST', body: { reason }, mode: 'user' });
}

export async function fetchShifts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api(`/shifts${qs ? `?${qs}` : ''}`, { mode: 'user' });
}

export async function fetchUsers() {
  return api('/users', { mode: 'user' });
}

export async function createUser(payload) {
  return api('/users', { method: 'POST', body: payload, mode: 'user' });
}

export async function updateUser(id, payload) {
  return api(`/users/${id}`, { method: 'PATCH', body: payload, mode: 'user' });
}

// ---------------------------------------------------------------------------
// CONNECTIVITY
// ---------------------------------------------------------------------------

let isOnline = false;

async function checkRealConnectivity() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${API_BASE.replace(/\/api$/, '')}/up`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
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
// OUTBOX FLUSH — terminal-key authenticated. Runs the same whether zero
// staff or three staff have ever logged into this device today.
// ---------------------------------------------------------------------------

const MAX_RETRY_COUNT = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60_000;
const BATCH_SIZE = 50;

function backoffDelay(retryCount) {
  const cap = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
  return cap / 2 + Math.random() * (cap / 2);
}

let flushing = false;

export async function flushOutbox({ onNeedsProvisioning } = {}) {
  if (flushing) return;
  flushing = true;
  try {
    const pending = await db.outbox_queue.where('status').equals('pending').sortBy('created_at');

    const due = pending.filter((item) => {
      const readyAt = item.last_attempt_at
        ? new Date(item.last_attempt_at).getTime() + backoffDelay(item.retry_count)
        : 0;
      return Date.now() >= readyAt;
    });

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const chunk = due.slice(i, i + BATCH_SIZE);

      let results;
      try {
        const response = await api('/sync/push', {
          method: 'POST', mode: 'terminal',
          body: { items: chunk.map((item) => ({ id: item.id, entity_type: item.entity_type, payload: item.payload })) }
        });
        results = response.results;
      } catch (err) {
        if (err instanceof AuthRequiredError && err.kind === 'terminal') {
          onNeedsProvisioning?.(); // this device was never set up with a terminal key — a real setup gap, not a transient failure
          return;
        }
        continue; // network failure — leave the chunk pending, backoff applies per-item next attempt
      }

      for (const item of chunk) {
        const result = results[item.id];
        if (result?.ok) {
          await db.outbox_queue.delete(item.id);
          continue;
        }

        const retry_count = item.retry_count + 1;
        await db.outbox_queue.update(item.id, {
          retry_count, last_attempt_at: new Date().toISOString(),
          status: retry_count >= MAX_RETRY_COUNT ? 'failed' : 'pending'
        });
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// CATALOG PULL — terminal-key authenticated, same reasoning as the flush.
// ---------------------------------------------------------------------------

export async function pullCatalog() {
  const since = await getSyncMeta('catalog_pulled_at', '1970-01-01T00:00:00Z');

  let data;
  try {
    data = await api(`/catalog?since=${encodeURIComponent(since)}`, { mode: 'terminal' });
  } catch (err) {
    if (err instanceof AuthRequiredError) return false;
    throw err;
  }

  await db.transaction('rw', db.products, db.categories, db.users, db.stock_batches, async () => {
    if (data.products?.length) await db.products.bulkPut(data.products);
    if (data.categories?.length) await db.categories.bulkPut(data.categories);
    if (data.users?.length) await db.users.bulkPut(data.users);
    if (data.stock_batches?.length) await db.stock_batches.bulkPut(data.stock_batches);
  });

  await setSyncMeta('catalog_pulled_at', data.server_time);
  return true;
}

// ---------------------------------------------------------------------------
// BACKGROUND LOOP
// ---------------------------------------------------------------------------

let stopWatcher = null;
let flushInterval = null;
let pullInterval = null;

export function startSyncWorker({ onStatusChange, onNeedsProvisioning } = {}) {
  stopWatcher = startConnectivityWatcher(async (online) => {
    onStatusChange?.(online ? 'online' : 'offline');
    if (online) {
      await flushOutbox({ onNeedsProvisioning });
      await pullCatalog();
    }
  });

  flushInterval = setInterval(() => flushOutbox({ onNeedsProvisioning }), 15_000);
  pullInterval = setInterval(pullCatalog, 60_000);
}

export function stopSyncWorker() {
  stopWatcher?.();
  clearInterval(flushInterval);
  clearInterval(pullInterval);
}
