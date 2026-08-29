// main.js — the real app, replacing the test script from earlier. Every
// function called here (verifyStaffLogin, searchProducts, completeSale,
// etc.) is the actual offline-first logic already built, not mock data.

import { db, getTerminalId, isProvisioned, setTerminalKey, getOpenShift } from './local-db.js';
import { verifyStaffLogin, searchProducts, quickSelect, attachScannerListener, getProductByBarcode } from './input-handler.js';
import { startSyncWorker, pullCatalog, completeSale, openShift, logActivity } from './sync-worker.js';
import {
  setAdminUser, renderActivity, renderShifts, renderReturns,
  renderReconciliation, renderAnalytics, renderStaff
} from './admin.js';

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
const round2 = (n) => Math.round(n * 100) / 100;
const initials = (name) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// Small in-page replacement for window.prompt(), which throws in Vite's
// dev environment and many embedded/webview contexts. Used for the
// terminal provisioning key and the shift opening-cash amount.
function showPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:#fff;padding:20px;border-radius:8px;min-width:280px;">
        <p style="margin:0 0 10px;font-size:14px;">${message}</p>
        <input type="text" value="${defaultValue}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;">
        <div style="margin-top:12px;text-align:right;">
          <button type="button" data-act="cancel" style="margin-right:8px;">Cancel</button>
          <button type="button" data-act="ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    input.focus();
    input.select();

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(input.value));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
  });
}

// roles: which nav items each role sees. This is display-only — every
// screen behind these is still enforced server-side by its own Gate; a
// cashier who forced their way to, say, #viewStaff would just get 401s
// back from every call admin.js makes.
const NAV_ITEMS = [
  { key: 'billing', label: 'POS Billing', roles: ['cashier', 'manager', 'owner'], onEnter: () => renderGrid() },
  { key: 'shifts', label: 'Shifts', roles: ['manager', 'owner'], onEnter: renderShifts },
  { key: 'returns', label: 'Returns', roles: ['owner'], onEnter: renderReturns },
  { key: 'reconciliation', label: 'Reconciliation', roles: ['owner'], onEnter: renderReconciliation },
  { key: 'analytics', label: 'Fast/Slow Movers', roles: ['owner'], onEnter: renderAnalytics },
  { key: 'activity', label: 'Activity Log', roles: ['owner'], onEnter: renderActivity },
  { key: 'staff', label: 'Staff', roles: ['manager', 'owner'], onEnter: renderStaff }
];

let currentUser = null;
let currentShiftId = null;
let cart = [];
let selectedLoginUser = null;
let pinDraft = '';
let activeView = 'billing';

// ---------------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------------

async function init() {
  if (!(await isProvisioned())) {
    const key = await showPrompt("This terminal hasn't been set up yet. Enter its one-time key:");
    if (key) await setTerminalKey(key.trim());
  }

  startSyncWorker({
    onStatusChange: (status) => {
      $('statusLabel').textContent = status === 'online' ? 'Online' : 'Offline';
      $('statusPill').classList.toggle('offline', status !== 'online');
    },
    onNeedsProvisioning: () => window.alert('Terminal key missing or rejected — sync will not work until this device is re-provisioned.')
  });

  await pullCatalog().catch(() => {}); // best-effort — offline on first launch is fine, staff grid just stays empty until it succeeds
  await renderStaffGrid();
}

// ---------------------------------------------------------------------------
// LOGIN — fully local. verifyStaffLogin() never touches the network.
// ---------------------------------------------------------------------------

async function renderStaffGrid() {
  const users = await db.users.filter((u) => u.is_active !== false).toArray();
  $('staffGrid').innerHTML = users.length
    ? users.map((u) => `
        <button type="button" class="staff-card" data-id="${u.id}">
          <span class="av">${initials(u.full_name)}</span>
          <span class="nm">${u.full_name}</span>
          <span class="rl${u.role === 'owner' ? ' owner' : ''}">${u.role}</span>
        </button>`).join('')
    : '<p style="grid-column:1/-1; text-align:center; color:#6B655A; font-size:13px;">No staff synced yet — needs a connection at least once.</p>';

  $('staffGrid').querySelectorAll('.staff-card').forEach((btn) => {
    btn.addEventListener('click', () => openPinPad(users.find((u) => u.id === btn.dataset.id)));
  });
}

function openPinPad(user) {
  selectedLoginUser = user;
  pinDraft = '';
  $('staffGrid').hidden = true;
  $('pinPad').hidden = false;
  $('pinName').textContent = user.full_name;
  $('pinAv').textContent = initials(user.full_name);
  $('loginError').textContent = '';
  renderPinDots();
}

$('pinBack').addEventListener('click', () => {
  $('staffGrid').hidden = false;
  $('pinPad').hidden = true;
  selectedLoginUser = null;
});

function renderPinDots() {
  document.querySelectorAll('.pin-dots span').forEach((dot, i) => dot.classList.toggle('filled', i < pinDraft.length));
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
$('keypad').innerHTML = KEYS.map((k) => {
  if (k === 'clear') return '<button type="button" class="wide" data-key="clear">Clear</button>';
  if (k === 'back') return '<button type="button" class="wide" data-key="back">\u232b</button>';
  return `<button type="button" data-key="${k}">${k}</button>`;
}).join('');

$('keypad').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const k = btn.dataset.key;
    if (k === 'clear') pinDraft = '';
    else if (k === 'back') pinDraft = pinDraft.slice(0, -1);
    else if (pinDraft.length < 4) pinDraft += k;
    renderPinDots();
    if (pinDraft.length === 4) await attemptLogin();
  });
});

async function attemptLogin() {
  const { approved, user } = await verifyStaffLogin(selectedLoginUser.id, pinDraft);
  if (approved) {
    currentUser = user;
    await enterApp();
  } else {
    $('loginError').textContent = 'Incorrect PIN — try again.';
    pinDraft = '';
    renderPinDots();
  }
}

// ---------------------------------------------------------------------------
// APP SHELL
// ---------------------------------------------------------------------------

async function enterApp() {
  $('loginScreen').hidden = true;
  $('appShell').hidden = false;
  $('sideName').textContent = currentUser.full_name;
  $('sideRole').textContent = currentUser.role;
  $('sideAv').textContent = initials(currentUser.full_name);
  setAdminUser(currentUser);

  const terminal_id = await getTerminalId();
  const openShiftRow = await getOpenShift(terminal_id);

  if (openShiftRow) {
    currentShiftId = openShiftRow.id;
  } else {
    const openingRaw = await showPrompt('Opening cash amount:', '0');
    const opening_cash = parseFloat(openingRaw) || 0;
    currentShiftId = await openShift({ cashier_id: currentUser.id, opening_cash });
  }

  await logActivity({ actor_id: currentUser.id, shift_id: currentShiftId, event_type: 'login' });

  renderNav();
  switchView('billing');
  await renderGrid();
  renderCart();
}

function renderNav() {
  const items = NAV_ITEMS.filter((n) => n.roles.includes(currentUser.role));
  $('navItems').innerHTML = items.map((n) => `
    <button type="button" class="nav-item${n.key === activeView ? ' active' : ''}" data-view="${n.key}">${n.label}</button>
  `).join('');
  $('navItems').querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view${capitalize(view)}`; });
  $('viewTitle').textContent = NAV_ITEMS.find((n) => n.key === view)?.label ?? view;
  renderNav();

  const entry = NAV_ITEMS.find((n) => n.key === view);
  entry?.onEnter();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

$('logoutBtn').addEventListener('click', async () => {
  await logActivity({ actor_id: currentUser.id, shift_id: currentShiftId, event_type: 'logout' });
  currentUser = null;
  cart = [];
  activeView = 'billing';
  $('appShell').hidden = true;
  $('loginScreen').hidden = false;
  $('staffGrid').hidden = false;
  $('pinPad').hidden = true;
  await renderStaffGrid();
});

// ---------------------------------------------------------------------------
// BILLING — quickSelect() and searchProducts() read the LOCAL catalog only,
// same as they always have. completeSale() still doesn't allocate against
// stock_batches (flagged repeatedly) — this UI doesn't hide that, it just
// doesn't block on it either.
// ---------------------------------------------------------------------------

async function renderGrid() {
  const products = await db.products.filter((p) => p.is_active !== false).toArray();
  $('grid').innerHTML = products.length
    ? products.map((p) => `
        <button class="qkey" type="button" data-id="${p.id}">
          <span class="nm">${p.name}</span>
          <span class="pr">${peso(p.unit_price)} / ${p.unit}</span>
        </button>`).join('')
    : '<p style="color:#6B7280; font-size:13px;">No products synced yet.</p>';

  $('grid').querySelectorAll('.qkey').forEach((btn) => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, 'quick-select'));
  });
}

async function addToCart(productId, source) {
  const line = await quickSelect(productId, 1);
  if (!line) return;

  const existing = cart.find((l) => l.product_id === line.product_id);
  if (existing) {
    existing.quantity += 1;
    existing.line_total = round2(existing.unit_price_snapshot * existing.quantity);
  } else {
    cart.push(line);
  }

  await logActivity({
    actor_id: currentUser.id, shift_id: currentShiftId,
    event_type: source === 'scan' ? 'barcode_scanned' : 'item_added',
    entity_type: 'product', entity_id: productId
  });

  renderCart();
}

function renderCart() {
  $('lines').innerHTML = cart.length
    ? cart.map((line, i) => `
        <div class="line">
          <span class="nm">${line.name_snapshot}</span>
          <span class="leader"></span>
          <span class="qty">\u00d7${line.quantity}</span>
          <span class="amt">${peso(line.line_total)}</span>
          <button type="button" data-remove="${i}" aria-label="Remove">\u2715</button>
        </div>`).join('')
    : '<div class="empty-ticket">No items yet \u2014 scan, search, or tap an item.</div>';

  $('lines').querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cart.splice(Number(btn.dataset.remove), 1);
      renderCart();
    });
  });

  const subtotal = round2(cart.reduce((sum, l) => sum + l.line_total, 0));
  const vat = round2(subtotal * 0.12);
  const total = round2(subtotal + vat);

  $('subtotal').textContent = peso(subtotal);
  $('vat').textContent = peso(vat);
  $('grandTotal').textContent = peso(total);
  $('chargeBtn').disabled = cart.length === 0;
}

$('searchInput').addEventListener('input', async (e) => {
  const q = e.target.value;
  if (!q.trim()) { $('searchResults').innerHTML = ''; return; }

  const hits = await searchProducts(q);
  $('searchResults').innerHTML = hits.map((p) => `
    <button type="button" class="search-hit" data-id="${p.id}">${p.name} \u2014 ${peso(p.unit_price)}</button>
  `).join('');

  $('searchResults').querySelectorAll('.search-hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      addToCart(btn.dataset.id, 'search');
      $('searchInput').value = '';
      $('searchResults').innerHTML = '';
    });
  });
});

attachScannerListener(async (code) => {
  if (!currentUser) return; // scanner only active once logged in
  const product = await getProductByBarcode(code);
  if (product) {
    addToCart(product.id, 'scan');
  } else {
    await logActivity({ actor_id: currentUser.id, shift_id: currentShiftId, event_type: 'barcode_no_match', details: { code } });
  }
});

$('chargeBtn').addEventListener('click', async () => {
  const subtotal = round2(cart.reduce((sum, l) => sum + l.line_total, 0));
  const tax_amount = round2(subtotal * 0.12);
  const total_amount = round2(subtotal + tax_amount);

  const sale_id = await completeSale({
    cashier_id: currentUser.id,
    shift_id: currentShiftId,
    cart,
    payment_method: 'cash',
    amount_tendered: total_amount,
    tax_amount
  });

  window.alert(`Sale complete \u2014 #${sale_id.slice(0, 8)}`);
  cart = [];
  renderCart();
});

init();