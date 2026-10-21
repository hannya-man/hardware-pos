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
  `select pos.reset_password(gen_random_uuid(), '1234')`,
  `select pos.set_role(gen_random_uuid(), 'owner', '123456')`,
  `select pos.turn_off_two_factor(gen_random_uuid())`,
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
check('catalog users carry no two-factor secret', catalog.users.every((u) => !('totp_secret' in u) && 'totp_enabled' in u));
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
// Stock taken has to be what was sold, from the item's own store batches.
const cementBeforeTamper = await cementLeft();
await tamper('a 1-bag sale that takes 11 bags off the count', forged((p) => { p.movements[0].delta = -11; }), 'stock taken');
await tamper('a sale that takes less stock than it sold', forged((p) => { p.movements[0].delta = -0.5; }), 'stock taken');
await tamper('a sale that takes nothing off the count', forged((p) => { p.movements = []; }), 'stock taken');
await tamper("a sale that takes another item's stock", forged((p) => { p.movements[0].batch_id = rebar.batch.id; }), 'another item');
await tamper("a sale that takes the warehouse's stock", (() => {
  const s = saleItem({ sale: randomUUID(), lines: [{ product: rebar.product, batch: { id: deliveryId }, qty: 1 }], tendered: 500 });
  return s;
})(), 'warehouse');
check('refused sales took no stock', near(await cementLeft(), cementBeforeTamper));
// A sale sent again under its id can't gain lines or take more stock.
{
  const resend = structuredClone(cashSale);
  resend.id = randomUUID();
  const extra = { ...rebar, qty: 5 };
  resend.payload.items.push({ id: randomUUID(), sale_id: cashSaleId, product_id: rebar.product.id, sku_snapshot: rebar.product.sku, name_snapshot: rebar.product.name, unit_price_snapshot: Number(rebar.product.unit_price), quantity: extra.qty, line_discount: 0, line_total: extra.qty * Number(rebar.product.unit_price), voided_at: null, voided_by: null });
  resend.payload.movements.push({ id: randomUUID(), product_id: rebar.product.id, batch_id: rebar.batch.id, terminal_id: 'term-1', delta: -extra.qty, reason: 'sale', reference_id: cashSaleId, actor_id: cashier, client_created_at: nowIso() });
  resend.payload.sale.total_amount = resend.payload.sale.subtotal = resend.payload.items.reduce((t, i) => t + i.line_total, 0);
  const rebarBefore = Number((await one(`select qty_good_remaining from public.stock_batches where id = $1`, [rebar.batch.id])).qty_good_remaining);
  res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [resend] } });
  check('a sale sent again with an extra line is taken as a resend', res.body.results[resend.id]?.ok, res.body);
  check('...and adds nothing to the recorded sale', (await one(`select count(*)::int n from public.sale_items where sale_id = $1`, [cashSaleId])).n === 2
    && near((await one(`select total_amount from public.sales where id = $1`, [cashSaleId])).total_amount, cashSale.payload.sale.total_amount)
    && near((await one(`select qty_good_remaining from public.stock_batches where id = $1`, [rebar.batch.id])).qty_good_remaining, rebarBefore));
}
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
await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [{ id: randomUUID(), entity_type: 'shift_log', payload: { ...shiftClosed, counted_cash: 1290, cash_discrepancy: 0 } }] } });
const recount = await one(`select counted_cash, cash_discrepancy from public.shift_logs where id = $1`, [shiftId]);
check('a second "closed" can\'t rewrite the cash count', near(recount.counted_cash, 1280) && near(recount.cash_discrepancy, -10), recount);
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
refused('an owner account is not added in the app', await rpc(db, 'pos_user_create', { auth: U(o1), args: { full_name: 'Ben', role: 'owner', pin: '123456' } }), 422, 'added in Supabase');
res = await rpc(db, 'pos_user_create', { auth: U(o1), args: { full_name: '  Ben Reyes ', role: 'cashier', pin: '4321' } });
ok('staff added', res);
const ben = res.body;
check('staff added trimmed, no secrets', ben.full_name === 'Ben Reyes' && !('pin_hash' in ben), ben);
refused('a role is not changed in the app', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: ben.id, role: 'owner' } }), 422, 'changed in Supabase');
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '4321' } });
const benOldToken = res.body.token;
res = await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: ben.id, full_name: 'Ben R.', role: 'cashier', pin: '6543' } });
ok('staff edited (the role sent unchanged)', res);
check('edited', res.body.full_name === 'Ben R.' && res.body.role === 'cashier', res.body);
check('staff_updated logged without the password', (await one(`select details from public.activity_log where event_type = 'staff_updated'`)).details.pin_reset === true);
refused('a password reset by someone else signs them out', await rpc(db, 'pos_customers', { auth: U(benOldToken), args: {} }), 401);
ok('new password works', await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '6543' } }));
refused("another owner's password is theirs to change", await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner2, pin: '999999' } }), 422, 'Only Owner Two');
check("another owner's password unchanged", (await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } })).status === 200);
ok('an owner changes their own password', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner1, pin: '111111' } }));
ok('...and stays signed in', await rpc(db, 'pos_users', { auth: U(o1), args: {} }));

// Owner accounts are made, and their sign-in reset, in the SQL Editor; each
// change is on the owners' Audit log.
const ownerChanges = async (userId) => (await all(`select actor_id, terminal_id, details from public.audit_logs
  where action_type = 'owner_account_changed' and entity_id = $1 order by created_at`, [userId])).map((r) => r.details.change);
check('owners added in the SQL Editor are audited', (await ownerChanges(owner1)).join() === 'added' && (await ownerChanges(owner2)).join() === 'added');
check('set_role makes an owner, with a 6-digit password', /now an owner/.test((await one(`select pos.set_role($1, 'owner', '654321') as m`, [ben.id])).m));
check('...audited', (await ownerChanges(ben.id)).join() === 'role');
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '654321' } });
ok('the new owner signs in', res);
const benToken = res.body.token;
res = await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: ben.id, is_active: false } });
ok('deactivated', res);
check('an owner deactivated by another owner is audited', (await ownerChanges(ben.id)).join() === 'role,deactivated'
  && (await one(`select actor_id from public.audit_logs where action_type = 'owner_account_changed' and entity_id = $1 order by created_at desc limit 1`, [ben.id])).actor_id === owner1);
refused('deactivated account signed out everywhere', await rpc(db, 'pos_customers', { auth: U(benToken), args: {} }), 401);
refused('deactivated account cannot sign in', await rpc(db, 'pos_login', { auth: T(), args: { user_id: ben.id, pin: '654321' } }), 422);
await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner2, is_active: false } });
refused('last owner stays an owner', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner1, role: 'cashier' } }), 422, 'only owner');
refused('last owner stays active', await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner1, is_active: false } }), 422, 'only owner');
{
  let refusal = null;
  try { await db.query(`select pos.set_role($1, 'cashier', '1111')`, [owner1]); } catch (err) { refusal = err.message; }
  check('set_role keeps the last owner an owner', /only owner/.test(refusal ?? ''), refusal);
}
await rpc(db, 'pos_user_update', { auth: U(o1), args: { id: owner2, is_active: true } });
res = await rpc(db, 'pos_users', { auth: U(o1), args: { include_archived: true } });
check('archived staff on request', res.body.length === 5 && res.body.some((u) => u.id === ben.id && !u.is_active));
const o2BeforeReset = (await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } })).body.token;
await db.query(`update public.users set locked_until = now() + interval '1 minute', failed_pin_attempts = 5 where id = $1`, [owner2]);
check('reset_password: a forgotten password, a lock lifted', /was changed/.test((await one(`select pos.reset_password($1, '222222') as m`, [owner2])).m)
  && (await one(`select locked_until from public.users where id = $1`, [owner2])).locked_until === null);
check('...audited', (await ownerChanges(owner2)).join() === 'added,deactivated,reactivated,password_reset');
refused('...and signed out everywhere', await rpc(db, 'pos_users', { auth: U(o2BeforeReset), args: {} }), 401);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } });
const o2b = res.body.token;

// Two-factor: each owner sets up their own, and the server checks the codes.
refused('2FA only for owners', await rpc(db, 'pos_two_factor_setup', { auth: U(o1), args: { id: cashier } }), 422, 'only available for owner');
refused("2FA for another owner is theirs to set up", await rpc(db, 'pos_two_factor_setup', { auth: U(o1), args: { id: owner2 } }), 422, 'Only Owner Two');
res = await rpc(db, 'pos_two_factor_setup', { auth: U(o2b), args: { id: owner2 } });
ok('2FA setup', res);
const secret = res.body.secret;
check('2FA secret is 32 base32 chars', /^[A-Z2-7]{32}$/.test(secret), secret);
check('otpauth url', res.body.otpauth_url === `otpauth://totp/RRC%20Merchandise%3AOwner%20Two?secret=${secret}&issuer=RRC%20Merchandise&algorithm=SHA1&digits=6&period=30`, res.body.otpauth_url);
const wrongCode = totpNow(secret) === '000000' ? '111111' : '000000';
refused('2FA wrong code', await rpc(db, 'pos_two_factor_verify', { auth: U(o2b), args: { id: owner2, code: wrongCode } }), 422, 'did not match');
refused("2FA confirmed only by its owner", await rpc(db, 'pos_two_factor_verify', { auth: U(o1), args: { id: owner2, code: totpNow(secret) } }), 422, 'Only Owner Two');
res = await rpc(db, 'pos_two_factor_verify', { auth: U(o2b), args: { id: owner2, code: totpNow(secret) } });
check('2FA on with a real authenticator code', res.status === 200 && res.body.enabled === true, res);
res = await rpc(db, 'pos_catalog', { auth: T(), args: { since: catalog.server_time } });
const synced = res.body.users.find((u) => u.id === owner2);
check('the 2FA secret stays on the server: tills only learn that it is on', synced && !('totp_secret' in synced) && synced.totp_enabled === true, synced);
check('no account reaches a till with a 2FA secret', res.body.users.every((u) => !('totp_secret' in u)));

// Server sign-in for an owner with 2FA: password, then code.
const owner2Attempts = async () => (await one(`select failed_pin_attempts n from public.users where id = $1`, [owner2])).n;
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222' } });
check('the right password alone asks for the code', res.status === 422 && res.body.code_required === true && /authenticator code/.test(res.body.message), res);
check('...without counting as a wrong try', (await owner2Attempts()) === 0);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '999999', code: totpNow(secret) } });
check('a wrong password with a right code is still a wrong password', res.status === 422 && !res.body.code_required && /isn't right/.test(res.body.message), res);
await db.query(`update public.users set failed_pin_attempts = 0 where id = $1`, [owner2]);
for (let i = 1; i <= 5; i++) {
  res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222', code: wrongCode } });
}
check('wrong codes count toward the lock, even with the right password', res.status === 422 && (await owner2Attempts()) === 5
  && (await one(`select locked_until > now() l from public.users where id = $1`, [owner2])).l, res);
refused('locked: even the right code waits', await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222', code: totpNow(secret) } }), 422, 'Too many attempts');
await db.query(`update public.users set locked_until = now() - interval '1 second' where id = $1`, [owner2]);
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: owner2, pin: '222222', code: totpNow(secret) } });
check('password + code signs in, and says the code was checked', res.status === 200 && res.body.token && res.body.two_factor_checked === true, res);
check('...and starts the count over', (await owner2Attempts()) === 0);
const o2c = res.body.token;
res = await rpc(db, 'pos_login', { auth: T(), args: { user_id: cashier, pin: '1234' } });
check('a cashier needs no code', res.status === 200 && res.body.two_factor_checked === false, res);

res = await rpc(db, 'pos_void_request_create', { auth: U(o1), args: { sale_id: creditSaleId, reason: 'With 2FA' } });
const vr2 = res.body.id;
refused('approve here needs the code', await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr2, user_id: owner2, pin: '222222', code: null } }), 422, 'authenticator code');
refused('approve here with a wrong code', await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr2, user_id: owner2, pin: '222222', code: wrongCode } }), 422, 'wrong or has expired');
check('...counted', (await owner2Attempts()) === 1);
res = await rpc(db, 'pos_void_approve_here', { auth: U(o1), args: { id: vr2, user_id: owner2, pin: '222222', code: totpNow(secret) } });
check('approve here with password + code', res.status === 200 && res.body.status === 'approved', res);
check('voided credit sale stops counting', (await rpc(db, 'pos_customers', { auth: U(o1), args: {} })).body.total_owed === -50);
refused("2FA turned off only by its owner", await rpc(db, 'pos_two_factor_disable', { auth: U(o1), args: { id: owner2 } }), 422, 'Supabase');
res = await rpc(db, 'pos_two_factor_disable', { auth: U(o2c), args: { id: owner2 } });
check('2FA off', res.body.enabled === false && (await one(`select totp_secret from public.users where id = $1`, [owner2])).totp_secret === null);
await db.query(`update public.users set totp_secret = $2, totp_enabled = true where id = $1`, [owner2, secret]);
check('turn_off_two_factor for a lost phone', /is off for Owner Two/.test((await one(`select pos.turn_off_two_factor($1) as m`, [owner2])).m)
  && (await one(`select totp_enabled from public.users where id = $1`, [owner2])).totp_enabled === false);
check('...audited', (await ownerChanges(owner2)).at(-1) === 'two_factor_off');

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
check('wrong passwords and wrong codes recorded (the fifth code locks); a missing code only asks for it',
  owner2Fails.map((f) => f.details.step).join() === 'password,password,code,code,code,code,code,password,code'
  && owner2Fails[6].details.locked === true && owner2Fails[7].details.locked === true, owner2Fails.map((f) => f.details));
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

// A sale from a till with its clock days ahead is dated when it arrived.
const aheadId = randomUUID();
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [saleItem({ sale: aheadId, shift: null, lines: [{ ...cement, qty: 1 }], tendered: 500, when: new Date(Date.now() + 3 * 86400e3).toISOString() })] } });
check('a sale dated days ahead is accepted', Object.values(res.body.results)[0]?.ok, res.body);
check('...dated when it arrived, its stock movement too', (await one(`select s.client_created_at <= now() + interval '1 minute'
  and (select bool_and(m.client_created_at <= now() + interval '1 minute') from public.stock_movements m where m.reference_id = s.id) as ok
  from public.sales s where s.id = $1`, [aheadId])).ok);
check('...and on the Audit log', (await one(`select count(*)::int n from public.audit_logs where action_type = 'timestamp_anomaly_clamped' and entity_type = 'sale' and entity_id = $1`, [aheadId])).n === 1);

// Sold below the listed price: the app never does it, so the owners see it.
const cheapId = randomUUID();
const cheap = saleItem({ sale: cheapId, shift: null, lines: [{ ...cement, qty: 2 }], tendered: 1000 });
cheap.payload.items[0].unit_price_snapshot = 100;
cheap.payload.items[0].line_total = 200;
cheap.payload.sale.total_amount = cheap.payload.sale.subtotal = cheap.payload.sale.amount_paid = 200;
cheap.payload.sale.change_amount = 800;
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [cheap] } });
const flagged = await one(`select details from public.audit_logs where action_type = 'price_override' and entity_id = $1`, [cheapId]);
check('a sale below the listed price is on the Audit log', Object.values(res.body.results)[0]?.ok && flagged?.details.product_name === cement.product.name
  && near(flagged.details.sold_at, 100) && near(flagged.details.listed_at, cement.product.unit_price), flagged);
await rpc(db, 'pos_product_update', { auth: U(o1), args: { id: cement.product.id, unit_price: Number(cement.product.unit_price) + 20 } });
const oldPriceId = randomUUID();
res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [saleItem({ sale: oldPriceId, shift: null, lines: [{ ...cement, qty: 1 }], tendered: 500 })] } });
check("a sale at the price before a change (the till hadn't heard yet) isn't flagged", Object.values(res.body.results)[0]?.ok
  && (await one(`select count(*)::int n from public.audit_logs where action_type = 'price_override' and entity_id = $1`, [oldPriceId])).n === 0);

// The Sales report: every breakdown adds up to the same total, in the store's time zone.
refused('the sales report is for owners', await rpc(db, 'pos_sales_report', { auth: U(cashierToken), args: { period: 'week' } }), 403);
const weekStart = `(date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')`;
const weekSales = await one(`select coalesce(sum(total_amount), 0)::float as amount, count(*)::int as n from public.sales
  where status = 'completed' and client_created_at >= ${weekStart} and client_created_at < ${weekStart} + interval '7 days'`);
const sumOf = (rows) => rows.reduce((t, r) => t + Number(r.amount), 0);
for (const [period, buckets] of [['day', 24], ['week', 7], ['month', null], ['year', 12]]) {
  res = await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period } });
  const r = res.body;
  check(`sales report (${period}) answers`, res.status === 200 && r.period === period, res);
  if (res.status !== 200) continue;
  const total = Number(r.totals.amount);
  check(`sales report (${period}): ${buckets ?? 'one per day of the month'} buckets`, buckets ? r.series.length === buckets : r.series.length >= 28 && r.series.length <= 31, r.series.length);
  check(`sales report (${period}): over time, items, payment, categories, staff and hours all add up to the total`,
    [r.series, r.items, r.payment, r.categories, r.staff, r.hours].every((rows) => near(sumOf(rows), total)) && r.hours.length === 24,
    { total, series: sumOf(r.series), items: sumOf(r.items), payment: sumOf(r.payment), categories: sumOf(r.categories), staff: sumOf(r.staff), hours: sumOf(r.hours) });
  check(`sales report (${period}): best sellers first`, r.items.every((x, i) => i === 0 || Number(r.items[i - 1].amount) >= Number(x.amount)), r.items.map((x) => x.amount));
}
res = await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period: 'week' } });
const week = res.body;
check('sales report: this week matches the sales on record, voided ones left out', near(week.totals.amount, weekSales.amount) && week.totals.count === weekSales.n
  && week.totals.voided_count === (await one(`select count(*)::int n from public.sales where status = 'voided' and client_created_at >= ${weekStart}`)).n, { report: week.totals, weekSales });
check('sales report: credit collected in the period', near(week.totals.credit_collected,
  (await one(`select coalesce(sum(amount), 0)::float a from public.credit_payments where client_created_at >= ${weekStart}`)).a), week.totals);
check("sales report: the store's time now, inside this week", week.now.slice(0, 10) >= week.first_day && week.now.slice(0, 10) <= week.last_day
  && week.series.some((b) => b.at > week.now) === (week.now.slice(0, 10) < week.last_day), week.now);
const firstDay = new Date(`${week.first_day}T00:00:00Z`);
check('sales report: a week is Monday to Sunday', firstDay.getUTCDay() === 1 && (new Date(`${week.last_day}T00:00:00Z`) - firstDay) / 86400e3 === 6, [week.first_day, week.last_day]);
const cementSold = week.items.find((x) => x.product_id === cement.product.id);
check('sales report: an item with its units and money', cementSold && cementSold.unit === cement.product.unit
  && near(cementSold.quantity, (await one(`select sum(i.quantity)::float q from public.sale_items i join public.sales s on s.id = i.sale_id
    where i.product_id = $1 and s.status = 'completed' and s.client_created_at >= ${weekStart}`, [cement.product.id])).q), cementSold);
res = await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period: 'week', offset: 1 } });
check('sales report: last week, with no sales, is empty but whole', res.status === 200 && res.body.totals.count === 0 && res.body.items.length === 0
  && res.body.series.length === 7 && near(sumOf(res.body.series), 0), res.body.totals);
check('sales report: this week compared with last', near(week.totals.previous_amount, res.body.totals.amount) && week.totals.previous_count === res.body.totals.count);
// While this week is under way it's compared with last week up to this moment
// a week ago; the rest of last week counts once this week is over. (Skipped
// in the minutes either side of midnight on Sunday, when "a week ago" is
// another week.)
const intoWeek = Number((await one(`select extract(epoch from now() - ${weekStart}) as s`)).s);
if (intoWeek > 300 && intoWeek < 7 * 86400 - 300) {
  const weekAgo = (minutes) => new Date(Date.now() - 7 * 86400e3 + minutes * 60e3).toISOString();
  res = await rpc(db, 'pos_sync_push', { auth: T(), args: { items: [
    saleItem({ sale: randomUUID(), shift: null, lines: [{ ...cement, qty: 1 }], tendered: 1000, when: weekAgo(-2) }),
    saleItem({ sale: randomUUID(), shift: null, lines: [{ ...cement, qty: 2 }], tendered: 1000, when: weekAgo(2) }),
  ] } });
  const thisWeek = (await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period: 'week' } })).body.totals;
  const lastWeek = (await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period: 'week', offset: 1 } })).body.totals;
  check('sales report: this week so far against last week up to the same moment', Object.values(res.body.results).every((r) => r.ok)
    && thisWeek.previous_count === 1 && near(thisWeek.previous_amount, cement.product.unit_price) && lastWeek.count === 2, { thisWeek, lastWeek });
}
res = await rpc(db, 'pos_sales_report', { auth: U(o1), args: { period: 'year', offset: -3 } });
check('sales report: a negative offset means this period', res.status === 200 && res.body.offset === 0, res.body.offset);

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
