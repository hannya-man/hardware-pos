// credit.js — customers who bought on credit (utang): who owes how much,
// what's behind each balance, and recording payments. Payments and customer
// edits are saved on this device first and synced, like sales.

import { recordCreditPayment, saveCustomer, flushOutbox, fetchCustomers, fetchCustomer } from './sync-worker.js';
import { session, withServerAuth, log } from './session.js';
import {
  $, esc, peso, qty, fmtDate, fmtTime, round2, keepDecimal, setStatus,
  tableMessage, renderRows, onAction, openModal, closeModal, showPrompt, toast, countTo,
} from './ui.js';

const METHOD_LABELS = { cash: 'cash', gcash: 'GCash / PayMaya' };

let customers = [];
let current = null; // the customer open in the detail dialog
let payMethod = 'cash';

export async function renderCredit() {
  tableMessage('creditTable', 'Loading…');
  await flushOutbox().catch(() => {}); // include credit sales made on this device moments ago
  try {
    const data = await withServerAuth(() => fetchCustomers());
    customers = data.customers;
    const owing = customers.filter((c) => c.owed > 0.004);
    countTo($('creditTotal'), data.total_owed);
    countTo($('creditCount'), owing.length, Math.round);
    drawCustomers();
  } catch (err) {
    tableMessage('creditTable', `Couldn't load. ${err.message}`);
  }
}

function drawCustomers() {
  const q = $('creditSearch').value.trim().toLowerCase();
  const rows = customers.filter((c) => ($('creditShowPaid').checked || c.owed > 0.004)
    && (!q || c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q)));

  renderRows('creditTable', rows, (c) => `
    <tr class="is-clickable" data-action="open" data-id="${esc(c.id)}">
      <td><span class="cell-main">${esc(c.name)}</span></td>
      <td>${esc(c.phone ?? '—')}</td>
      <td class="nowrap">${fmtDate(c.last_activity_at)}</td>
      <td class="num"><strong class="${c.owed > 0.004 ? 'text-bad' : 'text-ok'}">${c.owed > 0.004 ? peso(c.owed) : 'Paid up'}</strong></td>
      <td class="actions">${c.owed > 0.004 ? `<button type="button" class="btn btn-sm" data-action="pay" data-id="${esc(c.id)}">Record payment</button>` : ''}</td>
    </tr>`, $('creditShowPaid').checked || q ? 'No customers match.' : 'Nobody owes you anything right now.');
}

$('creditSearch').addEventListener('input', drawCustomers);
$('creditShowPaid').addEventListener('change', drawCustomers);

onAction('creditTable', {
  open: (id) => openCustomer(id),
  pay: (id) => openPayment(customers.find((c) => c.id === id)),
});

// ---------------------------------------------------------------------------
// One customer: balance and history
// ---------------------------------------------------------------------------

async function openCustomer(id) {
  try {
    const data = await withServerAuth(() => fetchCustomer(id));
    current = data.customer;
    drawCustomer(data);
    openModal('customerOverlay');
  } catch (err) {
    toast(`Couldn't open the customer. ${err.message}`, 'error');
  }
}

function drawCustomer({ customer, sales, payments }) {
  $('customerName').textContent = customer.name;
  $('customerPhone').textContent = customer.phone ?? 'No phone number';
  $('customerOwed').textContent = peso(customer.owed);
  $('customerOwed').className = customer.owed > 0.004 ? 'text-bad' : 'text-ok';
  $('customerPayBtn').hidden = customer.owed <= 0.004;

  const entries = [
    ...sales.map((s) => ({
      at: s.client_created_at,
      html: `
        <div class="history-main">
          <strong>${s.status === 'voided' ? 'Credit sale (voided)' : 'Bought on credit'}</strong>
          <span class="muted">${esc(s.items.map((i) => `${i.name_snapshot} × ${qty(i.quantity)}`).join(', '))}</span>
          <span class="muted">${fmtTime(s.client_created_at)} · ${esc(s.cashier?.full_name ?? '')}${Number(s.amount_paid) > 0 ? ` · paid ${peso(s.amount_paid)} now` : ''}</span>
        </div>
        <span class="history-amt ${s.status === 'voided' ? 'is-struck' : 'text-bad'}">+ ${peso(Number(s.total_amount) - Number(s.amount_paid ?? 0))}</span>`,
    })),
    ...payments.map((p) => ({
      at: p.client_created_at,
      html: `
        <div class="history-main">
          <strong>Paid ${esc(METHOD_LABELS[p.payment_method] ?? p.payment_method)}</strong>
          <span class="muted">${fmtTime(p.client_created_at)} · received by ${esc(p.received_by?.full_name ?? '')}${p.reference ? ` · ${esc(p.reference)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</span>
        </div>
        <span class="history-amt text-ok">− ${peso(p.amount)}</span>`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  $('customerHistory').innerHTML = entries.length
    ? entries.map((e) => `<li>${e.html}</li>`).join('')
    : '<li class="muted">No history yet.</li>';
}

$('customerPayBtn').addEventListener('click', () => openPayment(current));

$('customerEditBtn').addEventListener('click', async () => {
  const name = await showPrompt('Customer name', { value: current.name, confirmLabel: 'Next', onConfirm: (v) => (v.trim() ? null : 'Enter a name.') });
  if (name === null) return;
  const phone = await showPrompt('Phone number', { value: current.phone ?? '', placeholder: 'Optional', inputmode: 'tel', confirmLabel: 'Save' });
  if (phone === null) return;

  await saveCustomer({ id: current.id, name, phone });
  log('customer_updated', { entity_type: 'customer', entity_id: current.id, details: { name: name.trim() } });
  await flushOutbox().catch(() => {});
  toast('Customer saved.');
  closeModal('customerOverlay');
  await renderCredit();
  openCustomer(current.id);
});

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

function openPayment(customer) {
  if (!customer) return;
  current = customer;
  $('paymentFor').textContent = `${customer.name} owes ${peso(customer.owed)}.`;
  $('paymentAmount').value = ''; // typed in: what the customer actually handed over
  $('paymentReference').value = '';
  setPayMethod('cash');
  setStatus('paymentStatus');
  openModal('paymentOverlay');
}

function setPayMethod(next) {
  payMethod = next;
  $('paymentMethod').querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('active', b.dataset.method === next));
  drawPaymentChange();
}

// What the amount received does to the balance. Cash can be more than what's
// owed, like at checkout: the balance is paid off and the rest goes back as
// change, so the payment recorded is never more than the balance. A GCash or
// PayMaya transfer can't be: there's no cash at the counter to give back.
function paymentSplit() {
  const typed = $('paymentAmount').value.trim();
  const received = round2(Number(typed) || 0);
  const owed = round2(Math.max(0, Number(current?.owed) || 0));
  return {
    typed, received, owed,
    paid: round2(Math.min(received, owed)),
    change: round2(Math.max(0, received - owed)),
    left: round2(Math.max(0, owed - received)),
  };
}

function drawPaymentChange() {
  if (!current) return;
  const { typed, owed, change, left } = paymentSplit();
  const [label, amount, tone] = !typed ? ['Owes', owed, 'is-empty']
    : left > 0 ? ['Still owes', left, 'owe-row']
    : change > 0 && payMethod !== 'cash' ? ['More than owed by', change, 'short']
    : change > 0 ? ['Change', change, '']
    : ['Paid in full', null, ''];
  $('paymentChangeLabel').textContent = label;
  $('paymentChange').textContent = amount == null ? '' : peso(amount);
  $('paymentChangeRow').className = `change-row payment-change${tone ? ` ${tone}` : ''}`;
}

$('paymentMethod').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-method]');
  if (btn) setPayMethod(btn.dataset.method);
});
$('paymentAmount').addEventListener('input', (e) => {
  keepDecimal(e.target);
  drawPaymentChange();
  setStatus('paymentStatus');
});
$('paymentAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('paymentSaveBtn').click(); });

$('paymentSaveBtn').addEventListener('click', async () => {
  const { received, owed, paid, change } = paymentSplit();
  if (!(received > 0)) return setStatus('paymentStatus', 'Enter the amount received.', 'err');
  if (!(paid > 0)) return setStatus('paymentStatus', 'This customer doesn\'t owe anything.', 'err');
  if (change > 0 && payMethod !== 'cash') {
    return setStatus('paymentStatus', `A GCash / PayMaya payment can't be more than the ${peso(owed)} owed. Enter ${peso(owed)}, and send the rest back.`, 'err');
  }

  $('paymentSaveBtn').disabled = true;
  try {
    await recordCreditPayment({
      customer_id: current.id, amount: paid, payment_method: payMethod,
      reference: $('paymentReference').value.trim() || null,
      note: change > 0 ? `Cash received ${peso(received)}, change ${peso(change)}` : null,
      received_by: session.user.id, shift_id: session.shiftId,
    });
    closeModal('paymentOverlay');
    closeModal('customerOverlay');
    toast(change > 0
      ? `${peso(paid)} payment from ${current.name} saved: paid in full. Change: ${peso(change)}.`
      : `${peso(paid)} payment from ${current.name} saved.`);
    await flushOutbox().catch(() => {}); // so the balance below already includes it
    await renderCredit();
  } catch (err) {
    setStatus('paymentStatus', `Couldn't save the payment. ${err.message}`, 'err');
  } finally {
    $('paymentSaveBtn').disabled = false;
  }
});
