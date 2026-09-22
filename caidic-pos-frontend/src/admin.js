// admin.js — the "admin can access everything" screens. Nothing in here
// enforces access on its own; every call these functions make hits an
// endpoint that runs its own Gate::authorize() server-side (see the
// Laravel routes/api.php). The nav filtering in main.js only decides what
// a person SEES, not what they're allowed to do — a cashier who somehow
// reached this screen would just get a 401/403 back from every call.

import { db } from './local-db.js';
import { searchProducts } from './input-handler.js';
import {
  loginWithPin,
  fetchActivityLog, fetchShifts, fetchSales, voidSaleAsAdmin,
  submitReturn, fetchTodayReconciliation, submitReconciliation,
  fetchMovers, submitCycleCount,
  fetchUsers, createUser, updateUser,
  setupTwoFactor, verifyTwoFactor, disableTwoFactor,
  fetchStock, updateProduct
} from './sync-worker.js';

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
export const fmtTime = (iso) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const NO_MATCH_NOTE = '<p class="placeholder-note" style="padding:6px 2px;">No matches. Try Sync Now if this item should be here.</p>';
const pinLengthFor = (role) => (role === 'owner' ? 6 : 4);

let adminUser = null;
export function setAdminUser(user) { adminUser = user; }

// ---------------------------------------------------------------------------
// SERVER-AUTH HELPER — every owner-gated call goes through this. If the
// Sanctum token is missing or was rejected, it prompts a PIN, exchanges it
// for a fresh token via loginWithPin(), then retries the original call
// exactly once. This is the one place a "confirm your PIN" popup should
// ever appear for these screens — callers below never handle auth directly.
// Exported so dashboard.js and inventory.js can reuse it instead of each
// building their own PIN-retry modal.
// ---------------------------------------------------------------------------

function promptForServerPin() {
  return new Promise((resolve, reject) => {
    const overlay = $('pinConfirmOverlay');
    const input = $('pinConfirmInput');
    const error = $('pinConfirmError');

    input.value = '';
    error.hidden = true;
    overlay.hidden = false;
    input.focus();

    const cleanup = () => {
      overlay.hidden = true;
      $('pinConfirmSubmit').removeEventListener('click', onSubmit);
      $('pinConfirmCancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
    };

    async function onSubmit() {
      try {
        await loginWithPin(adminUser.id, input.value);
        cleanup();
        resolve();
      } catch {
        error.textContent = "That didn't work. Wrong PIN, or no connection right now.";
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    }

    function onCancel() {
      cleanup();
      reject(new Error('PIN confirmation cancelled'));
    }

    function onKeydown(e) {
      if (e.key === 'Enter') onSubmit();
    }

    $('pinConfirmSubmit').addEventListener('click', onSubmit);
    $('pinConfirmCancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}

export async function withServerAuth(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.name !== 'AuthRequiredError' || err.kind !== 'user') throw err;
    await promptForServerPin(); // throws if cancelled, which correctly aborts the caller too
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// STAFF LOGS — owner only. Redesigned around accounts instead of a flat
// filtered table: one row per staff member, a View button that opens
// that person's own activity (when they clocked in and out, and
// everything logged in between, with the IP address it came from), and
// a Download button that saves just their most recent shift as a CSV
// file, not their whole history. Nothing here is editable — this screen
// only ever reads and exports, the same as the reference layout this
// was modeled on.
// ---------------------------------------------------------------------------

let logAccounts = [];
let currentLogAccount = null;

export async function renderActivity() {
  $('staffLogsDetailCard').hidden = true;
  $('staffLogsListCard').hidden = false;

  const tbody = $('staffLogsAccountsTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Loading...</td></tr>';

  try {
    logAccounts = await withServerAuth(() => fetchUsers());
    tbody.innerHTML = logAccounts.length
      ? logAccounts.map((u) => `
          <tr>
            <td>${u.full_name}</td>
            <td>${u.role}</td>
            <td>
              <button type="button" class="btn-secondary" data-view-account="${u.id}">View</button>
              <button type="button" class="btn-secondary" data-download-account="${u.id}">Download</button>
            </td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="3">No staff accounts yet.</td></tr>';

    tbody.querySelectorAll('[data-view-account]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const user = logAccounts.find((u) => u.id === btn.dataset.viewAccount);
        if (user) openAccountLog(user);
      });
    });
    tbody.querySelectorAll('[data-download-account]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const user = logAccounts.find((u) => u.id === btn.dataset.downloadAccount);
        if (user) await downloadLastShift(btn, user);
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load. ${err.message}</td></tr>`;
  }
}

async function openAccountLog(user) {
  currentLogAccount = user;
  $('staffLogsListCard').hidden = true;
  $('staffLogsDetailCard').hidden = false;
  $('staffLogsDetailTitle').textContent = user.full_name;

  const shiftsBody = $('staffLogsShiftsTable').querySelector('tbody');
  shiftsBody.innerHTML = '<tr class="empty-row"><td colspan="3">Loading...</td></tr>';
  const activityBody = $('staffLogsActivityTable').querySelector('tbody');
  activityBody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading...</td></tr>';

  try {
    const shiftResult = await withServerAuth(() => fetchShifts({ cashier_id: user.id }));
    const shifts = (shiftResult.data ?? shiftResult).slice(0, 10);
    shiftsBody.innerHTML = shifts.length
      ? shifts.map((s) => `
          <tr>
            <td>${fmtTime(s.started_at)}</td>
            <td>${s.ended_at ? fmtTime(s.ended_at) : 'Still open'}</td>
            <td>${s.status}</td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="3">No shifts yet.</td></tr>';
  } catch (err) {
    shiftsBody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load. ${err.message}</td></tr>`;
  }

  try {
    const result = await withServerAuth(() => fetchActivityLog({ actor_id: user.id }));
    const rows = result.data ?? result;
    activityBody.innerHTML = rows.length
      ? rows.map((r) => `
          <tr>
            <td>${fmtTime(r.client_created_at)}</td>
            <td>${r.event_type.replace(/_/g, ' ')}</td>
            <td>${r.entity_type ?? ''}</td>
            <td>${r.ip_address ?? '\u2014'}</td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="4">No activity recorded yet.</td></tr>';
  } catch (err) {
    activityBody.innerHTML = `<tr class="empty-row"><td colspan="4">Couldn't load. ${err.message}</td></tr>`;
  }
}

$('staffLogsBackBtn').addEventListener('click', renderActivity);

// Saves just the most recent shift's activity as a CSV file — not the
// account's whole history — matching "download" being a quick recent
// check, not a full export.
async function downloadLastShift(button, user) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';

  try {
    const shiftResult = await withServerAuth(() => fetchShifts({ cashier_id: user.id }));
    const shifts = shiftResult.data ?? shiftResult;

    if (!shifts.length) {
      window.alert(`${user.full_name} has no shifts yet.`);
      return;
    }

    const lastShift = shifts[0]; // already sorted newest first by the server
    const activityResult = await withServerAuth(() => fetchActivityLog({ shift_id: lastShift.id }));
    const rows = activityResult.data ?? activityResult;

    const header = ['Date & Time', 'Activity', 'Entity', 'IP Address'];
    const lines = [header.map(csvCell).join(',')];
    rows.forEach((r) => {
      lines.push([
        fmtTime(r.client_created_at),
        r.event_type.replace(/_/g, ' '),
        r.entity_type ?? '',
        r.ip_address ?? '',
      ].map(csvCell).join(','));
    });

    downloadTextFile(`${slugify(user.full_name)}-last-shift.csv`, lines.join('\r\n'));
  } catch (err) {
    window.alert(`Couldn't prepare the download. ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'staff';
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// SHIFTS — "how much did this shift make", and admin void. manager+owner.
// ---------------------------------------------------------------------------

export async function renderShifts() {
  $('shiftDetailCard').hidden = true;
  $('shiftsListCard').hidden = false;

  const tbody = $('shiftsTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';

  try {
    const result = await withServerAuth(() => fetchShifts());
    const shifts = result.data ?? result;

    tbody.innerHTML = shifts.length
      ? shifts.map((s) => `
          <tr class="clickable-row" data-shift="${s.id}">
            <td>${fmtTime(s.started_at)}</td>
            <td>${s.cashier?.full_name ?? '\u2014'}</td>
            <td>${s.status}</td>
            <td class="amt-cell">${peso(s.opening_cash)}</td>
            <td class="amt-cell">${peso(s.sales_total ?? 0)}</td>
            <td>${s.cash_discrepancy != null ? peso(s.cash_discrepancy) : '\u2014'}</td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="6">No shifts yet.</td></tr>';

    tbody.querySelectorAll('[data-shift]').forEach((row) => {
      row.addEventListener('click', () => renderShiftDetail(row.dataset.shift, shifts.find((s) => s.id === row.dataset.shift)));
    });
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Couldn't load. ${err.message}</td></tr>`;
  }
}

async function renderShiftDetail(shiftId, shiftRow) {
  $('shiftsListCard').hidden = true;
  $('shiftDetailCard').hidden = false;
  $('shiftDetailTitle').textContent = `Sales for ${shiftRow?.cashier?.full_name ?? 'shift'}, ${fmtTime(shiftRow?.started_at)}`;

  const tbody = $('shiftSalesTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';

  const result = await withServerAuth(() => fetchSales({ shift_id: shiftId }));
  const sales = result.data ?? result;

  const draw = () => {
    tbody.innerHTML = sales.length
      ? sales.map((s) => `
          <tr>
            <td>${fmtTime(s.client_created_at)}</td>
            <td class="amt-cell">${peso(s.total_amount)}</td>
            <td>${s.payment_method}</td>
            <td>${s.status}</td>
            <td>${s.status === 'completed' ? `<button type="button" class="btn-void" data-void="${s.id}">Void</button>` : ''}</td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="5">No sales on this shift.</td></tr>';

    tbody.querySelectorAll('[data-void]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = window.prompt('Reason for voiding this sale:');
        if (!reason) return;
        await withServerAuth(() => voidSaleAsAdmin(btn.dataset.void, reason));
        renderShiftDetail(shiftId, shiftRow);
      });
    });
  };

  draw();
}

$('backToShifts').addEventListener('click', renderShifts);

// ---------------------------------------------------------------------------
// VOID — a focused list of completed sales, separate from browsing shift
// by shift. Same voidSaleAsAdmin() call the Shift detail view already
// used; this just surfaces it as its own screen per the new sidebar.
// manager+owner.
// ---------------------------------------------------------------------------

export async function renderVoid() {
  await loadVoidableSales();
}

async function loadVoidableSales() {
  const tbody = $('voidTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const result = await withServerAuth(() => fetchSales({ status: 'completed' }));
    const sales = result.data ?? result;
    drawVoidTable(sales);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Couldn't load. ${err.message}</td></tr>`;
  }
}

function drawVoidTable(sales) {
  const tbody = $('voidTable').querySelector('tbody');
  tbody.innerHTML = sales.length
    ? sales.map((s) => `
        <tr>
          <td>${fmtTime(s.client_created_at)}</td>
          <td>${s.cashier?.full_name ?? '\u2014'}</td>
          <td class="amt-cell">${peso(s.total_amount)}</td>
          <td>${s.payment_method}</td>
          <td><button type="button" class="btn-void" data-void="${s.id}">Void</button></td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="5">Nothing to void right now.</td></tr>';

  tbody.querySelectorAll('[data-void]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reason = window.prompt('Reason for voiding this sale:');
      if (!reason) return;
      await withServerAuth(() => voidSaleAsAdmin(btn.dataset.void, reason));
      loadVoidableSales();
    });
  });
}

// ---------------------------------------------------------------------------
// RETURNS — owner only. A return needs a reason or receipt number before
// it can be accepted — this is the "proof" requirement, enforced on the
// server too.
// ---------------------------------------------------------------------------

let selectedReturnProduct = null;

export function renderReturns() {
  $('retProductSearch').value = '';
  $('retProductResults').innerHTML = '';
  $('retSelectedProduct').textContent = 'None selected';
  selectedReturnProduct = null;
  $('retQuantity').value = 1;
  $('retReason').value = '';
  $('retStatus').textContent = '';
  $('retStatus').className = 'form-status';
}

$('retProductSearch').addEventListener('input', async (e) => {
  const query = e.target.value;
  const hits = await searchProducts(query);
  $('retProductResults').innerHTML = hits.length
    ? hits.map((p) => `<button type="button" class="search-hit" data-id="${p.id}" data-name="${p.name}">${p.name} (${p.sku})</button>`).join('')
    : (query.trim() ? NO_MATCH_NOTE : '');
  $('retProductResults').querySelectorAll('.search-hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedReturnProduct = { id: btn.dataset.id, name: btn.dataset.name };
      $('retSelectedProduct').textContent = btn.dataset.name;
      $('retProductSearch').value = '';
      $('retProductResults').innerHTML = '';
    });
  });
});

$('retSubmitBtn').addEventListener('click', async () => {
  const status = $('retStatus');
  if (!selectedReturnProduct) {
    status.textContent = 'Pick a product first.';
    status.className = 'form-status err';
    return;
  }

  const reason = $('retReason').value.trim();
  if (!reason) {
    status.textContent = 'Please write the receipt number or a reason first. This is needed as proof for the return.';
    status.className = 'form-status err';
    return;
  }

  const condition = document.querySelector('input[name="retCondition"]:checked').value;

  try {
    await withServerAuth(() => submitReturn({
      id: crypto.randomUUID(),
      product_id: selectedReturnProduct.id,
      quantity_returned: Number($('retQuantity').value),
      condition,
      reason,
      client_created_at: new Date().toISOString()
    }));
    status.textContent = `Return accepted: ${selectedReturnProduct.name} (${condition}).`;
    status.className = 'form-status ok';
    renderReturns();
  } catch (err) {
    status.textContent = `Failed. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---------------------------------------------------------------------------
// RECONCILIATION — owner only.
// ---------------------------------------------------------------------------

export async function renderReconciliation() {
  $('recSystemOut').textContent = '\u2026';
  $('recSystemIn').textContent = '\u2026';
  $('recStatus').textContent = '';
  $('recStatus').className = 'form-status';

  try {
    const today = new Date().toISOString().slice(0, 10);
    const totals = await withServerAuth(() => fetchTodayReconciliation(today));
    $('recSystemOut').textContent = totals.system_qty_out;
    $('recSystemIn').textContent = totals.system_qty_in;
  } catch (err) {
    $('recSystemOut').textContent = '-';
    $('recSystemIn').textContent = '-';
  }
}

$('recSubmitBtn').addEventListener('click', async () => {
  const status = $('recStatus');
  try {
    const result = await withServerAuth(() => submitReconciliation({
      id: crypto.randomUUID(),
      business_date: new Date().toISOString().slice(0, 10),
      physical_qty_out: Number($('recPhysicalOut').value),
      physical_qty_in: Number($('recPhysicalIn').value),
      notes: $('recNotes').value || null,
      client_created_at: new Date().toISOString()
    }));
    status.textContent = result.status === 'matched'
      ? 'Matched. Day closed clean.'
      : `Discrepancy logged (out: ${result.discrepancy_out}, in: ${result.discrepancy_in}). Acknowledged.`;
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Failed. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---------------------------------------------------------------------------
// ANALYTICS — Top 10 / Bottom 5 movers, and cycle-count entry. Owner only.
// ---------------------------------------------------------------------------

export async function renderAnalytics() {
  const fastBody = $('fastMoversTable').querySelector('tbody');
  const slowBody = $('slowMoversTable').querySelector('tbody');
  fastBody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  slowBody.innerHTML = '';

  try {
    const data = await withServerAuth(() => fetchMovers(7));
    fastBody.innerHTML = moversRows(data.top_movers, 'top_mover');
    slowBody.innerHTML = moversRows(data.slow_movers, 'slow_mover');
    wireCycleCountRows();
  } catch (err) {
    fastBody.innerHTML = `<tr class="empty-row"><td colspan="5">Couldn't load. ${err.message}</td></tr>`;
  }
}

function moversRows(items, reason) {
  if (!items.length) return '<tr class="empty-row"><td colspan="5">Nothing in this window yet.</td></tr>';
  return items.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td class="amt-cell">${p.units_moved}</td>
      <td class="amt-cell" id="sysqty-${p.id}">-</td>
      <td><input type="number" class="cycle-input" step="0.001" data-count-product="${p.id}" data-reason="${reason}" placeholder="count"></td>
      <td><button type="button" class="btn-secondary" data-count-submit="${p.id}">Save</button></td>
    </tr>`).join('');
}

function wireCycleCountRows() {
  document.querySelectorAll('[data-count-submit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const productId = btn.dataset.countSubmit;
      const input = document.querySelector(`[data-count-product="${productId}"]`);
      const reason = input.dataset.reason;
      if (!input.value) return;

      try {
        const result = await withServerAuth(() => submitCycleCount({
          id: crypto.randomUUID(),
          business_date: new Date().toISOString().slice(0, 10),
          product_id: productId,
          reason,
          physical_quantity: Number(input.value),
          client_created_at: new Date().toISOString()
        }));
        const sysCell = $(`sysqty-${productId}`);
        sysCell.textContent = result.system_quantity;
        sysCell.className = 'amt-cell ' + (Math.abs(result.variance) < 0.001 ? 'variance-ok' : 'variance-bad');
      } catch (err) {
        window.alert(`Couldn't save count. ${err.message}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// STAFF — manager+owner. Deactivating someone asks for confirmation
// first. Edit lets any of a staff member's details be changed, including
// resetting a PIN — this is also how an owner changes their own PIN.
// Owner accounts get a 6-digit PIN and can turn on two-factor login with
// Google Authenticator; cashier and manager accounts stay at 4 digits.
// ---------------------------------------------------------------------------

let editingStaffId = null;
let editingStaffUser = null;

export async function renderStaff() {
  $('usrStatus').textContent = '';
  $('usrStatus').className = 'form-status';
  applyPinFieldFor('usrRole', 'usrPin');

  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading...</td></tr>';

  try {
    const users = await withServerAuth(() => fetchUsers());
    drawStaffTable(users);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Couldn't load. ${err.message}</td></tr>`;
  }
}

function applyPinFieldFor(roleSelectId, pinInputId) {
  const isOwner = $(roleSelectId).value === 'owner';
  const len = pinLengthFor($(roleSelectId).value);
  $(pinInputId).maxLength = len;
  $(pinInputId).placeholder = isOwner ? `${len}-digit PIN` : `${len}-digit PIN`;
}

$('usrRole').addEventListener('change', () => applyPinFieldFor('usrRole', 'usrPin'));

function drawStaffTable(users) {
  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${u.full_name}</td>
      <td>${u.role}${u.role === 'owner' && u.totp_enabled ? ' (2FA on)' : ''}</td>
      <td>${u.is_active ? 'Active' : 'Inactive'}</td>
      <td>
        <button type="button" class="btn-secondary" data-edit-staff="${u.id}">Edit</button>
        <button type="button" class="btn-secondary" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-edit-staff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = users.find((u) => u.id === btn.dataset.editStaff);
      if (user) openEditStaffModal(user);
    });
  });

  tbody.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowActive = btn.dataset.active === 'true';
      if (nowActive && !window.confirm('Are you sure you want to deactivate this staff member? They will not be able to log in until reactivated.')) {
        return;
      }
      await withServerAuth(() => updateUser(btn.dataset.toggle, { is_active: !nowActive }));
      renderStaff();
    });
  });
}

function openEditStaffModal(user) {
  editingStaffId = user.id;
  editingStaffUser = { ...user };
  $('editStaffName').value = user.full_name;
  $('editStaffRole').value = user.role;
  $('editStaffPin').value = '';
  applyPinFieldFor('editStaffRole', 'editStaffPin');
  $('editStaffStatus').textContent = '';
  $('editStaffStatus').className = 'form-status';

  refreshTwoFaSection();
  $('editStaffOverlay').hidden = false;
}

function refreshTwoFaSection() {
  const isOwner = $('editStaffRole').value === 'owner';
  $('editStaffTwoFaSection').hidden = !isOwner;
  if (!isOwner) return;
  const enabled = !!editingStaffUser?.totp_enabled;
  $('editStaffTwoFaStatus').textContent = enabled ? 'On' : 'Off';
  $('editStaffTwoFaToggle').textContent = enabled ? 'Turn Off' : 'Set Up';
}

$('editStaffRole').addEventListener('change', () => {
  applyPinFieldFor('editStaffRole', 'editStaffPin');
  refreshTwoFaSection();
});

$('editStaffCancelBtn').addEventListener('click', () => { $('editStaffOverlay').hidden = true; });

$('editStaffSubmitBtn').addEventListener('click', async () => {
  const status = $('editStaffStatus');
  const full_name = $('editStaffName').value.trim();
  const role = $('editStaffRole').value;
  const pin = $('editStaffPin').value.trim();
  const expectedLen = pinLengthFor(role);

  if (!full_name) {
    status.textContent = 'Name cannot be empty.';
    status.className = 'form-status err';
    return;
  }
  if (pin && pin.length !== expectedLen) {
    status.textContent = `A new PIN for this role must be exactly ${expectedLen} digits, or left blank to keep the current one.`;
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => updateUser(editingStaffId, { full_name, role, ...(pin ? { pin } : {}) }));
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
    setTimeout(() => { $('editStaffOverlay').hidden = true; }, 500);
    renderStaff();
  } catch (err) {
    status.textContent = `Couldn't save. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---- Two-factor setup, from inside Edit Staff, owner accounts only ----

$('editStaffTwoFaToggle').addEventListener('click', async () => {
  if (!editingStaffUser) return;

  if (editingStaffUser.totp_enabled) {
    if (!window.confirm('Turn off two-factor login for this account? They will only need their PIN to sign in after this.')) return;
    try {
      await withServerAuth(() => disableTwoFactor(editingStaffId));
      editingStaffUser.totp_enabled = false;
      refreshTwoFaSection();
    } catch (err) {
      window.alert(`Couldn't turn off two-factor login. ${err.message}`);
    }
    return;
  }

  try {
    const { secret } = await withServerAuth(() => setupTwoFactor(editingStaffId));
    openTwoFaModal(secret);
  } catch (err) {
    window.alert(`Couldn't start setup. ${err.message}`);
  }
});

function formatSecretForDisplay(secret) {
  return (secret.match(/.{1,4}/g) || [secret]).join(' ');
}

function openTwoFaModal(secret) {
  $('twoFaSecretDisplay').textContent = formatSecretForDisplay(secret);
  $('twoFaConfirmCode').value = '';
  $('twoFaStatus').textContent = '';
  $('twoFaStatus').className = 'form-status';
  $('twoFaOverlay').hidden = false;
}

$('twoFaCancelBtn').addEventListener('click', () => { $('twoFaOverlay').hidden = true; });

$('twoFaConfirmBtn').addEventListener('click', async () => {
  const status = $('twoFaStatus');
  const code = $('twoFaConfirmCode').value.trim();

  if (code.length !== 6) {
    status.textContent = 'Enter the 6-digit code shown in the authenticator app.';
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => verifyTwoFactor(editingStaffId, code));
    status.textContent = 'Turned on.';
    status.className = 'form-status ok';
    editingStaffUser.totp_enabled = true;
    refreshTwoFaSection();
    setTimeout(() => { $('twoFaOverlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = `Couldn't confirm. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---- Add staff ----

$('usrAddBtn').addEventListener('click', async () => {
  const status = $('usrStatus');
  const full_name = $('usrName').value.trim();
  const pin = $('usrPin').value.trim();
  const role = $('usrRole').value;
  const expectedLen = pinLengthFor(role);

  if (!full_name || pin.length !== expectedLen) {
    status.textContent = `Name and a ${expectedLen}-digit PIN are both required for this role.`;
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => createUser({ full_name, role, pin }));
    status.textContent = `Added ${full_name}.`;
    status.className = 'form-status ok';
    $('usrName').value = '';
    $('usrPin').value = '';
    renderStaff();
  } catch (err) {
    status.textContent = `Failed. ${err.message}`;
    status.className = 'form-status err';
  }
});

// ---------------------------------------------------------------------------
// ARCHIVES — a read-only view of what's already archived across Products
// and Staff. No purge, here or anywhere in this app — archived just means
// hidden from the main list and fully restorable, same as it's always
// worked. Reuses fetchStock/updateProduct and fetchUsers/updateUser; no
// new backend calls needed for this screen.
// ---------------------------------------------------------------------------

export async function renderArchives() {
  const itemsBody = $('archivedItemsTable').querySelector('tbody');
  const staffBody = $('archivedStaffTable').querySelector('tbody');
  itemsBody.innerHTML = '<tr class="empty-row"><td colspan="3">Loading...</td></tr>';
  staffBody.innerHTML = '<tr class="empty-row"><td colspan="3">Loading...</td></tr>';

  try {
    const allStock = await withServerAuth(() => fetchStock(true));
    const archivedItems = allStock.filter((r) => !r.is_active);
    itemsBody.innerHTML = archivedItems.length
      ? archivedItems.map((r) => `
          <tr>
            <td>${r.name}</td>
            <td class="sku-tag">${r.sku}</td>
            <td><button type="button" class="btn-secondary" data-restore-item="${r.id}">Restore</button></td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="3">Nothing archived.</td></tr>';

    itemsBody.querySelectorAll('[data-restore-item]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await withServerAuth(() => updateProduct(btn.dataset.restoreItem, { is_active: true }));
        renderArchives();
      });
    });
  } catch (err) {
    itemsBody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load. ${err.message}</td></tr>`;
  }

  try {
    const allStaff = await withServerAuth(() => fetchUsers());
    const archivedStaff = allStaff.filter((u) => !u.is_active);
    staffBody.innerHTML = archivedStaff.length
      ? archivedStaff.map((u) => `
          <tr>
            <td>${u.full_name}</td>
            <td>${u.role}</td>
            <td><button type="button" class="btn-secondary" data-restore-staff="${u.id}">Restore</button></td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="3">Nothing archived.</td></tr>';

    staffBody.querySelectorAll('[data-restore-staff]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await withServerAuth(() => updateUser(btn.dataset.restoreStaff, { is_active: true }));
        renderArchives();
      });
    });
  } catch (err) {
    staffBody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load. ${err.message}</td></tr>`;
  }
}
