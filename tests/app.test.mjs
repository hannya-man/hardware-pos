// Runs the app's own sync-worker.js / local-db.js / input-handler.js (copied
// unchanged except for import.meta.env) in Node, with IndexedDB faked and
// fetch routed to the imitation Supabase, through a whole store day.
import 'fake-indexeddb/auto';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { checker, createProject, fakeFetch } from './harness.mjs';

// The copies live under tests/, so their imports (dexie, bcryptjs) resolve
// from tests/node_modules. The folder is git-ignored.
const SRC = new URL('../caidic-pos-frontend/src/', import.meta.url);
const APP = new URL('./.app-under-test/', import.meta.url);
mkdirSync(APP, { recursive: true });
writeFileSync(new URL('package.json', APP), '{ "type": "module" }');
for (const file of ['local-db.js', 'sync-worker.js', 'input-handler.js', 'totp.js']) {
  writeFileSync(new URL(file, APP), readFileSync(new URL(file, SRC), 'utf8').replaceAll('import.meta.env', 'globalThis.__ENV__'));
}

const { check, finish } = checker();
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;
async function throws(label, fn, test) {
  try {
    await fn();
    check(label, false, 'did not throw');
  } catch (err) {
    check(label, test(err), `${err.name}: ${err.message}`);
  }
}

const URL_BASE = 'https://test-ref.supabase.co';
globalThis.__ENV__ = { VITE_SUPABASE_URL: `${URL_BASE}/`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
const server = await createProject();
const requests = [];
globalThis.fetch = fakeFetch(server, URL_BASE, { onRequest: (fn, body, headers) => requests.push({ fn, body, headers }) });

const one = async (sql, params) => (await server.query(sql, params)).rows[0];
const owner1 = (await one(`select pos.add_staff('Rosa Cruz', 'owner', '111111') as id`)).id;
const owner2 = (await one(`select pos.add_staff('Carlo Cruz', 'owner', '222222') as id`)).id;
const cashierId = (await one(`select pos.add_staff('Ana Reyes', 'cashier', '1234') as id`)).id;
const terminalKey = (await one(`select pos.add_terminal('Front counter') as k`)).k;

const local = await import(new URL('local-db.js', APP));
const sync = await import(new URL('sync-worker.js', APP));
const { verifyStaffLogin, findExactProduct, makeCartLine } = await import(new URL('input-handler.js', APP));
const { verifyTotp } = await import(new URL('totp.js', APP));
const { db } = local;

check('configured from the env', sync.serverConfigured === true);

// --- a new device: no key yet -------------------------------------------
check('catalog pull without a key reports not provisioned', (await sync.pullCatalog()) === false);
await local.setTerminalKey(terminalKey);
check('catalog pull', (await sync.pullCatalog()) === true);
check('device has the catalog', (await db.products.count()) === 194 && (await db.users.count()) === 3 && (await db.categories.count()) === 12 && (await db.stock_batches.count()) === 194);
const lastRequest = requests.at(-1);
check('request shape: { auth, args }', lastRequest.fn === 'pos_catalog' && lastRequest.body.auth.terminal_key === terminalKey && 'since' in lastRequest.body.args && typeof lastRequest.body.auth.terminal_id === 'string', lastRequest.body);
check('publishable key sent as apikey only', lastRequest.headers.apikey === 'sb_publishable_test' && !lastRequest.headers.Authorization, lastRequest.headers);

// --- sign in, offline then online ---------------------------------------
const signIn = await verifyStaffLogin(cashierId, '1234');
check('offline sign-in against the synced hash', signIn.approved && signIn.user.full_name === 'Ana Reyes');
check('offline sign-in refuses a wrong password', !(await verifyStaffLogin(cashierId, '4321')).approved);
for (let i = 0; i < 5; i++) await verifyStaffLogin(owner2, '000000');
check('five wrong passwords lock the account on the device', (await verifyStaffLogin(owner2, '222222')).locked === true);
const tries = await local.getSyncMeta('sign_in_attempts', {});
check('the lock is saved on the device, so reloading the page keeps it', tries[owner2]?.count === 5 && tries[owner2].lockedUntil > Date.now(), tries);
tries[owner2].lockedUntil = Date.now() - 1;
await local.setSyncMeta('sign_in_attempts', tries);
check('after the minute, the right password works', (await verifyStaffLogin(owner2, '222222')).approved === true);
check('and the count starts over', !(await local.getSyncMeta('sign_in_attempts', {}))[owner2]);
await throws('server sign-in with a wrong password shows the reason', () => sync.requestToken(cashierId, '0000'), (e) => e.message === "That password isn't right — try again.");
await sync.saveServerLogin(await sync.requestToken(cashierId, '1234'));

const shiftId = await sync.openShift({ cashier_id: cashierId, opening_cash: 500 });
sync.setActiveShift(shiftId);

// --- sell ------------------------------------------------------------------
const cementLine = await makeCartLine((await findExactProduct('CEM-001')).id);
cementLine.quantity = 3;
cementLine.line_total = 3 * cementLine.unit_price_snapshot;
const nailLine = await makeCartLine((await findExactProduct('BAR-002')).id);
const cashSaleId = await sync.completeSale({ cashier_id: cashierId, shift_id: shiftId, cart: [cementLine, nailLine], payment: { method: 'cash', tendered: 1000 } });
const customer = await sync.saveCustomer({ name: ' Maria Lopez ', phone: '0917 555 0101' });
const creditLine = await makeCartLine((await findExactProduct('CEM-002')).id);
const creditSaleId = await sync.completeSale({ cashier_id: cashierId, shift_id: shiftId, cart: [creditLine], payment: { method: 'credit', tendered: 100, paid: 100, customer_id: customer.id } });
await sync.recordCreditPayment({ customer_id: customer.id, amount: 50, payment_method: 'cash', received_by: cashierId, shift_id: shiftId });
const rebar = await findExactProduct('BAR-001');
await sync.receiveStock({ product_id: rebar.id, location: 'warehouse', quantity: 20, damaged_quantity: 1, actor_id: cashierId });
await sync.submitMaterialRequest({ requested_by: cashierId, shift_id: shiftId, items: [{ product_id: rebar.id, sku_snapshot: rebar.sku, name_snapshot: rebar.name, quantity_requested: 4 }], notes: 'For delivery' });
await sync.logActivity({ actor_id: cashierId, shift_id: shiftId, event_type: 'view_opened', entity_type: 'view', details: { view: 'credit' } });

const queued = await db.outbox_queue.count();
await sync.flushOutbox();
check(`outbox empties (${queued} items)`, (await db.outbox_queue.count()) === 0, await db.outbox_queue.toArray());
check('server has both sales', (await one(`select count(*)::int n from public.sales`)).n === 2);
check('server stock drawn FIFO', near((await one(`select sum(qty_good_remaining) q from public.stock_batches b join public.products p on p.id = b.product_id where p.sku = 'CEM-001'`)).q, 97));

// --- screens a cashier can open ---------------------------------------------
const credit = await sync.fetchCustomers();
const maria = credit.customers.find((c) => c.id === customer.id);
check('credit balance', maria && near(maria.owed, creditLine.line_total - 100 - 50) && near(credit.total_owed, maria.owed), credit);
const detail = await sync.fetchCustomer(customer.id);
check('customer history', detail.sales.length === 1 && detail.payments.length === 1 && detail.payments[0].received_by.full_name === 'Ana Reyes');
const lists = await sync.fetchMaterialRequests({ status: 'pending' });
check('pick lists', lists.data.length === 3, lists.data.length);
const manual = lists.data.find((r) => !r.sale_id);
check('manual pick list', manual.notes === 'For delivery' && manual.requested_by.full_name === 'Ana Reyes', manual);
await sync.fulfillMaterialRequest(manual.id);
await throws('picking up twice is refused with the reason', () => sync.fulfillMaterialRequest(manual.id), (e) => e.message === 'This list was already picked up.');
await throws('a cashier is kept off owner screens', () => sync.fetchDashboard('today'), (e) => e.name === 'AuthRequiredError' && e.kind === 'user');
check('the refused token is forgotten', (await local.getAuthToken()) === null);

// --- an owner signs in at the same terminal ----------------------------------
await sync.saveServerLogin(await sync.requestToken(owner1, '111111'));
const dash = await sync.fetchDashboard('today');
const expected = cementLine.line_total + nailLine.line_total + creditLine.line_total;
check('dashboard', near(dash.sales.total, expected) && dash.sales.count === 2 && near(dash.credit_owed, maria.owed) && dash.on_shift[0]?.name === 'Ana Reyes', dash);
const stock = await sync.fetchStock();
const rebarRow = stock.find((r) => r.id === rebar.id);
check('stock screen', near(rebarRow.store_good, 100) && near(rebarRow.warehouse_good, 19) && near(rebarRow.damaged, 1), rebarRow);
const categories = await sync.fetchCategories();
const cementCategory = categories.find((c) => c.name === 'Cement & Concrete');
const { sku } = await sync.fetchNextSku(cementCategory.id);
check('next sku', sku === 'CEM-005', sku);
const created = await sync.createProduct({ sku, name: 'White Cement', category_id: cementCategory.id, unit: 'bag', unit_price: 300, store_qty: 10, warehouse_qty: 0, reorder_level: 5 });
await sync.updateProduct(created.id, { name: 'White Cement', unit: 'bag', unit_price: 320, reorder_level: 5, store_qty: 8 });
await sync.pullCatalog();
const pulled = await db.products.get(created.id);
check('new item reaches the device', pulled && Number(pulled.unit_price) === 320 && !('cost_price' in pulled), pulled);
const sales = await sync.fetchSales({ from: new Date(Date.now() - 3600e3).toISOString() });
check('sales screen', sales.data.length === 2 && near(sales.totals.cash, cementLine.line_total + nailLine.line_total), sales.totals);
const shifts = await sync.fetchShifts({ cashier_id: '' });
check('shifts screen', shifts.data.length === 1 && shifts.data[0].sales_count === 2, shifts.data[0]);
const shiftDetail = await sync.fetchShift(shiftId);
check('shift timeline', shiftDetail.sales.length === 2 && shiftDetail.payments.length === 1 && shiftDetail.activity.some((a) => a.event_type === 'view_opened' && a.ip_address === '203.0.113.7'), shiftDetail.activity.map((a) => a.event_type));
await sync.submitReturn({ id: randomUUID(), product_id: rebar.id, quantity_returned: 2, condition: 'good', reason: 'Slip 1042', client_created_at: new Date().toISOString() });
await throws('return without proof', () => sync.submitReturn({ id: randomUUID(), product_id: rebar.id, quantity_returned: 1, condition: 'good', reason: '', client_created_at: new Date().toISOString() }), (e) => /proof/.test(e.message));

// --- a void: one owner asks, the other approves at this screen ---------------
const asked = await sync.requestVoid(cashSaleId, 'Rang up the wrong items');
check('void asked', asked.status === 'pending' && asked.seconds_left > 0);
check('void waiting for others', (await sync.fetchVoidRequests()).length === 1);
await throws('the same owner cannot approve twice', () => sync.approveVoid(asked.id), (e) => /already said yes/.test(e.message));
await throws('approve here with a wrong password', () => sync.approveVoidHere(asked.id, { user_id: owner2, pin: '999999', code: null }), (e) => e.message === "That password isn't right — try again.");
const approved = await sync.approveVoidHere(asked.id, { user_id: owner2, pin: '222222', code: null });
check('voided', approved.status === 'approved' && approved.approvals.length === 2);
check('the open view of the request', (await sync.fetchVoidRequest(asked.id)).status === 'approved');
await sync.pullCatalog();
check('the device learns of the void', (await db.sales.get(cashSaleId)).status === 'voided');
const drawer = await sync.shiftCash(shiftId);
check('voided cash sale leaves the drawer count', near(drawer.expected, 500 + 100 + 50), drawer);

// --- clock out -----------------------------------------------------------
const closed = await sync.closeShift({ shift_id: shiftId, counted_cash: 640 });
check('blind count difference', near(closed.cash_discrepancy, -10), closed);
await sync.flushOutbox();
const serverShift = await one(`select status, counted_cash, cash_discrepancy from public.shift_logs where id = $1`, [shiftId]);
check('shift closed on the server', serverShift.status === 'closed' && near(serverShift.cash_discrepancy, -10), serverShift);
check('discrepancy audited', (await one(`select count(*)::int n from public.audit_logs where action_type = 'shift_close_discrepancy'`)).n === 1);

// --- staff and two-factor ----------------------------------------------------
const staff = await sync.fetchUsers(true);
check('staff screen', staff.length === 3 && staff.every((u) => !('pin_hash' in u)));
const added = await sync.createUser({ full_name: 'Ben Torres', role: 'cashier', pin: '5555' });
await throws('wrong password length', () => sync.createUser({ full_name: 'X', role: 'cashier', pin: '55' }), (e) => /4-digit/.test(e.message));
await throws('an owner account is added in Supabase, not in the app', () => sync.createUser({ full_name: 'X', role: 'owner', pin: '555555' }), (e) => /Supabase/.test(e.message));
await sync.updateUser(added.id, { full_name: 'Ben T.', role: 'cashier' });
await throws("another owner's two-factor login is theirs to set up", () => sync.setupTwoFactor(owner2), (e) => e.status === 422 && /Only/.test(e.message));
const setup = await sync.setupTwoFactor(owner1); // signed in as owner1: their own
check('2FA setup', /^otpauth:\/\/totp\//.test(setup.otpauth_url) && setup.secret.length === 32);
const code = (() => {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of setup.secret) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(Date.now() / 30000), 4);
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
})();
check('2FA on', (await sync.verifyTwoFactor(owner1, code)).enabled === true);
await sync.pullCatalog();
const synced = await db.users.get(owner1);
check('the device learns 2FA is on, but never gets the secret', synced.totp_enabled === true && !('totp_secret' in synced), synced);
await throws('the server sign-in asks for the code', () => sync.requestToken(owner1, '111111'), (e) => e.body?.code_required === true);
await throws('...and refuses a wrong one', () => sync.requestToken(owner1, '111111', code === '123456' ? '654321' : '123456'), (e) => /wrong or has expired/.test(e.message));
const login = await sync.requestLogin(owner1, '111111', code);
check('password + code: a token, with the code checked by the server', !!login.token && login.two_factor_checked === true, login);
await sync.forgetServerLogin(); // the earlier sign-in, as the app does at every sign-in
await sync.saveServerLogin(login.token);
check('totp.js still checks codes (for a server not updated yet)', await verifyTotp(setup.secret, code) && !(await verifyTotp(setup.secret, code === '123456' ? '654321' : '123456')));
check('2FA off', (await sync.disableTwoFactor(owner1)).enabled === false);

// --- wrong passwords at the till reach the owners' Audit log -----------------
await sync.recordFailedSignIn({ user_id: cashierId, step: 'password', locked: false });
await sync.flushOutbox();
const wrongPasswords = await sync.fetchAuditLog({ action_type: 'failed_pin_attempt' });
check('a wrong password at the till reaches the Audit log', wrongPasswords.data.some((a) =>
  a.subject === 'Ana Reyes' && a.details.checked === 'device' && a.ip_address === '203.0.113.7'), wrongPasswords.data);
const everything = await sync.fetchAuditLog({});
check('the Audit log has the void and the cash difference', ['admin_void', 'shift_close_discrepancy']
  .every((kind) => everything.data.some((a) => a.action_type === kind)), everything.data.map((a) => a.action_type));

// --- sign-out, Sync now, and a bad key ---------------------------------------
await sync.forgetServerLogin();
check('signed out', (await local.getAuthToken()) === null && (await one(`select count(*)::int n from public.api_tokens where user_id = $1`, [owner1])).n === 0);
await throws('screens need a sign-in again', () => sync.fetchCustomers(), (e) => e.name === 'AuthRequiredError');
check('Sync now (fresh catalog)', (await sync.forceFullSync()) === true && (await db.products.count()) === 195);
await local.setTerminalKey('WRONG-KEY');
await sync.logActivity({ actor_id: cashierId, event_type: 'screen_locked' });
let needsKey = false;
await sync.flushOutbox({ onNeedsProvisioning: () => { needsKey = true; } });
check('a rejected terminal key pauses sync and says so', needsKey && (await db.outbox_queue.count()) === 1);
check('a rejected terminal key: catalog pull reports it', (await sync.pullCatalog()) === false);

finish('app (sync-worker.js end to end)');
