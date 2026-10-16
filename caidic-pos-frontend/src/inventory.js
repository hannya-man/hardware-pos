// inventory.js — the Stock screen (counts and value in the store and the
// warehouse, new items, edits, deliveries, the printable price list) and
// material pick lists.

import { db } from './local-db.js';
import {
  fetchStock, updateProduct, createProduct, fetchNextSku, fetchCategories,
  receiveStock, submitMaterialRequest, pullCatalog, flushOutbox,
  fetchMaterialRequests, fulfillMaterialRequest,
} from './sync-worker.js';
import { session, withServerAuth, log, connectToServer } from './session.js';
import {
  $, esc, peso, qty, round2, fmtTime, badge, icon, keepDecimal, setStatus, showSelected,
  tableMessage, renderRows, onAction, openModal, closeModal, productPicker, showConfirm, toast, printOnly, countTo,
  printSlip, fmtDateTime,
} from './ui.js';

const UNITS = [['pc', 'piece (pc)'], ['bag', 'bag'], ['sheet', 'sheet'], ['roll', 'roll'], ['kg', 'kilo (kg)'], ['ft', 'foot (ft)']];
for (const id of ['addItemUnit', 'editItemUnit']) {
  $(id).innerHTML = UNITS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
}

const refreshCatalog = () => pullCatalog().catch(() => {}); // keep this terminal's offline copy in step
const pushNow = () => flushOutbox().catch(() => {}); // so server lists include what was just saved here
const numberOr = (id, fallback) => ($(id).value.trim() === '' ? fallback : Number($(id).value));

// ---------------------------------------------------------------------------
// STOCK
// ---------------------------------------------------------------------------

let stockRows = [];
let categories = [];

const totalQty = (r) => r.store_good + r.warehouse_good;
const value = (r, quantity) => round2(quantity * Number(r.unit_price));

export async function renderStock() {
  categories = await db.categories.orderBy('name').toArray();
  const chosen = $('stockCategory').value;
  $('stockCategory').innerHTML = '<option value="">All categories</option>'
    + categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('stockCategory').value = chosen;
  await loadStock();
}

async function loadStock() {
  tableMessage('stockTable', 'Loading…');
  try {
    stockRows = await withServerAuth(() => fetchStock($('stockArchivedToggle').checked));
    const active = stockRows.filter((r) => r.is_active);
    const store = active.reduce((sum, r) => sum + value(r, r.store_good), 0);
    const warehouse = active.reduce((sum, r) => sum + value(r, r.warehouse_good), 0);
    countTo($('stockStoreValue'), store);
    countTo($('stockWarehouseValue'), warehouse);
    countTo($('stockTotalValue'), store + warehouse);
    drawStock();
  } catch (err) {
    tableMessage('stockTable', `Couldn't load. ${err.message}`);
  }
}

function stockBadge(r) {
  if (!r.is_active) return badge('Archived');
  if (totalQty(r) <= 0) return badge('Out of stock', 'bad');
  return r.low_stock ? badge('Low stock', 'warn') : badge('In stock', 'ok');
}

function drawStock() {
  const q = $('stockSearch').value.trim().toLowerCase();
  const category = $('stockCategory').value;
  const lowOnly = $('stockLowOnly').checked;
  const rows = stockRows.filter((r) => (!q || r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q))
    && (!category || r.category_id === category)
    && (!lowOnly || (r.is_active && r.low_stock)));

  renderRows('stockTable', rows, (r) => `
    <tr class="${r.is_active ? '' : 'is-muted'}">
      <td>
        <span class="cell-main">${esc(r.name)}</span>
        <span class="cell-sub">${esc(r.sku)}${r.damaged > 0 ? ` · <span class="text-bad">${qty(r.damaged)} damaged</span>` : ''}</span>
      </td>
      <td class="num">${peso(r.unit_price)}<span class="cell-sub">per ${esc(r.unit)}</span></td>
      <td class="num">${qty(r.store_good)}</td>
      <td class="num">${qty(r.warehouse_good)}</td>
      <td class="num">${peso(value(r, totalQty(r)))}</td>
      <td>${stockBadge(r)}</td>
      <td class="actions">${r.is_active
        ? `<button type="button" class="btn btn-sm" data-action="edit" data-id="${esc(r.id)}">Edit</button>`
        : `<button type="button" class="btn btn-sm" data-action="restore" data-id="${esc(r.id)}">Restore</button>`}</td>
    </tr>`, lowOnly ? 'Nothing is low on stock.' : 'No items match.');
}

$('stockSearch').addEventListener('input', drawStock);
for (const id of ['stockCategory', 'stockLowOnly']) $(id).addEventListener('change', drawStock);
$('stockArchivedToggle').addEventListener('change', loadStock);

onAction('stockTable', {
  edit: (id) => openEditItem(stockRows.find((r) => r.id === id)),
  restore: async (id) => {
    try {
      await withServerAuth(() => updateProduct(id, { is_active: true }));
      toast('Item restored. It can be sold again.');
      await refreshCatalog();
      await loadStock();
    } catch (err) {
      toast(`Couldn't restore the item. ${err.message}`, 'error');
    }
  },
});

// ---------------------------------------------------------------------------
// EDIT ITEM: details and the store / warehouse counts in one save. Only the
// counts that were actually changed are sent, so a sale made meanwhile isn't
// overwritten by the number that was on screen.
// ---------------------------------------------------------------------------

let editing = null;

function openEditItem(row) {
  if (!row) return;
  editing = row;
  if (![...$('editItemUnit').options].some((o) => o.value === row.unit)) {
    $('editItemUnit').add(new Option(row.unit, row.unit)); // keep an unlisted unit instead of overwriting it
  }
  $('editItemSku').textContent = row.sku;
  $('editItemName').value = row.name;
  $('editItemUnit').value = row.unit;
  $('editItemPrice').value = Number(row.unit_price);
  $('editItemStoreQty').value = row.store_good;
  $('editItemWarehouseQty').value = row.warehouse_good;
  $('editItemReorder').value = Number(row.reorder_level ?? 10);
  setStatus('editItemStatus');
  openModal('editItemOverlay');
}

$('editItemSubmitBtn').addEventListener('click', async () => {
  const name = $('editItemName').value.trim();
  const unit_price = Number($('editItemPrice').value);
  const store = numberOr('editItemStoreQty', editing.store_good);
  const warehouse = numberOr('editItemWarehouseQty', editing.warehouse_good);
  if (!name || !(unit_price > 0)) return setStatus('editItemStatus', 'Enter a name and a price above 0.', 'err');
  if (!(store >= 0) || !(warehouse >= 0)) return setStatus('editItemStatus', 'Counts can’t be below 0.', 'err');

  const payload = { name, unit: $('editItemUnit').value, unit_price, reorder_level: numberOr('editItemReorder', 0) };
  if (store !== editing.store_good) payload.store_qty = store;
  if (warehouse !== editing.warehouse_good) payload.warehouse_qty = warehouse;

  try {
    await withServerAuth(() => updateProduct(editing.id, payload));
    closeModal('editItemOverlay');
    toast(`${name} saved.`);
    await refreshCatalog();
    await loadStock();
  } catch (err) {
    setStatus('editItemStatus', `Couldn't save. ${err.message}`, 'err');
  }
});

$('editItemArchiveBtn').addEventListener('click', async () => {
  const yes = await showConfirm('Archive this item?', {
    message: `${editing.name} will be hidden from selling and from the stock list. Turn on “Show archived” to restore it later.`,
    confirmLabel: 'Archive',
    danger: true,
  });
  if (!yes) return;
  try {
    await withServerAuth(() => updateProduct(editing.id, { is_active: false }));
    closeModal('editItemOverlay');
    toast(`${editing.name} archived.`);
    await refreshCatalog();
    await loadStock();
  } catch (err) {
    setStatus('editItemStatus', `Couldn't archive. ${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// NEW ITEM, with its starting counts. The SKU is suggested from the category
// (and can be typed over); the barcode is generated on the server.
// ---------------------------------------------------------------------------

let lastSuggestedSku = '';

$('addItemOpenBtn').addEventListener('click', async () => {
  for (const id of ['addItemSku', 'addItemName', 'addItemPrice']) $(id).value = '';
  $('addItemStoreQty').value = $('addItemWarehouseQty').value = '0';
  $('addItemUnit').value = 'pc';
  $('addItemReorder').value = '10';
  lastSuggestedSku = '';
  setStatus('addItemStatus');
  $('addItemCategory').innerHTML = categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
    || '<option value="">Loading categories…</option>';
  openModal('addItemOverlay');

  if (!categories.length) {
    categories = await withServerAuth(() => fetchCategories()).catch(() => []);
    $('addItemCategory').innerHTML = categories.length
      ? categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
      : '<option value="">No categories found</option>';
  }
  suggestSku();
});

async function suggestSku() {
  const categoryId = $('addItemCategory').value;
  const current = $('addItemSku').value.trim();
  if (!categoryId || (current && current !== lastSuggestedSku)) return; // keep a code they typed themselves
  try {
    const { sku } = await withServerAuth(() => fetchNextSku(categoryId));
    $('addItemSku').value = lastSuggestedSku = sku;
  } catch { /* only a suggestion */ }
}

$('addItemCategory').addEventListener('change', suggestSku);

$('addItemSubmitBtn').addEventListener('click', async () => {
  const payload = {
    sku: $('addItemSku').value.trim(),
    name: $('addItemName').value.trim(),
    category_id: $('addItemCategory').value,
    unit: $('addItemUnit').value,
    unit_price: Number($('addItemPrice').value),
    store_qty: numberOr('addItemStoreQty', 0),
    warehouse_qty: numberOr('addItemWarehouseQty', 0),
    reorder_level: numberOr('addItemReorder', 10),
  };
  if (!payload.name || !payload.category_id || !payload.sku || !(payload.unit_price > 0)) {
    return setStatus('addItemStatus', 'Fill in the name, category, item code, and a price above 0.', 'err');
  }
  if (!(payload.store_qty >= 0) || !(payload.warehouse_qty >= 0)) return setStatus('addItemStatus', 'Counts can’t be below 0.', 'err');

  try {
    await withServerAuth(() => createProduct(payload));
    closeModal('addItemOverlay');
    toast(`${payload.name} added.`);
    await refreshCatalog(); // so it can be sold on this device right away
    await loadStock();
  } catch (err) {
    setStatus('addItemStatus', `Couldn't add the item. ${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// ADD DELIVERY: adds received stock to the store or the warehouse. Saved on
// this device first and synced through the outbox.
// ---------------------------------------------------------------------------

let deliveryProduct = null;
let deliveryLocation = 'store';
const deliveryPicker = productPicker('receiveProductSearch', 'receiveProductResults', (p) => {
  deliveryProduct = p;
  showSelected('receiveSelected', p);
  $('receiveQty').focus();
});

function setDeliveryLocation(next) {
  deliveryLocation = next;
  $('receiveLocation').querySelectorAll('[data-location]').forEach((b) => b.classList.toggle('active', b.dataset.location === next));
}

$('receiveLocation').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-location]');
  if (btn) setDeliveryLocation(btn.dataset.location);
});

$('receiveOpenBtn').addEventListener('click', () => {
  deliveryProduct = null;
  deliveryPicker.reset();
  showSelected('receiveSelected', null);
  setDeliveryLocation('warehouse');
  $('receiveQty').value = '';
  $('receiveDamagedQty').value = '0';
  setStatus('receiveStatus');
  openModal('receiveOverlay');
});

$('receiveSubmitBtn').addEventListener('click', async () => {
  const quantity = Number($('receiveQty').value);
  const damaged = Number($('receiveDamagedQty').value) || 0;
  if (!deliveryProduct || !(quantity > 0)) return setStatus('receiveStatus', 'Pick an item and enter the quantity received.', 'err');
  if (damaged < 0 || damaged > quantity) return setStatus('receiveStatus', 'Damaged units must be between 0 and the quantity received.', 'err');

  await receiveStock({
    product_id: deliveryProduct.id, location: deliveryLocation,
    quantity, damaged_quantity: damaged, actor_id: session.user.id,
  });
  log('stock_received', { entity_type: 'product', entity_id: deliveryProduct.id, details: { name: deliveryProduct.name, quantity, location: deliveryLocation } });
  closeModal('receiveOverlay');
  toast(`Added ${qty(quantity - damaged)} ${deliveryProduct.unit} of ${deliveryProduct.name} to the ${deliveryLocation}.`);
  await pushNow();
  await loadStock();
});

// ---------------------------------------------------------------------------
// PRICE LIST, printed from the Stock screen (cost prices never appear).
// ---------------------------------------------------------------------------

$('priceListPrintBtn').addEventListener('click', async () => {
  const products = (await db.products.filter((p) => p.is_active !== false).toArray())
    .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));
  const byCategory = {};
  for (const p of products) (byCategory[p.category_id] ??= []).push(p);
  const today = new Date().toLocaleDateString('en-PH', { dateStyle: 'long' });

  $('priceListPrint').innerHTML = `
    <h1>RRC Merchandise · Price list</h1>
    <p>${esc(today)}</p>
    ${categories.filter((c) => byCategory[c.id]).map((c) => `
      <h2>${esc(c.name)}</h2>
      <table>${byCategory[c.id].map((p) => `
        <tr><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${peso(p.unit_price)}</td></tr>`).join('')}
      </table>`).join('')}`;
  printOnly('priceListPrint');
});

// ---------------------------------------------------------------------------
// Picked-items editor for pick lists
// ---------------------------------------------------------------------------

function itemEditor(containerId, fields) {
  let items = [];
  const container = $(containerId);

  const draw = () => {
    container.innerHTML = items.length ? `
      <div class="item-row item-row-head"><span class="item-name">Item</span>${fields.map((f) => `<span class="item-field">${f.label}</span>`).join('')}<span class="icon-btn-space"></span></div>
      ${items.map((item, i) => `
        <div class="item-row">
          <span class="item-name">${esc(item.name_snapshot)}</span>
          ${fields.map((f) => `<input type="text" inputmode="decimal" class="input input-sm item-field" value="${item[f.key]}" data-index="${i}" data-key="${f.key}" aria-label="${f.label}">`).join('')}
          <button type="button" class="icon-btn icon-btn-danger" data-remove="${i}" aria-label="Remove">${icon('close')}</button>
        </div>`).join('')}` : '';
  };

  container.addEventListener('input', (e) => { if (e.target.dataset.key) keepDecimal(e.target); });
  container.addEventListener('change', (e) => {
    const { key, index } = e.target.dataset;
    if (!key) return;
    const field = fields.find((f) => f.key === key);
    items[Number(index)][key] = Number(e.target.value) || field.fallback;
    e.target.value = items[Number(index)][key];
  });
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    items.splice(Number(btn.dataset.remove), 1);
    draw();
  });

  return {
    get items() { return items; },
    add(p, defaults) {
      if (!items.some((i) => i.product_id === p.id)) items.push({ product_id: p.id, sku_snapshot: p.sku, name_snapshot: p.name, unit_snapshot: p.unit, ...defaults });
      draw();
    },
    clear() { items = []; draw(); },
  };
}

// ---------------------------------------------------------------------------
// PICK LISTS: what the stockroom has to get ready. Every sale lands here on
// its own (completeSale, with the slip's Ref no.), and a list can also be sent
// without charging. Everyone sees them, and while the screen is open it
// checks for new ones every 10 seconds.
// ---------------------------------------------------------------------------

const PAY_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', bank: 'Bank transfer', credit: 'Credit' };
const mrList = itemEditor('mrItemsList', [{ key: 'quantity_requested', label: 'Qty', fallback: 1 }]);
productPicker('mrProductSearch', 'mrProductResults', (p) => mrList.add(p, { quantity_requested: 1 }));

let pickLists = [];
let shownLists = ''; // what's on screen, so a check that finds nothing new leaves it alone
let listTimer = null;

export async function renderMaterialRequests() {
  mrList.clear();
  $('mrNotes').value = '';
  setStatus('mrStatus');
  shownLists = '';
  await pushNow();
  await loadMaterialRequests();

  clearInterval(listTimer);
  listTimer = setInterval(() => {
    if ($('viewMaterialRequests').hidden || $('appShell').hidden || !session.user) return clearInterval(listTimer);
    pushNow().then(() => loadMaterialRequests(true));
  }, 10_000);
}

$('mrSubmitBtn').addEventListener('click', async () => {
  if (!mrList.items.length) return setStatus('mrStatus', 'Add at least one item first.', 'err');

  await submitMaterialRequest({ requested_by: session.user.id, shift_id: session.shiftId, items: mrList.items, notes: $('mrNotes').value.trim() || null });
  mrList.clear();
  $('mrNotes').value = '';
  setStatus('mrStatus');
  toast('Pick list sent. It will sync automatically.');
  await pushNow();
  await loadMaterialRequests();
});

// quiet: the 10-second check, which never asks for a password or shows errors.
async function loadMaterialRequests(quiet = false) {
  if (!quiet) tableMessage('materialRequestsTable', 'Loading…');
  const params = $('mrShowAll').checked ? {} : { status: 'pending' };
  let lists;
  try {
    const result = await (quiet ? fetchMaterialRequests(params) : withServerAuth(() => fetchMaterialRequests(params)));
    lists = result.data ?? result;
  } catch (err) {
    if (!quiet) tableMessage('materialRequestsTable', `Couldn't load. ${err.message}`);
    else if (err.name === 'AuthRequiredError') connectToServer(); // with the sign-in password; the next check uses it
    return;
  }

  const shown = lists.map((r) => `${r.id}:${r.status}:${r.sale?.status ?? ''}`).join();
  if (quiet && shown === shownLists) return;
  shownLists = shown;
  pickLists = lists;
  const waiting = lists.filter((r) => r.status === 'pending' && r.sale?.status !== 'voided').length;
  $('mrCount').textContent = waiting ? `${waiting} waiting` : '';
  renderRows('materialRequestsTable', lists, pickListRow, $('mrShowAll').checked ? 'No pick lists yet.' : 'Nothing to pick right now.');
}

function pickListRow(r) {
  const voided = r.status === 'cancelled' || r.sale?.status === 'voided';
  const by = r.requested_by?.full_name;
  const forWho = r.sale_id
    ? `<span class="cell-main">Sale ${esc(r.sale_id.slice(0, 8).toUpperCase())}</span>
       <span class="cell-sub">${esc([PAY_LABELS[r.sale?.payment_method], r.sale?.customer?.name, by].filter(Boolean).join(' · '))}</span>`
    : `<span class="cell-main">${esc(by ?? '—')}</span><span class="cell-sub">Not charged</span>`;
  const print = `<button type="button" class="btn btn-sm" data-action="print" data-id="${esc(r.id)}">${icon('print')}Print</button>`;
  const action = voided ? badge('Sale voided', 'bad')
    : r.status === 'pending' ? `${print}<button type="button" class="btn btn-sm btn-primary" data-action="fulfill" data-id="${esc(r.id)}">Mark picked up</button>`
    : `${print}${badge(`Picked up${r.fulfilled_by?.full_name ? ` · ${r.fulfilled_by.full_name}` : ''}`, 'ok')}`;
  return `
    <tr class="${r.status === 'pending' && !voided ? '' : 'is-muted'}">
      <td class="nowrap">${fmtTime(r.client_created_at)}</td>
      <td>${forWho}</td>
      <td>${r.items.map((i) => `<strong>${qty(i.quantity_requested)}${i.unit_snapshot ? ` ${esc(i.unit_snapshot)}` : ''}</strong> ${esc(i.name_snapshot)}`).join('<br>')}</td>
      <td>${esc(r.notes ?? '')}</td>
      <td class="actions">${action}</td>
    </tr>`;
}

// The stockroom's copy to pick from: what to get, ticked off as it's picked,
// signed when the customer takes it. A reprint of a finished list says when
// it was picked up.
function printPickSlip(r) {
  const ref = r.sale_id?.slice(0, 8).toUpperCase();
  printSlip({
    title: 'Pick slip',
    facts: [
      [ref ? 'Ref no.' : 'List no.', ref ?? r.id.slice(0, 8).toUpperCase()],
      ['Ordered', fmtDateTime(r.client_created_at)],
      ['Payment', ref ? PAY_LABELS[r.sale?.payment_method] : 'Not charged'],
      ['Customer', r.sale?.customer?.name],
      [ref ? 'Cashier' : 'Sent by', r.requested_by?.full_name],
      ['Picked up', r.status === 'fulfilled' ? [fmtDateTime(r.fulfilled_at), r.fulfilled_by?.full_name].filter(Boolean).join(' · ') : null],
      ['Printed', `${fmtDateTime(new Date())} · ${session.user.full_name}`],
    ],
    lines: r.items.map((i) => ({ quantity: i.quantity_requested, unit: i.unit_snapshot, name: i.name_snapshot })),
    checkLabel: 'Picked',
    note: r.notes,
    signatures: ['Picked by', 'Received by'],
    footer: ref ? "Match the Ref no. with the customer's slip before handing the items over." : 'Not charged: get these items ready.',
  });
  log('pick_slip_printed', { entity_type: 'material_request', entity_id: r.id, details: { sale_ref: ref ?? null, item_count: r.items.length } });
}

$('mrShowAll').addEventListener('change', () => loadMaterialRequests());
onAction('materialRequestsTable', {
  print: (id) => {
    const list = pickLists.find((r) => r.id === id);
    if (list) printPickSlip(list);
  },
  fulfill: async (id, btn) => {
    btn.disabled = true;
    try {
      await withServerAuth(() => fulfillMaterialRequest(id));
      toast('Marked as picked up.');
      await loadMaterialRequests();
    } catch (err) {
      toast(`Couldn't update the list. ${err.message}`, 'error');
      await loadMaterialRequests();
    }
  },
});
