// admin.js — Sales (voids themselves are in voids.js), Shifts (with each
// shift's timeline), Returns, and Staff. Hiding a screen in the menu is only
// a convenience: every call here hits a server function that checks the role
// itself.

import QRCode from 'qrcode';
import {
  flushOutbox, fetchSales, fetchShifts, fetchShift, submitReturn,
  fetchUsers, createUser, updateUser, setupTwoFactor, verifyTwoFactor, disableTwoFactor, fetchAuditLog,
} from './sync-worker.js';
import { withServerAuth } from './session.js';
import { askToVoid, openVoidRequest } from './voids.js';
import {
  $, esc, peso, qty, fmtTime, fmtDate, fmtDateTime, humanize, badge, avatar, setStatus, showSelected, countTo,
  tableMessage, renderRows, onAction, openModal, closeModal, productPicker, showConfirm, toast,
} from './ui.js';

const PAY_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', bank: 'Bank transfer', credit: 'Credit', card: 'Card', other: 'Other' };
const rowsOf = (result) => result.data ?? result; // paginated or plain
const pinLengthFor = (role) => (role === 'owner' ? 6 : 4);
const personCell = (u) => (u ? `<div class="person">${avatar(u)}<span class="cell-main">${esc(u.full_name)}</span></div>` : '—');
const clock = (iso) => new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${peso(Math.abs(n))}`;

const paymentLabel = (s) => (s.payment_method === 'credit' ? `Credit · ${s.customer?.name ?? 'customer'}` : PAY_LABELS[s.payment_method] ?? humanize(s.payment_method));

function itemsSummary(items = [], shown = 2) {
  const text = items.slice(0, shown).map((i) => `${i.name_snapshot} × ${qty(i.quantity)}`).join(', ');
  return esc(text) + (items.length > shown ? ` <span class="muted">+${items.length - shown} more</span>` : '');
}

function duration(from, to) {
  const minutes = Math.max(0, Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 60000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// Start of today / this week (Monday) / this month, on this device's clock.
function periodStart(period) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === 'month') start.setDate(1);
  return start.toISOString();
}

// Long lists arrive a page at a time (100 sales, 50 shifts, 200 audit
// events). "Show more" under the table adds the next page.
function showMore(buttonId, result, shown) {
  const left = Math.max(0, Number(result?.total ?? 0) - shown);
  $(buttonId).parentElement.hidden = left === 0;
  $(buttonId).textContent = `Show more (${left} left)`;
}

const addPage = (rows, more) => {
  const have = new Set(rows.map((r) => r.id));
  return rows.concat(more.filter((r) => !have.has(r.id))); // a new entry can shift a page by one
};

async function loadMore(buttonId, load) {
  $(buttonId).disabled = true;
  try {
    await load();
  } catch (err) {
    toast(`Couldn't load more. ${err.message}`, 'error');
  } finally {
    $(buttonId).disabled = false;
  }
}

// ---------------------------------------------------------------------------
// SALES
// ---------------------------------------------------------------------------

let salesPeriod = 'today';
let sales = [];
let salesPage = 1;
let openSaleRow = null;

const saleRow = (s) => `
  <tr class="is-clickable${s.status === 'completed' ? '' : ' is-muted'}" data-action="open" data-id="${esc(s.id)}">
    <td class="nowrap">${fmtTime(s.client_created_at)}</td>
    <td>${itemsSummary(s.items)}</td>
    <td>${esc(paymentLabel(s))}</td>
    <td>${esc(s.cashier?.full_name ?? '—')}</td>
    <td class="num"><strong>${peso(s.total_amount)}</strong>${s.status !== 'completed'
      ? `<span class="cell-sub">${badge(humanize(s.status), 'bad')}</span>`
      : s.pending_void ? `<span class="cell-sub">${badge('Void waiting', 'warn')}</span>` : ''}</td>
  </tr>`;

function drawSales(result) {
  renderRows('salesTable', sales, saleRow, 'No sales in this period yet.');
  showMore('salesMoreBtn', result, sales.length);
}

export async function renderSales() {
  $('salesPeriod').querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === salesPeriod));
  tableMessage('salesTable', 'Loading…');
  showMore('salesMoreBtn', null, 0);
  await flushOutbox().catch(() => {}); // include sales made on this device moments ago
  try {
    const result = await withServerAuth(() => fetchSales({ from: periodStart(salesPeriod) }));
    sales = rowsOf(result);
    salesPage = 1;
    const totals = result.totals ?? {};
    const sum = (...methods) => methods.reduce((t, m) => t + Number(totals[m] ?? 0), 0);
    countTo($('salesTotal'), Object.values(totals).reduce((t, v) => t + Number(v), 0));
    countTo($('salesCash'), sum('cash'));
    countTo($('salesDigital'), sum('gcash', 'bank', 'card', 'other'));
    countTo($('salesCredit'), sum('credit'));
    drawSales(result);
  } catch (err) {
    tableMessage('salesTable', `Couldn't load. ${err.message}`);
  }
}

$('salesMoreBtn').addEventListener('click', () => loadMore('salesMoreBtn', async () => {
  const result = await withServerAuth(() => fetchSales({ from: periodStart(salesPeriod), page: salesPage + 1 }));
  salesPage = result.current_page;
  sales = addPage(sales, rowsOf(result));
  drawSales(result);
}));

$('salesPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn) return;
  salesPeriod = btn.dataset.period;
  renderSales();
});

onAction('salesTable', { open: (id) => openSale(sales.find((s) => s.id === id)) });

function openSale(sale) {
  if (!sale) return;
  openSaleRow = sale;
  const facts = [
    ['Time', fmtTime(sale.client_created_at)],
    ['Staff', sale.cashier?.full_name ?? '—'],
    ['Payment', paymentLabel(sale)],
  ];
  if (sale.payment_method === 'cash' && sale.amount_tendered != null) {
    facts.push(['Cash received', peso(sale.amount_tendered)], ['Change', peso(sale.change_amount ?? 0)]);
  }
  if (sale.payment_reference) facts.push(['Reference', sale.payment_reference]);
  if (sale.payment_method === 'credit') {
    facts.push(['Paid now', peso(sale.amount_paid ?? 0)], ['Added to credit', peso(Number(sale.total_amount) - Number(sale.amount_paid ?? 0))]);
  }
  if (sale.status !== 'completed') facts.push(['Status', `${humanize(sale.status)}${sale.void_reason ? `: ${sale.void_reason}` : ''}`]);

  $('saleTitle').textContent = `Sale of ${peso(sale.total_amount)}`;
  $('saleFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('saleLines').innerHTML = (sale.items ?? []).map((i) => `
    <div class="summary-line">
      <div><span class="summary-name">${esc(i.name_snapshot)}</span><span class="summary-sub">${qty(i.quantity)} × ${peso(i.unit_price_snapshot)}</span></div>
      <span class="summary-amt">${peso(i.line_total)}</span>
    </div>`).join('');
  $('saleTotal').textContent = peso(sale.total_amount);
  $('saleVoidBtn').hidden = sale.status !== 'completed' || !!sale.pending_void;
  $('saleVoidRequestBtn').hidden = sale.status !== 'completed' || !sale.pending_void;
  openModal('saleOverlay');
}

// Asking only starts it: a second owner has to agree (voids.js).
$('saleVoidBtn').addEventListener('click', async () => {
  if (await askToVoid(openSaleRow)) closeModal('saleOverlay');
});

$('saleVoidRequestBtn').addEventListener('click', () => {
  closeModal('saleOverlay');
  openVoidRequest(openSaleRow.pending_void.id);
});

// A void was asked for, answered, or lapsed (here or on another device).
window.addEventListener('voids-changed', () => {
  if (!$('viewSales').hidden) renderSales();
});

// ---------------------------------------------------------------------------
// SHIFTS: clock-in to clock-out, and a timeline of everything in between.
// ---------------------------------------------------------------------------

let shifts = [];
let shiftData = null;

const STEP_EVENTS = new Set(['item_added', 'barcode_scanned', 'view_opened']); // only with "Show every step"
const SHOWN_FROM_RECORDS = new Set(['shift_started', 'shift_ended', 'sale_completed', 'credit_payment_received']);
const SCREEN_NAMES = { dashboard: 'Dashboard', billing: 'Sell', credit: 'Credit', materialRequests: 'Pick lists', stock: 'Stock', sales: 'Sales', shifts: 'Shifts', returns: 'Returns', staff: 'Staff', audit: 'Audit log' };

const EVENT_TEXT = {
  login: () => 'Signed back in',
  session_resumed: () => 'Reopened the POS',
  screen_locked: (d) => (d.reason === 'idle' ? 'Locked after 10 minutes without use' : 'Took a break'),
  logout: () => 'Signed out',
  view_opened: (d) => `Opened ${SCREEN_NAMES[d.view] ?? 'a screen'}`,
  item_added: (d) => `Added ${d.name ?? 'an item'} to the order`,
  barcode_scanned: (d) => `Scanned ${d.name ?? 'an item'}`,
  barcode_no_match: (d) => `Scanned an unknown barcode (${d.code ?? ''})`,
  material_request_sent: (d) => `Sent a pick list (${d.item_count ?? ''} items)`,
  pick_list_done: (d) => `Marked a pick list as picked up${d.sale_ref ? ` (sale ${d.sale_ref})` : ''}`,
  pick_slip_printed: (d) => `Printed a pick slip${d.sale_ref ? ` for sale ${d.sale_ref}` : ''} (${d.item_count ?? ''} items)`,
  customer_added: (d) => `Added credit customer ${d.name ?? ''}`,
  customer_updated: (d) => `Updated customer ${d.name ?? ''}`,
  stock_received: (d) => `Added a delivery: ${qty(d.quantity)} × ${d.name ?? 'item'} to the ${d.location ?? 'store'}`,
  price_changed: (d) => `Changed the price of ${d.product_name} from ${peso(d.from)} to ${peso(d.to)}`,
  item_added_to_catalog: (d) => `Added a new item: ${d.product_name}`,
  item_details_updated: (d) => `Edited ${d.product_name}`,
  item_archived: (d) => `Archived ${d.product_name}`,
  item_restored: (d) => `Restored ${d.product_name}`,
  stock_quantity_adjusted: (d) => `Changed the ${d.location} count of ${d.product_name} by ${d.delta > 0 ? '+' : ''}${qty(d.delta)}`,
  void_requested: (d) => `Asked to void a ${peso(d.total_amount)} sale: “${d.reason ?? ''}”`,
  void_approved: (d) => `Approved voiding a ${peso(d.total_amount)} sale`,
  void_rejected: (d) => `Said no to voiding a ${peso(d.total_amount)} sale`,
  void_cancelled: (d) => `Cancelled the request to void a ${peso(d.total_amount)} sale`,
  sale_voided: (d) => `Voided a ${peso(d.total_amount)} sale${d.approved_by ? ` (approved by ${d.approved_by})` : ''}: “${d.reason ?? ''}”`,
  return_accepted: (d) => `Accepted a return: ${qty(d.quantity)} × ${d.product_name ?? 'item'} (${d.condition ?? ''})`,
  staff_added: (d) => `Added staff account ${d.staff_name}`,
  staff_updated: (d) => `Edited staff account ${d.staff_name}`,
  staff_deactivated: (d) => `Deactivated ${d.staff_name}`,
  staff_reactivated: (d) => `Restored ${d.staff_name}`,
  two_factor_enabled: (d) => `Turned on two-factor login for ${d.staff_name}`,
  two_factor_disabled: (d) => `Turned off two-factor login for ${d.staff_name}`,
};
const describe = (a) => EVENT_TEXT[a.event_type]?.(a.details ?? {}) ?? humanize(a.event_type);

let shiftsPage = 1;

function shiftRow(s) {
  const diff = s.cash_discrepancy == null ? null : Number(s.cash_discrepancy);
  return `
    <tr class="is-clickable" data-action="open" data-id="${esc(s.id)}">
      <td>${personCell(s.cashier)}</td>
      <td class="nowrap">${fmtTime(s.started_at)}</td>
      <td class="nowrap">${s.ended_at ? fmtTime(s.ended_at) : '—'}</td>
      <td class="num">${duration(s.started_at, s.ended_at)}</td>
      <td class="num">${peso(s.sales_total ?? 0)}<span class="cell-sub">${s.sales_count} sale${s.sales_count === 1 ? '' : 's'}</span></td>
      <td class="num${diff ? ' text-bad' : ''}">${diff == null ? '—' : diff === 0 ? 'None' : signed(diff)}</td>
      <td>${s.status === 'open' ? badge('On shift', 'info') : badge('Ended')}</td>
    </tr>`;
}

function drawShifts(result) {
  renderRows('shiftsTable', shifts, shiftRow, 'No shifts yet.');
  showMore('shiftsMoreBtn', result, shifts.length);
}

export async function renderShifts() {
  $('shiftDetail').hidden = true;
  $('shiftsListCard').hidden = false;
  await fillStaffFilter();
  tableMessage('shiftsTable', 'Loading…');
  showMore('shiftsMoreBtn', null, 0);
  await flushOutbox().catch(() => {});
  try {
    const result = await withServerAuth(() => fetchShifts({ cashier_id: $('shiftStaffFilter').value }));
    shifts = rowsOf(result);
    shiftsPage = 1;
    drawShifts(result);
  } catch (err) {
    tableMessage('shiftsTable', `Couldn't load. ${err.message}`);
  }
}

$('shiftsMoreBtn').addEventListener('click', () => loadMore('shiftsMoreBtn', async () => {
  const result = await withServerAuth(() => fetchShifts({ cashier_id: $('shiftStaffFilter').value, page: shiftsPage + 1 }));
  shiftsPage = result.current_page;
  shifts = addPage(shifts, rowsOf(result));
  drawShifts(result);
}));

async function fillStaffFilter() {
  const select = $('shiftStaffFilter');
  if (select.options.length) return;
  const staff = await withServerAuth(() => fetchUsers(true)).catch(() => []);
  select.innerHTML = '<option value="">All staff</option>' + staff.map((u) => `<option value="${esc(u.id)}">${esc(u.full_name)}</option>`).join('');
}

$('shiftStaffFilter').addEventListener('change', renderShifts);
$('shiftBackBtn').addEventListener('click', renderShifts);
$('shiftShowSteps').addEventListener('change', () => shiftData && drawTimeline());
onAction('shiftsTable', { open: (id) => openShiftDetail(id) });

async function openShiftDetail(id) {
  try {
    shiftData = await withServerAuth(() => fetchShift(id));
  } catch (err) {
    return toast(`Couldn't open the shift. ${err.message}`, 'error');
  }
  const { shift, sales: shiftSales, payments } = shiftData;
  const done = shiftSales.filter((s) => s.status === 'completed');
  const credit = done.filter((s) => s.payment_method === 'credit').reduce((t, s) => t + Number(s.total_amount) - Number(s.amount_paid ?? 0), 0);
  const received = payments.reduce((t, p) => t + Number(p.amount), 0);
  const diff = shift.cash_discrepancy == null ? null : Number(shift.cash_discrepancy);

  $('shiftsListCard').hidden = true;
  $('shiftDetail').hidden = false;
  $('shiftTitle').textContent = `${shift.cashier?.full_name ?? 'Shift'} · ${fmtDate(shift.started_at)}`;
  const stat = (label, value, sub = '', tone = '') => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value ${tone}">${value}</span><span class="stat-sub">${sub}</span></div>`;
  $('shiftStats').innerHTML = [
    stat('Sales', peso(done.reduce((t, s) => t + Number(s.total_amount), 0)), `${done.length} sale${done.length === 1 ? '' : 's'}`),
    stat('Given on credit', peso(credit), 'to be paid later'),
    stat('Credit payments taken', peso(received), `${payments.length} payment${payments.length === 1 ? '' : 's'}`),
    shift.status === 'open'
      ? stat('Cash count', 'Not yet', `on shift for ${duration(shift.started_at)}`)
      : stat('Cash difference', diff == null ? '—' : diff === 0 ? 'None' : signed(diff),
        shift.counted_cash == null ? 'no cash to count' : `counted ${peso(shift.counted_cash)} of ${peso(shift.expected_cash)}`, diff ? 'text-bad' : 'text-ok'),
  ].join('');
  drawTimeline();
  $('content').scrollTop = 0;
}

function timelineEntries() {
  const { shift, sales: shiftSales, payments, activity } = shiftData;
  const showSteps = $('shiftShowSteps').checked;
  const entries = [
    { at: shift.started_at, kind: 'start', title: 'Clocked in', sub: `Cash in the drawer: ${peso(shift.opening_cash)}` },
    ...shiftSales.map((s) => ({
      at: s.client_created_at,
      kind: s.status === 'completed' ? 'sale' : 'void',
      title: `${s.status === 'completed' ? 'Sale' : 'Sale (voided)'} · ${peso(s.total_amount)} · ${paymentLabel(s)}`,
      sub: (s.items ?? []).map((i) => `${i.name_snapshot} × ${qty(i.quantity)}`).join(', '),
    })),
    ...payments.map((p) => ({
      at: p.client_created_at, kind: 'payment',
      title: `Credit payment · ${peso(p.amount)} from ${p.customer?.name ?? 'a customer'}`,
      sub: PAY_LABELS[p.payment_method] ?? p.payment_method,
    })),
    ...activity
      .filter((a) => !SHOWN_FROM_RECORDS.has(a.event_type) && (showSteps || !STEP_EVENTS.has(a.event_type)))
      .map((a) => ({ at: a.client_created_at, kind: STEP_EVENTS.has(a.event_type) ? 'step' : 'event', title: describe(a), sub: a.ip_address ? `from ${a.ip_address}` : '' })),
  ];
  if (shift.ended_at) {
    entries.push({
      at: shift.ended_at, kind: 'end', title: 'Clocked out',
      sub: shift.counted_cash == null ? 'No cash to count' : `Counted ${peso(shift.counted_cash)}, expected ${peso(shift.expected_cash)}`,
    });
  }
  return entries.sort((a, b) => new Date(a.at) - new Date(b.at));
}

function drawTimeline() {
  $('shiftTimeline').innerHTML = timelineEntries().map((e) => `
    <li class="tl tl-${e.kind}">
      <time>${clock(e.at)}</time>
      <div><strong>${esc(e.title)}</strong>${e.sub ? `<span>${esc(e.sub)}</span>` : ''}</div>
    </li>`).join('');
}

// A cell starting with = + - @ would run as a formula when opened in Excel or
// Google Sheets (a customer named "=HYPERLINK(...)", say); a leading ' keeps
// it plain text.
const csvCell = (value) => {
  const text = String(value ?? '');
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

// Saves rows (the first one is the header) as a CSV file.
function downloadCsv(filename, rows) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([rows.map((cells) => cells.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('shiftDownloadBtn').addEventListener('click', () => {
  const who = (shiftData.shift.cashier?.full_name ?? 'shift').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  downloadCsv(`${who}-${shiftData.shift.started_at.slice(0, 10)}.csv`,
    [['Time', 'What happened', 'Details'], ...timelineEntries().map((e) => [fmtTime(e.at), e.title, e.sub])]);
});

// ---------------------------------------------------------------------------
// RETURNS (owner). Needs proof: an invoice or slip number, or a reason.
// ---------------------------------------------------------------------------

let returnProduct = null;
const returnPicker = productPicker('retProductSearch', 'retProductResults', (p) => {
  returnProduct = p;
  showSelected('retSelectedProduct', p);
});

export function renderReturns() {
  returnProduct = null;
  returnPicker.reset();
  showSelected('retSelectedProduct', null);
  $('retQuantity').value = 1;
  $('retReason').value = '';
  const good = document.querySelector('input[name="retCondition"][value="good"]');
  good.checked = true;
  good.dispatchEvent(new Event('change', { bubbles: true })); // so the highlight follows
  setStatus('retStatus');
}

$('retSubmitBtn').addEventListener('click', async () => {
  const quantity = Number($('retQuantity').value);
  const reason = $('retReason').value.trim();
  if (!returnProduct) return setStatus('retStatus', 'Pick the item being returned.', 'err');
  if (!(quantity > 0)) return setStatus('retStatus', 'Enter the quantity returned.', 'err');
  if (reason.length < 3) return setStatus('retStatus', 'Write the invoice or slip number, or the reason. It is the proof for this return.', 'err');

  const condition = document.querySelector('input[name="retCondition"]:checked').value;
  try {
    await withServerAuth(() => submitReturn({
      id: crypto.randomUUID(), product_id: returnProduct.id, quantity_returned: quantity,
      condition, reason, client_created_at: new Date().toISOString(),
    }));
    toast(`Return accepted: ${returnProduct.name} (${condition}).`);
    renderReturns();
  } catch (err) {
    setStatus('retStatus', `Failed. ${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// STAFF (owners). Owners use a 6-digit password and can turn on two-factor
// login; cashiers use 4 digits. Deactivated accounts can't sign in but are
// never deleted, so their history stays.
// ---------------------------------------------------------------------------

let staffRows = [];
let editingStaff = null;

function applyPinLength(roleId, pinId) {
  const length = pinLengthFor($(roleId).value);
  $(pinId).maxLength = length;
  $(pinId).placeholder = `${length}-digit password`;
}

for (const id of ['usrPin', 'editStaffPin']) {
  $(id).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
}

export async function renderStaff() {
  setStatus('usrStatus');
  applyPinLength('usrRole', 'usrPin');
  tableMessage('usersTable', 'Loading…');
  try {
    const showInactive = $('staffShowInactive').checked;
    staffRows = (await withServerAuth(() => fetchUsers(showInactive))).filter((u) => showInactive || u.is_active);
    renderRows('usersTable', staffRows, (u) => `
      <tr class="${u.is_active ? '' : 'is-muted'}">
        <td>${personCell(u)}</td>
        <td><span class="cap">${esc(u.role)}</span>${u.role === 'owner' && u.totp_enabled ? ` ${badge('2FA on', 'info')}` : ''}${u.is_active ? '' : ` ${badge('Deactivated')}`}</td>
        <td class="actions">${u.is_active ? `
          <button type="button" class="btn btn-sm" data-action="edit" data-id="${esc(u.id)}">Edit</button>
          <button type="button" class="btn btn-sm btn-danger-soft" data-action="deactivate" data-id="${esc(u.id)}">Deactivate</button>` : `
          <button type="button" class="btn btn-sm" data-action="restore" data-id="${esc(u.id)}">Restore</button>`}</td>
      </tr>`, 'No staff accounts yet.');
  } catch (err) {
    tableMessage('usersTable', `Couldn't load. ${err.message}`);
  }
}

$('staffShowInactive').addEventListener('change', renderStaff);

async function setActive(id, is_active, done) {
  try {
    await withServerAuth(() => updateUser(id, { is_active }));
    toast(done);
    renderStaff();
  } catch (err) {
    toast(`Couldn't update the account. ${err.message}`, 'error');
  }
}

onAction('usersTable', {
  edit: (id) => openEditStaff(staffRows.find((u) => u.id === id)),
  deactivate: async (id) => {
    const user = staffRows.find((u) => u.id === id);
    const yes = await showConfirm('Deactivate this account?', {
      message: `${user.full_name} won't be able to sign in. Their shifts and sales stay on record, and the account can be restored.`,
      confirmLabel: 'Deactivate',
      danger: true,
    });
    if (yes) setActive(id, false, `${user.full_name} was deactivated.`);
  },
  restore: (id) => setActive(id, true, 'Account restored.'),
});

$('usrRole').addEventListener('change', () => applyPinLength('usrRole', 'usrPin'));

$('usrAddBtn').addEventListener('click', async () => {
  const full_name = $('usrName').value.trim();
  const role = $('usrRole').value;
  const pin = $('usrPin').value.trim();
  const length = pinLengthFor(role);
  if (!full_name || pin.length !== length) return setStatus('usrStatus', `Enter a name and a ${length}-digit password.`, 'err');

  try {
    await withServerAuth(() => createUser({ full_name, role, pin }));
    $('usrName').value = $('usrPin').value = '';
    toast(`${full_name} was added.`);
    renderStaff();
  } catch (err) {
    setStatus('usrStatus', `Failed. ${err.message}`, 'err');
  }
});

function openEditStaff(user) {
  if (!user) return;
  editingStaff = { ...user };
  $('editStaffName').value = user.full_name;
  $('editStaffRole').value = user.role;
  $('editStaffPin').value = '';
  applyPinLength('editStaffRole', 'editStaffPin');
  setStatus('editStaffStatus');
  refreshTwoFa();
  openModal('editStaffOverlay');
}

function refreshTwoFa() {
  $('editStaffTwoFaSection').hidden = $('editStaffRole').value !== 'owner';
  const on = !!editingStaff?.totp_enabled;
  $('editStaffTwoFaStatus').textContent = on ? 'On' : 'Off';
  $('editStaffTwoFaToggle').textContent = on ? 'Turn off' : 'Set up';
}

$('editStaffRole').addEventListener('change', () => {
  applyPinLength('editStaffRole', 'editStaffPin');
  refreshTwoFa();
});

$('editStaffSubmitBtn').addEventListener('click', async () => {
  const full_name = $('editStaffName').value.trim();
  const role = $('editStaffRole').value;
  const pin = $('editStaffPin').value.trim();
  const length = pinLengthFor(role);
  if (!full_name) return setStatus('editStaffStatus', 'Name cannot be empty.', 'err');
  if (pin && pin.length !== length) return setStatus('editStaffStatus', `A new password for this role must be ${length} digits, or leave it blank.`, 'err');

  try {
    await withServerAuth(() => updateUser(editingStaff.id, { full_name, role, ...(pin ? { pin } : {}) }));
    closeModal('editStaffOverlay');
    toast('Staff details saved.');
    renderStaff();
  } catch (err) {
    setStatus('editStaffStatus', `Couldn't save. ${err.message}`, 'err');
  }
});

$('editStaffTwoFaToggle').addEventListener('click', async () => {
  if (!editingStaff) return;

  if (editingStaff.totp_enabled) {
    if (!(await showConfirm('Turn off two-factor login?', { message: 'This account will only need its password to sign in.', confirmLabel: 'Turn off', danger: true }))) return;
    try {
      await withServerAuth(() => disableTwoFactor(editingStaff.id));
      editingStaff.totp_enabled = false;
      refreshTwoFa();
      renderStaff();
    } catch (err) {
      toast(`Couldn't turn off two-factor login. ${err.message}`, 'error');
    }
    return;
  }

  try {
    const { secret, otpauth_url } = await withServerAuth(() => setupTwoFactor(editingStaff.id));
    $('twoFaSecretDisplay').textContent = (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
    $('twoFaConfirmCode').value = '';
    $('twoFaQr').innerHTML = '';
    setStatus('twoFaStatus');
    openModal('twoFaOverlay');
    const dataUrl = await QRCode.toDataURL(otpauth_url, { width: 184, margin: 1 }).catch(() => null);
    if (dataUrl) $('twoFaQr').innerHTML = `<img src="${dataUrl}" width="184" height="184" alt="QR code for the authenticator app">`;
  } catch (err) {
    toast(`Couldn't start two-factor setup. ${err.message}`, 'error');
  }
});

async function confirmTwoFa() {
  const code = $('twoFaConfirmCode').value.trim();
  if (code.length !== 6) return setStatus('twoFaStatus', 'Enter the 6-digit code shown in the app.', 'err');
  try {
    await withServerAuth(() => verifyTwoFactor(editingStaff.id, code));
    editingStaff.totp_enabled = true;
    refreshTwoFa();
    closeModal('twoFaOverlay');
    toast('Two-factor login is on.');
    renderStaff();
  } catch (err) {
    setStatus('twoFaStatus', `Couldn't confirm. ${err.message}`, 'err');
  }
}

$('twoFaConfirmBtn').addEventListener('click', confirmTwoFa);
$('twoFaConfirmCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmTwoFa(); });

// ---------------------------------------------------------------------------
// AUDIT LOG (owners): events that need an owner's eyes, newest first. The
// download is the record to keep (or show an auditor).
// ---------------------------------------------------------------------------

let auditPeriod = 'today';
let auditRows = [];
let auditPage = 1;

const AUDIT_TEXT = {
  failed_pin_attempt: (a, d) => `Wrong ${d.step === 'code' ? 'authenticator code' : 'password'} for ${a.subject ?? 'an account'}${d.locked ? '. The account is locked for a minute.' : ''}`,
  shift_close_discrepancy: (a, d) => `Cash ${Number(d.cash_discrepancy) < 0 ? 'short' : 'over'} by ${peso(Math.abs(Number(d.cash_discrepancy)))} at the end of ${a.subject ? `${a.subject}'s` : 'a'} shift`,
  admin_void: (a, d) => `Voided sale ${a.subject ?? ''} of ${peso(d.total_amount)}: “${d.reason ?? ''}”`,
  batch_oversold: (a, d) => `Sold ${qty(d.oversold_by)} more ${a.subject ?? 'of an item'} than the stock count showed`,
  return_accepted: (a, d) => `Return accepted: ${qty(d.quantity_returned)} × ${a.subject ?? 'an item'} (${d.condition ?? ''})`,
  manual_stock_adjustment: (a, d) => `Couldn't take ${qty(d.short_by)} ${a.subject ?? 'of an item'} out of the ${d.location ?? 'store'}: not enough in stock`,
  timestamp_anomaly_clamped: (a) => `A delivery of ${a.subject ?? 'an item'} was dated in the future (a device's clock is wrong), so its date was corrected`,
  customer_anonymized: () => "A customer's name and phone number were removed on request",
};
const describeAudit = (a) => AUDIT_TEXT[a.action_type]?.(a, a.details ?? {}) ?? humanize(a.action_type);
const auditWho = (a) => [a.actor?.full_name, a.approver && a.approver.id !== a.actor?.id ? `approved by ${a.approver.full_name}` : null]
  .filter(Boolean).join(', ') || '—';

const auditRow = (a) => `
  <tr>
    <td class="nowrap">${fmtTime(a.client_created_at)}</td>
    <td>${esc(describeAudit(a))}</td>
    <td>${esc(auditWho(a))}</td>
    <td class="nowrap">${esc(a.ip_address ?? '—')}</td>
  </tr>`;

function drawAudit(result) {
  renderRows('auditTable', auditRows, auditRow, 'Nothing to review in this period.');
  showMore('auditMoreBtn', result, auditRows.length);
}

const auditFilters = (page) => ({ from: periodStart(auditPeriod), action_type: $('auditType').value, page });

export async function renderAudit() {
  $('auditPeriod').querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === auditPeriod));
  tableMessage('auditTable', 'Loading…');
  showMore('auditMoreBtn', null, 0);
  await flushOutbox().catch(() => {}); // include wrong passwords tried on this device moments ago
  try {
    const result = await withServerAuth(() => fetchAuditLog(auditFilters(1)));
    auditRows = rowsOf(result);
    auditPage = 1;
    drawAudit(result);
  } catch (err) {
    tableMessage('auditTable', `Couldn't load. ${err.message}`);
  }
}

$('auditMoreBtn').addEventListener('click', () => loadMore('auditMoreBtn', async () => {
  const result = await withServerAuth(() => fetchAuditLog(auditFilters(auditPage + 1)));
  auditPage = result.current_page;
  auditRows = addPage(auditRows, rowsOf(result));
  drawAudit(result);
}));

$('auditPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn) return;
  auditPeriod = btn.dataset.period;
  renderAudit();
});
$('auditType').addEventListener('change', renderAudit);

$('auditDownloadBtn').addEventListener('click', () => {
  downloadCsv(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Time', 'What happened', 'Who', 'From', 'Kind'],
    ...auditRows.map((a) => [fmtDateTime(a.client_created_at), describeAudit(a), auditWho(a), a.ip_address ?? '', a.action_type]),
  ]);
});
