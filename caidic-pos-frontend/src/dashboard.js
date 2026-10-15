// dashboard.js — sales, money owed, stock value and alerts, who's working,
// and what's selling or not (owners).

import { fetchDashboard, flushOutbox } from './sync-worker.js';
import { withServerAuth } from './session.js';
import { $, esc, peso, qty, fmtTime, countTo } from './ui.js';

const METHODS = [['cash', 'Cash'], ['gcash', 'GCash / PayMaya'], ['credit', 'Credit']];
// Just the time for today; the date too for a shift left open since an earlier day.
const since = (iso) => (new Date(iso).toDateString() === new Date().toDateString()
  ? new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
  : fmtTime(iso));

let period = 'today';

const list = (id, items, render, empty) => {
  $(id).innerHTML = items.length ? items.map(render).join('') : `<li class="muted">${empty}</li>`;
};

export async function renderDashboard() {
  $('dashPeriod').querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
  await flushOutbox().catch(() => {}); // include sales made on this device moments ago

  try {
    const d = await withServerAuth(() => fetchDashboard(period));
    const split = METHODS.filter(([key]) => d.sales.by_method[key]).map(([key, label]) => `${label} ${peso(d.sales.by_method[key])}`);

    countTo($('dashSales'), d.sales.total);
    $('dashSalesSub').textContent = `${d.sales.count} sale${d.sales.count === 1 ? '' : 's'}${split.length ? ` · ${split.join(' · ')}` : ''}`;
    countTo($('dashOwed'), d.credit_owed);
    countTo($('dashStock'), d.stock.store_value + d.stock.warehouse_value);
    $('dashStockSub').textContent = `Store ${peso(d.stock.store_value)} · Warehouse ${peso(d.stock.warehouse_value)}`;
    countTo($('dashLow'), d.stock.low_stock_count, Math.round);
    $('dashLowCard').classList.toggle('is-warn', d.stock.low_stock_count > 0);

    list('dashOnShift', d.on_shift, (s) => `<li><span>${esc(s.name)}</span><span class="muted">since ${since(s.started_at)}</span></li>`, 'Nobody is clocked in.');
    list('dashTop', d.top_selling, (p) => `<li><span>${esc(p.name)}</span><span class="muted">${qty(p.units_sold)} ${esc(p.unit)}</span></li>`, 'Nothing sold in this period yet.');
    list('dashSlow', d.not_selling, (p) => `<li><span>${esc(p.name)}</span><span class="muted">${peso(p.value)} in stock</span></li>`, 'Everything in stock sold recently.');
  } catch (err) {
    $('dashSales').textContent = '—';
    $('dashSalesSub').textContent = `Couldn't load. ${err.message}`;
  }
}

$('dashPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn) return;
  period = btn.dataset.period;
  renderDashboard();
});
