// format.js — money, quantities and safe HTML text. On its own so the
// customer's screen (customer.js) can use them without loading anything that
// touches the store's data; everything else gets them through ui.js.

const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
export const peso = (n) => money.format(Number(n) || 0);
export const qty = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 3 });

// Every value from the catalog or a person goes through this before it's
// put into HTML. Product names like `Flat Bar 3/16" x 3/4"` contain quotes.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
