// inventory.js — Stock and Price List read from the same /inventory/stock
// call and just render it differently. Receive Stock writes locally first
// via the existing receiveStock() from sync-worker.js. Material Pick Lists
// and Supplier Orders (Purchase Orders) live here too. Add New Item and
// Edit Item are the newest additions — see those sections below.

import { withServerAuth, fmtTime } from './admin.js';
import {
  fetchStock, updateProduct, createProduct, fetchNextSku, fetchCategories,
  receiveStock, pullCatalog,
  fetchMaterialRequests, fulfillMaterialRequest, submitMaterialRequest,
  fetchSuppliers, createSupplier, fetchPurchaseOrders, createPurchaseOrder, receivePurchaseOrder
} from './sync-worker.js';
import { searchProducts } from './input-handler.js';
import { db } from './local-db.js';

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
const NO_MATCH_NOTE = '<p class="placeholder-note" style="padding:6px 2px;">No matches. Try Sync Now if this item should be here.</p>';

let inventoryUser = null;
export function setInventoryUser(user) { inventoryUser = user; }

// ---------------------------------------------------------------------------
// STOCK
// ---------------------------------------------------------------------------

let lastStockData = [];
let stockShowArchived = false;

export async function renderStock() {
  $('stockArchivedToggle').checked = stockShowArchived;
  $('stockArchivedToggle').onchange = (e) => { stockShowArchived = e.target.checked; loadStock(); };
  $('stockSearch').oninput = () => drawStockTable(lastStockData);
  $('receiveOpenBtn').onclick = openReceiveModal;
  $('addItemOpenBtn').onclick = openAddItemModal;

  await loadStock();
}

async function loadStock() {
  const tbody = $('stockTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    lastStockData = await withServerAuth(() => fetchStock(stockShowArchived));
    drawStockTable(lastStockData);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Couldn't load. ${err.message}</td></tr>`;
  }
}

function drawStockTable(rows) {
  const q = $('stockSearch').value.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q)) : rows;

  const tbody = $('stockTable').querySelector('tbody');
  tbody.innerHTML = filtered.length
    ? filtered.map((r) => `
        <tr class="${r.is_active ? '' : 'row-archived'}">
          <td>${r.name}<br><span class="sku-tag">${r.sku}</span></td>
          <td class="amt-cell">${r.store_good}</td>
          <td class="amt-cell">${r.warehouse_good}</td>
          <td class="amt-cell ${r.damaged > 0 ? 'variance-bad' : ''}">${r.damaged}</td>
          <td class="amt-cell ${r.low_stock ? 'variance-bad' : ''}">${r.low_stock ? 'Low' : 'OK'}</td>
          <td>${r.is_active ? 'Active' : 'Archived'}</td>
          <td>
            <button type="button" class="btn-secondary" data-edit="${r.id}">Edit</button>
            <button type="button" class="btn-secondary" data-archive="${r.id}" data-active="${r.is_active}">${r.is_active ? 'Archive' : 'Restore'}</button>
          </td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="7">No items match.</td></tr>';

  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = filtered.find((r) => r.id === btn.dataset.edit);
      if (row) openEditItemModal(row);
    });
  });

  tbody.querySelectorAll('[data-archive]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowActive = btn.dataset.active === 'true';
      if (nowActive && !window.confirm('Are you sure you want to archive this item? It will be hidden from Stock and Billing, but you can restore it later from Archives.')) {
        return;
      }
      await withServerAuth(() => updateProduct(btn.dataset.archive, { is_active: !nowActive }));
      await pullCatalog().catch(() => {}); // keep this terminal's own offline copy in step with the change right away
      await loadStock();
    });
  });
}

// ---------------------------------------------------------------------------
// EDIT ITEM — full editing from the Stock List: name, unit, price, and
// low stock alert level, not just archive/restore. Item code (SKU) and
// category aren't changed here on purpose, to keep this simple.
// ---------------------------------------------------------------------------

let editingItemId = null;

function openEditItemModal(row) {
  editingItemId = row.id;
  $('editItemName').value = row.name;
  $('editItemUnit').value = row.unit ?? 'pc';
  $('editItemPrice').value = row.unit_price;
  $('editItemReorder').value = row.reorder_level ?? 10;
  $('editItemStatus').textContent = '';
  $('editItemStatus').className = 'form-status';
  $('editItemOverlay').hidden = false;
}

$('editItemCancelBtn').addEventListener('click', () => { $('editItemOverlay').hidden = true; });

$('editItemSubmitBtn').addEventListener('click', async () => {
  const status = $('editItemStatus');
  const name = $('editItemName').value.trim();
  const unit = $('editItemUnit').value;
  const unit_price = Number($('editItemPrice').value);
  const reorder_level = Number($('editItemReorder').value) || 0;

  if (!name || !unit_price || unit_price <= 0) {
    status.textContent = 'Please fill in a name and a price above 0.';
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => updateProduct(editingItemId, { name, unit, unit_price, reorder_level }));
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
    await pullCatalog().catch(() => {});
    await loadStock();
    setTimeout(() => { $('editItemOverlay').hidden = true; }, 500);
  } catch (err) {
    status.textContent = `Couldn't save. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---------------------------------------------------------------------------
// RECEIVE STOCK
// ---------------------------------------------------------------------------

function openReceiveModal() {
  $('receiveOverlay').hidden = false;
  $('receiveProductSearch').value = '';
  $('receiveProductResults').innerHTML = '';
  $('receiveSelected').textContent = 'None selected';
  $('receiveSelected').dataset.id = '';
  $('receiveQty').value = '';
  $('receiveDamagedQty').value = '0';
  $('receiveStatus').textContent = '';
}

$('receiveCancelBtn').addEventListener('click', () => { $('receiveOverlay').hidden = true; });

$('receiveProductSearch').addEventListener('input', async (e) => {
  const query = e.target.value;
  const hits = await searchProducts(query);
  $('receiveProductResults').innerHTML = hits.length
    ? hits.map((p) => `<button type="button" class="search-hit" data-id="${p.id}" data-name="${p.name}">${p.name} (${p.sku})</button>`).join('')
    : (query.trim() ? NO_MATCH_NOTE : '');
  $('receiveProductResults').querySelectorAll('.search-hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('receiveSelected').textContent = btn.dataset.name;
      $('receiveSelected').dataset.id = btn.dataset.id;
      $('receiveProductSearch').value = '';
      $('receiveProductResults').innerHTML = '';
    });
  });
});

$('receiveSubmitBtn').addEventListener('click', async () => {
  const status = $('receiveStatus');
  const productId = $('receiveSelected').dataset.id;
  const quantity = Number($('receiveQty').value);

  if (!productId || !quantity || quantity <= 0) {
    status.textContent = 'Pick an item and enter a quantity.';
    status.className = 'form-status err';
    return;
  }

  await receiveStock({
    product_id: productId, location: $('receiveLocation').value, quantity,
    damaged_quantity: Number($('receiveDamagedQty').value) || 0, actor_id: inventoryUser.id,
  });

  status.textContent = 'Received. It will sync automatically.';
  status.className = 'form-status ok';
  await loadStock();
  setTimeout(() => { $('receiveOverlay').hidden = true; }, 700);
});

// ---------------------------------------------------------------------------
// ADD NEW ITEM — lets a manager/owner create a brand new SKU. Before this,
// the only catalog options were editing the price or archiving/restoring
// an item that already existed from the original seeded list — there was
// no way to add something new at all. Same server gate as everything else
// on this screen (manage-catalog).
//
// The item code (SKU) is suggested automatically as soon as a category
// is picked (see suggestSku below) and the barcode is generated entirely
// on the server — nobody needs to invent either one by hand. The
// suggested SKU can still be typed over if wanted.
//
// Categories come from this device's own local copy first (fast, works
// offline); if that copy is empty for any reason, it falls back to
// asking the server directly.
// ---------------------------------------------------------------------------

let lastSuggestedSku = '';

async function openAddItemModal() {
  $('addItemStatus').textContent = '';
  $('addItemStatus').className = 'form-status';
  $('addItemSku').value = '';
  lastSuggestedSku = '';
  $('addItemName').value = '';
  $('addItemPrice').value = '';
  $('addItemUnit').value = 'pc';
  $('addItemReorder').value = '10';
  $('addItemOverlay').hidden = false;
  $('addItemCategory').innerHTML = '<option value="">Loading categories...</option>';

  await pullCatalog().catch(() => {});
  let categories = await db.categories.orderBy('name').toArray();

  if (!categories.length) {
    try {
      categories = await withServerAuth(() => fetchCategories());
    } catch {
      categories = [];
    }
  }

  $('addItemCategory').innerHTML = categories.length
    ? categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')
    : '<option value="">No categories found</option>';

  if (categories.length) await suggestSku();
}

async function suggestSku() {
  const categoryId = $('addItemCategory').value;
  if (!categoryId) return;

  const currentValue = $('addItemSku').value.trim();
  if (currentValue && currentValue !== lastSuggestedSku) return; // they've typed their own code, leave it alone

  try {
    const { sku } = await withServerAuth(() => fetchNextSku(categoryId));
    $('addItemSku').value = sku;
    lastSuggestedSku = sku;
  } catch {
    // best-effort suggestion only, not required to add the item
  }
}

$('addItemCategory').addEventListener('change', suggestSku);
$('addItemCancelBtn').addEventListener('click', () => { $('addItemOverlay').hidden = true; });

$('addItemSubmitBtn').addEventListener('click', async () => {
  const status = $('addItemStatus');
  const sku = $('addItemSku').value.trim();
  const name = $('addItemName').value.trim();
  const category_id = $('addItemCategory').value;
  const unit = $('addItemUnit').value;
  const unit_price = Number($('addItemPrice').value);
  const reorder_level = Number($('addItemReorder').value) || 10;

  if (!sku || !name || !category_id || !unit_price || unit_price <= 0) {
    status.textContent = 'Please fill in the item code, name, category, and a price above 0.';
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => createProduct({ sku, name, category_id, unit, unit_price, reorder_level }));
    status.textContent = 'Item added.';
    status.className = 'form-status ok';
    await pullCatalog().catch(() => {}); // so it shows up in Billing on this device right away, not after the next background sync
    await loadStock();
    setTimeout(() => { $('addItemOverlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = `Couldn't add item. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---------------------------------------------------------------------------
// PRICE LIST — cost_price never appears here, even for owners.
// ---------------------------------------------------------------------------

let lastPriceListData = [];

export async function renderPriceList() {
  $('priceListSearch').oninput = () => drawPriceListTable(lastPriceListData);
  $('priceListPrintBtn').onclick = () => window.print();
  await loadPriceList();
}

async function loadPriceList() {
  const tbody = $('priceListTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Loading...</td></tr>';
  try {
    lastPriceListData = await withServerAuth(() => fetchStock(false));
    drawPriceListTable(lastPriceListData);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load. ${err.message}</td></tr>`;
  }
}

function drawPriceListTable(rows) {
  const q = $('priceListSearch').value.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q)) : rows;

  const tbody = $('priceListTable').querySelector('tbody');
  tbody.innerHTML = filtered.length
    ? filtered.map((r) => `
        <tr>
          <td>${r.name}<br><span class="sku-tag">${r.sku}</span></td>
          <td>${r.unit}</td>
          <td class="amt-cell price-edit" data-id="${r.id}" data-price="${r.unit_price}">${peso(r.unit_price)}</td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="3">No items match.</td></tr>';

  tbody.querySelectorAll('.price-edit').forEach((cell) => cell.addEventListener('click', () => editPrice(cell)));
}

function editPrice(cell) {
  const current = cell.dataset.price;
  cell.innerHTML = `<input type="number" step="0.01" min="0" value="${current}" class="price-input">`;
  const input = cell.querySelector('input');
  input.focus();
  input.select();

  const commit = async () => {
    const newPrice = Number(input.value);
    if (!Number.isFinite(newPrice) || newPrice < 0 || newPrice === Number(current)) {
      cell.textContent = peso(current);
      return;
    }
    cell.textContent = 'Saving...';
    try {
      await withServerAuth(() => updateProduct(cell.dataset.id, { unit_price: newPrice }));
      cell.dataset.price = newPrice;
      cell.textContent = peso(newPrice);
      await pullCatalog().catch(() => {}); // keep this terminal's own offline copy in step with the change right away
    } catch (err) {
      cell.textContent = peso(current);
      window.alert(`Couldn't update price. ${err.message}`);
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

// ---------------------------------------------------------------------------
// MATERIAL PICK LISTS — anyone on shift can build and send one (cashier
// included, matches how it's created from POS Terminal). The "submitted
// lists" table below only shows for manager/owner, since viewing goes
// through the Sanctum-gated manage-catalog endpoint; the create form above
// it is offline-first and open to everyone via submitMaterialRequest().
// ---------------------------------------------------------------------------

let mrItems = [];

export async function renderMaterialRequests() {
  mrItems = [];
  $('mrProductSearch').value = '';
  $('mrProductResults').innerHTML = '';
  $('mrNotes').value = '';
  $('mrStatus').textContent = '';
  $('mrStatus').className = 'form-status';
  drawMrItems();

  const canReview = inventoryUser?.role === 'manager' || inventoryUser?.role === 'owner';
  $('mrListCard').hidden = !canReview;
  if (canReview) {
    $('mrShowAll').onchange = () => loadMaterialRequests();
    await loadMaterialRequests();
  }
}

$('mrProductSearch').addEventListener('input', async (e) => {
  const query = e.target.value;
  const hits = await searchProducts(query);
  $('mrProductResults').innerHTML = hits.length
    ? hits.map((p) => `<button type="button" class="search-hit" data-id="${p.id}" data-name="${p.name}" data-sku="${p.sku}">${p.name} (${p.sku})</button>`).join('')
    : (query.trim() ? NO_MATCH_NOTE : '');
  $('mrProductResults').querySelectorAll('.search-hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!mrItems.find((i) => i.product_id === btn.dataset.id)) {
        mrItems.push({
          product_id: btn.dataset.id, sku_snapshot: btn.dataset.sku,
          name_snapshot: btn.dataset.name, quantity_requested: 1
        });
      }
      $('mrProductSearch').value = '';
      $('mrProductResults').innerHTML = '';
      drawMrItems();
    });
  });
});

function drawMrItems() {
  $('mrItemsList').innerHTML = mrItems.length
    ? mrItems.map((item, i) => `
        <div class="mr-item-row">
          <span class="mr-item-name">${item.name_snapshot}</span>
          <input type="number" min="0.001" step="0.001" value="${item.quantity_requested}" data-mr-qty="${i}" class="mr-item-qty">
          <button type="button" data-mr-remove="${i}" aria-label="Remove">\u2715</button>
        </div>`).join('')
    : '<p class="placeholder-note">No items added yet.</p>';

  $('mrItemsList').querySelectorAll('[data-mr-qty]').forEach((input) => {
    input.addEventListener('change', () => {
      mrItems[Number(input.dataset.mrQty)].quantity_requested = Number(input.value) || 1;
    });
  });
  $('mrItemsList').querySelectorAll('[data-mr-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mrItems.splice(Number(btn.dataset.mrRemove), 1);
      drawMrItems();
    });
  });
}

$('mrSubmitBtn').addEventListener('click', async () => {
  const status = $('mrStatus');
  if (!mrItems.length) {
    status.textContent = 'Add at least one item first.';
    status.className = 'form-status err';
    return;
  }

  await submitMaterialRequest({
    requested_by: inventoryUser.id,
    items: mrItems,
    notes: $('mrNotes').value || null,
  });

  status.textContent = 'Sent. It will sync automatically.';
  status.className = 'form-status ok';
  mrItems = [];
  drawMrItems();
  $('mrNotes').value = '';

  const canReview = inventoryUser?.role === 'manager' || inventoryUser?.role === 'owner';
  if (canReview) loadMaterialRequests();
});

async function loadMaterialRequests() {
  const tbody = $('materialRequestsTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const showAll = $('mrShowAll').checked;
    const result = await withServerAuth(() => fetchMaterialRequests(showAll ? {} : { status: 'pending' }));
    drawMaterialRequestsTable(result.data ?? result);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Couldn't load. ${err.message}</td></tr>`;
  }
}

function drawMaterialRequestsTable(requests) {
  const tbody = $('materialRequestsTable').querySelector('tbody');
  tbody.innerHTML = requests.length
    ? requests.map((r) => `
        <tr class="${r.status === 'fulfilled' ? 'row-archived' : ''}">
          <td>${fmtTime(r.client_created_at)}</td>
          <td>${r.requested_by?.full_name ?? '-'}</td>
          <td>${r.items.map((i) => `${i.name_snapshot} \u00d7${i.quantity_requested}`).join('<br>')}</td>
          <td>${r.notes ?? ''}</td>
          <td>${r.status === 'pending'
            ? `<button type="button" class="btn-secondary" data-fulfill="${r.id}">Mark Sent</button>`
            : 'Sent'}</td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="5">Nothing pending.</td></tr>';

  tbody.querySelectorAll('[data-fulfill]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await withServerAuth(() => fulfillMaterialRequest(btn.dataset.fulfill));
      loadMaterialRequests();
    });
  });
}

// ---------------------------------------------------------------------------
// SUPPLIER ORDERS (Purchase Orders) — manager+owner. Not offline: created
// directly through Sanctum, since placing an order is a purchasing
// decision, not routine cashier work — the same trade-off Returns and
// Reconciliation already accepted.
// ---------------------------------------------------------------------------

let poItems = [];
let supplierCache = [];

export async function renderPurchaseOrders() {
  $('poOpenCreateBtn').onclick = openPoModal;
  await loadPurchaseOrders();
}

async function loadPurchaseOrders() {
  const tbody = $('purchaseOrdersTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const result = await withServerAuth(() => fetchPurchaseOrders());
    drawPurchaseOrdersTable(result.data ?? result);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Couldn't load. ${err.message}</td></tr>`;
  }
}

function drawPurchaseOrdersTable(pos) {
  const tbody = $('purchaseOrdersTable').querySelector('tbody');
  tbody.innerHTML = pos.length
    ? pos.map((po) => `
        <tr class="${po.status !== 'pending' ? 'row-archived' : ''}">
          <td>${po.po_number}</td>
          <td>${po.supplier?.name ?? '-'}</td>
          <td>${po.items.map((i) => `${i.name_snapshot} \u00d7${i.quantity_ordered}`).join('<br>')}</td>
          <td>${po.status}</td>
          <td>${po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-PH') : '-'}</td>
          <td>${po.status === 'pending'
            ? `<button type="button" class="btn-secondary" data-receive-po="${po.id}">Mark Received</button>`
            : ''}</td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="6">No purchase orders yet.</td></tr>';

  tbody.querySelectorAll('[data-receive-po]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Mark this PO as fully received? This adds the ordered quantities to Store stock.')) return;
      await withServerAuth(() => receivePurchaseOrder(btn.dataset.receivePo));
      loadPurchaseOrders();
    });
  });
}

async function openPoModal() {
  poItems = [];
  $('poItemsList').innerHTML = '';
  $('poProductSearch').value = '';
  $('poProductResults').innerHTML = '';
  $('poExpectedDate').value = '';
  $('poNotes').value = '';
  $('poCreateStatus').textContent = '';
  $('poNewSupplierFields').hidden = true;

  $('poSupplierSelect').innerHTML = '<option value="">Loading suppliers...</option>';
  $('poCreateOverlay').hidden = false;

  try {
    supplierCache = await withServerAuth(() => fetchSuppliers());
    drawSupplierOptions();
  } catch (err) {
    $('poSupplierSelect').innerHTML = '<option value="">Could not load suppliers</option>';
  }
}

function drawSupplierOptions() {
  $('poSupplierSelect').innerHTML = '<option value="">Select a supplier...</option>' +
    supplierCache.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
}

$('poCancelBtn').addEventListener('click', () => { $('poCreateOverlay').hidden = true; });

$('poNewSupplierToggle').addEventListener('click', () => {
  $('poNewSupplierFields').hidden = !$('poNewSupplierFields').hidden;
});

$('poNewSupplierSave').addEventListener('click', async () => {
  const name = $('poNewSupplierName').value.trim();
  if (!name) return;

  const supplier = await withServerAuth(() => createSupplier({
    name, phone: $('poNewSupplierPhone').value.trim() || null
  }));
  supplierCache.push(supplier);
  drawSupplierOptions();
  $('poSupplierSelect').value = supplier.id;
  $('poNewSupplierFields').hidden = true;
  $('poNewSupplierName').value = '';
  $('poNewSupplierPhone').value = '';
});

$('poProductSearch').addEventListener('input', async (e) => {
  const query = e.target.value;
  const hits = await searchProducts(query);
  $('poProductResults').innerHTML = hits.length
    ? hits.map((p) => `<button type="button" class="search-hit" data-id="${p.id}" data-name="${p.name}" data-sku="${p.sku}">${p.name} (${p.sku})</button>`).join('')
    : (query.trim() ? NO_MATCH_NOTE : '');
  $('poProductResults').querySelectorAll('.search-hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!poItems.find((i) => i.product_id === btn.dataset.id)) {
        poItems.push({
          product_id: btn.dataset.id, sku_snapshot: btn.dataset.sku,
          name_snapshot: btn.dataset.name, quantity_ordered: 1, unit_cost: 0
        });
      }
      $('poProductSearch').value = '';
      $('poProductResults').innerHTML = '';
      drawPoItems();
    });
  });
});

function drawPoItems() {
  $('poItemsList').innerHTML = poItems.length
    ? poItems.map((item, i) => `
        <div class="mr-item-row">
          <span class="mr-item-name">${item.name_snapshot}</span>
          <input type="number" min="0.001" step="0.001" value="${item.quantity_ordered}" data-po-qty="${i}" class="mr-item-qty" title="Quantity">
          <input type="number" min="0" step="0.01" value="${item.unit_cost}" data-po-cost="${i}" class="mr-item-qty" title="Unit cost">
          <button type="button" data-po-remove="${i}" aria-label="Remove">\u2715</button>
        </div>`).join('')
    : '<p class="placeholder-note">No items added yet.</p>';

  $('poItemsList').querySelectorAll('[data-po-qty]').forEach((input) => {
    input.addEventListener('change', () => { poItems[Number(input.dataset.poQty)].quantity_ordered = Number(input.value) || 1; });
  });
  $('poItemsList').querySelectorAll('[data-po-cost]').forEach((input) => {
    input.addEventListener('change', () => { poItems[Number(input.dataset.poCost)].unit_cost = Number(input.value) || 0; });
  });
  $('poItemsList').querySelectorAll('[data-po-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { poItems.splice(Number(btn.dataset.poRemove), 1); drawPoItems(); });
  });
}

$('poSubmitBtn').addEventListener('click', async () => {
  const status = $('poCreateStatus');
  const supplierId = $('poSupplierSelect').value;

  if (!supplierId) {
    status.textContent = 'Pick a supplier first.';
    status.className = 'form-status err';
    return;
  }
  if (!poItems.length) {
    status.textContent = 'Add at least one item.';
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => createPurchaseOrder({
      supplier_id: supplierId,
      items: poItems,
      expected_date: $('poExpectedDate').value || null,
      notes: $('poNotes').value || null,
    }));
    status.textContent = 'Purchase order created.';
    status.className = 'form-status ok';
    await loadPurchaseOrders();
    setTimeout(() => { $('poCreateOverlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = `Failed. ${err.message}`;
    status.className = 'form-status err';
  }
});
