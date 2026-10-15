// input-handler.js — barcode scanner detection, catalog lookups, and the
// offline PIN check. Everything here reads this device's own copy of the
// catalog, so none of it needs the internet.

import bcrypt from 'bcryptjs';
import { db } from './local-db.js';

// A missing is_active counts as active; only an explicit false hides an item.
const isSellable = (p) => p?.is_active !== false;

// ---------------------------------------------------------------------------
// Barcode scanner. A HID scanner "types" very fast and ends with Enter.
// Keystrokes aimed at a form field are ignored, so typing a code into a field
// and pressing Enter is never mistaken for a scan.
// ---------------------------------------------------------------------------

const SCANNER_MAX_INTERVAL_MS = 50;
const SCANNER_MIN_LENGTH = 6;

const isField = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);

export function attachScannerListener(onScan) {
  let buffer = '';
  let lastKeyTime = 0;

  document.addEventListener('keydown', (event) => {
    if (isField(event.target)) return;

    const now = performance.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (event.key === 'Enter') {
      if (buffer.length >= SCANNER_MIN_LENGTH) {
        event.preventDefault();
        onScan(buffer);
      }
      buffer = '';
      return;
    }

    if (event.key.length !== 1) return;
    buffer = gap <= SCANNER_MAX_INTERVAL_MS ? buffer + event.key : event.key;
  }, true);
}

// ---------------------------------------------------------------------------
// Catalog lookups
// ---------------------------------------------------------------------------

export async function searchProducts(query, limit = 20) {
  const raw = query.trim();
  const q = raw.toLowerCase();
  if (!q) return [];

  const matches = await db.products
    .filter((p) => isSellable(p) && (
      (p.name ?? '').toLowerCase().includes(q)
      || (p.sku ?? '').toLowerCase().includes(q)
      || p.barcode === raw
    ))
    .toArray();

  return matches.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')).slice(0, limit);
}

// Exact barcode, then exact SKU — what a scan or a typed code should hit.
export async function findExactProduct(code) {
  const c = code.trim();
  if (!c) return null;
  const product = (await db.products.where('barcode').equals(c).first())
    ?? (await db.products.where('sku').equalsIgnoreCase(c).first());
  return isSellable(product) ? product : null;
}

// A fresh cart line for one unit of a product, with the details the checkout
// and the printed slip need snapshotted at the moment it was added.
export async function makeCartLine(productId) {
  const product = await db.products.get(productId);
  if (!product || !isSellable(product)) return null;

  const category = product.category_id ? await db.categories.get(product.category_id) : null;
  const price = Number(product.unit_price);

  return {
    product_id: product.id,
    sku_snapshot: product.sku,
    name_snapshot: product.name,
    category_name: category?.name ?? 'Uncategorized',
    unit_price_snapshot: price,
    unit_snapshot: product.unit,
    quantity: 1,
    line_discount: 0,
    line_total: price,
  };
}

// ---------------------------------------------------------------------------
// Staff login — fully offline on purpose, so the till opens even when the
// store's internet is down. Checks the PIN against the bcrypt hash synced in
// the last catalog pull. It only unlocks this screen; server-gated actions
// ask for the PIN again (see session.js).
// ---------------------------------------------------------------------------

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60_000;
const attempts = new Map(); // user id -> { count, lockedUntil }

export async function verifyStaffLogin(userId, pin) {
  const now = Date.now();
  const user = await db.users.get(userId);
  if (!user || user.is_active === false) return { approved: false, user: null };

  const state = attempts.get(userId);
  if (state?.lockedUntil > now) return { approved: false, user: null, locked: true };

  if (await bcrypt.compare(pin, user.pin_hash)) {
    attempts.delete(userId);
    return { approved: true, user };
  }

  const count = (state?.count ?? 0) + 1;
  attempts.set(userId, { count, lockedUntil: count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : null });
  return { approved: false, user: null, locked: count >= MAX_LOGIN_ATTEMPTS };
}
