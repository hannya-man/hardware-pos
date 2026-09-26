// input-handler.js
// Front-end input handling for the POS: on-screen quick-select buttons,
// manual SKU/name search, automatic HID barcode-scanner detection, and PIN
// verification — all reading from the LOCAL catalog (local-db.js), so none
// of it needs a network round trip. That last part matters more than it
// used to: see verifyStaffLogin() below.

import { db } from './local-db.js';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// 1. BARCODE SCANNER DETECTION — unchanged
// ---------------------------------------------------------------------------

const SCANNER_MAX_INTERVAL_MS = 50;
const SCANNER_MIN_LENGTH = 6;

export function attachScannerListener(onScan) {
  let buffer = '';
  let lastKeyTime = 0;

  function handleKeydown(event) {
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
  }

  document.addEventListener('keydown', handleKeydown, true);
  return () => document.removeEventListener('keydown', handleKeydown, true);
}

// ---------------------------------------------------------------------------
// 2. MANUAL SEARCH
//
// FIXED: this used to check `p.is_active` as a plain truthy value, which
// silently excludes any product whose local record doesn't have that
// field set to exactly `true` (for instance `undefined`, if that record
// was written to this device before is_active was included in every
// sync response). The Billing grid was never written that way — it
// always checked `p.is_active !== false`, meaning "show it unless we
// were explicitly told it's archived" — so a product could show up on
// the grid perfectly fine while search for that exact same item turned
// up nothing. Both now use the same permissive check, and results are
// sorted by name so they show up in a predictable order instead of
// whatever order they happened to be stored in.
// ---------------------------------------------------------------------------

export async function searchProducts(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches = await db.products
    .filter((p) => p.is_active !== false
      && ((p.sku ?? '').toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q)))
    .toArray();

  matches.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  return matches.slice(0, limit);
}

export async function getProductByBarcode(barcode) {
  return db.products.where({ barcode }).first();
}

export async function getProductBySku(sku) {
  return db.products.where({ sku }).first();
}

// ---------------------------------------------------------------------------
// 3. QUICK-SELECT
//
// FIXED: same `is_active` issue as searchProducts — `!product.is_active`
// meant a product with a missing (not explicitly false) is_active field
// would silently refuse to be added to the cart even while showing on
// the grid, with no error or message, just nothing happening on tap.
//
// UPDATED: also snapshots the product's category name (category_name) so
// the checkout review popup (see main.js) can show what kind of item
// each line is, without doing its own extra lookups.
// ---------------------------------------------------------------------------

export async function quickSelect(productId, quantity = 1) {
  const product = await db.products.get(productId);
  if (!product || product.is_active === false) return null;

  const category = product.category_id ? await db.categories.get(product.category_id) : null;

  return {
    product_id: product.id,
    sku_snapshot: product.sku,
    name_snapshot: product.name,
    category_name: category?.name ?? 'Uncategorized',
    unit_price_snapshot: product.unit_price,
    quantity,
    line_discount: 0,
    line_total: round2(product.unit_price * quantity)
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 4. STAFF LOGIN — the "who's using this terminal right now" check. Fully
// local, fully offline, on purpose: this is what a cashier hits FIRST,
// before anything else, and it must never depend on the store having
// internet that morning. pin_hash is already sitting in the locally synced
// `users` table from the last successful pullCatalog() — this checks
// against that cached copy, exactly the same bcrypt pattern
// verifyManagerPin() already used below, just for any active user instead
// of manager/owner only.
//
// This does NOT get you a server session — it only unlocks the local UI.
// A separate, on-demand PIN exchange with the server (sync-worker.js's
// loginWithPin()) is what a caller uses right before an owner-gated action
// like Returns or Reconciliation, and that one DOES require connectivity —
// which is fine, since those actions were already established as OK to
// require it.
// ---------------------------------------------------------------------------

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60_000;
const loginAttemptState = new Map(); // user id -> { count, lockedUntil }

export async function verifyStaffLogin(userId, pin) {
  const now = Date.now();
  const user = await db.users.get(userId);

  if (!user || user.is_active === false) {
    return { approved: false, user: null };
  }

  const state = loginAttemptState.get(userId);
  if (state?.lockedUntil && state.lockedUntil > now) {
    return { approved: false, user: null, lockedUntil: state.lockedUntil };
  }

  const match = await bcrypt.compare(pin, user.pin_hash);
  if (match) {
    loginAttemptState.delete(userId);
    return { approved: true, user };
  }

  const count = (state?.count ?? 0) + 1;
  loginAttemptState.set(userId, {
    count,
    lockedUntil: count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : null
  });

  return { approved: false, user: null };
}

// ---------------------------------------------------------------------------
// 5. MANAGER PIN OVERRIDE — unchanged. Still local, still offline, still
// only for: voiding/refunding an already-paid sale, a price override, or
// "No Sale". Not for ordinary order editing.
// ---------------------------------------------------------------------------

export async function verifyManagerPin(pin) {
  const now = Date.now();
  const approvers = await db.users
    .filter((u) => u.is_active && (u.role === 'manager' || u.role === 'owner'))
    .toArray();

  for (const user of approvers) {
    const state = loginAttemptState.get(user.id);
    if (state?.lockedUntil && state.lockedUntil > now) continue;

    const match = await bcrypt.compare(pin, user.pin_hash);
    if (match) {
      loginAttemptState.delete(user.id);
      return { approved: true, user };
    }

    const count = (state?.count ?? 0) + 1;
    loginAttemptState.set(user.id, {
      count,
      lockedUntil: count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : null
    });
  }

  return { approved: false, user: null };
}
