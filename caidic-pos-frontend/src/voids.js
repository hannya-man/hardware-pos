// voids.js — voiding a sale takes two owners. One asks (asking counts as their
// yes) and a second approves within 10 minutes: on their own device, where an
// alert shows up for them, or at the same screen with their own password. If
// that doesn't happen in time, the sale simply stays as it was. The server
// enforces all of this; these screens only show it.

import { db } from './local-db.js';
import { requestVoid, fetchVoidRequests, fetchVoidRequest, approveVoid, approveVoidHere, rejectVoid } from './sync-worker.js';
import { session, withServerAuth, isOwner, connectToServer } from './session.js';
import { $, esc, peso, qty, fmtTime, icon, setStatus, openModal, closeModal, showPrompt, toast } from './ui.js';

const MINUTES = 10;
const PAY_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', bank: 'Bank transfer', credit: 'Credit', card: 'Card', other: 'Other' };
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const names = (list) => list.map((a) => a.full_name).join(' and ');
// Other screens (the Sales list) redraw on this.
const changed = () => window.dispatchEvent(new Event('voids-changed'));

let current = null; // the request open in the dialog
let deadline = 0; // when it lapses, on this device's clock
let ticker = null;

// ---------------------------------------------------------------------------
// Asking (from a sale on the Sales screen)
// ---------------------------------------------------------------------------

// Resolves true once the request is made (the dialog then follows it).
export async function askToVoid(sale) {
  const reason = await showPrompt('Void this sale?', {
    message: `${voidEffect(sale)}\nAnother owner has to approve it within ${MINUTES} minutes, or the sale stays as it is.`,
    placeholder: 'Reason (required)',
    confirmLabel: 'Ask for approval',
    danger: true,
    onConfirm: (value) => (value.trim() ? null : 'Enter a reason for the record.'),
  });
  if (reason === null) return false;

  try {
    const request = await withServerAuth(() => requestVoid(sale.id, reason.trim()));
    changed();
    showRequest(request);
    return true;
  } catch (err) {
    toast(`Couldn't ask for the void. ${err.message}`, 'error');
    return false;
  }
}

function voidEffect(sale) {
  return sale.payment_method === 'credit'
    ? `The items go back into stock, and ${sale.customer?.name ?? 'the customer'} no longer owes for this sale.`
    : 'The items go back into stock. Give the customer their money back if they paid.';
}

export async function openVoidRequest(id) {
  try {
    showRequest(await withServerAuth(() => fetchVoidRequest(id)));
  } catch (err) {
    toast(`Couldn't open the void request. ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// The request: who agreed so far, time left, and what this person can do
// ---------------------------------------------------------------------------

function showRequest(request) {
  draw(request);
  setStatus('voidStatus');
  openModal('voidOverlay');

  clearInterval(ticker);
  let seconds = 0;
  ticker = setInterval(() => {
    if ($('voidOverlay').hidden) return clearInterval(ticker);
    drawState();
    if (++seconds % 4 === 0 && current.status === 'pending') follow(); // approvals made on other devices
  }, 1000);
}

async function follow() {
  try {
    const fresh = await fetchVoidRequest(current.id); // in the background: never a password prompt
    if (fresh.status !== current.status) changed();
    if (!$('voidOverlay').hidden && fresh.id === current.id) draw(fresh);
  } catch { /* offline for a moment: keep counting down */ }
}

function draw(request) {
  current = request;
  deadline = Date.now() + request.seconds_left * 1000;
  const { sale } = request;
  const me = session.user?.id;
  const open = request.status === 'pending';
  const asker = request.requested_by?.id;

  $('voidTitle').textContent = `Void a ${peso(sale.total_amount)} sale`;
  $('voidFacts').innerHTML = [
    ['Sold', `${fmtTime(sale.client_created_at)} · ${sale.cashier?.full_name ?? '—'}`],
    ['Payment', sale.payment_method === 'credit' ? `Credit · ${sale.customer?.name ?? 'customer'}` : PAY_LABELS[sale.payment_method] ?? sale.payment_method],
    ['Asked by', request.requested_by?.full_name ?? '—'],
    ['Reason', request.reason],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('voidLines').innerHTML = (sale.items ?? []).map((i) => `
    <div class="summary-line">
      <div><span class="summary-name">${esc(i.name_snapshot)}</span><span class="summary-sub">${qty(i.quantity)} × ${peso(i.unit_price_snapshot)}</span></div>
      <span class="summary-amt">${peso(i.line_total)}</span>
    </div>`).join('');

  // Each yes so far, then an empty slot per yes still needed.
  const missing = open ? Math.max(0, request.approvals_needed - request.approvals.length) : 0;
  $('voidApprovals').innerHTML = [
    ...request.approvals.map((a) => `<li class="is-yes">${icon('check')}<span>${esc(a.full_name)}${a.user_id === asker ? ' <span class="muted">· asked</span>' : ''}</span></li>`),
    ...Array.from({ length: missing }, () => '<li><span class="void-slot"></span><span class="muted">Another owner</span></li>'),
  ].join('');

  const agreed = request.approvals.some((a) => a.user_id === me);
  $('voidApproveBtn').hidden = agreed;
  $('voidHereBtn').hidden = !agreed; // the owner who asked, with the other owner beside them
  $('voidRejectBtn').textContent = asker === me ? 'Cancel request' : "Don't void";
  drawState();
}

// The big status line. A pending request whose time ran out on this screen
// shows as lapsed straight away; the server agrees on its own.
function drawState() {
  const r = current;
  const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  const waiting = r.status === 'pending' && left > 0;
  const needed = r.approvals_needed - r.approvals.length;

  const [tone, title, sub] = waiting
    ? ['wait', `Waiting for ${needed === 1 ? 'one more owner' : `${needed} more owners`}`, `${clock(left)} left`]
    : r.status === 'approved' ? ['done', 'Voided', `Approved by ${names(r.approvals)}. The items are back in stock.`]
    : r.status === 'rejected' ? ['off', 'Not voided', `${r.resolved_by?.full_name ?? 'An owner'} said no. The sale stays as it is.`]
    : r.status === 'cancelled' ? ['off', 'Not voided', `${r.resolved_by?.full_name ?? 'The owner who asked'} cancelled the request.`]
    : ['off', 'Not voided', `No second owner approved it within ${MINUTES} minutes, so the sale stays as it is.`];

  $('voidState').className = `void-state void-state-${tone}`;
  $('voidState').innerHTML = `<strong>${esc(title)}</strong><span>${esc(sub)}</span>`;
  $('voidActions').hidden = !waiting;
}

async function act(call) {
  setStatus('voidStatus');
  const buttons = $('voidActions').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    done(await withServerAuth(call));
  } catch (err) {
    setStatus('voidStatus', err.message, 'err');
    follow(); // it may have changed meanwhile: lapsed, or another owner answered first
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function done(request) {
  draw(request);
  changed();
  checkAlerts();
  if (request.status === 'approved') toast('Sale voided. The items are back in stock.');
}

$('voidApproveBtn').addEventListener('click', () => act(() => approveVoid(current.id)));
$('voidRejectBtn').addEventListener('click', () => act(() => rejectVoid(current.id)));

// ---------------------------------------------------------------------------
// Another owner approves at this screen, with their own password (and their
// authenticator code if they use two-factor login).
// ---------------------------------------------------------------------------

$('voidHereBtn').addEventListener('click', async () => {
  const agreed = new Set(current.approvals.map((a) => a.user_id));
  const owners = (await db.users.filter((u) => u.role === 'owner' && u.is_active !== false && !agreed.has(u.id)).toArray())
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (!owners.length) return setStatus('voidStatus', 'No other owner account is on this device yet. Tap Sync now, then try again.', 'err');

  $('approveHereOwner').innerHTML = owners.map((u) => `<option value="${esc(u.id)}">${esc(u.full_name)}</option>`).join('');
  $('approveHerePin').value = $('approveHereCode').value = '';
  setStatus('approveHereStatus');
  await showCodeField();
  openModal('approveHereOverlay');
});

async function showCodeField() {
  const owner = await db.users.get($('approveHereOwner').value);
  $('approveHereCodeField').hidden = !owner?.totp_enabled;
}

$('approveHereOwner').addEventListener('change', showCodeField);
for (const id of ['approveHerePin', 'approveHereCode']) {
  $(id).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('approveHereBtn').click(); });
}

$('approveHereBtn').addEventListener('click', async () => {
  const pin = $('approveHerePin').value;
  const code = $('approveHereCode').value;
  const needsCode = !$('approveHereCodeField').hidden;
  if (pin.length !== 6) return setStatus('approveHereStatus', "Enter the owner's 6-digit password.", 'err');
  if (needsCode && code.length !== 6) return setStatus('approveHereStatus', 'Enter the 6-digit code from the authenticator app.', 'err');

  $('approveHereBtn').disabled = true;
  try {
    const request = await withServerAuth(() => approveVoidHere(current.id, { user_id: $('approveHereOwner').value, pin, code: needsCode ? code : null }));
    closeModal('approveHereOverlay');
    done(request);
  } catch (err) {
    setStatus('approveHereStatus', err.message, 'err');
    $('approveHerePin').value = '';
    $('approveHerePin').focus();
  } finally {
    $('approveHereBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Alerts: while an owner is signed in, this device checks every 15 seconds
// for voids waiting on their yes, and shows a banner until they answer.
// ---------------------------------------------------------------------------

let waiting = [];
let alertTimer = null;
const seen = new Set();

export function startVoidAlerts() {
  stopVoidAlerts();
  if (!isOwner()) return;
  checkAlerts();
  alertTimer = setInterval(checkAlerts, 15_000);
}

export function stopVoidAlerts() {
  clearInterval(alertTimer);
  alertTimer = null;
  waiting = [];
  $('voidBanner').hidden = true;
}

async function checkAlerts(retry = true) {
  if (!isOwner()) return;
  let requests;
  try {
    requests = await fetchVoidRequests(); // in the background: never a password prompt
  } catch (err) {
    // Not connected yet: use the sign-in password once, then look again.
    if (err.name === 'AuthRequiredError' && retry && await connectToServer()) checkAlerts(false);
    return;
  }
  const me = session.user?.id;
  waiting = requests
    .filter((r) => !r.approvals.some((a) => a.user_id === me))
    .map((r) => ({ ...r, deadline: Date.now() + r.seconds_left * 1000 }));

  const fresh = waiting.filter((r) => !seen.has(r.id));
  fresh.forEach((r) => seen.add(r.id));
  if (fresh.length) {
    toast(`${fresh[0].requested_by?.full_name ?? 'An owner'} asks to void a ${peso(fresh[0].sale.total_amount)} sale. It needs your approval.`);
    changed();
  }
  drawBanner();
}

function drawBanner() {
  waiting = waiting.filter((r) => r.deadline > Date.now());
  $('voidBanner').hidden = !waiting.length;
  if (!waiting.length) return;

  const [first] = waiting;
  const minutes = Math.max(1, Math.ceil((first.deadline - Date.now()) / 60_000));
  $('voidBannerText').innerHTML = waiting.length === 1
    ? `<strong>${esc(first.requested_by?.full_name ?? 'An owner')}</strong> asks to void a ${peso(first.sale.total_amount)} sale. Approve or decline within ${minutes} min.`
    : `<strong>${waiting.length} voids</strong> are waiting for your approval. The first one lapses in ${minutes} min.`;
}

$('voidBannerBtn').addEventListener('click', () => {
  if (waiting[0]) openVoidRequest(waiting[0].id);
});
