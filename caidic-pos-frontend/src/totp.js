// totp.js — the browser-side half of Google Authenticator support.
// Matches app/Services/TotpService.php on the server exactly (RFC 6238),
// using the browser's own crypto.subtle for HMAC-SHA1 — a local
// computation, not a network call, which is why this keeps working
// fully offline once a device has this staff member's secret cached
// locally at least once.

const PERIOD = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function counterToBytes(counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, 0, false);
  view.setUint32(4, counter, false);
  return new Uint8Array(buf);
}

async function hmacSha1(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, messageBytes);
  return new Uint8Array(signature);
}

async function codeAt(secretBytes, counter) {
  const hash = await hmacSha1(secretBytes, counterToBytes(counter));
  const offset = hash[19] & 0x0f;
  const truncated = ((hash[offset] & 0x7f) << 24)
    | ((hash[offset + 1] & 0xff) << 16)
    | ((hash[offset + 2] & 0xff) << 8)
    | (hash[offset + 3] & 0xff);
  return String(truncated % 1000000).padStart(DIGITS, '0');
}

// Accepts a code from the current 30-second window, or the one right
// before or after it — the same small allowance for clock drift and
// typing time that the server side gives.
export async function verifyTotp(base32Secret, userCode, window = 1) {
  if (!base32Secret) return false;
  const code = String(userCode || '').replace(/\D/g, '');
  if (code.length !== DIGITS) return false;

  const secretBytes = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / PERIOD);

  for (let i = -window; i <= window; i++) {
    const candidate = await codeAt(secretBytes, counter + i);
    if (candidate === code) return true;
  }

  return false;
}
