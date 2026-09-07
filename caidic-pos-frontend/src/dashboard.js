// dashboard.js — Sales Activity/Orders, Active Items, Top Selling,
// Inventory Summary, Purchase Orders (Supplier Orders pending count),
// Stock Alerts, and Register Status. manager+owner, gated server-side by
// view-dashboard.

import { fetchDashboard } from './sync-worker.js';
import { withServerAuth } from './admin.js';

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
const num = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtSince = (iso) => new Date(iso).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

let currentPeriod = 'today';

export async function renderDashboard() {
  $('dashPeriod').querySelectorAll('.period-btn').forEach((btn) => {
    btn.onclick = () => {
      currentPeriod = btn.dataset.period;
      loadDashboard(currentPeriod);
    };
  });
  await loadDashboard(currentPeriod);
}

async function loadDashboard(period) {
  $('dashPeriod').querySelectorAll('.period-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });

  try {
    const data = await withServerAuth(() => fetchDashboard(period));

    $('dashRevenue').textContent = peso(data.sales_activity.revenue);
    $('dashOrderCount').textContent = data.sales_orders.order_count;
    $('dashActiveSkus').textContent = data.active_items;
    $('dashGoodUnits').textContent = num(data.inventory_summary.good_units_on_hand);
    $('dashRetailValue').textContent = peso(data.inventory_summary.retail_value_on_hand);
    $('dashPendingPOs').textContent = data.purchase_orders.pending;

    // Stock Alerts — count only for now, not period-scoped (it's a
    // right-now fact). Click-through to the actual low-stock rows lives
    // on Stock's own "Low" flag.
    $('dashLowStockCount').textContent = data.stock_alerts.low_stock_count;

    // Register Status — whichever terminal has an open shift right now,
    // across the whole store, not just this device.
    if (data.register_status.open) {
      $('dashRegisterStatus').textContent = 'Open';
      $('dashRegisterDetail').textContent = `${data.register_status.cashier} since ${fmtSince(data.register_status.started_at)}`;
    } else {
      $('dashRegisterStatus').textContent = 'Closed';
      $('dashRegisterDetail').textContent = 'No shift currently open';
    }

    const tbody = $('dashTopSelling').querySelector('tbody');
    tbody.innerHTML = data.top_selling.length
      ? data.top_selling.map((p) => `<tr><td>${p.name}</td><td class="amt-cell">${p.units_sold}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="2">Nothing sold in this period yet.</td></tr>';
  } catch (err) {
    $('dashRevenue').textContent = "Couldn't load";
  }
}
