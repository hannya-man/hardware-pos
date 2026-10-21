// reports.js — the Sales report (owners): what sold and for how much in a
// day, week, month or year, and in the ones before it, for everyone or for
// one person (what they sold). Totals against the period before, sales over
// time beside the period before, the best sellers, how customers paid,
// sales by category and by staff (with each person's top items), revenue by
// item and SKU, and the busiest days and hours. The server adds it all up
// (pos_sales_report); charts.js draws the graphs.

import { fetchSalesReport, flushOutbox } from './sync-worker.js';
import { withServerAuth } from './session.js';
import { $, esc, peso, qty, countTo, downloadCsv } from './ui.js';
import { PERIODS, rangeName, emptyText, count, sales, share, localDate, fmt, salesTrend, donut, heatmap, barList } from './charts.js';

const PAY_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', bank: 'Bank transfer', credit: 'Credit (utang)', card: 'Card', other: 'Other' };
const ROLE_NAMES = { owner: 'Owner', cashier: 'Cashier' };
const TOP = 10; // best sellers shown before "Show all"
const SKU_ROWS = 25; // revenue by item: rows shown before "Show all"

let period = 'week';
let offset = 0; // 0 is the current period, 1 the one before, ...
let cashierId = ''; // one person's sales only, or everyone's
let itemsBy = 'amount';
let allItems = false;
const asTable = { series: false, heat: false };
const skus = { sort: 'amount', desc: true, search: '', all: false };
let report = null;
let loading = 0;

function rangeDates(r) {
  const a = localDate(r.first_day);
  const b = localDate(r.last_day);
  if (r.period === 'day') return fmt(a, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (r.period === 'month') return fmt(a, { month: 'long', year: 'numeric' });
  if (r.period === 'year') return String(a.getUTCFullYear());
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${fmt(a, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  const end = fmt(b, a.getUTCMonth() === b.getUTCMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${fmt(a, { month: 'short', day: 'numeric' })} – ${end}, ${b.getUTCFullYear()}`;
}

export async function renderReports() {
  drawControls();
  await load({ flush: true });
}

async function load({ flush = false } = {}) {
  const mine = ++loading;
  $('reportRangeDates').textContent = 'Loading…';
  $('reportDownloadBtn').disabled = true;
  $('reportBody').classList.add('is-loading'); // the last report stays, faded, until the next one is in
  try {
    if (flush) await flushOutbox().catch(() => {}); // include sales made on this device moments ago
    const data = await withServerAuth(() => fetchSalesReport(period, offset, cashierId));
    if (mine !== loading) return; // another choice was made meanwhile
    report = data;
    $('reportError').hidden = true;
    $('reportBody').hidden = false;
    draw();
  } catch (err) {
    if (mine !== loading) return;
    report = null;
    $('reportRangeDates').textContent = '';
    $('reportErrorText').textContent = `Couldn't load the report. ${err.message}`;
    $('reportError').hidden = false;
    $('reportBody').hidden = true;
  } finally {
    if (mine === loading) $('reportBody').classList.remove('is-loading');
  }
}

// ---------------------------------------------------------------------------
// The period, the one before or after, whose sales, and the download
// ---------------------------------------------------------------------------

function drawControls() {
  const { unit } = PERIODS[period];
  $('reportPeriod').querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
  $('reportItemsBy').querySelectorAll('[data-by]').forEach((b) => b.classList.toggle('active', b.dataset.by === itemsBy));
  for (const [id, word] of [['reportPrev', 'Previous'], ['reportNext', 'Next']]) {
    $(id).setAttribute('aria-label', `${word} ${unit}`);
    $(id).title = `${word} ${unit}`;
  }
  $('reportNext').disabled = offset === 0;
  $('reportRangeName').textContent = rangeName(period, offset);
  $('reportStaffPick').value = cashierId;
}

function go() {
  drawControls();
  load();
}

// One person's sales only (or everyone's again)
function pickPerson(id) {
  cashierId = id;
  allItems = false;
  skus.all = false;
  go();
}

$('reportPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn || btn.dataset.period === period) return;
  period = btn.dataset.period;
  offset = 0;
  allItems = false;
  skus.all = false;
  go();
});
$('reportPrev').addEventListener('click', () => {
  offset += 1;
  go();
});
$('reportNext').addEventListener('click', () => {
  if (!offset) return;
  offset -= 1;
  go();
});
$('reportRetryBtn').addEventListener('click', go);
$('reportStaffPick').addEventListener('change', () => pickPerson($('reportStaffPick').value));
$('reportWhoAll').addEventListener('click', () => pickPerson(''));
$('reportStaff').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-value]');
  if (btn) pickPerson(btn.dataset.value === cashierId ? '' : btn.dataset.value);
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// "+12% vs last week by this time": green going up, red going down, and
// always with its sign, so the colour isn't the only cue.
function compared(now, before) {
  const p = PERIODS[report.period];
  const against = report.offset === 0 ? `${p.last.toLowerCase()} by this time` : `the ${p.unit} before`;
  if (!before) return now ? `No sales ${against}` : '';
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return `About the same as ${against}`;
  return `<span class="${pct > 0 ? 'text-ok' : 'text-bad'}">${pct > 0 ? '+' : '−'}${count(Math.abs(pct))}%</span> vs ${against}`;
}

function drawPeople() {
  const r = report;
  const options = [['', 'Everyone'], ...r.people.map((u) => [u.id, `${u.full_name} (${ROLE_NAMES[u.role] ?? u.role})`])];
  $('reportStaffPick').innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  $('reportStaffPick').value = cashierId;
  $('reportWho').hidden = !r.cashier;
  $('reportWhoName').textContent = r.cashier ? r.cashier.full_name : '';
}

function draw() {
  const r = report;
  const t = r.totals;
  const amount = Number(t.amount);
  const n = Number(t.count);
  const before = Number(t.previous_amount);
  const beforeN = Number(t.previous_count);

  $('reportRangeDates').textContent = rangeDates(r);
  $('reportDownloadBtn').disabled = false;
  drawPeople();

  countTo($('reportTotal'), amount);
  $('reportTotalSub').innerHTML = compared(amount, before);
  countTo($('reportCount'), n, count);
  $('reportCountSub').innerHTML = compared(n, beforeN);
  if (n) {
    countTo($('reportAverage'), amount / n);
  } else {
    $('reportAverage').textContent = '—';
    $('reportAverage').dataset.value = 0;
  }
  $('reportAverageSub').innerHTML = n ? compared(amount / n, beforeN ? before / beforeN : 0) : '';
  countTo($('reportCollected'), t.credit_collected);
  $('reportCollectedSub').textContent = Number(t.credit_given) ? `${peso(t.credit_given)} new credit (utang)` : 'No new credit (utang)';

  $('reportVoided').hidden = !Number(t.voided_count);
  $('reportVoided').textContent = `Not counted above: ${sales(t.voided_count)} voided (${peso(t.voided_amount)}).`;

  drawSeries();
  drawItems();
  donut($('reportPayment'), r.payment.map((x) => ({
    key: PAY_LABELS[x.method] ? x.method : 'other', name: PAY_LABELS[x.method] ?? x.method, value: Number(x.amount), detail: sales(x.count),
  })), { total: amount, empty: emptyText(r) });
  barList($('reportCategories'), r.categories, {
    name: (x) => x.name,
    value: (x) => Number(x.amount),
    text: (x) => `${peso(x.amount)} · ${share(x.amount, amount)}`,
    empty: emptyText(r),
  });
  drawStaff();
  drawSkus();
  drawHeat();
}

function drawSeries() {
  $('reportSeriesTitle').textContent = PERIODS[report.period].chart;
  salesTrend($('reportSeries'), report, { table: asTable.series });
  $('reportSeriesTable').textContent = asTable.series ? 'Show as chart' : 'Show as table';
}

// Everyone, always: what each person sold, their best items, and a way to
// see the whole report for just them.
function drawStaff() {
  const r = report;
  barList($('reportStaff'), r.staff, {
    name: (x) => `${x.name}${x.role ? ` · ${ROLE_NAMES[x.role] ?? x.role}` : ''}`,
    value: (x) => Number(x.amount),
    text: (x) => `${peso(x.amount)} · ${sales(x.count)}`,
    sub: (x) => (x.top_items.length ? `Top: ${x.top_items.slice(0, 3).map((i) => `${i.name} (${qty(i.quantity)}${i.unit ? ` ${i.unit}` : ''})`).join(', ')}` : ''),
    link: (x) => ({ value: x.id ?? '', label: x.id === cashierId ? 'Show everyone' : 'See what they sold' }),
    on: (x) => x.id === cashierId,
    empty: emptyText(r),
  });
}

// Which days and hours are busiest. Not for a single day, whose sales over
// time are by the hour already.
function drawHeat() {
  $('reportHoursCard').hidden = report.period === 'day' || !report.heat.length;
  if ($('reportHoursCard').hidden) return;
  heatmap($('reportHours'), report, { table: asTable.heat });
  $('reportHoursTable').textContent = asTable.heat ? 'Show as chart' : 'Show as table';
  $('reportHoursNote').textContent = report.period === 'week'
    ? 'How many sales were made in each hour of each day.'
    : `How many sales were made in each hour, all the Mondays (and so on) of the ${PERIODS[report.period].unit} together.`;
}

function drawItems() {
  const byUnits = itemsBy === 'quantity';
  const items = [...report.items].sort(byUnits
    ? (a, b) => Number(b.quantity) - Number(a.quantity) || Number(b.amount) - Number(a.amount)
    : (a, b) => Number(b.amount) - Number(a.amount) || Number(b.quantity) - Number(a.quantity));
  const units = (x) => `${qty(x.quantity)}${x.unit ? ` ${x.unit}` : ''}`;
  barList($('reportItems'), allItems ? items : items.slice(0, TOP), {
    rank: true,
    name: (x) => x.name,
    value: (x) => Number(byUnits ? x.quantity : x.amount),
    text: (x) => (byUnits ? `${units(x)} · ${peso(x.amount)}` : `${peso(x.amount)} · ${units(x)}`),
    empty: emptyText(report),
  });
  $('reportItemsMore').parentElement.hidden = items.length <= TOP;
  $('reportItemsMore').textContent = allItems ? `Show the top ${TOP}` : `Show all ${items.length}`;
}

// ---------------------------------------------------------------------------
// Revenue by item: every item sold, with its SKU, units, revenue, share of
// the total and average price; sorted by any column, searched by name or SKU.
// ---------------------------------------------------------------------------

const SKU_SORT = {
  sku: (x) => String(x.sku ?? ''),
  name: (x) => String(x.name ?? ''),
  quantity: (x) => Number(x.quantity),
  amount: (x) => Number(x.amount),
  price: (x) => Number(x.amount) / (Number(x.quantity) || 1),
  sales: (x) => Number(x.sales),
};

function drawSkus() {
  const total = Number(report.totals.amount);
  const key = SKU_SORT[skus.sort];
  const words = skus.search.trim().toLowerCase();
  const rows = report.items
    .filter((x) => !words || `${x.sku ?? ''} ${x.name}`.toLowerCase().includes(words))
    .sort((a, b) => {
      const [va, vb] = [key(a), key(b)];
      const order = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return (skus.desc ? -order : order) || Number(b.amount) - Number(a.amount);
    });
  const shown = skus.all ? rows : rows.slice(0, SKU_ROWS);
  const top = Math.max(0, ...report.items.map((x) => Number(x.amount)));
  $('reportSkuTable').querySelector('tbody').innerHTML = shown.length
    ? shown.map((x) => `
      <tr>
        <td class="sku-code">${esc(x.sku ?? '—')}</td>
        <td><span class="cell-main">${esc(x.name)}</span></td>
        <td class="num">${esc(qty(x.quantity))}${x.unit ? ` <span class="cell-unit">${esc(x.unit)}</span>` : ''}</td>
        <td class="num sku-amount">${esc(peso(x.amount))}</td>
        <td class="num"><span class="share-cell"><span class="share-bar"><i></i></span>${esc(share(x.amount, total))}</span></td>
        <td class="num">${esc(peso(Number(x.amount) / (Number(x.quantity) || 1)))}</td>
        <td class="num">${esc(count(x.sales))}</td>
      </tr>`).join('')
    : `<tr class="empty-row"><td colspan="7">${esc(words ? `No item or SKU matches “${skus.search.trim()}”.` : emptyText(report))}</td></tr>`;
  $('reportSkuTable').querySelectorAll('.share-bar i').forEach((bar, i) => { bar.style.width = `${top ? (Number(shown[i].amount) / top) * 100 : 0}%`; });
  $('reportSkuTable').querySelectorAll('th[data-sort]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.sort === skus.sort ? (skus.desc ? 'descending' : 'ascending') : 'none');
  });
  $('reportSkuSort').value = skus.sort;
  $('reportSkuFoot').textContent = rows.length
    ? `${count(rows.length)} item${rows.length === 1 ? '' : 's'} · ${peso(rows.reduce((t, x) => t + Number(x.amount), 0))}${words ? ` of ${peso(total)}` : ''}`
    : '';
  $('reportSkuMore').parentElement.hidden = rows.length <= SKU_ROWS;
  $('reportSkuMore').textContent = skus.all ? `Show the first ${SKU_ROWS}` : `Show all ${rows.length}`;
}

// Sorting: a column heading (again: the other way round), or the list on phones
function sortSkus(by, flip) {
  if (flip && by === skus.sort) skus.desc = !skus.desc;
  else {
    skus.sort = by;
    skus.desc = !['sku', 'name'].includes(by); // A to Z for words, biggest first for numbers
  }
  if (report) drawSkus();
}
$('reportSkuTable').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) sortSkus(th.dataset.sort, true);
});
$('reportSkuSort').addEventListener('change', () => sortSkus($('reportSkuSort').value, false));
$('reportSkuSearch').addEventListener('input', () => {
  skus.search = $('reportSkuSearch').value;
  if (report) drawSkus();
});
$('reportSkuMore').addEventListener('click', () => {
  skus.all = !skus.all;
  drawSkus();
});

$('reportItemsBy').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-by]');
  if (!btn || btn.dataset.by === itemsBy) return;
  itemsBy = btn.dataset.by;
  drawControls();
  if (report) drawItems();
});
$('reportItemsMore').addEventListener('click', () => {
  allItems = !allItems;
  drawItems();
});
$('reportSeriesTable').addEventListener('click', () => {
  asTable.series = !asTable.series;
  if (report) drawSeries();
});
$('reportHoursTable').addEventListener('click', () => {
  asTable.heat = !asTable.heat;
  if (report) drawHeat();
});

// ---------------------------------------------------------------------------
// Download: the whole report as a spreadsheet file
// ---------------------------------------------------------------------------

$('reportDownloadBtn').addEventListener('click', () => {
  if (!report) return;
  const r = report;
  const t = r.totals;
  const p = PERIODS[r.period];
  const money = (n) => Number(n || 0).toFixed(2);
  const when = { day: (s) => s.slice(11, 16), week: (s) => s.slice(0, 10), month: (s) => s.slice(0, 10), year: (s) => s.slice(0, 7) }[r.period];
  const who = r.cashier ? r.cashier.full_name : 'Everyone';
  const slug = r.cashier ? `-${r.cashier.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  downloadCsv(`sales-report-${r.period}-${r.first_day}${slug}.csv`, [
    ['Sales report', `${rangeName(r.period, r.offset)}: ${rangeDates(r)}`],
    ['Sales by', who],
    [],
    ['Total sales', money(t.amount)],
    ['Number of sales', t.count],
    ['Average sale', Number(t.count) ? money(t.amount / t.count) : ''],
    [r.offset === 0 ? `${p.last}, by this time` : `The ${p.unit} before`, money(t.previous_amount), sales(t.previous_count)],
    ['Credit collected', money(t.credit_collected)],
    ['New credit (utang)', money(t.credit_given)],
    ['Voided, not counted', money(t.voided_amount), sales(t.voided_count)],
    [],
    [p.chart, 'Amount', 'Sales', `The ${p.unit} before`],
    ...r.series.map((b, i) => [when(b.at), money(b.amount), b.count, money(r.previous_series[i]?.amount)]),
    [],
    ['SKU', 'Item', 'Units sold', 'Unit', 'Revenue', 'Share', 'Average price', 'Sales'],
    ...r.items.map((x) => [x.sku ?? '', x.name, x.quantity, x.unit ?? '', money(x.amount), share(x.amount, t.amount),
      money(Number(x.amount) / (Number(x.quantity) || 1)), x.sales]),
    [],
    ['How customers paid', 'Amount', 'Sales'],
    ...r.payment.map((x) => [PAY_LABELS[x.method] ?? x.method, money(x.amount), x.count]),
    [],
    ['Category', 'Amount'],
    ...r.categories.map((x) => [x.name, money(x.amount)]),
    [],
    ['Staff (everyone)', 'Role', 'Amount', 'Sales', 'Top items'],
    ...r.staff.map((x) => [x.name, ROLE_NAMES[x.role] ?? '', money(x.amount), x.count,
      x.top_items.map((i) => `${i.name} (${i.quantity}${i.unit ? ` ${i.unit}` : ''}, ${money(i.amount)})`).join('; ')]),
    [],
    ['Hour', 'Amount', 'Sales'],
    ...r.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, money(h.amount), h.count]),
  ]);
});
