// main.js — the real app, replacing the test script from earlier. Every
// function called here (verifyStaffLogin, searchProducts, completeSale,
// etc.) is the actual offline-first logic already built, not mock data.

import { db, getTerminalId, isProvisioned, setTerminalKey, getOpenShift } from './local-db.js';
import { verifyStaffLogin, searchProducts, quickSelect, attachScannerListener, getProductByBarcode } from './input-handler.js';
import { startSyncWorker, pullCatalog, forceFullSync, flushOutbox, completeSale, openShift, logActivity } from './sync-worker.js';
import {
  setAdminUser, renderActivity, renderShifts, renderVoid, renderReturns,
  renderReconciliation, renderAnalytics, renderStaff, renderArchives
} from './admin.js';
import { renderDashboard } from './dashboard.js';
import { renderStock, renderPriceList, renderMaterialRequests, renderPurchaseOrders, setInventoryUser } from './inventory.js';
import { printReceipt } from './receipt.js';

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
//
// Grouped items (inventory, sales, staffGroup) render as a collapsible
// section in the sidebar; their `children` are the actual clickable
// leaves. Only leaves have onEnter / a matching view div — groups are
// just a visual container and are never passed to switchView().
//
// billing's onEnter pulls the latest catalog before drawing the grid —
// this covers the common case (a stale local copy). If a device's local
// copy is missing something more stubbornly, that's what the Sync Now
// button (see doManualSync below) is for.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['manager', 'owner'], onEnter: renderDashboard },
  {
    key: 'posTerminal', label: 'POS Terminal', roles: ['cashier', 'manager', 'owner'],
    children: [
      { key: 'billing', label: 'Billing & Checkout', roles: ['cashier', 'manager', 'owner'], onEnter: async () => { await pullCatalog().catch(() => {}); await renderGrid(); } },
      { key: 'materialRequests', label: 'Material Pick Lists', roles: ['cashier', 'manager', 'owner'], onEnter: renderMaterialRequests },
    ],
  },
  {
    key: 'inventory', label: 'Inventory', roles: ['manager', 'owner'],
    children: [
      { key: 'stock', label: 'Stock List', roles: ['manager', 'owner'], onEnter: renderStock },
      { key: 'reconciliation', label: 'Stock Audits', roles: ['owner'], onEnter: renderReconciliation },
      { key: 'purchaseOrders', label: 'Supplier Orders', roles: ['manager', 'owner'], onEnter: renderPurchaseOrders },
      { key: 'priceList', label: 'Price List', roles: ['manager', 'owner'], onEnter: renderPriceList },
    ],
  },
  {
    key: 'sales', label: 'Sales', roles: ['manager', 'owner'],
    children: [
      { key: 'salesOrders', label: 'Order History', roles: ['manager', 'owner'], onEnter: renderShifts },
      { key: 'analytics', label: 'Fast & Slow Items', roles: ['owner'], onEnter: renderAnalytics },
      { key: 'returns', label: 'Tool Returns', roles: ['owner'], onEnter: renderReturns },
      { key: 'void', label: 'Cancelled Sales', roles: ['manager', 'owner'], onEnter: renderVoid },
    ],
  },
  {
    key: 'staffGroup', label: 'Security & Logs', roles: ['manager', 'owner'],
    children: [
      { key: 'activity', label: 'Staff Logs', roles: ['owner'], onEnter: renderActivity },
      { key: 'staff', label: 'User Roles & Access', roles: ['manager', 'owner'], onEnter: renderStaff },
    ],
  },
  { key: 'archives', label: 'Archives', roles: ['manager', 'owner'], onEnter: renderArchives },
];

let currentUser = null;
let currentShiftId = null;
let cart = [];
let selectedLoginUser = null;
let pinDraft = '';
let activeView = 'billing';
let expandedGroups = new Set();

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
      $('statusLabel').textContent = status === 'online' ? 'Active' : 'Inactive';
      $('statusPill').classList.toggle('offline', status !== 'online');
    },
    onNeedsProvisioning: () => window.alert('Terminal key missing or rejected. Sync will not work until this device is re-provisioned.')
  });

  await pullCatalog().catch(() => {}); // best-effort — offline on first launch is fine, staff grid just stays empty until it succeeds

  // Safety net: if this device only knows about one staff member (or
  // none) locally, that's almost always a stale or incomplete first sync
  // rather than the true state of things, so start over completely, just
  // this once, automatically. Harmless if there really is only one
  // account so far — it just means one extra full check.
  const userCount = await db.users.count();
  if (userCount <= 1) {
    await forceFullSync().catch(() => {});
  }

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
    : '<p style="grid-column:1/-1; text-align:center; color:#6B655A; font-size:13px;">No staff found yet. Tap "Sync Now" below to check again.</p>';

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
    $('loginError').textContent = 'Incorrect PIN. Try again.';
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
  setInventoryUser(currentUser);

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

function flattenLeaves(items) {
  return items.flatMap((item) => (item.children ? flattenLeaves(item.children) : [item]));
}

function findLeaf(key) {
  return flattenLeaves(NAV_ITEMS).find((item) => item.key === key);
}

function findParentGroup(key) {
  return NAV_ITEMS.find((item) => item.children?.some((c) => c.key === key));
}

function renderNav() {
  $('navItems').innerHTML = NAV_ITEMS
    .filter((item) => item.roles.includes(currentUser.role))
    .map((item) => {
      if (!item.children) {
        return `<button type="button" class="nav-item${item.key === activeView ? ' active' : ''}" data-view="${item.key}">${item.label}</button>`;
      }
      const visibleChildren = item.children.filter((c) => c.roles.includes(currentUser.role));
      if (!visibleChildren.length) return '';
      const isOpen = expandedGroups.has(item.key);
      return `
        <div class="nav-group${isOpen ? ' open' : ''}" data-group-key="${item.key}">
          <button type="button" class="nav-group-header" data-group="${item.key}">
            <span>${item.label}</span>
            <span class="nav-chevron">&#9662;</span>
          </button>
          <div class="nav-group-children">
            ${visibleChildren.map((c) => `
              <button type="button" class="nav-item nav-item-child${c.key === activeView ? ' active' : ''}" data-view="${c.key}">${c.label}</button>
            `).join('')}
          </div>
        </div>`;
    }).join('');

  $('navItems').querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  $('navItems').querySelectorAll('[data-group]').forEach((btn) => {
    btn.addEventListener('click', () => toggleGroup(btn.dataset.group));
  });
}

function toggleGroup(key) {
  const groupEl = document.querySelector(`.nav-group[data-group-key="${key}"]`);
  if (!groupEl) return;
  const isOpen = groupEl.classList.toggle('open');
  if (isOpen) expandedGroups.add(key); else expandedGroups.delete(key);
}

function switchView(view) {
  activeView = view;
  const parent = findParentGroup(view);
  if (parent) expandedGroups.add(parent.key);

  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view${capitalize(view)}`; });
  const entry = findLeaf(view);
  $('viewTitle').textContent = entry?.label ?? view;
  renderNav();
  entry?.onEnter?.();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

$('logoutBtn').addEventListener('click', async () => {
  await logActivity({ actor_id: currentUser.id, shift_id: currentShiftId, event_type: 'logout' });
  currentUser = null;
  cart = [];
  activeView = 'billing';
  expandedGroups.clear();
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
    : `<div class="empty-ticket" style="grid-column:1/-1;">
         No items are loaded on this device yet.<br>
         Tap "Sync Now" at the top of the screen, or check that this device has internet.
       </div>`;

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
    : '<div class="empty-ticket">No items yet. Scan, search, or tap an item.</div>';

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
  $('searchResults').innerHTML = hits.length
    ? hits.map((p) => `<button type="button" class="search-hit" data-id="${p.id}">${p.name} (${peso(p.unit_price)})</button>`).join('')
    : '<p class="placeholder-note" style="padding:6px 2px;">No matches.</p>';

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
  const soldItems = [...cart];

  const sale_id = await completeSale({
    cashier_id: currentUser.id,
    shift_id: currentShiftId,
    cart,
    payment_method: 'cash',
    amount_tendered: total_amount,
    tax_amount
  });

  printReceipt({
    saleId: sale_id,
    cashierName: currentUser.full_name,
    cart: soldItems,
    subtotal, taxAmount: tax_amount, totalAmount: total_amount,
    paymentMethod: 'cash', amountTendered: total_amount, changeAmount: 0
  });

  cart = [];
  renderCart();
});

// ---------------------------------------------------------------------------
// MANUAL SYNC — the Sync Now button. Unlike the quiet, incremental pulls
// that happen automatically, this always starts the catalog copy over
// from scratch (forceFullSync) and says plainly what happened afterward,
// so tapping it gives a real answer instead of just spinning silently.
// Works from the login screen too, before anyone's signed in.
// ---------------------------------------------------------------------------

async function doManualSync() {
  const buttons = [$('syncNowBtn'), $('syncNowLoginBtn')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Syncing...'; });

  try {
    await flushOutbox();
    const ok = await forceFullSync();

    if (!ok) {
      window.alert("Could not reach the server. Check that this device has internet, and that it has been set up with its one-time key.");
    } else {
      const productCount = await db.products.count();
      const userCount = await db.users.count();
      window.alert(`Synced. This device now has ${productCount} item(s) and ${userCount} staff account(s).`);
    }

    if (currentUser) {
      await findLeaf(activeView)?.onEnter?.();
    } else {
      await renderStaffGrid();
    }
  } catch {
    window.alert('Could not sync right now. Check the internet connection and try again.');
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.textContent = 'Sync Now'; });
  }
}

$('syncNowBtn')?.addEventListener('click', doManualSync);
$('syncNowLoginBtn')?.addEventListener('click', doManualSync);

init();
