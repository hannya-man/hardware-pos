// main.js — startup, sign-in (clock in), the menu, sign-out (break or end of
// shift), and Sync now.

import { isDark, toggleTheme } from './theme.js'; // first: the colours are set before anything is drawn
import { db, isProvisioned, setTerminalKey, getTerminalKey, getTerminalId, getOpenShift, lastCountedCash, getSyncMeta, setSyncMeta } from './local-db.js';
import { verifyStaffLogin } from './input-handler.js';
import {
  startSyncWorker, pullCatalog, forceFullSync, flushOutbox, retryFailedOutbox, openShift, closeShift, shiftCash,
  forgetServerLogin, recordFailedSignIn, serverConfigured, checkTerminalKey, requestLogin, saveServerLogin,
} from './sync-worker.js';
import { verifyTotp } from './totp.js';
import { session, setSession, log, connectToServer } from './session.js';
import { $, esc, icon, peso, fmtTime, initials, sanitizeDecimal, keepDecimal, hydrateIcons, setStatus, openModal, closeModal, showPrompt, toast, slidingHighlight } from './ui.js';
import { renderBilling, clearCart, cancelCheckout } from './billing.js';
import { renderCredit } from './credit.js';
import { renderDashboard } from './dashboard.js';
import { renderReports } from './reports.js';
import { renderStock, renderMaterialRequests } from './inventory.js';
import { renderSales, renderShifts, renderReturns, renderStaff, renderAudit } from './admin.js';
import { startVoidAlerts, stopVoidAlerts } from './voids.js';

// Never inside another site's page, where a hidden frame could trick someone
// into tapping (clickjacking). GitHub Pages can't send the header that would
// forbid it, so the app refuses to start instead.
if (window.top !== window.self) {
  document.body.replaceChildren();
  throw new Error('Open the POS directly, not inside another page.');
}

// Two roles: cashiers sell; owners also run the store screens.
const EVERYONE = ['cashier', 'owner'];
const OWNER = ['owner'];

// What each role sees in the menu. Display only: the server checks the role
// on every call, whatever this menu shows.
const NAV = [
  { items: [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', roles: OWNER, render: renderDashboard,
      help: 'How the store is doing: sales, money owed to you, stock value, and who is working.' },
  ] },
  { section: 'Daily work', items: [
    { key: 'billing', label: 'Sell', icon: 'cart', roles: EVERYONE, render: renderBilling,
      help: 'Scan, search, or tap items to add them, then Charge. Customers can pay cash, GCash/PayMaya, or on credit (utang). Prices shown are final. Every sale goes to the pick lists so the stockroom can get the items ready.' },
    { key: 'credit', label: 'Credit (utang)', icon: 'wallet', roles: EVERYONE, render: renderCredit,
      help: 'Customers who bought on credit and how much each one still owes. Record a payment when they pay. If they hand over more cash than they owe, the balance is paid off and the change to give back is shown.' },
    { key: 'materialRequests', label: 'Pick lists', icon: 'clipboard', roles: EVERYONE, render: renderMaterialRequests,
      help: 'What the stockroom has to get ready. Every sale shows up here on its own, with the Ref no. from its slip. Tap Print for a pick slip to work from, and Mark picked up once the customer has the items. You can also send a list without charging, for a big order or a delivery.' },
  ] },
  { section: 'Store', items: [
    { key: 'stock', label: 'Stock', icon: 'box', roles: OWNER, render: renderStock,
      help: 'Every item, how many are in the store and the warehouse, and what that stock is worth. Tap Edit to change a price or a count.' },
    { key: 'sales', label: 'Sales', icon: 'bag', roles: OWNER, render: renderSales,
      help: 'Every sale, with its items and how it was paid. Tap a sale to see it. To void one, a second owner has to approve within 10 minutes, or the sale stays as it is.' },
    { key: 'reports', label: 'Sales report', icon: 'chart', roles: OWNER, render: renderReports,
      help: 'What sold and for how much in a day, week, month, or year: the best sellers, how customers paid, sales by category and by staff, and the busiest hours. The arrows go back to earlier ones. Download saves it all as a spreadsheet.' },
    { key: 'shifts', label: 'Shifts', icon: 'clock', roles: OWNER, render: renderShifts,
      help: 'When each person clocked in and out, what they sold, any cash difference, and everything they did. Tap a shift to see its timeline.' },
    { key: 'returns', label: 'Returns', icon: 'undo', roles: OWNER, render: renderReturns,
      help: 'Accept an item a customer brings back. An invoice or slip number, or a reason, is needed as proof.' },
    { key: 'staff', label: 'Staff', icon: 'users', roles: OWNER, render: renderStaff,
      help: 'Add staff, change a name, role, or password, and turn on two-factor login for owners.' },
    { key: 'audit', label: 'Audit log', icon: 'shield', roles: OWNER, render: renderAudit,
      help: "Events that need an owner's eyes: wrong passwords at sign-in, cash differences at the end of a shift, voided sales, items sold beyond the stock count, returns, and devices with a wrong clock. Download it to keep a copy for your records." },
  ] },
];

const SCREENS = NAV.flatMap((group) => group.items);
const viewId = (key) => `view${key[0].toUpperCase()}${key.slice(1)}`;
// Just the time for today; the date too for a shift left open since an earlier day.
const since = (iso) => (new Date(iso).toDateString() === new Date().toDateString()
  ? new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
  : fmtTime(iso));

let activeView = null;
let selectedUser = null;
let pin = '';
let stage = 'pin'; // 'pin', then 'totp' for an owner with two-factor login on
let checking = false;
let typedPassword = null; // the sign-in password, handed to the session for the server login

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function boot() {
  hydrateIcons();
  buildKeypad();
  // Choices that glide: Today / This week / ..., payment methods, the menu.
  document.querySelectorAll('.segmented, .pay-methods, .nav').forEach((el) => slidingHighlight(el));
  document.querySelectorAll('.choice-row').forEach((el) => slidingHighlight(el, '.choice:has(input:checked)'));

  if (!serverConfigured) toast("This copy of the app wasn't built with its server address, so it can't sync.", 'error');

  if (!(await isProvisioned())) await askForTerminalKey();

  let online = null;
  let unsynced = 0;
  const drawStatus = () => {
    $('statusLabel').textContent = `${online ? 'Online' : online === false ? 'Offline' : 'Checking…'}${unsynced ? ` · ${unsynced} not synced` : ''}`;
    $('statusPill').classList.toggle('offline', online === false);
    $('statusPill').classList.toggle('attention', unsynced > 0);
  };
  startSyncWorker({
    onStatusChange: (now) => {
      online = now;
      drawStatus();
    },
    onUnsynced: (count) => {
      if (count > unsynced) toast(`${count} record${count === 1 ? '' : 's'} couldn't be saved on the server. Tap Sync now; if it stays, tell an owner.`, 'error');
      unsynced = count;
      drawStatus();
    },
    onNeedsProvisioning: () => askForTerminalKey({ fromSync: true }),
  });

  await pullCatalog().catch(() => {});
  // One known account (or none) almost always means an incomplete first sync.
  if ((await db.users.count()) <= 1) await forceFullSync().catch(() => {});

  // A refresh keeps the person signed in, unless the account was deactivated
  // meanwhile, or the till sat unused longer than the screen lock allows
  // (closed overnight, say): then they sign in again and their shift is
  // still open.
  const savedId = await getSyncMeta('current_user_id');
  const saved = savedId ? await db.users.get(savedId) : null;
  const recent = Date.now() - (await getSyncMeta('last_active_at', 0)) < IDLE_LOCK_MINUTES * 60_000;
  if (saved && saved.is_active !== false && recent) return enterApp(saved, 'session_resumed');
  if (savedId) await setSyncMeta('current_user_id', null);
  await renderStaffGrid();
}

// ---------------------------------------------------------------------------
// The terminal key: asked for when the device is set up, and again whenever
// the server stops taking it (an owner replaced a key that leaked, say).
// Sales and everything else made meanwhile stay on the device and go up as
// soon as the new key is in. A key is checked with the server before it's
// saved, unless there's no internet to ask.
// ---------------------------------------------------------------------------

const KEY_ASK_AGAIN_MS = 10 * 60_000;
let keyPrompt = null;
let keyAskedAt = 0;

function askForTerminalKey({ fromSync = false } = {}) {
  if (keyPrompt) return keyPrompt;
  // Sync notices every 15 seconds: ask then at most every 10 minutes, and
  // never on top of a checkout or another dialog (the next notice asks).
  if (fromSync && (Date.now() - keyAskedAt < KEY_ASK_AGAIN_MS || document.querySelector('.overlay:not([hidden])'))) {
    return Promise.resolve(false);
  }
  keyPrompt = (async () => {
    const replacing = !!(await getTerminalKey());
    const key = await showPrompt(replacing ? "Enter this till's new key" : 'Set up this terminal', {
      message: replacing
        ? "The server doesn't accept this till's key any more, so sales are kept here and not sent yet. Enter the new key from an owner (made in Supabase with pos.add_terminal). Nothing made on this till is lost."
        : "This device hasn't been set up yet. Enter its one-time terminal key.",
      placeholder: 'Terminal key',
      confirmLabel: 'Save',
      cancelLabel: fromSync ? 'Later' : 'Cancel',
      onConfirm: async (value) => ((await checkTerminalKey(value.trim())) === 'rejected'
        ? "The server doesn't accept that key. Check it with an owner and try again." : null),
    });
    keyAskedAt = Date.now();
    if (!key?.trim()) {
      if (fromSync) toast('Sales stay on this till until it has a working key. It will ask again in 10 minutes.', 'error');
      return false;
    }
    await setTerminalKey(key.trim());
    if (replacing) {
      toast('Key saved. Anything waiting on this till is being sent now.');
      flushOutbox().catch(() => {});
      pullCatalog().catch(() => {});
    }
    return true;
  })().finally(() => { keyPrompt = null; });
  return keyPrompt;
}

// ---------------------------------------------------------------------------
// Sign-in. The password is checked offline against this device's synced PIN
// hashes. Owners use 6 digits, plus an authenticator code if two-factor is
// on, which only the server can check (it alone has the secret).
// ---------------------------------------------------------------------------

async function renderStaffGrid() {
  const users = await db.users.filter((u) => u.is_active !== false).sortBy('full_name');
  $('staffGrid').innerHTML = users.length
    ? users.map((u) => `
        <button type="button" class="staff-card" data-id="${esc(u.id)}">
          <span class="avatar${u.role === 'owner' ? ' avatar-accent' : ''}">${esc(initials(u.full_name))}</span>
          <span class="staff-name">${esc(u.full_name)}</span>
          <span class="staff-role">${esc(u.role)}</span>
        </button>`).join('')
    : '<p class="empty-note">No staff on this device yet. Tap Sync staff list to check again.</p>';
}

$('staffGrid').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-id]');
  const user = card && await db.users.get(card.dataset.id);
  if (user) openPinPad(user);
});

const pinLength = () => (stage === 'totp' || selectedUser?.role === 'owner' ? 6 : 4);

function openPinPad(user) {
  selectedUser = user;
  stage = 'pin';
  pin = '';
  $('staffPicker').hidden = $('loginHint').hidden = true;
  $('pinPad').hidden = false;
  $('pinAv').textContent = initials(user.full_name);
  $('pinAv').classList.toggle('avatar-accent', user.role === 'owner');
  $('pinName').textContent = user.full_name;
  $('pinPrompt').textContent = `Enter your ${pinLength()}-digit password`;
  $('loginError').textContent = '';
  renderPinDots();
}

function closePinPad() {
  selectedUser = null;
  stage = 'pin';
  pin = '';
  typedPassword = null;
  $('pinPad').hidden = true;
  $('staffPicker').hidden = $('loginHint').hidden = false;
}

function renderPinDots() {
  $('pinDots').innerHTML = Array.from({ length: pinLength() }, (_, i) => `<span${i < pin.length ? ' class="filled"' : ''}></span>`).join('');
}

function buildKeypad() {
  $('keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map((key) => {
    if (key === 'clear') return '<button type="button" class="key-text" data-key="clear">Clear</button>';
    if (key === 'back') return `<button type="button" class="key-text" data-key="back" aria-label="Delete">${icon('backspace')}</button>`;
    return `<button type="button" data-key="${key}">${key}</button>`;
  }).join('');
}

async function pressKey(key) {
  if (checking) return;
  if (key === 'clear') pin = '';
  else if (key === 'back') pin = pin.slice(0, -1);
  else if (pin.length < pinLength()) pin += key;
  renderPinDots();
  if (pin.length < pinLength()) return;

  checking = true;
  try {
    if (stage === 'pin') await checkPin();
    else await checkTotp();
  } finally {
    checking = false;
  }
}

async function checkPin() {
  const { approved, user, locked } = await verifyStaffLogin(selectedUser.id, pin);
  if (!approved) {
    recordFailedSignIn({ user_id: selectedUser.id, step: 'password', locked: !!locked }).catch(() => {});
    return loginFailed(locked ? 'Too many tries. Wait a minute, then try again.' : 'Wrong password. Try again.');
  }
  typedPassword = pin; // before a two-factor step reuses the keypad

  if (user.role === 'owner' && user.totp_enabled) {
    stage = 'totp';
    pin = '';
    $('pinPrompt').textContent = 'Enter the 6-digit code from your authenticator app';
    $('loginError').textContent = '';
    return renderPinDots();
  }

  await signIn(user);
}

// The server checks the code (wrong ones count toward its lock and go on the
// Audit log), and the same call connects this person to it. With no internet
// they can still sign in to sell; owner screens ask for a code once it's back.
async function checkTotp() {
  const code = pin;
  try {
    const login = await requestLogin(selectedUser.id, typedPassword, code);
    // A server not yet updated doesn't check codes: this device does, as it
    // used to, while it still has the secret.
    if (!login.two_factor_checked && !(selectedUser.totp_secret && await verifyTotp(selectedUser.totp_secret, code))) {
      recordFailedSignIn({ user_id: selectedUser.id, step: 'code' }).catch(() => {});
      return loginFailed('That code did not match. Try again.');
    }
    return signIn(selectedUser, login.token);
  } catch (err) {
    if (err.offline) {
      toast('No internet: your authenticator code will be checked when you open an owner screen.');
      return signIn(selectedUser);
    }
    return loginFailed(err.message); // a wrong code, or too many tries
  }
}

function loginFailed(message) {
  pin = '';
  renderPinDots();
  $('loginError').textContent = message;
  $('pinDots').classList.remove('shake');
  void $('pinDots').offsetWidth; // restart the animation
  $('pinDots').classList.add('shake');
}

// token: a server sign-in already made with the password and code.
async function signIn(user, token = null) {
  const password = typedPassword;
  typedPassword = null;
  await forgetServerLogin(); // never act on the server as the previous person
  if (token) await saveServerLogin(token);
  await setSyncMeta('current_user_id', user.id);
  await setSyncMeta('last_active_at', Date.now());
  closePinPad();
  await enterApp(user, 'login', password, { connected: !!token });
}

$('keypad').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key) pressKey(key);
});
$('pinBack').addEventListener('click', closePinPad);

// A physical keyboard works on the PIN pad too.
document.addEventListener('keydown', (e) => {
  if ($('loginScreen').hidden || $('pinPad').hidden || document.querySelector('.overlay:not([hidden])')) return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === 'Backspace') pressKey('back');
  else if (e.key === 'Escape') closePinPad();
});

// ---------------------------------------------------------------------------
// Clock in: signing in resumes this person's open shift on this terminal, or
// starts a new one with the cash that's in the drawer.
// ---------------------------------------------------------------------------

async function enterApp(user, logEvent, password = null, { connected = false } = {}) {
  $('loginScreen').hidden = true;
  $('appShell').hidden = false;
  $('sideName').textContent = user.full_name;
  $('sideAv').textContent = initials(user.full_name);
  $('sideAv').classList.toggle('avatar-accent', user.role === 'owner');

  const terminalId = await getTerminalId();
  let shift = await getOpenShift(terminalId, user.id);
  const resumed = !!shift;
  if (!shift) {
    const lastCount = await lastCountedCash(terminalId);
    const cash = await showPrompt(`Hi, ${user.full_name.split(' ')[0]}! Start your shift`, {
      message: 'How much cash is in the drawer right now?',
      value: String(lastCount || 0),
      inputmode: 'decimal',
      confirmLabel: 'Start shift',
      cancelLabel: null,
    });
    await openShift({ cashier_id: user.id, opening_cash: Number(sanitizeDecimal(cash ?? '')) || 0 });
    shift = await getOpenShift(terminalId, user.id);
  }

  setSession(user, shift.id, password);
  // Ready for screens that read the server, so there's no second password prompt.
  const ready = connected ? Promise.resolve(true) : password ? connectToServer() : Promise.resolve();
  if (resumed) log(logEvent); // a new shift already logs its own clock-in
  $('sideShift').textContent = `On shift since ${since(shift.started_at)}`;
  renderNav();
  showView(user.role === 'cashier' ? 'billing' : 'dashboard');
  ready.then(startVoidAlerts); // owners: voids waiting for their yes
}

function renderNav() {
  const { role } = session.user;
  $('navItems').innerHTML = NAV.map(({ section, items }) => {
    const visible = items.filter((item) => item.roles.includes(role));
    if (!visible.length) return '';
    return `${section ? `<p class="nav-section">${section}</p>` : ''}${visible.map((item) => `
      <button type="button" class="nav-item" data-view="${item.key}" title="${item.label}">${icon(item.icon)}<span class="nav-label">${item.label}</span></button>`).join('')}`;
  }).join('');
}

function showView(key) {
  const screen = SCREENS.find((s) => s.key === key);
  activeView = key;
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== viewId(key); });
  $('navItems').querySelectorAll('[data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === key));
  $('viewTitle').textContent = screen.label;
  $('pageHelpPop').textContent = screen.help;
  $('content').scrollTop = 0;
  screen.render();
}

$('navItems').addEventListener('click', (e) => {
  const key = e.target.closest('[data-view]')?.dataset.view;
  if (!key) return;
  setMenu(false);
  if (key === activeView) return;
  showView(key);
  log('view_opened', { entity_type: 'view', details: { view: key } });
});

// Phones: the menu slides in from the left, opened by the button at the top
// (style.css keeps it in place on wider screens). Picking a screen, tapping
// beside the menu, or Escape closes it.
function setMenu(open) {
  $('appShell').classList.toggle('nav-open', open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
}

$('menuBtn').addEventListener('click', () => setMenu(!$('appShell').classList.contains('nav-open')));
$('navBackdrop').addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('appShell').classList.contains('nav-open')) setMenu(false);
});

// Dark or light screen, for this device (theme.js). The button names the
// look it switches to.
function drawThemeBtn() {
  const toLight = isDark();
  $('themeBtn').innerHTML = `${icon(toLight ? 'sun' : 'moon')}<span class="nav-label">${toLight ? 'Light screen' : 'Dark screen'}</span>`;
  $('themeBtn').title = toLight ? 'Light screen' : 'Dark screen';
}
$('themeBtn').addEventListener('click', () => {
  toggleTheme();
  drawThemeBtn();
});
drawThemeBtn();

// ---------------------------------------------------------------------------
// Sign out: a break keeps the shift open; ending it is a blind cash count
// (the expected amount only shows after the count is entered).
// ---------------------------------------------------------------------------

async function signOut() {
  stopVoidAlerts();
  await forgetServerLogin();
  await setSyncMeta('current_user_id', null);
  setSession(null, null);
  clearCart();
  setMenu(false);
  activeView = null;
  $('appShell').hidden = true;
  $('loginScreen').hidden = false;
  await renderStaffGrid();
}

$('logoutBtn').addEventListener('click', () => {
  setMenu(false);
  openModal('signOutOverlay');
});

$('takeBreakBtn').addEventListener('click', async () => {
  closeModal('signOutOverlay');
  log('screen_locked');
  await signOut();
});

// A till left alone locks itself after IDLE_LOCK_MINUTES with no tap, key or
// scan, the same as Take a break: the shift stays open and the next person
// signs in with their own password. Anything half done is closed first;
// nothing is charged.
const IDLE_LOCK_MINUTES = 10;
let lastInput = Date.now();
let lastSaved = 0;
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    lastInput = Date.now();
    // Kept on the device too (every 30 seconds at most), for the check at startup.
    if (session.user && lastInput - lastSaved > 30_000) {
      lastSaved = lastInput;
      setSyncMeta('last_active_at', lastInput).catch(() => {});
    }
  }, { capture: true, passive: true });
}

setInterval(async () => {
  if (!session.user || Date.now() - lastInput < IDLE_LOCK_MINUTES * 60_000) return;
  lastInput = Date.now();
  cancelCheckout();
  [...document.querySelectorAll('.overlay:not([hidden])')].reverse().forEach((overlay) => {
    const close = overlay.querySelector('[data-close]');
    if (close) close.click();
    else overlay.hidden = true;
  });
  log('screen_locked', { details: { reason: 'idle' } });
  await signOut();
  toast(`Locked after ${IDLE_LOCK_MINUTES} minutes without use. The shift is still open.`);
}, 30_000);

$('endShiftBtn').addEventListener('click', async () => {
  closeModal('signOutOverlay');
  await pullCatalog().catch(() => {}); // learns of voids approved elsewhere, so they leave the count
  const cash = await shiftCash(session.shiftId);
  if (!cash.opening && !cash.cashIn) {
    await closeShift({ shift_id: session.shiftId, counted_cash: null });
    toast('Shift ended. No cash to count this time.');
    return signOut();
  }
  $('countedCash').value = '';
  setStatus('countStatus');
  $('countStep').hidden = false;
  $('resultStep').hidden = true;
  openModal('endShiftOverlay');
});

$('countedCash').addEventListener('input', (e) => keepDecimal(e.target));
$('countedCash').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('countSubmitBtn').click(); });

$('countSubmitBtn').addEventListener('click', async () => {
  const raw = $('countedCash').value.trim();
  if (!raw) return setStatus('countStatus', 'Enter the amount you counted (0 if the drawer is empty).', 'err');

  $('countSubmitBtn').disabled = true;
  try {
    const shift = await closeShift({ shift_id: session.shiftId, counted_cash: Number(raw) });
    const diff = shift.cash_discrepancy;
    const verdict = diff === 0 ? ['Exact', 'text-ok'] : diff < 0 ? [`Short by ${peso(-diff)}`, 'text-bad'] : [`Over by ${peso(diff)}`, 'text-bad'];
    $('shiftResult').innerHTML = `
      <dt>Should be in the drawer</dt><dd>${peso(shift.expected_cash)}</dd>
      <dt>You counted</dt><dd>${peso(shift.counted_cash)}</dd>
      <dt>Difference</dt><dd class="${verdict[1]}">${verdict[0]}</dd>`;
    $('countStep').hidden = true;
    $('resultStep').hidden = false;
    $('resultDoneBtn').focus();
  } finally {
    $('countSubmitBtn').disabled = false;
  }
});

// Escape or Cancel: before the count, just closes; after it, the shift is
// already over, so it finishes signing out.
$('endShiftOverlay').querySelector('[data-close]').addEventListener('click', () => {
  if (!$('resultStep').hidden) $('resultDoneBtn').click();
});

$('resultDoneBtn').addEventListener('click', async () => {
  closeModal('endShiftOverlay');
  await signOut();
});

// ---------------------------------------------------------------------------
// Sync now: retries anything stuck, pushes what's waiting, and re-downloads
// the whole catalog. Works from the sign-in screen too.
// ---------------------------------------------------------------------------

async function syncNow() {
  const buttons = [$('syncNowBtn'), $('syncNowLoginBtn')];
  buttons.forEach((b) => { b.disabled = true; b.classList.add('is-busy'); });

  try {
    await retryFailedOutbox();
    await flushOutbox();
    if (await forceFullSync()) {
      const [items, staff] = await Promise.all([db.products.count(), db.users.count()]);
      toast(`Synced. This device has ${items} items and ${staff} staff accounts.`);
    } else if (await askForTerminalKey()) { // the server didn't take this till's key
      await forceFullSync();
      toast('Synced with the new key.');
    }

    if (session.user) await SCREENS.find((s) => s.key === activeView)?.render();
    else await renderStaffGrid();
  } catch (err) {
    toast(`Could not sync. ${err.message || 'Unknown error.'}`, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.classList.remove('is-busy'); });
  }
}

$('syncNowBtn').addEventListener('click', syncNow);
$('syncNowLoginBtn').addEventListener('click', syncNow);

// The published app keeps a copy of itself, so it still opens with the
// internet down (public/sw.js). Not in development, where files change.
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});

boot();
