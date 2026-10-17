// billing.js — the register: item grid, search, cart, checkout (cash, GCash /
// PayMaya, or credit), and the printed stock-out slip. Every sale also goes to
// the pick lists, so the stockroom gets the items ready.
//
// Not a BIR-accredited POS: the price on the shelf is the price charged (no
// VAT is added on top), and the only printout is a stock-out slip with no
// amounts on it. The store's BIR-registered invoice is issued separately.

import { db } from './local-db.js';
import { makeCartLine, findExactProduct, attachScannerListener } from './input-handler.js';
import { pullCatalog, completeSale, submitMaterialRequest, saveCustomer, flushOutbox } from './sync-worker.js';
import { session, log } from './session.js';
import {
  $, esc, peso, qty, round2, round3, icon, keepDecimal, setStatus,
  productPicker, openModal, closeModal, showPrompt, showConfirm, toast, printSlip, fmtDateTime,
} from './ui.js';

const METHOD_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', credit: 'Credit' };

let cart = [];
let categories = [];
let selectedCategory = null;
let checkoutTotal = null; // set while the checkout dialog is open
let method = 'cash';
let customer = null; // { id, name, phone } or { isNew: true, name }

const cartTotal = () => round2(cart.reduce((sum, line) => sum + line.line_total, 0));
const categoryName = (id) => categories.find((c) => c.id === id)?.name ?? 'Uncategorized';

export async function renderBilling() {
  showOrder(false);
  await pullCatalog().catch(() => {});
  categories = await db.categories.orderBy('name').toArray();
  if (selectedCategory && !categories.some((c) => c.id === selectedCategory)) selectedCategory = null;
  drawChips();
  await drawGrid();
  drawCart();
}

export function clearCart() {
  cart = [];
  drawCart();
}

// Closes checkout without asking (the till locking itself). Nothing is charged.
export function cancelCheckout() {
  if (checkoutTotal !== null) closeCheckout();
}

// ---------------------------------------------------------------------------
// Item grid and search
// ---------------------------------------------------------------------------

function drawChips() {
  $('categoryChips').innerHTML = [{ id: '', name: 'All' }, ...categories].map((c) => `
    <button type="button" class="chip${(c.id || null) === selectedCategory ? ' active' : ''}" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('');
}

// Sorted by SKU so items follow the same order as the store's price boards.
async function drawGrid() {
  const products = (await db.products
    .filter((p) => p.is_active !== false && (!selectedCategory || p.category_id === selectedCategory))
    .toArray())
    .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { numeric: true }));

  $('grid').innerHTML = products.length
    ? products.map((p) => `
        <button type="button" class="product" data-id="${esc(p.id)}">
          <span class="product-name">${esc(p.name)}</span>
          <span class="product-cat">${esc(categoryName(p.category_id))}</span>
          <span class="product-price">${peso(p.unit_price)} <small>/ ${esc(p.unit)}</small></span>
        </button>`).join('')
    : `<p class="empty">${selectedCategory ? 'No items in this category.' : 'No items on this device yet. Tap Sync now, or check the internet connection.'}</p>`;
  markTiles();
}

// Items already in the order show how many, so a tap is seen to count even
// where the order itself is out of sight (phones).
function markTiles() {
  const inOrder = new Map(cart.map((line) => [line.product_id, line.quantity]));
  $('grid').querySelectorAll('.product').forEach((tile) => {
    const n = inOrder.get(tile.dataset.id);
    if (n) tile.dataset.qty = qty(n);
    else delete tile.dataset.qty;
  });
}

$('categoryChips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  selectedCategory = chip.dataset.cat || null;
  drawChips();
  drawGrid();
});

$('grid').addEventListener('click', (e) => {
  const tile = e.target.closest('[data-id]');
  if (tile) addToCart(tile.dataset.id, 'item_added');
});

productPicker('searchInput', 'searchResults', (p) => addToCart(p.id, 'item_added'), (p) => `
  <span class="pick-main"><span>${esc(p.name)}</span><span class="pick-sub">${esc(categoryName(p.category_id))} · ${esc(p.sku)}</span></span>
  <span class="pick-price">${peso(p.unit_price)}</span>`);

attachScannerListener(async (code) => {
  if (!session.user || $('viewBilling').hidden || document.querySelector('.overlay:not([hidden])')) return;
  const product = await findExactProduct(code);
  if (product) return addToCart(product.id, 'barcode_scanned');
  toast(`No item matches barcode ${code}.`, 'error');
  log('barcode_no_match', { details: { code } });
});

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

// Adds run one after another: two quick taps on the same item (or a double
// scan) must land on one line, not race into two.
let adding = Promise.resolve();
function addToCart(productId, eventType) {
  adding = adding.then(() => addOne(productId, eventType)).catch(() => {});
  return adding;
}

async function addOne(productId, eventType) {
  const existing = cart.find((line) => line.product_id === productId);
  if (existing) {
    setQty(existing, existing.quantity + 1);
  } else {
    const line = await makeCartLine(productId);
    if (!line) return;
    cart.push(line);
    drawCart();
  }
  log(eventType, { entity_type: 'product', entity_id: productId, details: { name: existing?.name_snapshot ?? cart.at(-1)?.name_snapshot } });
}

// Quantities accept decimals: nails and similar items are sold by the kilo.
function setQty(line, value) {
  if (!line) return;
  if (!Number.isFinite(value) || value <= 0) {
    cart.splice(cart.indexOf(line), 1);
  } else {
    line.quantity = round3(value);
    line.line_total = round2(line.unit_price_snapshot * line.quantity);
  }
  drawCart();
}

function drawCart() {
  const count = cart.length;
  $('orderCount').textContent = count ? `${count} item${count === 1 ? '' : 's'}` : '';
  $('lines').innerHTML = count
    ? cart.map((line, i) => `
        <div class="line">
          <div class="line-info">
            <span class="line-name">${esc(line.name_snapshot)}</span>
            <span class="line-price">${peso(line.unit_price_snapshot)} / ${esc(line.unit_snapshot)}</span>
          </div>
          <span class="line-total">${peso(line.line_total)}</span>
          <div class="stepper">
            <button type="button" data-step="-1" data-index="${i}" aria-label="One less">${icon('minus')}</button>
            <input type="text" inputmode="decimal" value="${line.quantity}" data-index="${i}" aria-label="Quantity">
            <button type="button" data-step="1" data-index="${i}" aria-label="One more">${icon('plus')}</button>
          </div>
          <button type="button" class="icon-btn icon-btn-danger" data-remove="${i}" aria-label="Remove ${esc(line.name_snapshot)}">${icon('trash')}</button>
        </div>`).join('')
    : `<div class="order-empty">${icon('cart')}<p>No items yet</p><span>Scan, search, or tap an item to start.</span></div>`;

  const total = cartTotal();
  $('grandTotal').textContent = peso(total);
  $('chargeBtn').textContent = count ? `Charge ${peso(total)}` : 'Charge';
  $('chargeBtn').disabled = !count;
  $('sendToPickListBtn').disabled = !count;
  drawCartBar(count, total);
  markTiles();
  if (checkoutTotal !== null) drawCheckout();
}

// Phones: the order sits in a sheet that opens from a bar at the bottom of
// the screen. The bar shows the count and total and can charge straight away.
// Other screens never show either (style.css).
let barTotal = 0;
function drawCartBar(count, total) {
  $('cartBar').classList.toggle('is-empty', !count);
  $('cartBarCount').textContent = count;
  $('cartBarLabel').textContent = `${count} item${count === 1 ? '' : 's'}`;
  $('cartBarTotal').textContent = peso(total);
  $('cartBarCharge').disabled = !count;
  if (total > barTotal) { // something was added: a little nudge
    $('cartBar').classList.remove('bump');
    void $('cartBar').offsetWidth;
    $('cartBar').classList.add('bump');
  }
  barTotal = total;
  if (!count) showOrder(false);
}

function showOrder(open) {
  $('viewBilling').classList.toggle('order-open', open);
  $('cartBarOpen').setAttribute('aria-expanded', String(open));
}

$('cartBarOpen').addEventListener('click', () => showOrder(true));
$('cartBarCharge').addEventListener('click', () => $('chargeBtn').click());
$('orderCloseBtn').addEventListener('click', () => showOrder(false));
$('orderBackdrop').addEventListener('click', () => showOrder(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('viewBilling').classList.contains('order-open') && !document.querySelector('.overlay:not([hidden])')) showOrder(false);
});

$('lines').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  const remove = e.target.closest('[data-remove]');
  if (step) {
    const line = cart[Number(step.dataset.index)];
    setQty(line, line.quantity + Number(step.dataset.step));
  } else if (remove) {
    cart.splice(Number(remove.dataset.remove), 1);
    drawCart();
  }
});
$('lines').addEventListener('input', (e) => { if (e.target.matches('input')) keepDecimal(e.target); });
$('lines').addEventListener('change', (e) => {
  if (e.target.matches('input')) setQty(cart[Number(e.target.dataset.index)], Number(e.target.value));
});

// Sends the cart to the stockroom instead of charging it (bulk orders, or
// items that aren't out front). Nothing is charged.
$('sendToPickListBtn').addEventListener('click', async () => {
  if (!cart.length) return;
  const note = await showPrompt('Send to pick list', {
    message: 'The stockroom will prepare these items. Nothing is charged.',
    placeholder: 'Note for the stockroom (optional)',
    confirmLabel: 'Send',
  });
  if (note === null) return;

  try {
    await submitMaterialRequest({
      requested_by: session.user.id,
      shift_id: session.shiftId,
      items: cart.map((l) => ({ product_id: l.product_id, sku_snapshot: l.sku_snapshot, name_snapshot: l.name_snapshot, unit_snapshot: l.unit_snapshot, quantity_requested: l.quantity })),
      notes: note.trim() || null,
    });
    clearCart();
    flushOutbox().catch(() => {}); // straight to the stockroom when online
    toast('Sent to the pick list. It will sync automatically.');
  } catch (err) {
    toast(`Couldn't send it. ${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// Checkout. Nothing is recorded until Complete is pressed.
// ---------------------------------------------------------------------------

// Waits for an item still being added (a tap or scan right before Charge), so
// the checkout shows the whole order.
$('chargeBtn').addEventListener('click', async () => {
  await adding;
  if (!cart.length || checkoutTotal !== null) return;
  drawCheckout();
  $('checkoutCash').value = ''; // typed in by the cashier: what the customer actually handed over
  $('checkoutReference').value = '';
  $('creditDown').value = '';
  chooseCustomer(null);
  setMethod('cash');
  openModal('checkoutOverlay');
});

// Also redrawn when the order changes while checkout is open (a scan that was
// still being looked up), so the total shown is always the total recorded.
function drawCheckout() {
  checkoutTotal = cartTotal();
  $('checkoutLines').innerHTML = cart.map((line) => `
    <div class="summary-line">
      <div><span class="summary-name">${esc(line.name_snapshot)}</span><span class="summary-sub">${qty(line.quantity)} ${esc(line.unit_snapshot)} × ${peso(line.unit_price_snapshot)}</span></div>
      <span class="summary-amt">${peso(line.line_total)}</span>
    </div>`).join('');
  $('checkoutTotal').textContent = peso(checkoutTotal);
  refreshAmounts();
}

function setMethod(next) {
  method = next;
  $('payMethods').querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('active', b.dataset.method === method));
  $('payCash').hidden = method !== 'cash';
  $('payReference').hidden = method !== 'gcash';
  $('payCredit').hidden = method !== 'credit';
  setStatus('checkoutStatus');
  refreshAmounts();
  requestAnimationFrame(() => {
    $({ cash: 'checkoutCash', gcash: 'checkoutReference', credit: 'creditCustomerSearch' }[method]).focus();
  });
}

$('payMethods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-method]');
  if (btn) setMethod(btn.dataset.method);
});

// Change shows once cash is typed in; until then the row stays neutral.
function refreshAmounts() {
  if (checkoutTotal === null) return;
  const typed = $('checkoutCash').value.trim();
  const change = round2(Number(typed) - checkoutTotal);
  const short = typed !== '' && change < 0;
  $('checkoutChangeLabel').textContent = short ? 'Short by' : 'Change';
  $('checkoutChange').textContent = peso(typed === '' ? 0 : Math.abs(change));
  $('checkoutChangeRow').classList.toggle('short', short);
  $('checkoutChangeRow').classList.toggle('is-empty', typed === '');
  $('creditOwe').textContent = peso(Math.max(0, round2(checkoutTotal - (Number($('creditDown').value) || 0))));
}

for (const [id, row] of [['checkoutCash', 'checkoutChangeRow'], ['creditDown', 'creditOwe']]) {
  $(id).addEventListener('input', (e) => {
    keepDecimal(e.target);
    refreshAmounts();
    setStatus('checkoutStatus');
    showAboveButtons($(row).closest('.change-row'));
  });
}

// On a small phone the dialog's buttons stay pinned to the bottom of the
// screen (style.css), and the change can end up underneath them.
function showAboveButtons(el) {
  const modal = el.closest('.modal');
  const covered = el.getBoundingClientRect().bottom + 8 - modal.querySelector('.modal-actions').getBoundingClientRect().top;
  if (covered > 0) modal.scrollTop += covered;
}
for (const id of ['checkoutCash', 'checkoutReference', 'creditDown']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishSale(false);
    }
  });
}

// Credit customer: pick someone from this device's list, or type a new name.
function chooseCustomer(picked) {
  customer = picked;
  $('creditCustomerSearch').value = '';
  $('creditCustomerResults').innerHTML = '';
  $('creditCustomerSelected').textContent = picked
    ? `${picked.name}${picked.phone ? ` · ${picked.phone}` : ''}${picked.isNew ? ' (new customer)' : ''}`
    : '';
  $('creditCustomerSelected').classList.toggle('is-set', !!picked);
  $('newCustomerPhoneField').hidden = !picked?.isNew;
  $('newCustomerPhone').value = '';
}

$('creditCustomerSearch').addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  if (!query) {
    $('creditCustomerResults').innerHTML = '';
    return;
  }
  const q = query.toLowerCase();
  const matches = (await db.customers.filter((c) => c.is_active !== false
    && (c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q))).toArray())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8);
  const exact = matches.some((c) => c.name.toLowerCase() === q);

  $('creditCustomerResults').innerHTML = matches.map((c) => `
      <button type="button" class="pick" data-customer="${esc(c.id)}"><span>${esc(c.name)}</span><span class="pick-sub">${esc(c.phone ?? '')}</span></button>`).join('')
    + (exact ? '' : `<button type="button" class="pick pick-new" data-new-customer="${esc(query)}">${icon('plus')}<span>Add new customer “${esc(query)}”</span></button>`);
});

// Enter picks the only match, or starts a new customer with the typed name.
$('creditCustomerSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  e.preventDefault();
  const options = $('creditCustomerResults').querySelectorAll('[data-customer]');
  (options.length === 1 ? options[0] : $('creditCustomerResults').querySelector('[data-new-customer]'))?.click();
});

$('creditCustomerResults').addEventListener('click', async (e) => {
  const existing = e.target.closest('[data-customer]');
  const fresh = e.target.closest('[data-new-customer]');
  if (existing) chooseCustomer(await db.customers.get(existing.dataset.customer));
  else if (fresh) {
    chooseCustomer({ isNew: true, name: fresh.dataset.newCustomer });
    $('newCustomerPhone').focus();
  }
});

$('checkoutPrintBtn').addEventListener('click', () => finishSale(true));
$('checkoutDoneBtn').addEventListener('click', () => finishSale(false));
$('checkoutCloseBtn').addEventListener('click', async () => {
  const close = await showConfirm('Close checkout?', {
    message: 'The items stay in the current order. Nothing has been charged.',
    confirmLabel: 'Close',
    cancelLabel: 'Keep open',
  });
  if (close) closeCheckout();
});

function closeCheckout() {
  closeModal('checkoutOverlay');
  checkoutTotal = null;
}

// Works out what's being paid, or explains what's missing. Cash and GCash pay
// the full total, which completeSale adds up from the lines themselves.
function readPayment() {
  if (method === 'cash') {
    const typed = $('checkoutCash').value.trim();
    const tendered = Number(typed);
    if (!typed) return { error: 'Type in the cash the customer handed over.', focus: 'checkoutCash' };
    if (!(round2(tendered - checkoutTotal) >= 0)) return { error: 'Cash received is less than the total due.', focus: 'checkoutCash' };
    return { method, tendered };
  }
  if (method === 'gcash') {
    return { method, reference: $('checkoutReference').value.trim() || null };
  }
  const down = Number($('creditDown').value) || 0;
  if (!customer) return { error: 'Choose the customer, or type a new customer\'s name.', focus: 'creditCustomerSearch' };
  if (down > checkoutTotal) return { error: 'The amount paid now is more than the total. Use Cash instead.', focus: 'creditDown' };
  return { method, tendered: down || null, paid: down };
}

async function finishSale(print) {
  if (checkoutTotal === null || $('checkoutDoneBtn').disabled) return;

  const payment = readPayment();
  if (payment.error) {
    setStatus('checkoutStatus', payment.error, 'err');
    $(payment.focus).focus();
    return;
  }

  $('checkoutPrintBtn').disabled = $('checkoutDoneBtn').disabled = true;
  try {
    if (method === 'credit') {
      if (customer.isNew) {
        customer = await saveCustomer({ name: customer.name, phone: $('newCustomerPhone').value });
        log('customer_added', { entity_type: 'customer', entity_id: customer.id, details: { name: customer.name } });
      }
      payment.customer_id = customer.id;
    }

    const lines = [...cart];
    const total = checkoutTotal;
    const saleId = await completeSale({ cashier_id: session.user.id, shift_id: session.shiftId, cart: lines, payment });
    closeCheckout();
    clearCart();
    flushOutbox().catch(() => {}); // the sale and its pick list go out now when online, not on the next sync
    if (print) printSaleSlip(saleId, lines, METHOD_LABELS[method], method === 'credit' ? customer.name : null);

    const outcome = method === 'cash' ? (payment.tendered > total ? `Sale complete. Change: ${peso(payment.tendered - total)}.` : 'Sale complete.')
      : method === 'credit' ? `${peso(total - payment.paid)} added to ${customer.name}'s credit.`
      : `Sale complete. Paid by ${METHOD_LABELS[method]}.`;
    toast(`${outcome} The items are on the pick list.`); // completeSale sends them to the stockroom
  } catch (err) {
    setStatus('checkoutStatus', `Couldn't complete the sale. ${err.message}`, 'err');
  } finally {
    $('checkoutPrintBtn').disabled = $('checkoutDoneBtn').disabled = false;
  }
}

// The customer's stock-out slip. Its Ref no. matches the sale's pick list.
function printSaleSlip(saleId, lines, paymentLabel, customerName) {
  printSlip({
    title: 'Stock-out slip',
    facts: [
      ['Date', fmtDateTime(new Date())],
      ['Ref no.', saleId.slice(0, 8).toUpperCase()],
      ['Cashier', session.user.full_name],
      ['Payment', paymentLabel],
      ['Customer', customerName],
    ],
    lines: lines.map((l) => ({ quantity: l.quantity, unit: l.unit_snapshot, name: l.name_snapshot })),
    checkLabel: 'Out',
    signatures: ['Released by', 'Received by'],
    footer: 'Thank you for shopping at RRC Merchandise!',
  });
}
