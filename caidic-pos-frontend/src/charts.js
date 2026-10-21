// charts.js — the graphs on the Sales report and the Dashboard, drawn as
// plain SVG from what the server adds up (pos_sales_report):
//
//   salesTrend  sales over time: a line with the area under it tinted, the
//               period before as a grey line behind it, and a crosshair whose
//               tooltip gives both (hover, tap, or the arrow keys)
//   donut       one total split into parts (how customers paid), its legend
//               beside it; pointing at a part shows it in the middle
//   heatmap     day of the week by hour, a deeper orange for more sales
//   barList     a ranked list with a bar under each row
//
// Every value is also readable without the graph (a legend, the lists, or
// "Show as table"), and nothing is told by colour alone. The colours are CSS
// custom properties (style.css), so the dark and light looks both apply
// without redrawing. A graph plays a short entrance the first time it
// scrolls into view, and redraws itself for its new width when that changes.

import { esc, peso } from './ui.js';

// ---------------------------------------------------------------------------
// Periods, dates and numbers, shared with reports.js and dashboard.js
// ---------------------------------------------------------------------------

export const PERIODS = {
  day: { unit: 'day', now: 'Today', last: 'Yesterday', chart: 'Sales by hour', bucket: 'Hour' },
  week: { unit: 'week', now: 'This week', last: 'Last week', chart: 'Sales by day', bucket: 'Day' },
  month: { unit: 'month', now: 'This month', last: 'Last month', chart: 'Sales by day', bucket: 'Day' },
  year: { unit: 'year', now: 'This year', last: 'Last year', chart: 'Sales by month', bucket: 'Month' },
};
export const rangeName = (p, n) => (n === 0 ? PERIODS[p].now : n === 1 ? PERIODS[p].last : `${n} ${PERIODS[p].unit}s ago`);
const previousName = (p, n) => (n === 0 ? PERIODS[p].last : `${n + 1} ${PERIODS[p].unit}s ago`);
export const emptyText = (r) => (r.offset === 0 ? `No sales ${PERIODS[r.period].now.toLowerCase()} yet.` : `No sales ${rangeName(r.period, r.offset).toLowerCase()}.`);

const compact = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1 });
export const compactPeso = (n) => compact.format(Number(n) || 0);
export const count = (n) => Math.round(Number(n) || 0).toLocaleString('en-PH');
export const sales = (n) => `${count(n)} sale${Number(n) === 1 ? '' : 's'}`;
export const share = (part, whole) => {
  const pct = (Number(part) / (Number(whole) || 1)) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
};
// The server's dates and times are the store's local time, with no zone:
// read and shown as UTC so this device's own zone can't shift them.
export const localDate = (s) => new Date(`${s.length === 10 ? `${s}T00:00:00` : s}Z`);
export const fmt = (d, opts) => d.toLocaleString('en-PH', { timeZone: 'UTC', ...opts });
export const hourText = (h) => fmt(new Date(Date.UTC(2000, 0, 1, h)), { hour: 'numeric' });
export const hourSpan = (h) => `${hourText(h)} – ${hourText((h + 1) % 24)}`;
const dayName = (d, opts) => fmt(new Date(Date.UTC(2024, 0, d)), opts); // 1 Jan 2024 was a Monday

const TICK = { week: { weekday: 'short' }, month: { day: 'numeric' }, year: { month: 'short' } };
const FULL = { week: { weekday: 'short', month: 'short', day: 'numeric' }, month: { weekday: 'short', month: 'short', day: 'numeric' }, year: { month: 'long', year: 'numeric' } };
const textWidth = (s) => String(s).length * 6.6; // 11px figures, near enough
let uid = 0;

// ---------------------------------------------------------------------------
// What every graph shares: its width, its entrance, its tooltip
// ---------------------------------------------------------------------------

// Plays a graph's entrance once it's on screen (style.css pauses it until then).
const watcher = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.remove('is-waiting');
      watcher.unobserve(e.target);
    }
  }, { threshold: 0.2 })
  : null;
function entrance(el, animate) {
  el.classList.toggle('no-anim', !animate);
  el.classList.remove('is-waiting');
  if (!animate || !watcher) return;
  el.classList.add('is-waiting');
  watcher.observe(el);
}

// Redraws a graph, without its entrance, when its width changes.
const fitted = new Map(); // box -> { width, redraw }
const resizer = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const it = fitted.get(e.target);
      const w = e.target.clientWidth;
      if (!it || !w || w === it.width) continue;
      it.width = w;
      it.redraw();
    }
  })
  : null;
function keepFitted(box, redraw) {
  if (!fitted.has(box)) resizer?.observe(box);
  fitted.set(box, { width: box.clientWidth, redraw });
}

// A tap anywhere else puts away a graph's tooltip (a mouse leaving does too).
const hiders = new Map(); // box -> hide
document.addEventListener('pointerdown', (e) => {
  for (const [box, hide] of hiders) if (!box.contains(e.target)) hide();
});

// Tooltip rows: the value first and strong, then what it is, keyed with a
// short stroke of its series. Built with textContent: labels are data.
function fillTip(tip, title, rows) {
  tip.replaceChildren();
  if (title) {
    const head = document.createElement('span');
    head.className = 'chart-tip-title';
    head.textContent = title;
    tip.append(head);
  }
  for (const row of rows) {
    const line = document.createElement('span');
    line.className = 'chart-tip-row';
    if (row.key) {
      const key = document.createElement('i');
      key.className = `key key-${row.key}`;
      line.append(key);
    }
    const value = document.createElement('strong');
    value.textContent = row.value;
    const label = document.createElement('span');
    label.textContent = row.label;
    line.append(value, label);
    tip.append(line);
  }
  tip.hidden = false;
}

// Round steps (1, 2, 2.5 or 5 times a power of ten), about four of them.
function niceScale(max) {
  if (!(max > 0)) return { step: 1, top: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { step, top: step * Math.ceil(max / step) };
}

// A smooth line through the points that never overshoots them (monotone
// cubic): a quiet day stays at zero instead of dipping below it. One path
// command per step from a point to the next.
function curve(pts) {
  if (pts.length < 3) return pts.slice(1).map(([x, y]) => `L${x},${y}`);
  const n = pts.length;
  const slope = [];
  for (let i = 0; i < n - 1; i++) slope.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  const t = [slope[0]];
  for (let i = 1; i < n - 1; i++) t.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  t.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!slope[i]) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      t[i] = (3 / Math.sqrt(h)) * a * slope[i];
      t[i + 1] = (3 / Math.sqrt(h)) * b * slope[i];
    }
  }
  const steps = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3;
    steps.push(`C${pts[i][0] + dx},${pts[i][1] + t[i] * dx} ${pts[i + 1][0] - dx},${pts[i + 1][1] - t[i + 1] * dx} ${pts[i + 1][0]},${pts[i + 1][1]}`);
  }
  return steps;
}
const smooth = (pts) => `M${pts[0][0]},${pts[0][1]}${curve(pts).join('')}`;

// ---------------------------------------------------------------------------
// Sales over time, against the period before
// ---------------------------------------------------------------------------

export function salesTrend(box, r, { table = false, animate = true } = {}) {
  const p = PERIODS[r.period];
  const names = [rangeName(r.period, r.offset), previousName(r.period, r.offset)];
  const when = (at) => {
    const d = localDate(at);
    return r.period === 'day' ? hourSpan(d.getUTCHours()) : fmt(d, FULL[r.period]);
  };
  const points = r.series.map((b, i) => {
    const d = localDate(b.at);
    const before = r.previous_series?.[i];
    return {
      tick: r.period === 'day' ? hourText(d.getUTCHours()) : fmt(d, TICK[r.period]),
      when: when(b.at),
      value: Number(b.amount),
      count: Number(b.count),
      later: r.offset === 0 && b.at > r.now, // still to come: not a time without sales
      prev: before ? { value: Number(before.amount), count: Number(before.count), when: when(before.at) } : null,
    };
  });
  hiders.delete(box);
  keepFitted(box, () => salesTrend(box, r, { table, animate: false }));

  if (!points.some((pt) => (!pt.later && pt.value > 0) || pt.prev?.value > 0)) {
    box.innerHTML = `<p class="chart-empty">${esc(emptyText(r))}</p>`;
    return;
  }
  const amountCell = (v) => (v ? `${esc(peso(v.value))}<span class="cell-sub">${esc(sales(v.count))}</span>` : '—');
  if (table) {
    box.innerHTML = `<table class="mini-table"><thead><tr><th>${esc(p.bucket)}</th><th class="num">${esc(names[0])}</th><th class="num">${esc(names[1])}</th></tr></thead><tbody>${
      points.map((pt) => `<tr><td>${esc(pt.when)}</td><td class="num">${pt.later ? '—' : amountCell(pt)}</td><td class="num">${amountCell(pt.prev)}</td></tr>`).join('')
    }</tbody></table>`;
    return;
  }

  const width = box.clientWidth || 640; // not laid out (yet): a usual width
  const plotH = width < 480 ? 160 : 200;
  const n = points.length;
  const { step, top } = niceScale(Math.max(...points.map((pt) => Math.max(pt.later ? 0 : pt.value, pt.prev?.value ?? 0))));
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const pad = { top: 22, right: 14, bottom: 28, left: Math.max(...ticks.map((v) => textWidth(compactPeso(v)))) + 14 };
  const height = pad.top + plotH + pad.bottom;
  const band = (width - pad.left - pad.right) / n;
  const x = (i) => +(pad.left + band * (i + 0.5)).toFixed(1);
  const y = (v) => +(pad.top + plotH - (v / top) * plotH).toFixed(1);
  const base = y(0);
  const room = Math.max(...points.map((pt) => textWidth(pt.tick))) + 12;
  const every = [1, 2, 3, 4, 6, 12].find((k) => k * band >= room) ?? Math.ceil(room / band); // x labels that never touch
  const now = points.flatMap((pt, i) => (pt.later ? [] : [[x(i), y(pt.value)]]));
  const before = points.flatMap((pt, i) => (pt.prev ? [[x(i), y(pt.prev.value)]] : []));
  let last = -1; // the latest time so far
  points.forEach((pt, i) => { if (!pt.later) last = i; });
  const wash = `wash-${++uid}`;

  let svg = `<defs><linearGradient id="${wash}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="wash-top"/><stop offset="1" class="wash-bottom"/></linearGradient></defs>`;
  for (const v of ticks) {
    const yy = Math.round(y(v)) + 0.5;
    if (v) svg += `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="chart-tick" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${esc(compactPeso(v))}</text>`;
  }
  points.forEach((pt, i) => {
    if (i % every === 0) svg += `<text class="chart-tick" x="${x(i)}" y="${base + 19}" text-anchor="middle">${esc(pt.tick)}</text>`;
  });
  svg += `<line class="chart-base" x1="${pad.left}" x2="${width - pad.right}" y1="${Math.round(base) + 0.5}" y2="${Math.round(base) + 0.5}"/>`;
  if (before.length > 1) svg += `<path class="chart-prev" d="${smooth(before)}" pathLength="1"/>`;
  if (now.length > 1) {
    // In a period still under way, the stretch into the time it's in now is
    // dashed: that time isn't over, so its sales are only "so far".
    const steps = curve(now);
    const done = r.offset === 0 ? steps.slice(0, -1) : steps;
    svg += `<path class="chart-area" fill="url(#${wash})" d="${smooth(now)}L${now[now.length - 1][0]},${base}L${now[0][0]},${base}Z"/>`;
    if (done.length) svg += `<path class="chart-line" d="M${now[0][0]},${now[0][1]}${done.join('')}" pathLength="1"/>`;
    if (r.offset === 0) svg += `<path class="chart-sofar" d="M${now[now.length - 2][0]},${now[now.length - 2][1]}${steps[steps.length - 1]}"/>`;
  }
  // The highest point gets its value; the latest one a dot.
  const peak = points.reduce((best, pt, i) => (!pt.later && pt.value > (best < 0 ? 0 : points[best].value) ? i : best), -1);
  if (peak >= 0) {
    const text = compactPeso(points[peak].value);
    const half = textWidth(text) / 2;
    svg += `<text class="chart-peak" x="${Math.min(Math.max(x(peak), pad.left + half), width - pad.right - half)}" y="${y(points[peak].value) - 11}" text-anchor="middle">${esc(text)}</text>`;
  }
  if (last >= 0) svg += `<circle class="chart-dot chart-end" cx="${x(last)}" cy="${y(points[last].value)}" r="4"/>`;
  svg += `<g class="chart-cross"><line class="chart-cross-line" y1="${pad.top - 6}" y2="${base}"/><circle class="chart-dot chart-dot-prev" r="4"/><circle class="chart-dot" r="4"/></g>`;
  const total = points.reduce((t, pt) => t + (pt.later ? 0 : pt.value), 0);
  const totalBefore = points.reduce((t, pt) => t + (pt.prev?.value ?? 0), 0);
  svg += `<rect class="chart-hit-area" x="${pad.left}" y="0" width="${width - pad.left - pad.right}" height="${base}" tabindex="0" role="img"
    aria-label="${esc(`${p.chart}. ${names[0]}: ${peso(total)}. ${names[1]}: ${peso(totalBefore)}. The arrow keys read each ${p.bucket.toLowerCase()}.`)}"/>`;

  box.innerHTML = `<div class="chart-legend"><span><i class="key key-line"></i>${esc(names[0])}</span><span><i class="key key-prev"></i>${esc(names[1])}</span></div>`
    + `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`
    + '<div class="chart-tip chart-tip-side" hidden></div>';

  const svgEl = box.querySelector('svg');
  const tip = box.querySelector('.chart-tip');
  const cross = svgEl.querySelector('.chart-cross');
  const crossLine = cross.querySelector('line');
  const [dotPrev, dotNow] = cross.querySelectorAll('circle');
  const hit = svgEl.querySelector('.chart-hit-area');
  let at = -1;
  const place = (dot, show, cy, cx) => {
    dot.setAttribute('visibility', show ? 'visible' : 'hidden');
    if (show) {
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
    }
  };
  const show = (i) => {
    at = i;
    const pt = points[i];
    for (const a of ['x1', 'x2']) crossLine.setAttribute(a, x(i));
    place(dotNow, !pt.later, y(pt.value), x(i));
    place(dotPrev, !!pt.prev, pt.prev ? y(pt.prev.value) : 0, x(i));
    box.classList.add('is-pointing');
    fillTip(tip, pt.when, [
      pt.later ? { key: 'line', value: 'Still to come', label: names[0] } : { key: 'line', value: peso(pt.value), label: `${names[0]} · ${sales(pt.count)}${r.offset === 0 && i === last ? ' so far' : ''}` },
      ...(pt.prev ? [{ key: 'prev', value: peso(pt.prev.value), label: r.period === 'day' ? names[1] : `${names[1]} · ${pt.prev.when}` }] : []),
    ]);
    // Beside the crosshair, on whichever side has room, in the box's pixels
    const scale = (svgEl.getBoundingClientRect().width || width) / width;
    const px = x(i) * scale;
    const w = tip.offsetWidth || 180;
    tip.style.left = `${px + 14 + w > width * scale ? Math.max(0, px - 14 - w) : px + 14}px`;
    tip.style.top = `${box.querySelector('.chart-legend').offsetHeight + pad.top * scale}px`;
  };
  const hide = () => {
    at = -1;
    tip.hidden = true;
    box.classList.remove('is-pointing');
  };
  hiders.set(box, hide);
  const indexAt = (e) => {
    const rect = svgEl.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (width / (rect.width || width));
    return Math.max(0, Math.min(n - 1, Math.floor((sx - pad.left) / band)));
  };
  hit.addEventListener('pointermove', (e) => show(indexAt(e)));
  hit.addEventListener('pointerdown', (e) => show(indexAt(e)));
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  hit.addEventListener('focus', () => show(at >= 0 ? at : Math.max(0, last)));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    show(Math.max(0, Math.min(n - 1, to)));
  });
  entrance(box, animate);
}

// ---------------------------------------------------------------------------
// Donut: one total, split into parts
// ---------------------------------------------------------------------------

// slices: [{ key (its colour: cash, gcash, ...), name, value, detail }]
export function donut(box, slices, { total, empty, animate = true }) {
  hiders.delete(box);
  const parts = slices.filter((s) => Number(s.value) > 0);
  if (!parts.length) {
    box.innerHTML = `<p class="chart-empty">${esc(empty)}</p>`;
    return;
  }
  const size = 176;
  const c = size / 2;
  const r = c - 14;
  const gap = parts.length > 1 ? (2.5 / (2 * Math.PI * r)) * 100 : 0; // a 2px sliver of the card between parts
  let start = 0;
  const segs = parts.map((s, i) => {
    const pct = (Number(s.value) / total) * 100;
    const len = Math.max(0.01, pct - gap);
    const seg = `<circle class="donut-seg seg-${esc(s.key)}" data-i="${i}" cx="${c}" cy="${c}" r="${r}" pathLength="100" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${-start}"
      tabindex="0" role="img" aria-label="${esc(`${s.name}: ${peso(s.value)}, ${share(s.value, total)}, ${s.detail}`)}"/>`;
    start += pct;
    return seg;
  }).join('');
  const big = (v) => (peso(v).length > 11 ? compactPeso(v) : peso(v));
  box.innerHTML = `<div class="donut">
      <svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="donut-track" cx="${c}" cy="${c}" r="${r}"/>
        <g class="donut-ring"><g transform="rotate(-90 ${c} ${c})">${segs}</g></g>
        <text class="donut-value" x="${c}" y="${c + 2}" text-anchor="middle"></text>
        <text class="donut-label" x="${c}" y="${c + 22}" text-anchor="middle"></text>
      </svg>
      <ul class="donut-legend">${parts.map((s, i) => `
        <li data-i="${i}"><i class="key key-box seg-${esc(s.key)}"></i><span class="donut-name">${esc(s.name)}</span>
          <span class="donut-sub"><strong class="donut-amount">${esc(peso(s.value))}</strong> · ${esc(share(s.value, total))} · ${esc(s.detail)}</span></li>`).join('')}
      </ul>
    </div>`;
  const value = box.querySelector('.donut-value');
  const label = box.querySelector('.donut-label');
  const ring = box.querySelector('.donut');
  const focus = (i) => {
    ring.classList.toggle('is-pointing', i >= 0);
    box.querySelectorAll('[data-i]').forEach((el) => el.classList.toggle('is-on', Number(el.dataset.i) === i));
    value.textContent = i >= 0 ? big(parts[i].value) : big(total);
    label.textContent = i >= 0 ? `${parts[i].name} · ${share(parts[i].value, total)}` : 'in total';
  };
  focus(-1);
  box.querySelectorAll('[data-i]').forEach((el) => {
    const i = Number(el.dataset.i);
    el.addEventListener('pointerenter', () => focus(i));
    el.addEventListener('pointerleave', () => focus(-1));
    el.addEventListener('focus', () => focus(i));
    el.addEventListener('blur', () => focus(-1));
  });
  entrance(box, animate);
}

// ---------------------------------------------------------------------------
// Heatmap: which days and hours are busiest
// ---------------------------------------------------------------------------

export function heatmap(box, r, { table = false, animate = true } = {}) {
  hiders.delete(box);
  keepFitted(box, () => heatmap(box, r, { table, animate: false }));
  const cells = r.heat ?? [];
  if (!cells.length) {
    box.innerHTML = `<p class="chart-empty">${esc(emptyText(r))}</p>`;
    return;
  }
  // In a week each day is one date; over a month or a year, every Monday (...) together.
  const first = localDate(r.first_day).getTime();
  const dayText = r.period === 'week'
    ? (d) => fmt(new Date(first + (d - 1) * 86400e3), { weekday: 'short', month: 'short', day: 'numeric' })
    : (d) => `${dayName(d, { weekday: 'long' })}s`;
  const busiest = [...cells].sort((a, b) => b.count - a.count || b.amount - a.amount);
  if (table) {
    box.innerHTML = `<table class="mini-table"><thead><tr><th>Day</th><th>Hour</th><th class="num">Sales</th><th class="num">Amount</th></tr></thead><tbody>${
      busiest.map((c) => `<tr><td>${esc(dayText(c.day))}</td><td>${esc(hourSpan(c.hour))}</td><td class="num">${esc(count(c.count))}</td><td class="num">${esc(peso(c.amount))}</td></tr>`).join('')
    }</tbody></table>`;
    return;
  }

  const from = Math.min(...cells.map((c) => c.hour));
  const to = Math.max(...cells.map((c) => c.hour));
  const max = Math.max(...cells.map((c) => c.count));
  const byCell = new Map(cells.map((c) => [`${c.day}-${c.hour}`, c]));
  const width = box.clientWidth || 640;
  const labelW = 40;
  const cols = to - from + 1;
  const cellW = Math.min(88, (width - labelW) / cols);
  const cellH = Math.min(34, Math.max(22, cellW * 0.7));
  const height = 7 * cellH + 24;
  const svgW = labelW + cellW * cols;
  const room = textWidth(hourText(12)) + 10;
  const every = [1, 2, 3, 4, 6, 12].find((k) => k * cellW >= room) ?? 12;
  const level = (n) => (n ? Math.max(1, Math.ceil((5 * n) / max)) : 0); // five steps of orange

  let svg = '';
  for (let d = 1; d <= 7; d++) {
    svg += `<text class="chart-tick" x="${labelW - 8}" y="${(d - 1) * cellH + cellH / 2 + 4}" text-anchor="end">${esc(dayName(d, { weekday: 'short' }))}</text>`;
    for (let h = from; h <= to; h++) {
      const c = byCell.get(`${d}-${h}`);
      const n = c?.count ?? 0;
      svg += `<rect class="heat-cell heat-${level(n)}" data-d="${d}" data-h="${h}" x="${labelW + (h - from) * cellW + 1}" y="${(d - 1) * cellH + 1}"
        width="${cellW - 2}" height="${cellH - 2}" rx="3" tabindex="${d === 1 && h === from ? 0 : -1}" role="img"
        aria-label="${esc(`${dayText(d)}, ${hourSpan(h)}: ${n ? `${sales(n)}, ${peso(c.amount)}` : 'no sales'}`)}"/>`;
    }
  }
  for (let h = from; h <= to; h += every) {
    svg += `<text class="chart-tick" x="${labelW + (h - from + 0.5) * cellW}" y="${7 * cellH + 17}" text-anchor="middle">${esc(hourText(h))}</text>`;
  }
  box.innerHTML = `<svg class="chart-svg heat-svg" width="${svgW}" height="${height}" viewBox="0 0 ${svgW} ${height}" role="group" aria-label="Busiest times">${svg}</svg>`
    + `<div class="heat-legend"><span>Fewer</span>${[1, 2, 3, 4, 5].map((k) => `<i class="heat-${k}"></i>`).join('')}<span>More</span>`
    + `<span class="heat-top">Busiest: ${esc(dayText(busiest[0].day))}, ${esc(hourText(busiest[0].hour))} (${esc(sales(busiest[0].count))})</span></div>`
    + '<div class="chart-tip" hidden></div>';

  const tip = box.querySelector('.chart-tip');
  const svgEl = box.querySelector('svg');
  const rects = [...svgEl.querySelectorAll('.heat-cell')];
  const show = (rect) => {
    const d = Number(rect.dataset.d);
    const h = Number(rect.dataset.h);
    const c = byCell.get(`${d}-${h}`);
    fillTip(tip, null, [{ value: c ? sales(c.count) : 'No sales', label: `${dayText(d)} · ${hourSpan(h)}${c ? ` · ${peso(c.amount)}` : ''}` }]);
    const scale = (svgEl.getBoundingClientRect().width || svgW) / svgW;
    const half = (tip.offsetWidth || 160) / 2;
    const cx = (labelW + (h - from + 0.5) * cellW) * scale;
    tip.style.left = `${Math.min(Math.max(cx, half), Math.max(half, (box.clientWidth || width) - half))}px`;
    tip.style.top = `${((d - 1) * cellH - 4) * scale}px`;
  };
  const hide = () => { tip.hidden = true; };
  hiders.set(box, hide);
  rects.forEach((rect, i) => {
    rect.style.animationDelay = `${(Number(rect.dataset.h) - from) * 22}ms`; // a sweep from morning to evening
    rect.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(rect); });
    rect.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    rect.addEventListener('click', () => show(rect));
    rect.addEventListener('focus', () => show(rect));
    rect.addEventListener('blur', hide);
    rect.addEventListener('keydown', (e) => {
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
      const next = rects[i + (move ?? 0)];
      if (!move || !next || (Math.abs(move) === 1 && next.dataset.d !== rect.dataset.d)) return;
      e.preventDefault();
      rect.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    });
  });
  entrance(box, animate);
}

// ---------------------------------------------------------------------------
// A ranked list with a bar under each row, its length against the largest
// ---------------------------------------------------------------------------

export function barList(list, rows, { name, value, text, rank = false, empty, animate = true }) {
  const max = Math.max(0, ...rows.map(value));
  list.innerHTML = rows.length
    ? rows.map((x, i) => `
      <li class="bar-row">
        ${rank ? `<span class="bar-rank">${i + 1}</span>` : ''}
        <div class="bar-main">
          <div class="bar-text"><span class="bar-name" title="${esc(name(x))}">${esc(name(x))}</span><span class="bar-value">${esc(text(x))}</span></div>
          <div class="bar-track"><div class="bar-fill"></div></div>
        </div>
      </li>`).join('')
    : `<li class="bar-empty">${esc(empty)}</li>`;
  // Style properties, which the Content-Security-Policy allows (a style="" attribute it wouldn't)
  list.querySelectorAll('.bar-fill').forEach((el, i) => {
    el.style.width = `${max ? (value(rows[i]) / max) * 100 : 0}%`;
    el.style.animationDelay = `${Math.min(i, 12) * 35}ms`;
  });
  entrance(list, animate);
}
