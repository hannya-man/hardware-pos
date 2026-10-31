// The customer's screen (customer.html + customer.js) in a simulated browser,
// fed over the same BroadcastChannel the Sell screen uses: the welcome, an
// order as it's rung up, the change at checkout, the thank-you, and names
// shown as text, never as markup.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { checker } from './harness.mjs';

const { check, finish } = checker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FRONTEND = new URL('../caidic-pos-frontend/', import.meta.url);
const html = readFileSync(new URL('customer.html', FRONTEND), 'utf8').replace(/<script\b[^>]*><\/script>/g, '');
const { window } = new JSDOM(html, { url: 'https://hannya-man.github.io/hardware-pos/customer.html', pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, screen: window.screen });
window.HTMLElement.prototype.scrollIntoView = () => {};
const $ = (id) => window.document.getElementById(id);
const showing = () => ['custWelcome', 'custOrder', 'custThanks'].filter((id) => !$(id).hidden).join();

// The Sell screen's side of the channel
const till = new BroadcastChannel('rrc-customer-screen');
const heard = [];
till.onmessage = (e) => heard.push(e.data);
const send = async (message) => { till.postMessage(message); await sleep(50); };

try {
  await import(new URL('src/customer.js', FRONTEND));
  await sleep(50);
  check('asks the Sell screen for the order as it is', heard.includes('hello'), heard);
  check('the welcome, until something is rung up', showing() === 'custWelcome', showing());

  const lines = [
    { name: 'Skim Coat', unit: 'bag', quantity: 2, price: 560, total: 1120 },
    { name: '<img src=x onerror=alert(1)> Board', unit: 'pc', quantity: 1, price: 145, total: 145 },
  ];
  await send({ lines: lines.slice(0, 1), total: 1120, payment: null });
  await send({ lines, total: 1265, payment: null });
  check('the order, its count and total', showing() === 'custOrder' && $('custCount').textContent === '2 items' && $('custTotal').textContent === '₱1,265.00',
    `${showing()} ${$('custCount').textContent} ${$('custTotal').textContent}`);
  check('each line: name, how many at what price, line total', $('custLines').children[0].textContent.replace(/\s+/g, ' ').trim() === 'Skim Coat ₱1,120.00 2 bag × ₱560.00',
    $('custLines').children[0].textContent);
  check('a name is shown as text, never run as markup', !$('custLines').querySelector('img') && $('custLines').textContent.includes('<img src=x'));
  check('only what was just rung up lights up', [...$('custLines').children].map((li) => li.classList.contains('is-new')).join() === 'false,true');

  await send({ lines, total: 1265, payment: { method: 'cash', tendered: 1000 } });
  check('cash short of the total: no change shown yet', $('custPay').textContent.includes('Paying by') && !$('custPay').querySelector('.cust-change'), $('custPay').textContent);
  await send({ lines, total: 1265, payment: { method: 'cash', tendered: 1500 } });
  check('enough cash: what was handed over and the change', $('custPay').querySelector('.cust-change')?.textContent === 'Change₱235.00'
    && $('custPay').textContent.includes('₱1,500.00'), $('custPay').textContent);
  await send({ lines, total: 1265, payment: { method: 'credit', tendered: null } });
  check('credit: only how it is paid, nothing about what is owed', $('custPay').textContent === 'Paying byCredit (utang)', $('custPay').textContent);

  // What the Sell screen sends when a sale completes: the order cleared, then the thank-you
  await send({ lines: [], total: 0, payment: null });
  await send({ thanks: { total: 1265, method: 'cash', tendered: 1500 } });
  check('the thank-you, with the change', showing() === 'custThanks' && $('custThanksNote').textContent === 'Your change: ₱235.00', `${showing()} ${$('custThanksNote').textContent}`);
  await send({ lines: [], total: 0, payment: null });
  check('...and it stays up while the order is empty', showing() === 'custThanks', showing());
  await send({ lines: lines.slice(0, 1), total: 1120, payment: null });
  check('the next order replaces it at once', showing() === 'custOrder' && $('custCount').textContent === '1 item', showing());
  await send({ thanks: { total: 145, method: 'gcash', tendered: null } });
  check('the thank-you without cash: the total and how it was paid', $('custThanksNote').textContent === '₱145.00 · GCash / PayMaya', $('custThanksNote').textContent);
  await send({ hello: 'not an order' });
  check('anything else on the channel is ignored', showing() === 'custThanks', showing());
} catch (err) {
  check('no errors', false, err.stack ?? String(err));
}

till.close();
finish('customer screen (simulated browser)');
process.exit(process.exitCode ?? 0);
