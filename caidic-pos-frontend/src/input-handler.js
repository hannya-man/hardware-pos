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
// 2. MANUAL SEARCH — unchanged
// ---------------------------------------------------------------------------

export async function searchProducts(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return db.products
    .filter((p) => p.is_active && (p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
    .limit(limit)
    .toArray();
}

export async function getProductByBarcode(barcode) {
  return db.products.where({ barcode }).first();
}

export async function getProductBySku(sku) {
  return db.products.where({ sku }).first();
}

// ---------------------------------------------------------------------------
// 3. QUICK-SELECT — unchanged
// ---------------------------------------------------------------------------

export async function quickSelect(productId, quantity = 1) {
  const product = await db.products.get(productId);
  if (!product || !product.is_active) return null;

  return {
    product_id: product.id,
    sku_snapshot: product.sku,
    name_snapshot: product.name,
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
