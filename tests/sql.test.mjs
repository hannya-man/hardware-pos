// Exercises every pos_* function the way the app calls them (as the anon
// role, through the imitation PostgREST), against the real SQL files.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { checker, createProject, rpc } from './harness.mjs';

const { check, finish } = checker();
const ok = (label, res) => check(label, res.status === 200, res);
const refused = (label, res, status, text) =>
  check(label, res.status === status && (!text || JSON.stringify(res.body).includes(text)), res);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;
const nowIso = () => new Date().toISOString();

// --- JS reference implementations (same as the frontend's totp.js) --------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function b32encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter % 2 ** 32, 4);
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  const v = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(v % 1e6).padStart(6, '0');
}
const totpNow = (secret) => totpAt(secret, Math.floor(Date.now() / 1000 / 30));

// ---------------------------------------------------------------------------
const db = await createProject();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
// In a real project the catalog was seeded long before the first sync, not
// seconds before it (inside the catalog's one-minute overlap).
await db.exec(`
  set session_replication_role = replica;
  update public.categories set updated_at = now() - interval '1 day';
  update public.products set updated_at = now() - interval '1 day';
  update public.stock_batches set updated_at = now() - interval '1 day';
  set session_replication_role = origin;
`);

// Owner tools (SQL Editor)
const owner1 = (await one(`select pos.add_staff('Owner One', 'owner', '111111') as id`)).id;
const owner2 = (await one(`select pos.add_staff('Owner Two', 'owner', '222222') as id`)).id;
const cashier = (await one(`select pos.add_staff('Cashier Ana', 'cashier', '1234') as id`)).id;
const laravelHash = (await bcrypt.hash('5678', 12)).replace(/^\$2[ab]\$/, '$2y$');
const legacy = (await one(`insert into public.users (full_name, role, pin_hash) values ('Old Laravel Cashier', 'cashier', $1) returning id`, [laravelHash])).id;
const key = (await one(`select pos.add_terminal('Front counter') as k`)).k;
check('terminal key format', /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){5}$/.test(key), key);
for (const [label, sql] of [
  ['add_staff rejects wrong length', `select pos.add_staff('X', 'owner', '1234')`],
  ['add_staff rejects letters', `select pos.add_staff('X', 'cashier', 'abcd')`],
  ['add_staff rejects bad role', `select pos.add_staff('X', 'manager', '1234')`],
]) {
  let threw = false;
  try { await db.query(sql); } catch { threw = true; }
  check(label, threw);
}

// Nothing is reachable with the public key except the pos_* functions.
for (const sql of [
  'select * from public.users',
  'select * from public.sales',
  `insert into public.categories (name) values ('hack')`,
  `select pos.add_staff('Hacker', 'owner', '999999')`,
  `select pos.add_terminal('Hacker')`,
  `select pos.check_pin(gen_random_uuid(), '1234')`,
]) {
  let code = null;
  try {
    await db.transaction(async (tx) => { await tx.query('set local role anon'); await tx.query(sql); });
  } catch (err) { code = err.code; }
  check(`anon blocked: ${sql}`, code === '42501', code);
}
refused('pos.* not on the API', await rpc(db, 'add_staff', {}), 404);

// ---------------------------------------------------------------------------
// Terminal: catalog
const T = (extra = {}) => ({ terminal_id: 'term-1', shift_id: null, terminal_key: key, ...extra });
refused('catalog without key', await rpc(db, 'pos_catalog', { auth: { terminal_id: 'x' }, args: {} }), 401, 'PT401');
refused('catalog wrong key', await rpc(db, 'pos_catalog', { auth: T({ terminal_key: 'nope' }), args: {} }), 401, 'Unknown');
const sloppyKey = key.toLowerCase().replace(/-/g, ' ');
ok('catalog with key typed loosely', await rpc(db, 'pos_catalog', { auth: T({ terminal_key: sloppyKey }), args: {} }));
let res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: '1970-01-01T00:00:00Z' } });
ok('catalog full', res);
let catalog = res.body;
check('catalog products', catalog.products.length === 194, catalog.products.length);
check('catalog hides cost_price', catalog.products.every((p) => !('cost_price' in p)));
check('catalog categories', catalog.categories.length === 12);
check('catalog users', catalog.users.length === 4);
check('catalog batches', catalog.stock_batches.length === 194);
check('catalog voided_sales empty', Array.isArray(catalog.voided_sales) && catalog.voided_sales.length === 0);
check('catalog server_time is ISO UTC', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/.test(catalog.server_time), catalog.server_time);
check('last_seen_at recorded', (await one(`select last_seen_at is not null as s from public.terminals`)).s);
refused('catalog bad since', await rpc(db, 'pos_catalog', { auth: T(), args: { since: 'yesterday-ish' } }), 422, 'valid date');

const users = Object.fromEntries(catalog.users.map((u) => [u.full_name, u]));
check('offline sign-in: pgcrypto hash works in bcryptjs', await bcrypt.compare('111111', users['Owner One'].pin_hash));
check('offline sign-in: wrong pin fails in bcryptjs', !(await bcrypt.compare('111112', users['Owner One'].pin_hash)));
check('offline sign-in: Laravel $2y$ hash works in bcryptjs', await bcrypt.compare('5678', users['Old Laravel Cashier'].pin_hash));

// ---------------------------------------------------------------------------
// Sign-in to the server
refused('login needs the terminal key', await rpc(db, 'pos_login', { auth: { terminal_id: 'term-1' }, args: { user_id: owner1, pin: '111111' } }), 401);
refused('login malformed pin', await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner1, pin: '12' } }), 422, "isn't right");
refused('login unknown user', await rpc(db, 'pos_login', { auth: T(), args: { user_id: randomUUID(), pin: '111111' } }), 422);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: cashier, pin: '9999' } });
refused('login wrong pin is a 422 with a message', res, 422, "isn't right");
check('wrong pin counted (not rolled back)', (await one(`select failed_pin_attempts from public.users where id = $1`, [cashier])).failed_pin_attempts === 1);
for (let i = 0; i < 4; i++) await rpc(db, 'pos_login', { auth: T(), args: { user_id: cashier, pin: '9999' } });
refused('locked after 5 wrong', await rpc(db, 'pos_login', { auth: T(), args: { user_id: cashier, pin: '1234' } }), 422, 'Too many attempts');
await db.query(`update public.users set locked_until = now() - interval '1 second' where id = $1`, [cashier]);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: cashier, pin: '1234' } });
ok('login after lock lapses', res);
const cashierToken = res.body.token;
check('login returns no secrets', !('pin_hash' in res.body.user) && !('totp_secret' in res.body.user));
check('counter reset after success', (await one(`select failed_pin_attempts, locked_until from public.users where id = $1`, [cashier])).failed_pin_attempts === 0);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: legacy, pin: '5678' } });
ok('login with a Laravel $2y$ hash', res);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner1, pin: '111111' } });
ok('owner1 login', res);
const o1 = res.body.token;
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } });
const o2 = res.body.token;
check('token stored hashed', (await one(`select count(*)::int n from public.api_tokens where token_hash = $1`, [o1])).n === 0);

const U = (token, extra = {}) => ({ terminal_id: 'term-1', shift_id: null, token, ...extra });
refused('bad token', await rpc(db, 'pos_users', { auth: U('nope'), args: {} }), 401, 'PT401');
refused('cashier on an owner screen', await rpc(db, 'pos_dashboard', { auth: U(cashierToken), args: { period: 'today' } }), 403, 'PT403');
ok('cashier can read credit', await rpc(db, 'pos_customers', { auth: U(cashierToken), args: {} }));
ok('cashier can read pick lists', await rpc(db, 'pos_material_requests', { auth: U(cashierToken), args: {} }));

// ---------------------------------------------------------------------------
// Sync push: a shift, a cash sale, a credit sale, payments, a delivery, logs
const batchFor = (sku) => {
  const product = catalog.products.find((p) => p.sku === sku);
  return { product, batch: catalog.stock_batches.find((b) => b.product_id === product.id) };
};
const shiftId = randomUUID();
const shiftOpen = { id: shiftId, terminal_id: 'term-1', cashier_id: cashier, started_at: nowIso(), ended_at: null, opening_cash: 500, expected_cash: null, counted_cash: null, cash_discrepancy: null, status: 'open' };
const customerId = randomUUID();
const cement = batchFor('CEM-001');
const rebar = batchFor('BAR-001');

function saleItem({ sale, terminal = 'term-1', cashierId = cashier, method = 'cash', lines, paid, tendered, customer = null, shift = shiftId, when = nowIso() }) {
  const total = lines.reduce((t, l) => t + l.qty * Number(l.product.unit_price), 0);
  const items = lines.map((l) => ({ id: randomUUID(), sale_id: sale, product_id: l.product.id, sku_snapshot: l.product.sku, name_snapshot: l.product.name, unit_price_snapshot: Number(l.product.unit_price), quantity: l.qty, line_discount: 0, line_total: l.qty * Number(l.product.unit_price), voided_at: null, voided_by: null }));
  const movements = lines.map((l) => ({ id: randomUUID(), product_id: l.product.id, batch_id: l.batch?.id ?? null, terminal_id: terminal, delta: -l.qty, reason: 'sale', reference_id: sale, actor_id: cashierId, client_created_at: when }));
  return {
    id: randomUUID(), entity_type: 'sale', entity_id: sale,
    payload: {
      sale: { id: sale, terminal_id: terminal, cashier_id: cashierId, shift_id: shift, subtotal: total, discount_amount: 0, tax_amount: 0, total_amount: total, payment_method: method, amount_tendered: tendered ?? null, change_amount: method === 'cash' && tendered != null ? tendered - total : null, amount_paid: paid ?? total, payment_reference: null, customer_id: customer, status: 'completed', client_created_at: when },
      items, movements,
    },
  };
}
const pickList = (sale, by = cashier) => ({ id: randomUUID(), entity_type: 'material_request', entity_id: sale, payload: { id: randomUUID(), terminal_id: 'term-1', sale_id: sale, requested_by: by, notes: null, items: [{ product_id: cement.product.id, sku_snapshot: 'CEM-001', name_snapshot: 'Union Cement', unit_snapshot: 'bag', quantity_requested: 2 }], status: 'pending', client_created_at: nowIso() } });
const activity = (event, extra = {}) => ({ id: randomUUID(), entity_type: 'activity_log', entity_id: null, payload: { id: randomUUID(), terminal_id: 'term-1', actor_id: cashier, shift_id: shiftId, event_type: event, entity_type: null, entity_id: null, details: {}, client_created_at: nowIso(), ...extra } });

const cashSaleId = randomUUID();
const creditSaleId = randomUUID();
const cashSale = saleItem({ sale: cashSaleId, lines: [{ ...cement, qty: 2 }, { ...rebar, qty: 3 }], tendered: 1000 });
const creditSale = saleItem({ sale: creditSaleId, method: 'credit', customer: customerId, paid: 100, lines: [{ ...cement, qty: 1 }] });
const cashPick = pickList(cashSaleId);
const deliveryId = randomUUID();
const items = [
  activity('item_added', { entity_type: 'product', entity_id: cement.product.id, details: { name: 'Union Cement' } }),
  cashSale, creditSale, cashPick, pickList(creditSaleId),
  { id: randomUUID(), entity_type: 'customer', entity_id: customerId, payload: { id: customerId, name: 'Juan Dela Cruz', phone: '0917', is_active: true } },
  { id: randomUUID(), entity_type: 'shift_log', entity_id: shiftId, payload: shiftOpen },
  { id: randomUUID(), entity_type: 'credit_payment', entity_id: null, payload: { id: randomUUID(), customer_id: customerId, amount: 50, payment_method: 'cash', reference: null, note: null, terminal_id: 'term-1', shift_id: shiftId, received_by: cashier, client_created_at: nowIso() } },
  { id: randomUUID(), entity_type: 'stock_batch', entity_id: deliveryId, payload: { id: deliveryId, product_id: rebar.product.id, location: 'warehouse', received_at: nowIso(), qty_received: 50, qty_good_remaining: 48, qty_damaged: 2, source: 'receiving', reference_id: null, created_by: cashier, client_created_at: nowIso(), terminal_id: 'term-1' } },
  activity('view_opened', { entity_type: 'view', details: { view: 'credit' } }),
  activity('barcode_no_match', { entity_id: 'not-a-uuid', details: { code: '123' } }),
];
// The client sorts customers and shifts first; do the same.
const ORDER = { customer: 0, shift_log: 1, sale: 2, material_request: 3 };
items.sort((a, b) => (ORDER[a.entity_type] ?? 2) - (ORDER[b.entity_type] ?? 2));

refused('push without key', await rpc(db, 'pos_sync_push', { auth: {}, args: { items } }), 401);
refused('push without items', await rpc(db, 'pos_sync_push', { auth: T(), args: {} }), 422);
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items } });
ok('push', res);
const failed = Object.entries(res.body.results).filter(([, r]) => !r.ok);
check('push: every item ok', failed.length === 0, failed);
const cementLeft = async () => Number((await one(`select qty_good_remaining from public.stock_batches where id = $1`, [cement.batch.id])).qty_good_remaining);
check('push: FIFO batch drawn down', near(await cementLeft(), 97));
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items } });
check('push again: all ok', Object.values(res.body.results).every((r) => r.ok), res.body);
check('push again: stock not taken twice', near(await cementLeft(), 97));
check('push again: no duplicate sale', (await one(`select count(*)::int n from public.sales`)).n === 2);
check('sale lines kept in order', (await all(`select name_snapshot from public.sale_items where sale_id = $1 order by seq`, [cashSaleId])).map((r) => r.name_snapshot).join() === 'Union Cement,Rebar 7mm');
check('delivery: batch + stock_receipt of good + damaged', (await one(`select delta from public.stock_movements where reference_id = $1 and reason = 'stock_receipt'`, [deliveryId]))?.delta == 50);
check('activity: ip stamped from the connection', (await one(`select ip_address from public.activity_log where event_type = 'view_opened'`)).ip_address === '203.0.113.7');
check('activity: odd entity_id kept as null', (await one(`select entity_id from public.activity_log where event_type = 'barcode_no_match'`)).entity_id === null);

// One bad item doesn't block the rest
const orphan = saleItem({ sale: randomUUID(), shift: randomUUID(), lines: [{ ...cement, qty: 1 }] });
const good = activity('screen_locked');
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [orphan, good, { id: 'weird', entity_type: 'spaceship', payload: {} }] } });
check('push: sale with unknown shift fails alone', !res.body.results[orphan.id].ok && /foreign key/.test(res.body.results[orphan.id].error), res.body.results[orphan.id]);
check('push: unknown type fails alone', !res.body.results.weird.ok && /unknown entity_type/.test(res.body.results.weird.error));
check('push: good item still saved', res.body.results[good.id].ok);
check('push: failed sale left nothing behind', near(await cementLeft(), 97));

// Oversold batch, and a delivery dated in the future
const tiny = batchFor('CEM-002');
await db.query(`update public.stock_batches set qty_good_remaining = 1 where id = $1`, [tiny.batch.id]);
const oversell = saleItem({ sale: randomUUID(), lines: [{ ...tiny, qty: 3 }] });
const futureId = randomUUID();
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [oversell, { id: randomUUID(), entity_type: 'stock_batch', payload: { id: futureId, product_id: tiny.product.id, location: 'store', received_at: new Date(Date.now() + 86400e3).toISOString(), qty_received: 5, qty_good_remaining: 5, qty_damaged: 0, source: 'receiving', created_by: cashier, client_created_at: nowIso(), terminal_id: 'term-1' } }] } });
check('oversell applied', near((await one(`select qty_good_remaining from public.stock_batches where id = $1`, [tiny.batch.id])).qty_good_remaining, -2));
check('oversell flagged', (await one(`select count(*)::int n from public.audit_logs where action_type = 'batch_oversold'`)).n === 1);
check('future delivery clamped', (await one(`select received_at <= now() + interval '1 minute' as c from public.stock_batches where id = $1`, [futureId])).c);
check('clamp logged', (await one(`select count(*)::int n from public.audit_logs where action_type = 'timestamp_anomaly_clamped'`)).n === 1);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner1, pin: '111111' } });
res = await rpc(db, 'pos_stock', { auth: U(res.body.token), args: {} });
const oversoldRow = res.body.find((r) => r.id === tiny.product.id);
const onHand = (await one(`select sum(qty_good_remaining)::numeric q from public.stock_batches where product_id = $1 and location = 'store'`, [tiny.product.id])).q;
check('Stock screen counts an oversold batch, so it shows what is really on hand', near(oversoldRow.store_good, onHand) && near(onHand, 3), { shown: oversoldRow.store_good, onHand });

// A tampered terminal can't record what only two owners or the server decide.
const tamper = async (label, item, text) => {
  const r = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [item] } });
  const result = r.body.results?.[item.id];
  check(`refused: ${label}`, result && !result.ok && (!text || result.error.includes(text)), result);
};
const forged = (edit) => { const s = saleItem({ sale: randomUUID(), lines: [{ ...cement, qty: 1 }], tendered: 500 }); edit(s.payload); return s; };
await tamper('a sale that arrives already voided', forged((p) => { p.sale.status = 'voided'; p.sale.void_reason = 'cash pocketed'; }), 'two owners');
await tamper('a sale whose total is not its lines', forged((p) => { p.sale.total_amount = 1; p.sale.subtotal = 1; }), 'total');
await tamper('a line priced below its quantity', forged((p) => { p.items[0].line_total = 1; }), 'line');
await tamper('a line belonging to another sale', forged((p) => { p.items[0].sale_id = cashSaleId; }), 'another sale');
await tamper('a movement that adds stock', forged((p) => { p.movements[0].delta = 5; }), 'movement');
await tamper('a credit sale with no customer', forged((p) => { p.sale.payment_method = 'credit'; p.sale.amount_paid = 0; }), 'customer');
await tamper('a sale with no lines', forged((p) => { p.items = []; p.movements = []; }), 'line');
await tamper('a forged void on the audit log', { id: randomUUID(), entity_type: 'audit_log', payload: { id: randomUUID(), terminal_id: 'term-1', actor_id: owner1, approver_id: owner2, action_type: 'admin_void', entity_type: 'sale', entity_id: cashSaleId, details: {}, client_created_at: nowIso() } }, 'admin_void');
await tamper('a sale line on its own', { id: randomUUID(), entity_type: 'sale_item', payload: { id: randomUUID(), sale_id: cashSaleId, line_total: 0 } }, 'part of its sale');
await tamper('a stock movement on its own', { id: randomUUID(), entity_type: 'stock_movement', payload: { id: randomUUID(), product_id: cement.product.id, delta: 999, reason: 'stock_receipt' } }, 'part of its sale');
await tamper('a payment of nothing', { id: randomUUID(), entity_type: 'credit_payment', payload: { id: randomUUID(), customer_id: customerId, amount: 0, payment_method: 'cash', received_by: cashier, client_created_at: nowIso() } }, 'above zero');
await tamper('a delivery whose counts don\'t add up', { id: randomUUID(), entity_type: 'stock_batch', payload: { id: randomUUID(), product_id: cement.product.id, location: 'store', received_at: nowIso(), qty_received: 5, qty_good_remaining: 50, qty_damaged: 0, source: 'receiving', created_by: cashier, client_created_at: nowIso() } }, 'add up');
const prePicked = { id: randomUUID(), entity_type: 'material_request', payload: { id: randomUUID(), terminal_id: 'term-1', sale_id: null, requested_by: cashier, items: [], status: 'fulfilled', fulfilled_by: owner1, fulfilled_at: nowIso(), client_created_at: nowIso() } };
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [prePicked] } });
check('a pick list arrives waiting, whatever the terminal says', (await one(`select status, fulfilled_by from public.material_requests where id = $1`, [prePicked.payload.id])).status === 'pending');
await db.query(`delete from public.material_requests where id = $1`, [prePicked.payload.id]); // out of the pick-list counts below

// Shift closed, then a late copy of its start arrives
const shiftClosed = { ...shiftOpen, ended_at: nowIso(), expected_cash: 1290, counted_cash: 1280, cash_discrepancy: -10, status: 'closed' };
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [{ id: randomUUID(), entity_type: 'shift_log', payload: shiftClosed }, { id: randomUUID(), entity_type: 'audit_log', payload: { id: randomUUID(), terminal_id: 'term-1', actor_id: cashier, approver_id: null, action_type: 'shift_close_discrepancy', entity_type: 'shift_log', entity_id: shiftId, details: { cash_discrepancy: -10 }, client_created_at: nowIso() } }] } });
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [{ id: randomUUID(), entity_type: 'shift_log', payload: shiftOpen }] } });
check('late shift start accepted but ignored', res.body && Object.values(res.body.results)[0].ok);
check('shift stays closed', (await one(`select status, counted_cash from public.shift_logs where id = $1`, [shiftId])).status === 'closed');
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [{ id: randomUUID(), entity_type: 'customer', payload: { id: customerId, phone: '0918' } }] } });
check('customer edit keeps the fields not sent', (await one(`select name, phone from public.customers where id = $1`, [customerId])).name === 'Juan Dela Cruz');

// Append-only logs
{
  let code = null;
  try { await db.query(`update public.activity_log set event_type = 'x'`); } catch (err) { code = err.message; }
  check('activity_log is append-only', /append-only/.test(code ?? ''), code);
}

// ---------------------------------------------------------------------------
// Owner screens
res = await rpc(db, 'pos_dashboard', { auth: U(o1), args: { period: 'today' } });
ok('dashboard', res);
let d = res.body;
const expectedToday = Number(cashSale.payload.sale.total_amount) + Number(creditSale.payload.sale.total_amount) + Number(oversell.payload.sale.total_amount);
check('dashboard sales total', near(d.sales.total, expectedToday), d.sales);
check('dashboard by method', near(d.sales.by_method.credit, creditSale.payload.sale.total_amount) && d.sales.count === 3, d.sales);
check('dashboard credit owed', near(d.credit_owed, Number(creditSale.payload.sale.total_amount) - 100 - 50), d.credit_owed);
check('dashboard stock values are numbers', typeof d.stock.store_value === 'number' && d.stock.warehouse_value > 0, d.stock);
check('dashboard top selling, ties in name order', d.top_selling.map((p) => `${p.name}:${p.units_sold}`).join() === 'Premium Cement:3,Rebar 7mm:3,Union Cement:3', d.top_selling);
check('dashboard on shift is empty (shift closed)', d.on_shift.length === 0, d.on_shift);
for (const period of ['week', 'month', 'year', 'bogus']) ok(`dashboard ${period}`, await rpc(db, 'pos_dashboard', { auth: U(o1), args: { period } }));

res = await rpc(db, 'pos_stock', { auth: U(o1), args: { include_archived: false } });
ok('stock', res);
const cementRow = res.body.find((r) => r.sku === 'CEM-001');
check('stock row', near(cementRow.store_good, 97) && cementRow.warehouse_good === 0 && cementRow.low_stock === false, cementRow);
const rebarRow = res.body.find((r) => r.sku === 'BAR-001');
check('stock warehouse + damaged', near(rebarRow.warehouse_good, 48) && near(rebarRow.damaged, 2), rebarRow);

res = await rpc(db, 'pos_categories', { auth: U(o1), args: {} });
check('categories', res.body.length === 12 && res.body[0].name === 'Adhesives & Finishing', res.body[0]);
const cemCat = catalog.products.find((p) => p.sku === 'CEM-001').category_id;
res = await rpc(db, 'pos_next_sku', { auth: U(o1), args: { category_id: cemCat } });
check('next sku follows the category', res.body?.sku === 'CEM-005', res.body);
const paintCat = (await one(`insert into public.categories (name) values ('Paint & Coatings, Misc') returning id`)).id;
res = await rpc(db, 'pos_next_sku', { auth: U(o1), args: { category_id: paintCat } });
check('next sku for an empty category', res.body?.sku === 'PCM-001', res.body);
refused('next sku bad category', await rpc(db, 'pos_next_sku', { auth: U(o1), args: { category_id: randomUUID() } }), 422);

res = await rpc(db, 'pos_product_create', { auth: U(o1), args: { sku: 'PCM-001', name: 'Boysen Latex White', category_id: paintCat, unit: 'pc', unit_price: 850, store_qty: 5, warehouse_qty: 0, reorder_level: 3 } });
ok('product create', res);
const paint = res.body;
check('barcode is 200 + 9 digits', /^200\d{9}$/.test(paint.barcode), paint.barcode);
check('starting stock went through the ledger', (await one(`select sum(qty_good_remaining)::numeric q from public.stock_batches where product_id = $1`, [paint.id])).q == 5);
refused('product create duplicate sku', await rpc(db, 'pos_product_create', { auth: U(o1), args: { sku: 'PCM-001', name: 'Dup', category_id: paintCat, unit: 'pc', unit_price: 1 } }), 422, 'already used');
refused('product create negative price', await rpc(db, 'pos_product_create', { auth: U(o1), args: { sku: 'X-1', name: 'X', category_id: paintCat, unit: 'pc', unit_price: -1 } }), 422, 'below 0');
res = await rpc(db, 'pos_next_sku', { auth: U(o1), args: { category_id: paintCat } });
check('next sku after one item', res.body?.sku === 'PCM-002', res.body);

res = await rpc(db, 'pos_product_update', { auth: U(o1), args: { id: paint.id, name: 'Boysen Latex White', unit: 'pc', unit_price: 900, reorder_level: 3, store_qty: 2, warehouse_qty: 10 } });
ok('product update', res);
check('update returns the item', res.body.unit_price == 900 && res.body.is_active === true, res.body);
const paintStock = await one(`select sum(qty_good_remaining) filter (where location = 'store') s, sum(qty_good_remaining) filter (where location = 'warehouse') w from public.stock_batches where product_id = $1`, [paint.id]);
check('update counts', paintStock.s == 2 && paintStock.w == 10, paintStock);
const paintEvents = (await all(`select event_type from public.activity_log where entity_id = $1 order by created_at, event_type`, [paint.id])).map((r) => r.event_type);
check('update logged: price + two counts, no false "edited"', paintEvents.includes('price_changed') && paintEvents.filter((e) => e === 'stock_quantity_adjusted').length === 2 && !paintEvents.includes('item_details_updated'), paintEvents);
await rpc(db, 'pos_product_update', { auth: U(o1), args: { id: paint.id, is_active: false } });
res = await rpc(db, 'pos_stock', { auth: U(o1), args: { include_archived: false } });
check('archived item hidden', !res.body.some((r) => r.id === paint.id));
res = await rpc(db, 'pos_stock', { auth: U(o1), args: { include_archived: true } });
check('archived item shown on request', res.body.some((r) => r.id === paint.id && r.is_active === false));
refused('update missing item', await rpc(db, 'pos_product_update', { auth: U(o1), args: { id: randomUUID(), name: 'x' } }), 404);
refused('update bad id', await rpc(db, 'pos_product_update', { auth: U(o1), args: { id: 'abc' } }), 422);
res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: catalog.server_time } });
check('incremental catalog has the changed items only', res.body.products.some((p) => p.id === paint.id) && res.body.products.length < 10, res.body.products.length);

// Pick lists
res = await rpc(db, 'pos_material_requests', { auth: U(cashierToken), args: { status: 'pending' } });
ok('pick lists', res);
check('pick lists paginated', res.body.current_page === 1 && res.body.total === 2 && res.body.data.length === 2, res.body);
const cashList = res.body.data.find((r) => r.sale_id === cashSaleId);
check('pick list has its sale and sender', cashList?.sale?.payment_method === 'cash' && cashList.requested_by?.full_name === 'Cashier Ana', cashList);
const creditList = res.body.data.find((r) => r.sale_id === creditSaleId);
check('pick list shows the credit customer', creditList?.sale?.customer?.name === 'Juan Dela Cruz', creditList?.sale);
res = await rpc(db, 'pos_material_request_fulfill', { auth: U(cashierToken, { shift_id: shiftId }), args: { id: creditList.id } });
ok('fulfill', res);
check('fulfilled', res.body.status === 'fulfilled' && res.body.fulfilled_by === cashier, res.body);
refused('fulfill twice', await rpc(db, 'pos_material_request_fulfill', { auth: U(cashierToken), args: { id: creditList.id } }), 422, 'already picked up');
check('pick_list_done logged on the shift', (await one(`select details->>'sale_ref' r, shift_id from public.activity_log where event_type = 'pick_list_done'`)).r === creditSaleId.slice(0, 8).toUpperCase());

// Sales, shifts
res = await rpc(db, 'pos_sales', { auth: U(o1), args: { from: new Date(Date.now() - 3600e3).toISOString() } });
ok('sales', res);
check('sales list', res.body.data.length === 3 && res.body.total === 3, res.body.total);
check('sales totals', near(res.body.totals.cash, Number(cashSale.payload.sale.total_amount) + Number(oversell.payload.sale.total_amount)), res.body.totals);
const listed = res.body.data.find((s) => s.id === cashSaleId);
check('sale has items, cashier, no void', listed.items.length === 2 && listed.cashier.full_name === 'Cashier Ana' && listed.pending_void === null && listed.customer === null, listed);
res = await rpc(db, 'pos_sales', { auth: U(o1), args: { shift_id: shiftId, status: 'completed' } });
check('sales by shift', res.body.data.length === 3);
refused('sales bad date', await rpc(db, 'pos_sales', { auth: U(o1), args: { from: 'soon' } }), 422);

res = await rpc(db, 'pos_shifts', { auth: U(o1), args: { cashier_id: cashier } });
ok('shifts', res);
const shiftRow = res.body.data[0];
check('shift row', shiftRow.id === shiftId && shiftRow.cashier.role === 'cashier' && shiftRow.sales_count === 3 && near(shiftRow.sales_total, expectedToday), shiftRow);
res = await rpc(db, 'pos_shifts', { auth: U(o1), args: { cashier_id: '' } });
check('shifts with the "All staff" filter', res.status === 200 && res.body.total === 1, res);
res = await rpc(db, 'pos_shift', { auth: U(o1), args: { id: shiftId } });
ok('shift detail', res);
check('shift detail parts', res.body.shift.cashier.full_name === 'Cashier Ana' && res.body.sales.length === 3 && res.body.payments.length === 1 && res.body.payments[0].customer.name === 'Juan Dela Cruz' && res.body.activity.length >= 4, { sales: res.body.sales.length, payments: res.body.payments, activity: res.body.activity.length });
refused('shift missing', await rpc(db, 'pos_shift', { auth: U(o1), args: { id: randomUUID() } }), 404);

// Credit
res = await rpc(db, 'pos_customers', { auth: U(cashierToken), args: {} });
const juan = res.body.customers[0];
const owed = Number(creditSale.payload.sale.total_amount) - 150;
check('customer owes', juan.name === 'Juan Dela Cruz' && near(juan.owed, owed) && near(res.body.total_owed, owed) && juan.last_activity_at, juan);
res = await rpc(db, 'pos_customers', { auth: U(cashierToken), args: { q: '0918' } });
check('customer search by phone', res.body.customers.length === 1);
res = await rpc(db, 'pos_customers', { auth: U(cashierToken), args: { q: 'nobody' } });
check('customer search miss', res.body.customers.length === 0 && res.body.total_owed === 0, res.body);
res = await rpc(db, 'pos_customer', { auth: U(cashierToken), args: { id: customerId } });
ok('customer detail', res);
check('customer detail parts', near(res.body.customer.owed, owed) && res.body.sales.length === 1 && res.body.sales[0].cashier.full_name === 'Cashier Ana' && res.body.payments[0].received_by.full_name === 'Cashier Ana', res.body);

// Returns
const returnId = randomUUID();
res = await rpc(db, 'pos_return_create', { auth: U(o1), args: { id: returnId, product_id: cement.product.id, quantity_returned: 1, condition: 'damaged', reason: 'Slip 0042', client_created_at: nowIso() } });
ok('return', res);
await rpc(db, 'pos_return_create', { auth: U(o1), args: { id: returnId, product_id: cement.product.id, quantity_returned: 1, condition: 'damaged', reason: 'Slip 0042', client_created_at: nowIso() } });
check('return sent twice is one return', (await one(`select count(*)::int n from public.stock_batches where reference_id = $1`, [returnId])).n === 1);
check('damaged return kept apart', (await one(`select qty_good_remaining, qty_damaged from public.stock_batches where reference_id = $1`, [returnId])).qty_damaged == 1);
refused('return needs proof', await rpc(db, 'pos_return_create', { auth: U(o1), args: { id: randomUUID(), product_id: cement.product.id, quantity_returned: 1, condition: 'good', reason: 'x', client_created_at: nowIso() } }), 422, 'proof');
refused('return is owner-only', await rpc(db, 'pos_return_create', { auth: U(cashierToken), args: {} }), 403);

// ---------------------------------------------------------------------------
// Voids
refused('void needs a reason', await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: cashSaleId, reason: ' ' } }), 422);
res = await rpc(db, 'pos_void_request_create', { auth: U(o1, { shift_id: shiftId }), args: { sale_id: cashSaleId, reason: 'Wrong items' } });
ok('void asked', res);
let vr = res.body;
check('void request shape', vr.status === 'pending' && vr.approvals.length === 1 && vr.approvals[0].user_id === owner1 && vr.seconds_left > 590 && vr.approvals_needed === 2 && vr.sale.items.length === 2 && vr.sale.cashier.full_name === 'Cashier Ana', vr);
refused('one open void per sale', await rpc(db, 'pos_void_request_create', { auth: U(o2), args: { sale_id: cashSaleId, reason: 'Again' } }), 422, 'already has a void');
res = await rpc(db, 'pos_sales', { auth: U(o1), args: {} });
check('sale shows the waiting void', res.body.data.find((s) => s.id === cashSaleId).pending_void?.id === vr.id);
res = await rpc(db, 'pos_void_requests', { auth: U(o2), args: {} });
check('waiting voids listed', res.body.length === 1 && res.body[0].id === vr.id);
refused('same owner twice', await rpc(db, 'pos_void_approve', { auth: U(o1), args: { id: vr.id } }), 422, 'already said yes');
res = await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr.id, user_id: owner2, pin: '000000', code: null } });
refused('approve here, wrong password', res, 422, "isn't right");
check('approve here: wrong password counted', (await one(`select failed_pin_attempts from public.users where id = $1`, [owner2])).failed_pin_attempts === 1);
refused('approve here, not an owner', await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr.id, user_id: cashier, pin: '1234' } }), 422, 'Choose an owner');
const cementBefore = await cementLeft();
res = await rpc(db, 'pos_void_approve_here', { auth: U(cashierToken, { shift_id: shiftId }), args: { id: vr.id, user_id: owner2, pin: '222222', code: null } });
ok('approve here', res);
vr = res.body;
check('voided', vr.status === 'approved' && vr.approvals.length === 2 && vr.resolved_by.full_name === 'Owner Two' && vr.sale.status === 'voided', vr);
check('stock put back into the same batch', near(await cementLeft(), cementBefore + 2));
check('pick list cancelled', (await one(`select status from public.material_requests where sale_id = $1`, [cashSaleId])).status === 'cancelled');
check('void audited', (await one(`select details from public.audit_logs where action_type = 'admin_void'`)).details.approved_by.length === 2);
check('void activity names both owners', (await one(`select details->>'approved_by' a, actor_id from public.activity_log where event_type = 'sale_voided'`)).a === 'Owner One and Owner Two');
refused('approve after it is done', await rpc(db, 'pos_void_approve', { auth: U(o2), args: { id: vr.id } }), 422, 'already voided');
refused('fulfill a voided sale', await rpc(db, 'pos_material_request_fulfill', { auth: U(cashierToken), args: { id: cashList.id } }), 422, 'voided');
res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: catalog.server_time } });
check('terminals learn of the void', res.body.voided_sales.includes(cashSaleId), res.body.voided_sales);
res = await rpc(db, 'pos_dashboard', { auth: U(o1), args: { period: 'today' } });
check('voided sale leaves the totals', near(res.body.sales.total, expectedToday - Number(cashSale.payload.sale.total_amount)), res.body.sales);
check('voided sale leaves the best sellers', res.body.top_selling.map((p) => `${p.name}:${p.units_sold}`).join() === 'Premium Cement:3,Union Cement:1', res.body.top_selling);
const latePick = pickList(cashSaleId);
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [latePick] } });
check('late pick list for a voided sale arrives cancelled', (await one(`select status from public.material_requests where id = $1`, [latePick.payload.id])).status === 'cancelled');

res = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'Customer changed mind' } });
res = await rpc(db, 'pos_void_reject', { auth: U(o2), args: { id: res.body.id } });
check('another owner says no', res.body.status === 'rejected' && res.body.resolved_by.full_name === 'Owner Two', res.body);
res = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'Second try' } });
res = await rpc(db, 'pos_void_reject', { auth: U(o1), args: { id: res.body.id } });
check('asker cancels', res.body.status === 'cancelled', res.body);
res = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'Third try' } });
await db.query(`update public.void_requests set expires_at = now() - interval '1 second' where id = $1`, [res.body.id]);
refused('expired request', await rpc(db, 'pos_void_approve', { auth: U(o2), args: { id: res.body.id } }), 422, 'expired');
res = await rpc(db, 'pos_void_request', { auth: U(o2), args: { id: res.body.id } });
check('expired shows as expired', res.body.status === 'expired' && res.body.seconds_left === 0, res.body);
check('credit sale still completed', (await one(`select status from public.sales where id = $1`, [creditSaleId])).status === 'completed');
refused('void needs two owners', await (async () => {
  await db.query(`update public.users set is_active = false where id = $1`, [owner2]);
  const r = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'Solo' } });
  await db.query(`update public.users set is_active = true where id = $1`, [owner2]);
  return r;
})(), 422, 'two owners');

// ---------------------------------------------------------------------------
// Staff
res = await rpc(db, 'pos_users', { auth: U(o1), args: { include_archived: false } });
check('staff list', res.body.length === 4 && res.body.every((u) => !('pin_hash' in u)), res.body);
refused('cashier password length', await rpc(db, 'pos_user_create', { auth: U(o1), args: { full_name: 'Ben', role: 'cashier', pin: '123456' } }), 422, '4-digit');
refused('owner password length', await rpc(db, 'pos_user_create', { auth: U(o1), args: { full_name: 'Ben', role: 'owner', pin: '1234' } }), 422, 'An owner account needs a 6-digit');
res = await rpc(db, 'pos_user_create', { auth: U(o1), args: { full_name: '  Ben Reyes ', role: 'cashier', pin: '4321' } });
ok('staff added', res);
const ben = res.body;
check('staff added trimmed, no secrets', ben.full_name === 'Ben Reyes' && !('pin_hash' in ben), ben);
res = await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: ben.id, full_name: 'Ben R.', role: 'owner', pin: '654321' } });
ok('staff edited', res);
check('promoted', res.body.role === 'owner');
check('staff_updated logged without the password', (await one(`select details from public.activity_log where event_type = 'staff_updated'`)).details.pin_reset === true);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '654321' } });
ok('new password works', res);
const benToken = res.body.token;
res = await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: ben.id, is_active: false } });
ok('deactivated', res);
refused('deactivated account signed out everywhere', await rpc(db, 'pos_customers', { auth: U(benToken), args: {} }), 401);
refused('deactivated account cannot sign in', await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '654321' } }), 422);
await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner2, is_active: false } });
refused('last owner stays an owner', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner1, role: 'cashier' } }), 422, 'only owner');
refused('last owner stays active', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner1, is_active: false } }), 422, 'only owner');
await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner2, is_active: true } });
res = await rpc(db, 'pos_users', { auth: U(o1), args: { include_archived: true } });
check('archived staff on request', res.body.length === 5 && res.body.some((u) => u.id === ben.id && !u.is_active));

// Two-factor
refused('2FA only for owners', await rpc(db, 'pos_two_factor_setup', { auth: U(o1), args: { id: cashier } }), 422, 'only available for owner');
res = await rpc(db, 'pos_two_factor_setup', { auth: U(o1), args: { id: owner2 } });
ok('2FA setup', res);
const secret = res.body.secret;
check('2FA secret is 32 base32 chars', /^[A-Z2-7]{32}$/.test(secret), secret);
check('otpauth url', res.body.otpauth_url === `otpauth://totp/RRC%20Merchandise%3AOwner%20Two?secret=${secret}&issuer=RRC%20Merchandise&algorithm=SHA1&digits=6&period=30`, res.body.otpauth_url);
refused('2FA wrong code', await rpc(db, 'pos_two_factor_verify', { auth: U(o1), args: { id: owner2, code: totpNow(secret) === '000000' ? '111111' : '000000' } }), 422, 'did not match');
res = await rpc(db, 'pos_two_factor_verify', { auth: U(o1), args: { id: owner2, code: totpNow(secret) } });
check('2FA on with a real authenticator code', res.status === 200 && res.body.enabled === true, res);
res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: catalog.server_time } });
const synced = res.body.users.find((u) => u.id === owner2);
check('2FA secret syncs for offline sign-in', synced?.totp_secret === secret && synced.totp_enabled === true);
res = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'With 2FA' } });
const vr2 = res.body.id;
refused('approve here needs the code', await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr2, user_id: owner2, pin: '222222', code: null } }), 422, 'authenticator code');
res = await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr2, user_id: owner2, pin: '222222', code: totpNow(secret) } });
check('approve here with password + code', res.status === 200 && res.body.status === 'approved', res);
check('voided credit sale stops counting', (await rpc(db, 'pos_customers', { auth: U(o1), args: {} })).body.total_owed === -50);
res = await rpc(db, 'pos_two_factor_disable', { auth: U(o1), args: { id: owner2 } });
check('2FA off', res.body.enabled === false && (await one(`select totp_secret from public.users where id = $1`, [owner2])).totp_secret === null);

// TOTP and base32 in SQL agree with the JS used offline
for (let i = 0; i < 25; i++) {
  const s = b32encode(randomBytes(20));
  const counter = Math.floor(Math.random() * 2 ** 31);
  const sqlCode = (await one(`select pos.totp_code($1, $2) c`, [s, counter])).c;
  check(`totp_code matches JS (${s}, ${counter})`, sqlCode === totpAt(s, counter), sqlCode);
  const bytes = randomBytes(1 + Math.floor(Math.random() * 25));
  const enc = (await one(`select pos.base32_encode($1) e`, [bytes])).e;
  check('base32_encode matches JS', enc === b32encode(bytes), enc);
  const dec = (await one(`select encode(pos.base32_decode($1), 'hex') d`, [enc])).d;
  check('base32 round trip', dec === b32decode(enc).toString('hex'), dec);
}

// ---------------------------------------------------------------------------
// Security controls (docs/compliance)

// Wrong passwords and codes are on the audit log, with where they came from.
const failedFor = async (userId) => all(`select terminal_id, ip_address, details from public.audit_logs
  where action_type = 'failed_pin_attempt' and entity_id = $1 order by created_at, (details->>'attempt')::int nulls last`, [userId]);
const cashierFails = await failedFor(cashier);
check('wrong passwords recorded with device and address', cashierFails.length === 6
  && cashierFails.every((f) => f.ip_address === '203.0.113.7' && f.terminal_id === 'term-1' && f.details.checked === 'server'), cashierFails);
check('the fifth wrong password records the lock, and so does a try while locked',
  cashierFails[4]?.details.attempt === 5 && cashierFails[4].details.locked === true && cashierFails[5]?.details.locked === true, cashierFails.map((f) => f.details));
const owner2Fails = await failedFor(owner2);
check('approve here: a wrong password and a missing code recorded',
  owner2Fails.length === 2 && owner2Fails[0].details.step === 'password' && owner2Fails[1].details.step === 'code', owner2Fails.map((f) => f.details));
const tillFail = { id: randomUUID(), terminal_id: 'term-1', actor_id: null, approver_id: null, action_type: 'failed_pin_attempt', entity_type: 'user', entity_id: owner1, details: { step: 'password', locked: false, checked: 'device' }, client_created_at: nowIso() };
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [{ id: randomUUID(), entity_type: 'audit_log', payload: tillFail }] } });
check('a wrong password at an offline till arrives with sync, address stamped',
  Object.values(res.body.results)[0]?.ok && (await one(`select ip_address from public.audit_logs where id = $1`, [tillFail.id]))?.ip_address === '203.0.113.7', res.body);

// Server sign-ins run out: 12 hours at most, 2 hours unused.
const hashOf = `encode(sha256(convert_to($1, 'UTF8')), 'hex')`;
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } });
const oldToken = res.body.token;
await db.query(`update public.api_tokens set created_at = now() - interval '13 hours' where token_hash = ${hashOf}`, [oldToken]);
refused('a sign-in older than 12 hours is refused', await rpc(db, 'pos_users', { auth: U(oldToken), args: {} }), 401, 'expired');
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } });
const idleToken = res.body.token;
check('run-out sign-ins are cleared at the next sign-in', (await one(`select count(*)::int n from public.api_tokens where token_hash = ${hashOf}`, [oldToken])).n === 0);
ok('a fresh sign-in works', await rpc(db, 'pos_users', { auth: U(idleToken), args: {} }));
await db.query(`update public.api_tokens set last_used_at = now() - interval '3 hours' where token_hash = ${hashOf}`, [idleToken]);
refused('a sign-in unused for 2 hours is refused', await rpc(db, 'pos_users', { auth: U(idleToken), args: {} }), 401, 'expired');

// The owners' Audit log
res = await rpc(db, 'pos_audit_log', { auth: U(o1), args: {} });
ok('audit log', res);
const audit = res.body.data;
check('audit log: everything, newest first', res.body.total === (await one(`select count(*)::int n from public.audit_logs`)).n
  && audit.every((a, i) => i === 0 || audit[i - 1].client_created_at >= a.client_created_at), res.body.total);
const cashVoid = audit.find((a) => a.action_type === 'admin_void' && a.subject === cashSaleId.slice(0, 8).toUpperCase());
check('a void: who asked, who approved, which sale', cashVoid?.actor?.full_name === 'Owner One' && cashVoid.approver?.full_name === 'Owner Two', cashVoid);
const wrongPassword = audit.find((a) => a.action_type === 'failed_pin_attempt' && a.entity_id === cashier);
check('a wrong password names the account', wrongPassword?.subject === 'Cashier Ana' && wrongPassword.actor === null, wrongPassword);
res = await rpc(db, 'pos_audit_log', { auth: U(o1), args: { action_type: 'shift_close_discrepancy' } });
check('audit log by kind', res.body.data.length === 1 && res.body.data[0].subject === 'Cashier Ana' && Number(res.body.data[0].details.cash_discrepancy) === -10, res.body.data);
res = await rpc(db, 'pos_audit_log', { auth: U(o1), args: { from: new Date(Date.now() + 3600e3).toISOString() } });
check('audit log by date', res.status === 200 && res.body.total === 0, res.body);
refused('audit log is for owners', await rpc(db, 'pos_audit_log', { auth: U(cashierToken), args: {} }), 403);

// Erasing a customer's details on request (Data Privacy Act)
const quietId = randomUUID();
const owingId = randomUUID();
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [
  { id: randomUUID(), entity_type: 'customer', payload: { id: quietId, name: 'Pedro Penduko', phone: '0919 000 0000', is_active: true } },
  { id: randomUUID(), entity_type: 'customer', payload: { id: owingId, name: 'Maria Makiling', phone: '0920 000 0000', is_active: true } },
  saleItem({ sale: randomUUID(), method: 'credit', customer: owingId, paid: 0, lines: [{ ...cement, qty: 1 }] }),
] } });
let refusal = null;
try { await db.query(`select pos.anonymize_customer($1)`, [owingId]); } catch (err) { refusal = err.message; }
check('a customer who still owes is not erased', /still owes/.test(refusal ?? ''), refusal);
await db.query(`select pos.anonymize_customer($1)`, [quietId]);
const erased = await one(`select name, phone, is_active from public.customers where id = $1`, [quietId]);
check('name and phone removed', erased.name === 'Removed customer' && erased.phone === null && erased.is_active === false, erased);
check('erasure audited', (await one(`select count(*)::int n from public.audit_logs where action_type = 'customer_anonymized' and entity_id = $1`, [quietId])).n === 1);
res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: catalog.server_time } });
check('terminals get the erased record', res.body.customers.some((c) => c.id === quietId && c.name === 'Removed customer' && c.phone === null));
{
  let code = null;
  try {
    await db.transaction(async (tx) => { await tx.query('set local role anon'); await tx.query(`select pos.anonymize_customer($1)`, [owingId]); });
  } catch (err) { code = err.code; }
  check('anon cannot erase customers', code === '42501', code);
}

// Sign-out
ok('logout', await rpc(db, 'pos_logout', { auth: U(o1), args: {} }));
refused('token gone after logout', await rpc(db, 'pos_users', { auth: U(o1), args: {} }), 401);
ok('logout twice is fine', await rpc(db, 'pos_logout', { auth: U(o1), args: {} }));
ok('ping', await rpc(db, 'pos_ping', {}));

// Anything without a grant?
const ungranted = await all(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'pos\\_%' and not has_function_privilege('anon', p.oid, 'execute')`);
check('every pos_* function is callable', ungranted.length === 0, ungranted);
const leaked = await all(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pos' and has_function_privilege('anon', p.oid, 'execute')`);
check('no pos.* function is callable by anon', leaked.length === 0, leaked);

finish('server (SQL)');
