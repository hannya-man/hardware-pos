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
  fetchUsers, createUser, updateUser
} from './sync-worker.js';

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
const fmtTime = (iso) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let adminUser = null;
export function setAdminUser(user) { adminUser = user; }

// ---------------------------------------------------------------------------
// SERVER-AUTH HELPER — every owner-gated call goes through this. If the
// Sanctum token is missing or was rejected, it prompts a PIN, exchanges it
// for a fresh token via loginWithPin(), then retries the original call
// exactly once. This is the one place a "confirm your PIN" popup should
// ever appear for these screens — callers below never handle auth directly.
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
        error.textContent = "That didn't work — wrong PIN, or no connection right now.";
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

async function withServerAuth(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.name !== 'AuthRequiredError' || err.kind !== 'user') throw err;
    await promptForServerPin(); // throws if cancelled, which correctly aborts the caller too
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// ACTIVITY LOG — owner only (server-enforced via view-activity-log)
// ---------------------------------------------------------------------------

export async function renderActivity() {
  const eventType = $('actEventType').value;
  const tbody = $('activityTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading...</td></tr>';

  try {
    const result = await withServerAuth(() => fetchActivityLog(eventType ? { event_type: eventType } : {}));
    const rows = result.data ?? result;

    tbody.innerHTML = rows.length
      ? rows.map((r) => `
          <tr>
            <td>${fmtTime(r.client_created_at)}</td>
            <td>${r.actor_id ? r.actor_id.slice(0, 8) : '\u2014'}</td>
            <td>${r.event_type.replace(/_/g, ' ')}</td>
            <td>${r.entity_type ?? ''}</td>
          </tr>`).join('')
      : '<tr class="empty-row"><td colspan="4">No activity in this range.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Couldn't load — ${err.message}</td></tr>`;
  }
}

$('actFilterBtn').addEventListener('click', renderActivity);

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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Couldn't load — ${err.message}</td></tr>`;
  }
}

async function renderShiftDetail(shiftId, shiftRow) {
  $('shiftsListCard').hidden = true;
  $('shiftDetailCard').hidden = false;
  $('shiftDetailTitle').textContent = `Sales \u2014 ${shiftRow?.cashier?.full_name ?? 'shift'}, ${fmtTime(shiftRow?.started_at)}`;

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
// RETURNS — owner only.
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
  const hits = await searchProducts(e.target.value);
  $('retProductResults').innerHTML = hits.map((p) => `
    <button type="button" class="search-hit" data-id="${p.id}" data-name="${p.name}">${p.name} \u2014 ${p.sku}</button>
  `).join('');
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

  const condition = document.querySelector('input[name="retCondition"]:checked').value;

  try {
    await withServerAuth(() => submitReturn({
      id: crypto.randomUUID(),
      product_id: selectedReturnProduct.id,
      quantity_returned: Number($('retQuantity').value),
      condition,
      reason: $('retReason').value || null,
      client_created_at: new Date().toISOString()
    }));
    status.textContent = `Return accepted \u2014 ${selectedReturnProduct.name} (${condition}).`;
    status.className = 'form-status ok';
    renderReturns();
  } catch (err) {
    status.textContent = `Failed \u2014 ${err.message}`;
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
    $('recSystemOut').textContent = '\u2014';
    $('recSystemIn').textContent = '\u2014';
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
      ? 'Matched \u2014 day closed clean.'
      : `Discrepancy logged (out: ${result.discrepancy_out}, in: ${result.discrepancy_in}) \u2014 acknowledged.`;
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Failed \u2014 ${err.message}`;
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
    fastBody.innerHTML = `<tr class="empty-row"><td colspan="5">Couldn't load — ${err.message}</td></tr>`;
  }
}

function moversRows(items, reason) {
  if (!items.length) return '<tr class="empty-row"><td colspan="5">Nothing in this window yet.</td></tr>';
  return items.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td class="amt-cell">${p.units_moved}</td>
      <td class="amt-cell" id="sysqty-${p.id}">\u2014</td>
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
        window.alert(`Couldn't save count \u2014 ${err.message}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// STAFF — manager+owner.
// ---------------------------------------------------------------------------

export async function renderStaff() {
  $('usrStatus').textContent = '';
  $('usrStatus').className = 'form-status';

  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading...</td></tr>';

  try {
    const users = await withServerAuth(() => fetchUsers());
    drawStaffTable(users);
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Couldn't load — ${err.message}</td></tr>`;
  }
}

function drawStaffTable(users) {
  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${u.full_name}</td>
      <td>${u.role}</td>
      <td>${u.is_active ? 'Active' : 'Inactive'}</td>
      <td><button type="button" class="btn-secondary" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowActive = btn.dataset.active === 'true';
      await withServerAuth(() => updateUser(btn.dataset.toggle, { is_active: !nowActive }));
      renderStaff();
    });
  });
}

$('usrAddBtn').addEventListener('click', async () => {
  const status = $('usrStatus');
  const full_name = $('usrName').value.trim();
  const pin = $('usrPin').value.trim();

  if (!full_name || pin.length !== 4) {
    status.textContent = 'Name and a 4-digit PIN are both required.';
    status.className = 'form-status err';
    return;
  }

  try {
    await withServerAuth(() => createUser({ full_name, role: $('usrRole').value, pin }));
    status.textContent = `Added ${full_name}.`;
    status.className = 'form-status ok';
    $('usrName').value = '';
    $('usrPin').value = '';
    renderStaff();
  } catch (err) {
    status.textContent = `Failed \u2014 ${err.message}`;
    status.className = 'form-status err';
  }
});