// input-handler.js
// Front-end input handling for the POS: on-screen quick-select buttons,
// manual SKU/name search, and automatic HID barcode-scanner detection — all
// reading from the LOCAL catalog (local-db.js), so none of it needs a
// network round trip and none of it needs to change the day you plug in an
// actual scanner.
//
// Deliberately has no opinion about cart state or DOM/framework — every
// function here takes input and returns data. Wire the results into React
// state, a plain array, whatever you're building the real UI in. See
// demo.html for one concrete wiring.

import { db } from './local-db.js';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// 1. BARCODE SCANNER DETECTION
// ---------------------------------------------------------------------------
// USB/Bluetooth scanners in "HID keyboard-wedge" mode just type the
// barcode's characters, one keydown per character, then Enter — no drivers,
// no browser permission prompt, no code changes needed for the day you buy
// one. The only real job is telling that apart from a human typing:
// scanners fire keys ~1-5ms apart; humans rarely beat ~60-80ms even typing
// fast. So: bucket keystrokes into a "burst", and only trust a burst as a
// scan if it (a) ends in Enter, (b) is long enough to plausibly be a
// barcode, and (c) arrived faster than a human plausibly could.
//
// This never calls preventDefault() on the individual character keydowns —
// only on the final Enter, once classified — so it can't eat a fast human
// typist's legitimate input. If a scan happens while focus is inside a text
// field, the raw digits DO land in that field too (that's an unavoidable
// side effect of not fighting the browser mid-burst); your onScan callback
// should clear/reset whatever field might have caught them. See demo.html.

const SCANNER_MAX_INTERVAL_MS = 50; // gap between chars that still counts as "the same burst"
const SCANNER_MIN_LENGTH = 6;       // shortest string trusted as a barcode rather than a stray keypress

export function attachScannerListener(onScan) {
  let buffer = '';
  let lastKeyTime = 0;

  function handleKeydown(event) {
    const now = performance.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (event.key === 'Enter') {
      if (buffer.length >= SCANNER_MIN_LENGTH) {
        event.preventDefault(); // stop it from also submitting a focused search box
        onScan(buffer);
      }
      buffer = '';
      return;
    }

    if (event.key.length !== 1) return; // ignore Shift, Tab, arrows, etc.

    // A pause longer than a human keystroke means this is a NEW burst, not
    // a continuation of the last one — reset instead of appending.
    buffer = gap <= SCANNER_MAX_INTERVAL_MS ? buffer + event.key : event.key;
  }

  // Capture phase so this sees the keystroke before any focused input's
  // own handler does, regardless of what currently has focus.
  document.addEventListener('keydown', handleKeydown, true);
  return () => document.removeEventListener('keydown', handleKeydown, true);
}

// ---------------------------------------------------------------------------
// 2. MANUAL SEARCH — SKU or name, against the LOCAL catalog only
// ---------------------------------------------------------------------------
export async function searchProducts(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // A linear scan is fine here: a hardware store's catalog is realistically
  // hundreds to a few thousand SKUs, and this runs against data already in
  // memory/IndexedDB, not over the network. If your catalog grows into the
  // tens of thousands, add a small search index (e.g. FlexSearch) — that's
  // real over-engineering for day one.
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
// 3. QUICK-SELECT — on-screen buttons for common bulk items
// ---------------------------------------------------------------------------
// Returns a ready-to-add cart line. Doesn't touch cart state itself — the
// caller decides how the cart is stored.
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
// 4. MANAGER PIN OVERRIDE — for the checkpoints that actually need one
// ---------------------------------------------------------------------------
// Call this for: voiding/refunding a sale that's ALREADY been paid, a price
// override, or "No Sale" (opening the drawer with nothing rung up) — the
// standard loss-prevention checkpoints in a real retail terminal, all of
// which change money or inventory that's already been committed.
//
// Do NOT call this for ordinary order editing — removing a line, changing
// a quantity, or clearing the cart before payment. Nothing has been
// committed yet at that point, so there's nothing to approve; it's just
// building the order. Gating that behind a PIN is a common demo mistake
// (this kit had it too, briefly) that real POS software doesn't make.
//
// One shared PIN pad, matched against any active manager/owner (matching
// "enter the Admin PIN code" rather than "pick which manager, then enter
// their PIN"). Lockout state is in-memory/per page-load — cheap UX friction,
// not the real security boundary. The real audit trail is the failed_pin_
// attempt row your caller should write via sync-worker.js's
// logFailedPinAttempt() any time this returns { approved: false }.

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const attemptState = new Map(); // user id -> { count, lockedUntil }

export async function verifyManagerPin(pin) {
  const now = Date.now();
  const approvers = await db.users
    .filter((u) => u.is_active && (u.role === 'manager' || u.role === 'owner'))
    .toArray();

  for (const user of approvers) {
    const state = attemptState.get(user.id);
    if (state?.lockedUntil && state.lockedUntil > now) continue;

    const match = await bcrypt.compare(pin, user.pin_hash);
    if (match) {
      attemptState.delete(user.id);
      return { approved: true, user };
    }

    const count = (state?.count ?? 0) + 1;
    attemptState.set(user.id, {
      count,
      lockedUntil: count >= MAX_PIN_ATTEMPTS ? now + LOCKOUT_MS : null
    });
  }

  return { approved: false, user: null };
}
