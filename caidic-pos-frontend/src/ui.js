// ui.js — shared helpers: DOM lookups, formatting, icons, tables, modals,
// dialogs, toasts, and the item picker used by every search box.

import { searchProducts, findExactProduct } from './input-handler.js';

export const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
export const peso = (n) => money.format(Number(n) || 0);
export const qty = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 3 });
export const round2 = (n) => Math.round(n * 100) / 100;
export const round3 = (n) => Math.round(n * 1000) / 1000;
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const fmtDateTime = (when) => new Date(when).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }); // on printed slips
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const humanize = (s = '') => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Every value from the catalog or a person goes through this before it's
// put into HTML. Product names like `Flat Bar 3/16" x 3/4"` contain quotes.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Digits and a single decimal point only. Amount fields use type="text"
// with this instead of type="number", which is unreliable on touch keyboards.
export function sanitizeDecimal(raw) {
  const [whole, ...rest] = String(raw).replace(/[^\d.]/g, '').split('.');
  return rest.length ? `${whole}.${rest.join('')}` : whole;
}

export function keepDecimal(input) {
  const clean = sanitizeDecimal(input.value);
  if (clean !== input.value) input.value = clean;
}

// ---------------------------------------------------------------------------
// Small pieces of markup
// ---------------------------------------------------------------------------

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h2.4l2.3 11.3a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21 7H6"/>',
  clipboard: '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2M9 12h6M9 16h4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  truck: '<path d="M2.5 5.5h11v10h-11zM13.5 9h4.2l2.8 3.2v3.3h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  backspace: '<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z"/><path d="m16 9-5 6M11 9l5 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

// Static markup marks icons with <span data-icon="name">; swap them in once.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon, el.className); });
}

export const badge = (text, tone = '') => `<span class="badge${tone ? ` badge-${tone}` : ''}">${esc(text)}</span>`;

export const avatar = (user, size = 'sm') =>
  `<span class="avatar avatar-${size}${user.role === 'owner' ? ' avatar-accent' : ''}">${esc(initials(user.full_name))}</span>`;

export function showSelected(id, product) {
  $(id).textContent = product ? `${product.name} · ${product.sku}` : '';
  $(id).classList.toggle('is-set', !!product);
}

export function setStatus(id, message = '', tone = '') {
  $(id).textContent = message;
  $(id).className = `form-status${tone ? ` ${tone}` : ''}`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function tableMessage(tableId, message) {
  const columns = $(tableId).querySelectorAll('thead th').length || 1;
  $(tableId).querySelector('tbody').innerHTML = `<tr class="empty-row"><td colspan="${columns}">${esc(message)}</td></tr>`;
}

export function renderRows(tableId, rows, rowHtml, emptyText) {
  if (!rows.length) return tableMessage(tableId, emptyText);
  $(tableId).querySelector('tbody').innerHTML = rows.map(rowHtml).join('');
}

// One click listener per container, set up once: any element inside with
// data-action="x" calls handlers.x(data-id, element).
export function onAction(rootId, handlers) {
  $(rootId).addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && $(rootId).contains(el)) handlers[el.dataset.action]?.(el.dataset.id, el);
  });
}

// ---------------------------------------------------------------------------
// Modals. Escape (or a click on the backdrop, where allowed) presses the top
// overlay's [data-close] button, so every modal closes the same way. An
// overlay marked data-guarded handles its own close (to ask first).
// ---------------------------------------------------------------------------

export function openModal(id) {
  $(id).hidden = false;
  requestAnimationFrame(() => {
    const field = $(id).querySelector('[data-autofocus]');
    field?.focus();
    field?.select?.();
  });
}

export const closeModal = (id) => { $(id).hidden = true; };

document.addEventListener('click', (e) => {
  const overlay = e.target.closest('[data-close]')?.closest('.overlay[id]');
  if (overlay && !overlay.hasAttribute('data-guarded')) closeModal(overlay.id);
  else if (e.target.matches('.overlay[data-backdrop-close]')) e.target.querySelector('[data-close]')?.click();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = [...document.querySelectorAll('.overlay:not([hidden])')].pop();
  top?.querySelector('[data-close]')?.click();
});

// A promise-based dialog built on the same modal styles. With `field` it's a
// prompt (resolves to the text, or null if cancelled); without, a confirm
// (true/false). `onConfirm` can return an error message to keep it open.
function dialog({ title, message = '', field = null, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, onConfirm = null }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay overlay-top';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title)}</h3></div>
        ${message ? `<p class="modal-sub">${esc(message)}</p>` : ''}
        ${field ? `<input class="input${field.type === 'password' ? ' input-pin' : ''}" type="${field.type ?? 'text'}" inputmode="${field.inputmode ?? 'text'}" autocomplete="off" placeholder="${esc(field.placeholder ?? '')}" value="${esc(field.value ?? '')}">` : ''}
        <p class="dialog-error" hidden></p>
        <div class="modal-actions">
          ${cancelLabel ? `<button type="button" class="btn" data-close>${esc(cancelLabel)}</button>` : ''}
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('input');
    const okBtn = overlay.querySelector('[data-ok]');
    const error = overlay.querySelector('.dialog-error');
    const finish = (value) => { overlay.remove(); resolve(value); };

    async function confirm() {
      if (okBtn.disabled) return;
      const value = input ? input.value : true;
      if (onConfirm) {
        okBtn.disabled = true;
        const problem = await onConfirm(value);
        okBtn.disabled = false;
        if (problem) {
          error.textContent = problem;
          error.hidden = false;
          if (input?.type === 'password') input.value = '';
          input?.focus();
          return;
        }
      }
      finish(value);
    }

    okBtn.addEventListener('click', confirm);
    overlay.querySelector('[data-close]')?.addEventListener('click', () => finish(input ? null : false));
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
    requestAnimationFrame(() => { (input ?? okBtn).focus(); input?.select(); });
  });
}

export const showPrompt = (title, { value, placeholder, inputmode, type, ...opts } = {}) =>
  dialog({ ...opts, title, field: { value, placeholder, inputmode, type } });

export const showConfirm = (title, opts = {}) => dialog({ confirmLabel: 'Yes', ...opts, title });

// The receipt-paper slip (80 mm): the stock-out slip after a sale, or the pick
// slip the stockroom works from. No amounts on either. `facts` are [label,
// value] rows (empty values are left out); each line gets a box to tick.
// Prints through the browser's own print dialog to whatever printer the
// device has set up (a receipt printer installed as a normal printer works).
export function printSlip({ title, facts, lines, checkLabel, signatures, note = null, footer }) {
  $('slipDoc').textContent = title;
  $('slipMeta').innerHTML = facts.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('slipCheckHead').textContent = checkLabel;
  $('slipLines').innerHTML = lines.map((l) => `
    <tr><td class="slip-qty">${qty(l.quantity)} ${esc(l.unit ?? '')}</td><td>${esc(l.name)}</td><td class="slip-check"><span class="slip-box"></span></td></tr>`).join('');
  $('slipCount').textContent = lines.length;
  $('slipNote').hidden = !note;
  $('slipNote').textContent = note ? `Note: ${note}` : '';
  $('slipSignA').textContent = signatures[0];
  $('slipSignB').textContent = signatures[1];
  $('slipFoot').textContent = footer;
  printOnly('slipPrintArea');
}

// Prints one hidden section of the page (the slip, the price list) and nothing else.
export function printOnly(id) {
  document.body.dataset.print = id;
  window.print();
  setTimeout(() => delete document.body.dataset.print, 2000); // not every browser fires afterprint
}

window.addEventListener('afterprint', () => delete document.body.dataset.print);

export function toast(message, tone = '') {
  const el = document.createElement('div');
  el.className = `toast${tone ? ` toast-${tone}` : ''}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, tone === 'error' ? 6000 : 3500);
}

// ---------------------------------------------------------------------------
// Motion. Both skip the animation for anyone who turned animations off in
// Windows (prefers-reduced-motion).
// ---------------------------------------------------------------------------

const lessMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// One highlight per row of options (Today / This week / ..., payment methods,
// the menu) that glides to the chosen option instead of jumping. It follows
// the .active class, or whatever `selector` picks, so the code that changes
// the choice doesn't need to know about it.
export function slidingHighlight(container, selector = '.active') {
  const thumb = document.createElement('span');
  thumb.className = 'slide-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  container.classList.add('has-slider');

  const place = (animate) => {
    if (!thumb.isConnected) container.prepend(thumb); // the options were redrawn
    const chosen = container.querySelector(selector);
    // A hidden container measures as zero; it's placed when it shows (below).
    if (!chosen || !container.offsetParent) return thumb.classList.remove('is-on');
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = `${chosen.offsetWidth}px`;
    thumb.style.height = `${chosen.offsetHeight}px`;
    thumb.style.transform = `translate(${chosen.offsetLeft}px, ${chosen.offsetTop}px)`;
    thumb.classList.add('is-on');
    if (!animate) {
      void thumb.offsetWidth; // apply the jump before turning the glide back on
      thumb.style.transition = '';
    }
  };

  new MutationObserver((records) => {
    if (records.every((r) => r.target === thumb)) return;
    place(!records.some((r) => r.type === 'childList')); // redrawn options: no glide
  }).observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  container.addEventListener('change', () => place(true)); // radio buttons
  new ResizeObserver(() => place(false)).observe(container); // shown, or the window resized
  place(false);
}

// Counts a number on screen to its new value (a total after switching to
// This week, say) instead of swapping it in.
const counting = new WeakMap();
export function countTo(el, value, format = peso) {
  const to = Number(value) || 0;
  const from = Number(el.dataset.value) || 0;
  el.dataset.value = to;
  cancelAnimationFrame(counting.get(el));
  if (lessMotion.matches || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 650);
    el.textContent = format(from + (to - from) * (1 - (1 - t) ** 3)); // eases out
    if (t < 1) counting.set(el, requestAnimationFrame(step));
  };
  counting.set(el, requestAnimationFrame(step));
}

// ---------------------------------------------------------------------------
// Item picker: search-as-you-type over this device's catalog. Enter picks an
// exact barcode/SKU match (so a scanner aimed at the box works) or the only
// remaining result.
// ---------------------------------------------------------------------------

const defaultHit = (p) => `<span>${esc(p.name)}</span><span class="pick-sub">${esc(p.sku)}</span>`;

export function productPicker(inputId, resultsId, onPick, renderHit = defaultHit) {
  const input = $(inputId);
  const list = $(resultsId);
  let hits = [];
  let seq = 0;

  const reset = () => { seq += 1; hits = []; input.value = ''; list.innerHTML = ''; };
  const pick = (product) => { reset(); onPick(product); };

  input.addEventListener('input', async () => {
    const query = input.value.trim();
    const mine = ++seq;
    const found = query ? await searchProducts(query) : [];
    if (mine !== seq) return; // a newer keystroke already replaced this search
    hits = found;
    list.innerHTML = hits.length
      ? hits.map((p, i) => `<button type="button" class="pick" data-index="${i}">${renderHit(p)}</button>`).join('')
      : query ? '<p class="pick-empty">No matches. Try Sync now if this item should be here.</p>' : '';
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const query = input.value.trim();
    const exact = await findExactProduct(query);
    if (exact) return pick(exact);
    const found = await searchProducts(query);
    if (found.length === 1) pick(found[0]);
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]');
    if (btn) pick(hits[Number(btn.dataset.index)]);
  });

  return { reset };
}
