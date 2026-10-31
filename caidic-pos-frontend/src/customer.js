// customer.js — the customer's screen (customer.html), on a second monitor
// facing the counter: the order as the cashier rings it up, the total, how
// it's being paid and the change, then a thank-you. The Sell screen
// (billing.js) sends every change over a BroadcastChannel, so both windows
// must be open in the same browser on the same computer. This page only shows
// what it's sent: nothing on it does anything, and it never opens the store's
// data.

import './theme.js';
import { esc, peso, qty } from './format.js';

const METHOD_LABELS = { cash: 'Cash', gcash: 'GCash / PayMaya', credit: 'Credit (utang)' };
const THANKS_MS = 8000; // then the welcome, unless the next order has started

const $ = (id) => document.getElementById(id);
const cents = (n) => Math.round(n * 100) / 100;

let order = { lines: [], total: 0, payment: null };
let thanksTimer = null;

function show(id) {
  for (const section of ['custWelcome', 'custOrder', 'custThanks']) $(section).hidden = section !== id;
}

function drawOrder(next) {
  const before = order.lines;
  order = next;
  if (thanksTimer && !next.lines.length) return; // the thank-you stays up until the next order starts
  clearTimeout(thanksTimer);
  thanksTimer = null;
  if (!next.lines.length) return show('custWelcome');

  const count = next.lines.length;
  $('custCount').textContent = `${count} item${count === 1 ? '' : 's'}`;
  $('custLines').innerHTML = next.lines.map((l) => {
    const isNew = !before.some((b) => b.name === l.name && b.quantity === l.quantity);
    return `
      <li class="cust-line${isNew ? ' is-new' : ''}">
        <span class="cust-line-name">${esc(l.name)}</span>
        <span class="cust-line-total">${peso(l.total)}</span>
        <span class="cust-line-sub">${qty(l.quantity)} ${esc(l.unit)} × ${peso(l.price)}</span>
      </li>`;
  }).join('');
  [...$('custLines').querySelectorAll('.is-new')].at(-1)?.scrollIntoView({ block: 'nearest' });
  $('custTotal').textContent = peso(next.total);

  // Cash shows the change once enough is handed over; until then, only how it's being paid.
  const pay = next.payment;
  const change = pay?.tendered != null ? cents(pay.tendered - next.total) : null;
  $('custPay').innerHTML = !pay ? ''
    : change !== null && change >= 0
      ? `<div><span>Cash</span><b>${peso(pay.tendered)}</b></div><div class="cust-change"><span>Change</span><b>${peso(change)}</b></div>`
      : `<div><span>Paying by</span><b>${esc(METHOD_LABELS[pay.method] ?? '')}</b></div>`;
  show('custOrder');
}

function drawThanks({ total, method, tendered }) {
  const change = tendered != null ? cents(tendered - total) : 0;
  $('custThanksNote').textContent = change > 0 ? `Your change: ${peso(change)}` : `${peso(total)} · ${METHOD_LABELS[method] ?? ''}`;
  show('custThanks');
  clearTimeout(thanksTimer);
  thanksTimer = setTimeout(() => {
    thanksTimer = null;
    drawOrder(order);
  }, THANKS_MS);
}

const channel = new BroadcastChannel('rrc-customer-screen');
channel.addEventListener('message', ({ data }) => {
  if (data?.thanks) drawThanks(data.thanks);
  else if (Array.isArray(data?.lines)) drawOrder(data);
});
channel.postMessage('hello'); // the Sell screen answers with the order as it is now

// For whoever sets the screen up: fills the monitor (F11 does the same), and
// stays out of sight while it's filled.
const fullBtn = $('custFullBtn');
const drawFullBtn = () => {
  fullBtn.hidden = !document.fullscreenEnabled || !!document.fullscreenElement || (window.innerWidth >= screen.width && window.innerHeight >= screen.height);
};
fullBtn.addEventListener('click', () => document.documentElement.requestFullscreen().catch(() => {}));
window.addEventListener('resize', drawFullBtn);
drawFullBtn();
