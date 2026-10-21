// Uses the real app the way staff do, in a simulated browser (jsdom) against
// the imitation Supabase: set up the device, sign in, sell for cash and on
// credit, work the pick lists and credit screens, then as an owner open
// every screen, page through a busy day, void a sale with a second owner,
// leave the till until it locks, and reopen it the next day. Any error in
// the page fails the run.
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { checker, createProject, fakeFetch, rpc } from './harness.mjs';

const { check, finish } = checker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the store's server ------------------------------------------------------
const server = await createProject();
const one = async (sql, params) => (await server.query(sql, params)).rows[0];
const rosaId = (await one(`select pos.add_staff('Rosa Cruz', 'owner', '111111') as id`)).id;
await one(`select pos.add_staff('Carlo Cruz', 'owner', '222222') as id`);
const anaId = (await one(`select pos.add_staff('Ana Reyes', 'cashier', '1234') as id`)).id;
const terminalKey = (await one(`select pos.add_terminal('Front counter') as k`)).k;
// An item named like a spreadsheet formula, to check the downloads defuse it.
await server.query(`update public.products set name = '=HYPERLINK("http://example.com","x")' where sku = 'ADH-001'`);

// --- a browser -----------------------------------------------------------------
const FRONTEND = new URL('../caidic-pos-frontend/', import.meta.url);
const html = readFileSync(new URL('index.html', FRONTEND), 'utf8').replace(/<script\b[^>]*><\/script>/g, '');
const errors = [];
process.on('unhandledRejection', (e) => errors.push(`unhandled rejection: ${e?.stack ?? e}`));
const warn = console.warn;
console.warn = (...args) => {
  if (!String(args[0]).includes('"spaceship"')) errors.push(`console.warn: ${args.join(' ')}`); // the one refusal this test causes on purpose
  warn(...args);
};

function openBrowser() {
  const dom = new JSDOM(html, { url: 'https://hannya-man.github.io/hardware-pos/', pretendToBeVisual: true });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(`page error: ${e.message}`));
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.print = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {}; // downloads: nothing to navigate to
  Object.assign(globalThis, {
    window, document: window.document, Event: window.Event, CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, Node: window.Node,
    HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  return window;
}

const URL_BASE = 'https://test-ref.supabase.co';
globalThis.__ENV__ = { VITE_SUPABASE_URL: URL_BASE, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', PROD: false };
const serverFetch = fakeFetch(server, URL_BASE);
let slowNext = null; // { fn, ms }: hold the next call to that function, like a slow connection
globalThis.fetch = async (url, init) => {
  if (slowNext && String(url).endsWith(`/rpc/${slowNext.fn}`)) {
    const { ms } = slowNext;
    slowNext = null;
    await sleep(ms);
  }
  return serverFetch(url, init);
};
const downloads = [];
URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test'; };
URL.revokeObjectURL = () => {};

// The app's modules, copied with import.meta.env pointed at the values above.
// Each copy is a fresh page load; both share the same IndexedDB, like a reload.
const APP = new URL('./.app-under-test-ui/', import.meta.url);
mkdirSync(APP, { recursive: true });
writeFileSync(new URL('package.json', APP), '{ "type": "module" }');
for (const file of readdirSync(new URL('src/', FRONTEND)).filter((f) => f.endsWith('.js'))) {
  writeFileSync(new URL(file, APP), readFileSync(new URL(`src/${file}`, FRONTEND), 'utf8').replaceAll('import.meta.env', 'globalThis.__ENV__'));
}

// --- how a person uses it --------------------------------------------------------
let window = openBrowser();
let doc = window.document;
const $ = (id) => doc.getElementById(id);
async function waitFor(label, fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* not yet */ }
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
};
async function answer(value, button = '[data-ok]') {
  const overlay = await waitFor('a dialog', () => doc.querySelector('.overlay-top'));
  const input = overlay.querySelector('input');
  if (input && value != null) input.value = value;
  overlay.querySelector(button).click();
  await waitFor(`the dialog to close (${overlay.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)})`, () => !overlay.isConnected);
}
const toasts = () => [...$('toasts').children].map((t) => t.textContent).join(' | ');
const rows = (tableId) => [...$(tableId).querySelectorAll('tbody tr:not(.empty-row)')];
async function signIn(name, password) {
  const card = await waitFor(`${name} on the sign-in screen`, () =>
    [...$('staffGrid').querySelectorAll('.staff-card')].find((c) => c.textContent.includes(name)));
  card.click();
  await waitFor('the keypad', () => !$('pinPad').hidden);
  for (const digit of password) $('keypad').querySelector(`[data-key="${digit}"]`).click();
}
async function openScreen(key) {
  $('navItems').querySelector(`[data-view="${key}"]`).click();
  await waitFor(`the ${key} screen`, () => !doc.getElementById(`view${key[0].toUpperCase()}${key.slice(1)}`).hidden);
}
async function signOut() {
  $('logoutBtn').click();
  $('takeBreakBtn').click();
  await waitFor('the sign-in screen', () => !$('loginScreen').hidden && $('appShell').hidden);
}

try {
  await import(new URL('main.js', APP));
  const appDb = await import(new URL('local-db.js', APP));
  const appSync = await import(new URL('sync-worker.js', APP));

  // A new device asks for its key, then downloads the staff and the items.
  await answer(terminalKey.toLowerCase());
  await waitFor('three staff to sign in', () => $('staffGrid').querySelectorAll('.staff-card').length === 3);
  check('device set up with its key', (await one(`select last_seen_at is not null as seen from public.terminals`)).seen);

  // A wrong password, then the right one; the shift opens with the drawer's cash.
  await signIn('Ana Reyes', '9999');
  await waitFor('the wrong password message', () => $('loginError').textContent.includes('Wrong password'));
  for (const digit of '1234') $('keypad').querySelector(`[data-key="${digit}"]`).click();
  await answer('500');
  await waitFor('the Sell screen', () => !$('appShell').hidden && !$('viewBilling').hidden && $('navItems').querySelector('[data-view]'));
  const cashierMenu = [...$('navItems').querySelectorAll('[data-view]')].map((b) => b.dataset.view).join();
  check('cashier sees only the cashier menu', cashierMenu === 'billing,credit,materialRequests', cashierMenu);

  // A cash sale: two items, one tapped twice.
  const tiles = await waitFor('items on the Sell screen', () => { const t = $('grid').querySelectorAll('[data-id]'); return t.length > 100 && t; });
  tiles[0].click();
  tiles[0].click();
  tiles[5].click();
  await waitFor('two lines in the order', () => $('lines').querySelectorAll('.line').length === 2);
  check('a formula-like item name shows as plain text', $('lines').textContent.includes('=HYPERLINK('));
  // On a phone the order is out of sight: the bar at the bottom counts it,
  // and each item in it shows how many.
  check('the order bar shows the count and the total', !$('cartBar').classList.contains('is-empty')
    && $('cartBarCount').textContent === '2' && $('cartBarTotal').textContent === $('grandTotal').textContent, $('cartBar').textContent);
  check('items in the order show how many', tiles[0].dataset.qty === '2' && tiles[5].dataset.qty === '1' && !('qty' in tiles[1].dataset));
  $('cartBarOpen').click();
  check('the order opens from the bar', $('viewBilling').classList.contains('order-open') && $('cartBarOpen').getAttribute('aria-expanded') === 'true');
  $('chargeBtn').click();
  await waitFor('checkout', () => !$('checkoutOverlay').hidden);
  type($('checkoutCash'), '5000');
  $('checkoutDoneBtn').click();
  await waitFor('the sale to reach the server', async () => (await one(`select count(*)::int n from public.sales`)).n === 1);
  check('a finished sale empties the bar and closes the order', $('cartBar').classList.contains('is-empty')
    && !$('viewBilling').classList.contains('order-open') && !$('grid').querySelector('[data-qty]'));
  check('cash sale: the tapped-twice item counted twice', (await one(`select max(quantity)::int most from public.sale_items`)).most === 2);
  check('the sale went to the pick lists', (await one(`select count(*)::int n from public.material_requests where sale_id is not null`)).n === 1);

  // A credit sale for a new customer, with nothing paid now.
  tiles[10].click();
  await waitFor('one line', () => $('lines').querySelectorAll('.line').length === 1);
  $('cartBarCharge').click(); // charged straight from the bar, without opening the order
  await waitFor('checkout from the bar', () => !$('checkoutOverlay').hidden);
  $('payMethods').querySelector('[data-method="credit"]').click();
  type($('creditCustomerSearch'), 'Juan Dela Cruz');
  (await waitFor('the new-customer choice', () => $('creditCustomerResults').querySelector('[data-new-customer]'))).click();
  type($('newCustomerPhone'), '0917 555 0101');
  $('checkoutDoneBtn').click();
  await waitFor('the credit sale on the server', async () => (await one(`select count(*)::int n from public.sales where payment_method = 'credit' and customer_id is not null`)).n === 1);

  // The menu (on a phone it slides in from the top bar's button): picking a
  // screen closes it, and so does Escape.
  $('menuBtn').click();
  check('the menu button opens the menu', $('appShell').classList.contains('nav-open') && $('menuBtn').getAttribute('aria-expanded') === 'true');
  // Pick lists: both sales are there; one is picked up.
  await openScreen('materialRequests');
  check('picking a screen closes the menu', !$('appShell').classList.contains('nav-open') && $('menuBtn').getAttribute('aria-expanded') === 'false');
  $('menuBtn').click();
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the menu', !$('appShell').classList.contains('nav-open'));
  await waitFor('two pick lists', () => rows('materialRequestsTable').length === 2);
  rows('materialRequestsTable')[0].querySelector('[data-action="fulfill"]').click();
  await waitFor('a list marked picked up', async () => (await one(`select count(*)::int n from public.material_requests where status = 'fulfilled'`)).n === 1);

  // A list sent without charging (a big order for the stockroom) keeps its units.
  await openScreen('billing');
  tiles[20].click();
  await waitFor('one line', () => $('lines').querySelectorAll('.line').length === 1);
  $('sendToPickListBtn').click();
  await answer('For the 3 PM delivery');
  await waitFor('the list on the server', async () => (await one(`select count(*)::int n from public.material_requests where sale_id is null`)).n === 1);
  const manual = await one(`select items from public.material_requests where sale_id is null`);
  check("a list sent without charging keeps each item's unit", manual.items.every((i) => i.unit_snapshot), manual.items);

  // Credit: the customer owes the sale; a payment is recorded.
  await openScreen('credit');
  const owing = await waitFor('the credit customer', () => rows('creditTable').find((r) => r.textContent.includes('Juan Dela Cruz')));
  owing.querySelector('[data-action="pay"]').click();
  await waitFor('the payment form', () => !$('paymentOverlay').hidden);
  type($('paymentAmount'), '10');
  check('a part payment shows what is still owed', $('paymentChangeLabel').textContent === 'Still owes', $('paymentChangeRow').textContent);
  $('paymentSaveBtn').click();
  await waitFor('the payment on the server', async () => (await one(`select count(*)::int n from public.credit_payments`)).n === 1);

  // More than owed: cash pays off the balance and the rest is change; a
  // GCash transfer can't be more than the balance.
  const juanId = (await one(`select id from public.customers where name = 'Juan Dela Cruz'`)).id;
  const stillOwed = Number((await one(`select pos.customer_owed($1) as o`, [juanId])).o);
  const juanRow = await waitFor('the balance after the part payment', () => rows('creditTable').find((r) => r.textContent.includes('Juan Dela Cruz')
    && r.textContent.includes(stillOwed.toLocaleString('en-PH', { minimumFractionDigits: 2 }))));
  juanRow.querySelector('[data-action="pay"]').click();
  await waitFor('the payment form', () => !$('paymentOverlay').hidden);
  $('paymentMethod').querySelector('[data-method="gcash"]').click();
  type($('paymentAmount'), String(stillOwed + 500));
  check('GCash over the balance: by how much', $('paymentChangeLabel').textContent === 'More than owed by' && $('paymentChange').textContent === '₱500.00', $('paymentChangeRow').textContent);
  $('paymentSaveBtn').click();
  await waitFor('GCash over the balance refused', () => $('paymentStatus').textContent.includes("can't be more than"));
  $('paymentMethod').querySelector('[data-method="cash"]').click();
  check('cash over the balance: the change shows', $('paymentChangeLabel').textContent === 'Change' && $('paymentChange').textContent === '₱500.00', $('paymentChangeRow').textContent);
  $('paymentSaveBtn').click();
  await waitFor('the payment that pays it off', async () => (await one(`select count(*)::int n from public.credit_payments`)).n === 2);
  const paidOff = await one(`select amount::float as amount, note from public.credit_payments order by created_at desc limit 1`);
  check('...only what was owed is recorded, with the change noted', Math.abs(paidOff.amount - stillOwed) < 0.005 && paidOff.note.includes('change ₱500.00'), paidOff);
  check('...the balance is paid off', Math.abs(Number((await one(`select pos.customer_owed($1) as o`, [juanId])).o)) < 0.005);
  check('...and the change is said', toasts().includes('Change: ₱500.00'), toasts());

  // A screen still loading when its person signs out (a slow connection)
  // must not ask whoever comes next for that person's password.
  await openScreen('materialRequests');
  slowNext = { fn: 'pos_customers', ms: 1500 };
  await openScreen('credit');
  await signOut();
  await sleep(2500);
  check('no password prompt left behind after signing out', !doc.querySelector('.overlay-top'), doc.querySelector('.overlay-top')?.textContent);

  // An owner: every screen loads.
  await signIn('Rosa Cruz', '111111');
  await answer('0'); // the owner's own shift starts with an empty drawer
  await waitFor('the dashboard', () => !$('viewDashboard').hidden && $('dashSales').textContent.includes('₱'));
  check('dashboard shows the cash sale', !$('dashSales').textContent.includes('₱0.00'), $('dashSales').textContent);
  await waitFor("the dashboard's sales graph", () => $('dashTrend').querySelector('.chart-line, .chart-end'));
  check("the dashboard's graph is today's, by the hour, beside yesterday", $('dashTrendTitle').textContent === 'Sales today, by the hour'
    && $('dashTrend').querySelector('.chart-legend').textContent === 'TodayYesterday');
  // Dark is the default; the Dark mode switch in the menu turns it off (and
  // on) for this device, and the sign-in screen's button follows
  check('the screen starts dark, its switch on', doc.documentElement.dataset.theme === 'dark' && $('themeBtn').getAttribute('aria-checked') === 'true'
    && $('themeBtn').textContent === 'Dark mode');
  $('themeBtn').click();
  check('...and switches to light, remembered on this device', doc.documentElement.dataset.theme === 'light' && $('themeBtn').getAttribute('aria-checked') === 'false'
    && $('loginThemeBtn').getAttribute('aria-checked') === 'false' && window.localStorage.getItem('rrc-theme') === 'light'
    && doc.querySelector('meta[name="theme-color"]').content === '#F5F4F2');
  $('loginThemeBtn').click();
  check("...and back to dark from the sign-in screen's button", doc.documentElement.dataset.theme === 'dark' && $('themeBtn').getAttribute('aria-checked') === 'true'
    && window.localStorage.getItem('rrc-theme') === 'dark');
  for (const screen of ['stock', 'sales', 'shifts', 'returns', 'staff', 'audit']) await openScreen(screen);
  await openScreen('stock');
  await waitFor('stock rows', () => rows('stockTable').length > 100);
  await openScreen('staff');
  await waitFor('staff rows', () => rows('usersTable').length === 3);
  check('new passwords are typed hidden', $('usrPin').type === 'password' && $('editStaffPin').type === 'password');
  await openScreen('audit');
  // Everyone's activity: what the cashier and the owners did, a card each
  await waitFor("everyone's activity", () => rows('activityTable').length > 0 && $('activityPeople').querySelectorAll('.person-card').length === 3);
  const actText = rows('activityTable').map((r) => r.textContent.replace(/\s+/g, ' '));
  check("activity: the cashier's sales and credit payments, by name", actText.some((t) => t.includes('Ana Reyes') && /Sold \d+ items? for ₱/.test(t))
    && actText.some((t) => t.includes('Ana Reyes') && t.includes('credit payment from')), actText.slice(0, 15));
  check("activity: and the owner's, signing in", actText.some((t) => t.includes('Rosa Cruz') && t.includes('Clocked in')), actText.filter((t) => t.includes('Rosa')));
  const anaCard = [...$('activityPeople').querySelectorAll('.person-card')].find((c) => c.textContent.includes('Ana Reyes'));
  check("activity: Ana's card, with her sales today", anaCard?.textContent.includes('Cashier') && /[1-9][\d,]* sales? · ₱/.test(anaCard.textContent), anaCard?.textContent);
  anaCard.click();
  await waitFor("only Ana's activity", () => $('activityPerson').value === anaId && rows('activityTable').length > 0
    && rows('activityTable').every((r) => r.textContent.includes('Ana Reyes')) && $('activityPeople').querySelector('.is-on')?.textContent.includes('Ana Reyes'));
  $('activitySteps').click();
  await waitFor('every step, the screens she opened too', () => rows('activityTable').some((r) => r.textContent.includes('Opened Pick lists')));
  $('activityDownloadBtn').click();
  const actCsv = await downloads.at(-1).text();
  check('activity: downloaded, with who and what', actCsv.startsWith('"Time","Who","Role","What they did"') && actCsv.includes('"Cashier"') && !actCsv.includes('"Rosa Cruz"'), actCsv.slice(0, 200));
  // Needs a look: the events for an owner's eyes, counted on the tab
  check('the alerts tab says how many need a look', Number($('auditAlertCount').textContent) > 0, $('auditAlertCount').textContent);
  $('auditTab').querySelector('[data-tab="alerts"]').click();
  await waitFor('the wrong password on the Audit log', () => rows('auditTable').some((r) => r.textContent.includes('Wrong password for Ana Reyes')));

  // The cashier's shift: its timeline, and a download that defuses formulas.
  await openScreen('shifts');
  const anaShift = await waitFor("Ana's shift", () => rows('shiftsTable').find((r) => r.textContent.includes('Ana Reyes')));
  anaShift.click();
  await waitFor('the shift timeline', () => !$('shiftDetail').hidden && $('shiftTimeline').textContent.includes('Sale ·'));
  $('shiftDownloadBtn').click();
  const csv = await downloads.at(-1).text();
  check('a download keeps a formula-like name as text', csv.includes('"\'=HYPERLINK(') && !csv.includes('"=HYPERLINK('), csv.slice(0, 300));

  // A refused record never disappears quietly: the status pill counts it.
  await appDb.db.outbox_queue.add({ id: randomUUID(), entity_type: 'spaceship', entity_id: null, payload: {}, status: 'pending', retry_count: 7, created_at: new Date().toISOString() });
  await appSync.flushOutbox();
  await waitFor('the not-synced count', () => $('statusLabel').textContent.includes('1 not synced') && $('statusPill').classList.contains('attention'));
  check('a refused record is announced', toasts().includes("couldn't be saved on the server"), toasts());
  await appDb.db.outbox_queue.where('entity_type').equals('spaceship').delete();
  await appSync.flushOutbox();
  await waitFor('the count to clear', () => !$('statusLabel').textContent.includes('not synced'));

  // A busy day: 120 more sales; the Sales list shows 100, then the rest.
  const product = await one(`select id, sku, name, unit_price::float as price from public.products order by sku limit 1 offset 30`);
  for (let batch = 0; batch < 3; batch++) {
    const items = Array.from({ length: 40 }, (_, n) => {
      const saleId = randomUUID();
      return { id: randomUUID(), entity_type: 'sale', payload: {
        sale: { id: saleId, terminal_id: 'seed', cashier_id: anaId, shift_id: null, subtotal: product.price, total_amount: product.price, payment_method: 'cash', amount_tendered: product.price, change_amount: 0, amount_paid: product.price, status: 'completed', client_created_at: new Date(Date.now() - (batch * 40 + n + 1) * 1000).toISOString() },
        items: [{ id: randomUUID(), sale_id: saleId, product_id: product.id, sku_snapshot: product.sku, name_snapshot: product.name, unit_price_snapshot: product.price, quantity: 1, line_discount: 0, line_total: product.price }],
        // As the till sends it: the unit sold comes off the stock (no batch: like a till with an old copy)
        movements: [{ id: randomUUID(), product_id: product.id, batch_id: null, terminal_id: 'seed', delta: -1, reason: 'sale', reference_id: saleId, actor_id: anaId, client_created_at: new Date().toISOString() }],
      } };
    });
    const res = await rpc(server, 'pos_sync_push', { auth: { terminal_id: 'seed', terminal_key: terminalKey }, args: { items } });
    if (Object.values(res.body.results).some((r) => !r.ok)) throw new Error(`seeding sales failed: ${JSON.stringify(res.body)}`);
  }
  await openScreen('sales');
  await waitFor('the first 100 sales', () => rows('salesTable').length === 100 && !$('salesMoreBtn').parentElement.hidden);
  check('"Show more" says how many are left', $('salesMoreBtn').textContent.includes('22 left'), $('salesMoreBtn').textContent);
  $('salesMoreBtn').click();
  await waitFor('all 122 sales', () => rows('salesTable').length === 122 && $('salesMoreBtn').parentElement.hidden);

  // A void: this owner asks, the other approves at this screen.
  const cashSale = rows('salesTable').find((r) => r.textContent.includes('Cash'));
  cashSale.click();
  await waitFor('the sale', () => !$('saleOverlay').hidden);
  $('saleVoidBtn').click();
  await answer('Rang up the wrong items');
  await waitFor('the void request', () => !$('voidOverlay').hidden && $('voidState').textContent.includes('Waiting'));
  $('voidHereBtn').click();
  await waitFor('approve here', () => !$('approveHereOverlay').hidden);
  type($('approveHerePin'), '222222');
  $('approveHereBtn').click();
  await waitFor('the sale voided on the server', async () => (await one(`select count(*)::int n from public.sales where status = 'voided'`)).n === 1);
  await waitFor('the voided state', () => $('voidState').textContent.includes('Voided'));
  $('voidOverlay').querySelector('[data-close]').click();

  // The Sales report: this week as on the server, its best sellers, another
  // period and the one before it, and the download.
  const pesoText = (n) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(n);
  const reportOf = (name) => waitFor(`the sales report for ${name}`, () => $('reportRangeName').textContent === name && !$('reportBody').hidden
    && !$('reportBody').classList.contains('is-loading') && $('reportRangeDates').textContent !== 'Loading…');
  const since = (unit) => `client_created_at >= (date_trunc('${unit}', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')`;
  await openScreen('reports');
  await reportOf('This week');
  const week = await one(`select coalesce(sum(total_amount), 0)::float as amount, count(*)::int as n from public.sales where status = 'completed' and ${since('week')}`);
  check('sales report: this week\'s total and number of sales, as on the server', $('reportTotal').textContent === pesoText(week.amount)
    && $('reportCount').textContent === week.n.toLocaleString('en-PH'), [$('reportTotal').textContent, $('reportCount').textContent, week]);
  check('sales report: the voided sale is noted apart', !$('reportVoided').hidden && $('reportVoided').textContent.includes('1 sale voided'), $('reportVoided').textContent);
  const daysSoFar = (await one(`select extract(isodow from now() at time zone 'Asia/Manila')::int as d`)).d; // Monday 1 .. Sunday 7
  check('sales report: sales over time beside last week, with its legend', $('reportSeries').querySelector('.chart-line, .chart-end')
    && $('reportSeries').querySelector('.chart-legend').textContent === 'This weekLast week', $('reportSeries').innerHTML.slice(0, 200));
  // The keyboard (or a finger) on the graph: the crosshair lands on today, with today's sales
  $('reportSeries').querySelector('.chart-hit-area').dispatchEvent(new window.FocusEvent('focus'));
  const tip = $('reportSeries').querySelector('.chart-tip');
  check("sales report: the crosshair's tooltip gives today's sales", !tip.hidden && tip.querySelector('.chart-tip-row strong').textContent === pesoText(week.amount)
    && $('reportSeries').classList.contains('is-pointing'), tip.textContent);
  $('reportSeriesTable').click();
  const tableRows = [...$('reportSeries').querySelectorAll('.mini-table tbody tr')];
  check('sales report: the graph as a table, the days still to come marked', tableRows.length === 7
    && tableRows.filter((tr) => tr.children[1].textContent === '—').length === 7 - daysSoFar && $('reportSeriesTable').textContent === 'Show as chart',
  tableRows.map((tr) => tr.textContent));
  $('reportSeriesTable').click();
  const cash = await one(`select coalesce(sum(total_amount), 0)::float as amount from public.sales where status = 'completed' and payment_method = 'cash' and ${since('week')}`);
  const cashRow = [...$('reportPayment').querySelectorAll('.donut-legend li')].find((li) => li.textContent.includes('Cash'));
  check('sales report: how customers paid, as a donut with its legend', $('reportPayment').querySelectorAll('.donut-seg').length >= 2
    && cashRow?.querySelector('.donut-amount').textContent === pesoText(cash.amount) && $('reportPayment').querySelector('.donut-value').textContent === pesoText(week.amount),
  cashRow?.textContent);
  const heatSales = [...$('reportHours').querySelectorAll('.heat-cell:not(.heat-0)')];
  check('sales report: the busiest days and hours, as a heatmap', !$('reportHoursCard').hidden && $('reportHours').querySelectorAll('.heat-cell').length % 7 === 0
    && heatSales.length >= 1 && heatSales.some((c) => c.classList.contains('heat-5')), heatSales.length);
  $('reportItemsBy').querySelector('[data-by="quantity"]').click();
  const top = await one(`select coalesce(p.name, max(i.name_snapshot)) as name, sum(i.quantity)::float as q from public.sale_items i
    join public.sales s on s.id = i.sale_id left join public.products p on p.id = i.product_id
    where s.status = 'completed' and s.${since('week')} group by i.product_id, p.name order by q desc limit 1`);
  const first = $('reportItems').querySelector('.bar-row');
  check('sales report: the best seller by units comes first', first?.querySelector('.bar-name').textContent === top.name
    && first.querySelector('.bar-value').textContent.startsWith(`${top.q} `), [first?.textContent.replace(/\s+/g, ' '), top]);
  check('sales report: a formula-like item name shows as plain text', $('reportItems').textContent.includes('=HYPERLINK('));
  // Revenue by item: every item with its SKU, searchable by SKU
  const skuRows = () => [...$('reportSkuTable').querySelectorAll('tbody tr:not(.empty-row)')];
  const weekItems = await one(`select count(distinct i.product_id)::int n from public.sale_items i join public.sales s on s.id = i.sale_id
    where s.status = 'completed' and s.${since('week')}`);
  check('sales report: revenue by item, each with its SKU', skuRows().length === Math.min(25, weekItems.n)
    && skuRows().every((tr) => /^[A-Z]+-\d+$/.test(tr.children[0].textContent.trim())), skuRows().map((tr) => tr.children[0].textContent));
  type($('reportSkuSearch'), 'adh-001');
  check('...found by its SKU', skuRows().length === 1 && skuRows()[0].textContent.includes('=HYPERLINK('), skuRows().length);
  type($('reportSkuSearch'), '');
  // One person's sales: the whole report for them, everyone still under staff
  type($('reportStaffPick'), anaId);
  await waitFor("Ana's sales only", () => !$('reportWho').hidden && $('reportWhoName').textContent === 'Ana Reyes'
    && !$('reportBody').classList.contains('is-loading') && $('reportRangeDates').textContent !== 'Loading…');
  const anaWeek = await one(`select coalesce(sum(total_amount), 0)::float as amount from public.sales where status = 'completed' and cashier_id = $1 and ${since('week')}`, [anaId]);
  check("sales report for one person: Ana's total", $('reportTotal').textContent === pesoText(anaWeek.amount), [$('reportTotal').textContent, anaWeek]);
  const anaRow = $('reportStaff').querySelector('.bar-row.is-on');
  check('...her row marked under staff, with her top items', anaRow?.textContent.includes('Ana Reyes') && anaRow.textContent.includes('Top:')
    && anaRow.querySelector('.list-link').textContent === 'Show everyone', anaRow?.textContent.replace(/\s+/g, ' '));
  $('reportWhoAll').click();
  await waitFor("everyone's sales again", () => $('reportWho').hidden && $('reportStaffPick').value === ''
    && !$('reportBody').classList.contains('is-loading') && $('reportTotal').textContent === pesoText(week.amount));
  $('reportPeriod').querySelector('[data-period="month"]').click();
  await reportOf('This month');
  const month = await one(`select coalesce(sum(total_amount), 0)::float as amount from public.sales where status = 'completed' and ${since('month')}`);
  check('sales report: this month, as on the server', $('reportTotal').textContent === pesoText(month.amount) && $('reportNext').disabled, $('reportTotal').textContent);
  $('reportDownloadBtn').click();
  const reportCsv = await downloads.at(-1).text();
  check('sales report: downloaded with revenue by SKU, formulas defused', reportCsv.startsWith('"Sales report","This month: ')
    && reportCsv.includes('"SKU","Item","Units sold","Unit","Revenue"') && reportCsv.includes('"\'=HYPERLINK(') && !reportCsv.includes('"=HYPERLINK('), reportCsv.slice(0, 300));
  $('reportPrev').click();
  await reportOf('Last month');
  check('sales report: last month, before any sales, is empty', $('reportTotal').textContent === '₱0.00' && !$('reportNext').disabled
    && $('reportSeries').textContent.includes('No sales last month.') && $('reportItems').textContent.includes('No sales last month.'), $('reportSeries').textContent);
  $('reportNext').click();
  await reportOf('This month');

  // The till's key is replaced (say the old one leaked): Sync now asks for
  // the new one, checks it with the server, and sends what waited meanwhile.
  await server.query(`update public.terminals set is_active = false`);
  const newKey = (await one(`select pos.add_terminal('Front counter, new key') as k`)).k;
  await openScreen('stock'); // logs "view_opened": something waiting to be sent
  const waiting = await waitFor('something waiting to be sent', async () => (await appDb.db.outbox_queue.toArray())
    .find((i) => i.payload.event_type === 'view_opened' && i.payload.details?.view === 'stock')?.payload.id);
  $('syncNowBtn').click();
  const keyPrompt = await waitFor('the new-key prompt', () => [...doc.querySelectorAll('.overlay-top')].find((o) => o.textContent.includes('new key')), 30_000);
  keyPrompt.querySelector('input').value = 'WRONG-KEY-1234';
  keyPrompt.querySelector('[data-ok]').click();
  await waitFor('a wrong key refused in the dialog', () => !keyPrompt.querySelector('.dialog-error').hidden && keyPrompt.querySelector('.dialog-error').textContent.includes("doesn't accept"));
  await answer(newKey);
  await waitFor('what waited reaches the server with the new key', async () => (await one(`select count(*)::int n from public.activity_log where id = $1`, [waiting])).n === 1, 30_000);
  check('a replaced key: asked for, checked, saved', (await appDb.getTerminalKey()) === newKey);

  // Left alone, the till locks itself; the shift stays open.
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  await waitFor('the idle lock', () => !$('loginScreen').hidden && toasts().includes('Locked after'), 40_000);
  Date.now = realNow;
  check('idle lock kept the shifts open', (await one(`select count(*)::int n from public.shift_logs where status = 'open'`)).n === 2);

  // Closed while signed in and reopened the next morning: it asks for a
  // password instead of letting the next person in as the last one.
  await appDb.setSyncMeta('current_user_id', rosaId);
  await appDb.setSyncMeta('last_active_at', Date.now() - 12 * 60 * 60_000);
  const SECOND = new URL('./second/', APP);
  mkdirSync(SECOND, { recursive: true });
  for (const file of readdirSync(APP).filter((f) => f.endsWith('.js') || f === 'package.json')) cpSync(new URL(file, APP), new URL(file, SECOND));
  window = openBrowser();
  doc = window.document;
  await import(new URL('main.js', SECOND));
  await waitFor('the sign-in screen after reopening', () => $('staffGrid').querySelectorAll('.staff-card').length === 3);
  check('reopened the next day: nobody is signed in', $('appShell').hidden && !$('loginScreen').hidden && (await appDb.getSyncMeta('current_user_id')) === null);

  // An owner with two-factor login: the server checks the code (the till
  // never gets the secret) and refuses a wrong one.
  const carloId = (await one(`select id from public.users where full_name = 'Carlo Cruz'`)).id;
  const carloSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await server.query(`update public.users set totp_secret = $1, totp_enabled = true where id = $2`, [carloSecret, carloId]);
  $('syncNowLoginBtn').click();
  await waitFor('the till learns Carlo uses two-factor login', async () => (await appDb.db.users.get(carloId))?.totp_enabled === true);
  check('...but never gets the secret', !('totp_secret' in (await appDb.db.users.get(carloId))));
  await signIn('Carlo Cruz', '222222');
  await waitFor('the code step', () => $('pinPrompt').textContent.includes('authenticator'));
  const codeNow = async () => (await one(`select pos.totp_code($1, floor(extract(epoch from now()) / 30)::bigint) as c`, [carloSecret])).c;
  const rightCode = await codeNow();
  for (const d of rightCode === '000000' ? '111111' : '000000') $('keypad').querySelector(`[data-key="${d}"]`).click();
  await waitFor('a wrong code refused by the server', () => $('loginError').textContent.includes('wrong or has expired'));
  for (const d of await codeNow()) $('keypad').querySelector(`[data-key="${d}"]`).click();
  await answer('0'); // Carlo's shift starts
  await waitFor('the dashboard, on the server sign-in made with the code', () => !$('viewDashboard').hidden && $('dashSales').textContent.includes('₱'));
  check('an owner with 2FA signs in on a code the server checked', (await one(`select count(*)::int n from public.audit_logs
    where action_type = 'failed_pin_attempt' and entity_id = $1 and details->>'step' = 'code' and details->>'checked' = 'server'`, [carloId])).n === 1);
} catch (err) {
  errors.push(err.stack ?? String(err));
}

check('no errors in the page', errors.length === 0, errors);
finish('app screens (simulated browser)');
process.exit(process.exitCode ?? 0);
