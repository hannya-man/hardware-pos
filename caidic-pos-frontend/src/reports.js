// reports.js — the Sales report (owners): what sold and for how much in a
// day, week, month or year, and in the ones before it. Totals against the
// period before, sales over time, the best sellers, and the split by
// payment, category, staff and hour of the day. The server adds it all up
// (pos_sales_report); this draws it.
//
// The charts are plain SVG in one colour (each shows a single series, so no
// legend): thin bars with rounded tops, the highest one labelled, a tooltip
// on hover, tap or keyboard focus (the arrow keys move along), and a table
// instead when asked. The lists write every value out, so nothing is read
// from colour alone.

import { fetchSalesReport, flushOutbox } from './sync-worker.js';
import { withServerAuth } from './session.js';
import { $, esc, peso, qty, countTo, downloadCsv } from './ui.js';

const PAY_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', bank: 'Bank transfer', credit: 'Credit (utang)', card: 'Card', other: 'Other' };
const PERIODS = {
  day: { unit: 'day', now: 'Today', last: 'Yesterday', chart: 'Sales by hour', bucket: 'Hour' },
  week: { unit: 'week', now: 'This week', last: 'Last week', chart: 'Sales by day', bucket: 'Day' },
  month: { unit: 'month', now: 'This month', last: 'Last month', chart: 'Sales by day', bucket: 'Day' },
  year: { unit: 'year', now: 'This year', last: 'Last year', chart: 'Sales by month', bucket: 'Month' },
};
const TOP = 10; // best sellers shown before "Show all"

let period = 'week';
let offset = 0; // 0 is the current period, 1 the one before, ...
let itemsBy = 'amount';
let allItems = false;
const asTable = { series: false, hours: false };
let report = null;
let loading = 0;

const compact = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1 });
const compactPeso = (n) => compact.format(Number(n) || 0);
const count = (n) => Math.round(Number(n) || 0).toLocaleString('en-PH');
const sales = (n) => `${count(n)} sale${Number(n) === 1 ? '' : 's'}`;
const share = (part, whole) => {
  const pct = (Number(part) / (Number(whole) || 1)) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
};
// The server's dates and times are the store's local time, with no zone:
// read and shown as UTC so this device's own zone can't shift them.
const localDate = (s) => new Date(`${s.length === 10 ? `${s}T00:00:00` : s}Z`);
const fmt = (d, opts) => d.toLocaleString('en-PH', { timeZone: 'UTC', ...opts });
const hourText = (h) => fmt(new Date(Date.UTC(2000, 0, 1, h)), { hour: 'numeric' });
const hourSpan = (h) => `${hourText(h)} – ${hourText((h + 1) % 24)}`;

const rangeName = (p, n) => (n === 0 ? PERIODS[p].now : n === 1 ? PERIODS[p].last : `${n} ${PERIODS[p].unit}s ago`);
const emptyText = (r) => (r.offset === 0 ? `No sales ${PERIODS[r.period].now.toLowerCase()} yet.` : `No sales ${rangeName(r.period, r.offset).toLowerCase()}.`);

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
    const data = await withServerAuth(() => fetchSalesReport(period, offset));
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
// The period, the one before or after, and the download
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
}

function go() {
  drawControls();
  load();
}

$('reportPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn || btn.dataset.period === period) return;
  period = btn.dataset.period;
  offset = 0;
  allItems = false;
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

function draw() {
  const r = report;
  const t = r.totals;
  const amount = Number(t.amount);
  const n = Number(t.count);
  const before = Number(t.previous_amount);
  const beforeN = Number(t.previous_count);

  $('reportRangeDates').textContent = rangeDates(r);
  $('reportDownloadBtn').disabled = false;

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

  drawnWidth = $('reportSeries').clientWidth;
  drawSeries();
  drawItems();
  barList('reportPayment', r.payment, {
    name: (x) => PAY_LABELS[x.method] ?? x.method,
    value: (x) => Number(x.amount),
    text: (x) => `${peso(x.amount)} · ${share(x.amount, amount)} · ${sales(x.count)}`,
    empty: emptyText(r),
  });
  barList('reportCategories', r.categories, {
    name: (x) => x.name,
    value: (x) => Number(x.amount),
    text: (x) => `${peso(x.amount)} · ${share(x.amount, amount)}`,
    empty: emptyText(r),
  });
  barList('reportStaff', r.staff, {
    name: (x) => x.name,
    value: (x) => Number(x.amount),
    text: (x) => `${peso(x.amount)} · ${sales(x.count)}`,
    empty: emptyText(r),
  });
  drawHours();
}

function drawSeries() {
  const r = report;
  const p = PERIODS[r.period];
  const tick = { week: { weekday: 'short' }, month: { day: 'numeric' }, year: { month: 'short' } }[r.period];
  const full = { week: { weekday: 'long', month: 'short', day: 'numeric' }, month: { weekday: 'short', month: 'short', day: 'numeric' }, year: { month: 'long', year: 'numeric' } }[r.period];
  const bars = r.series.map((b) => {
    const d = localDate(b.at);
    return {
      value: Number(b.amount),
      tick: r.period === 'day' ? hourText(d.getUTCHours()) : fmt(d, tick),
      when: r.period === 'day' ? hourSpan(d.getUTCHours()) : fmt(d, full),
      main: peso(b.amount),
      detail: sales(b.count),
      later: r.offset === 0 && b.at > r.now, // still to come: not a day without sales
    };
  });
  $('reportSeriesTitle').textContent = p.chart;
  chart('reportSeries', bars, { label: p.chart, format: compactPeso, empty: emptyText(r), table: asTable.series, columns: [p.bucket, 'Amount', 'Sales'] });
  $('reportSeriesTable').textContent = asTable.series ? 'Show as chart' : 'Show as table';
}

// How many sales start in each hour of the day, from the first busy hour to
// the last. Not for a single day, whose chart above is by the hour already.
function drawHours() {
  const r = report;
  const busy = r.hours.filter((h) => Number(h.count) > 0);
  $('reportHoursCard').hidden = r.period === 'day' || !busy.length;
  if ($('reportHoursCard').hidden) return;
  const from = Math.max(0, busy[0].hour - 1);
  const to = Math.min(23, busy[busy.length - 1].hour + 1);
  const bars = r.hours.slice(from, to + 1).map((h) => ({
    value: Number(h.count), tick: hourText(h.hour), when: hourSpan(h.hour), main: sales(h.count), detail: peso(h.amount),
  }));
  chart('reportHours', bars, { label: 'Busiest hours', format: count, integer: true, empty: emptyText(r), table: asTable.hours, columns: ['Hour', 'Sales', 'Amount'] });
  $('reportHoursTable').textContent = asTable.hours ? 'Show as chart' : 'Show as table';
}

function drawItems() {
  const byUnits = itemsBy === 'quantity';
  const items = [...report.items].sort(byUnits
    ? (a, b) => Number(b.quantity) - Number(a.quantity) || Number(b.amount) - Number(a.amount)
    : (a, b) => Number(b.amount) - Number(a.amount) || Number(b.quantity) - Number(a.quantity));
  const units = (x) => `${qty(x.quantity)}${x.unit ? ` ${x.unit}` : ''}`;
  barList('reportItems', allItems ? items : items.slice(0, TOP), {
    rank: true,
    name: (x) => x.name,
    value: (x) => Number(byUnits ? x.quantity : x.amount),
    text: (x) => (byUnits ? `${units(x)} · ${peso(x.amount)}` : `${peso(x.amount)} · ${units(x)}`),
    empty: emptyText(report),
  });
  $('reportItemsMore').parentElement.hidden = items.length <= TOP;
  $('reportItemsMore').textContent = allItems ? `Show the top ${TOP}` : `Show all ${items.length}`;
}

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
  asTable.hours = !asTable.hours;
  if (report) drawHours();
});

// A list with a thin bar under each row, its length against the largest.
function barList(id, rows, { name, value, text, rank = false, empty }) {
  const max = Math.max(0, ...rows.map(value));
  $(id).innerHTML = rows.length
    ? rows.map((x, i) => `
      <li class="bar-row">
        ${rank ? `<span class="bar-rank">${i + 1}</span>` : ''}
        <div class="bar-main">
          <div class="bar-text"><span class="bar-name" title="${esc(name(x))}">${esc(name(x))}</span><span class="bar-value">${esc(text(x))}</span></div>
          <div class="bar-fill"></div>
        </div>
      </li>`).join('')
    : `<li class="bar-empty">${esc(empty)}</li>`;
  // Style properties, which the Content-Security-Policy allows (a style="" attribute it wouldn't)
  $(id).querySelectorAll('.bar-fill').forEach((el, i) => { el.style.width = `${max ? (value(rows[i]) / max) * 100 : 0}%`; });
}

// ---------------------------------------------------------------------------
// Column chart: round steps up the side, the highest column labelled, x
// labels thinned so they never touch, and a tooltip per column (its whole
// height, not just the bar, answers the pointer). Columns still to come
// (later today, later this week, ...) have no tooltip and no table row.
// ---------------------------------------------------------------------------

function chart(id, bars, { label, format, integer = false, empty, table, columns }) {
  const box = $(id);
  if (!bars.some((b) => b.value > 0)) {
    box.innerHTML = `<p class="chart-empty">${esc(empty)}</p>`;
    return;
  }
  if (table) {
    box.innerHTML = `<table class="mini-table"><thead><tr>${columns.map((c, i) => `<th${i ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>`
      + `<tbody>${bars.filter((b) => !b.later).map((b) => `<tr><td>${esc(b.when)}</td><td class="num">${esc(b.main)}</td><td class="num">${esc(b.detail)}</td></tr>`).join('')}</tbody></table>`;
    return;
  }

  const width = box.clientWidth || 640; // not laid out (yet): a usual width
  const plotH = width < 480 ? 150 : 180;
  const { step, top } = niceScale(Math.max(...bars.map((b) => b.value)), integer);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const textWidth = (s) => String(s).length * 6.5; // 11px figures, near enough
  const pad = { top: 20, right: 4, bottom: 26, left: Math.max(...ticks.map((v) => textWidth(format(v)))) + 12 };
  const height = pad.top + plotH + pad.bottom;
  const band = (width - pad.left - pad.right) / bars.length;
  const barW = Math.max(2, Math.min(24, band - 2)); // 24px at most, with 2px or more between
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const room = Math.max(...bars.map((b) => textWidth(b.tick))) + 10;
  const every = [1, 2, 3, 4, 6, 12].find((k) => k * band >= room) ?? Math.ceil(room / band);
  const middle = (i) => pad.left + band * i + band / 2;

  let svg = ticks.map((v) => {
    const yy = Math.round(y(v)) + 0.5;
    return (v ? `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"/>` : '')
      + `<text class="chart-tick" x="${pad.left - 8}" y="${yy + 4}" text-anchor="end">${esc(format(v))}</text>`;
  }).join('');
  bars.forEach((b, i) => {
    const h = b.value > 0 ? Math.max(2, (b.value / top) * plotH) : 0;
    if (!b.later) {
      svg += `<g class="chart-col" data-i="${i}" tabindex="${i ? -1 : 0}" role="img" aria-label="${esc(`${b.when}: ${b.main}, ${b.detail}`)}">`
        + `<rect class="chart-hit" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${plotH}" rx="4"/>`
        + (h ? `<path class="chart-bar" d="${barPath(middle(i) - barW / 2, pad.top + plotH - h, barW, h)}"/>` : '')
        + '</g>';
    }
    if (i % every === 0) svg += `<text class="chart-tick" x="${middle(i)}" y="${pad.top + plotH + 17}" text-anchor="middle">${esc(b.tick)}</text>`;
  });
  const peak = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);
  const peakText = format(bars[peak].value);
  const half = textWidth(peakText) / 2;
  svg += `<text class="chart-peak" x="${Math.min(Math.max(middle(peak), pad.left + half), width - pad.right - half)}" y="${y(bars[peak].value) - 7}" text-anchor="middle">${esc(peakText)}</text>`;
  const base = Math.round(y(0)) + 0.5;
  svg += `<line class="chart-base" x1="${pad.left}" x2="${width - pad.right}" y1="${base}" y2="${base}"/>`;

  box.innerHTML = `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(label)}">${svg}</svg>`
    + '<div class="chart-tip" hidden><strong></strong><span></span></div>';

  const tip = box.querySelector('.chart-tip');
  const cols = [...box.querySelectorAll('.chart-col')];
  const show = (i) => {
    const b = bars[i];
    tip.querySelector('strong').textContent = b.main;
    tip.querySelector('span').textContent = `${b.when} · ${b.detail}`;
    tip.hidden = false;
    const halfTip = (tip.offsetWidth || 160) / 2;
    tip.style.left = `${Math.min(Math.max(middle(i), halfTip), width - halfTip)}px`; // kept inside the chart
    tip.style.top = `${y(b.value) - 10}px`;
  };
  const hide = () => { tip.hidden = true; };
  cols.forEach((col, k) => {
    const i = Number(col.dataset.i);
    col.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(i); });
    col.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    col.addEventListener('click', () => show(i)); // a tap on a phone
    col.addEventListener('focus', () => show(i));
    col.addEventListener('blur', hide);
    col.addEventListener('keydown', (e) => {
      const to = cols[{ ArrowLeft: k - 1, ArrowRight: k + 1, Home: 0, End: cols.length - 1 }[e.key]];
      if (!to) return;
      e.preventDefault();
      col.setAttribute('tabindex', '-1');
      to.setAttribute('tabindex', '0');
      to.focus();
    });
  });
}

// 4px rounded at the top, square on the baseline.
function barPath(x, yTop, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`;
}

// Round steps (1, 2, 2.5 or 5 times a power of ten), about four of them.
function niceScale(max, integer) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  if (integer) step = Math.max(1, Math.ceil(step));
  return { step, top: step * Math.ceil(max / step) };
}

// The charts are drawn for their width: drawn again when it changes (a
// phone turned sideways, the window resized).
let drawnWidth = 0;
new ResizeObserver(() => {
  const w = $('reportSeries').clientWidth;
  if (!report || !w || w === drawnWidth) return;
  drawnWidth = w;
  drawSeries();
  drawHours();
}).observe($('reportSeries'));

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
  downloadCsv(`sales-report-${r.period}-${r.first_day}.csv`, [
    ['Sales report', `${rangeName(r.period, r.offset)}: ${rangeDates(r)}`],
    [],
    ['Total sales', money(t.amount)],
    ['Number of sales', t.count],
    ['Average sale', Number(t.count) ? money(t.amount / t.count) : ''],
    [r.offset === 0 ? `${p.last}, by this time` : `The ${p.unit} before`, money(t.previous_amount), sales(t.previous_count)],
    ['Credit collected', money(t.credit_collected)],
    ['New credit (utang)', money(t.credit_given)],
    ['Voided, not counted', money(t.voided_amount), sales(t.voided_count)],
    [],
    [p.chart, 'Amount', 'Sales'],
    ...r.series.map((b) => [when(b.at), money(b.amount), b.count]),
    [],
    ['Best sellers', 'Units', 'Unit', 'Amount', 'Sales'],
    ...r.items.map((x) => [x.name, x.quantity, x.unit ?? '', money(x.amount), x.sales]),
    [],
    ['How customers paid', 'Amount', 'Sales'],
    ...r.payment.map((x) => [PAY_LABELS[x.method] ?? x.method, money(x.amount), x.count]),
    [],
    ['Category', 'Amount'],
    ...r.categories.map((x) => [x.name, money(x.amount)]),
    [],
    ['Staff', 'Amount', 'Sales'],
    ...r.staff.map((x) => [x.name, money(x.amount), x.count]),
    [],
    ['Hour', 'Amount', 'Sales'],
    ...r.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, money(h.amount), h.count]),
  ]);
});
