// receipt.js — builds and prints a receipt right after a sale completes.
// Uses the browser's own print dialog (window.print()), styled narrow and
// monospace to read like actual receipt paper.
//
// IMPORTANT SCOPE NOTE: this prints through whatever printer is set up in
// Windows — a receipt printer installed as a regular Windows printer works
// fine, and most thermal printer drivers report their own roll width so
// the browser sizes the page correctly on their own. This does NOT speak
// raw ESC/POS commands to a thermal printer directly; that needs either a
// native bridge (outside a browser tab's reach) or a local print-server
// companion app, neither of which exists here. On a regular printer this
// just prints a narrow column on a normal sheet, which is fine too.

const $ = (id) => document.getElementById(id);
const peso = (n) => '\u20b1' + Number(n).toFixed(2);
const fmtReceiptTime = (iso) => new Date(iso).toLocaleString('en-PH', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

export function printReceipt({
  saleId, cashierName, cart, subtotal, taxAmount, totalAmount,
  paymentMethod, amountTendered, changeAmount
}) {
  $('receiptLines').innerHTML = cart.map((line) => `
    <div class="receipt-line">
      <div class="receipt-line-name">${line.name_snapshot}</div>
      <div class="receipt-line-detail">
        <span>${line.quantity} x ${peso(line.unit_price_snapshot)}</span>
        <span>${peso(line.line_total)}</span>
      </div>
    </div>`).join('');

  $('receiptTotals').innerHTML = `
    <div class="receipt-total-row"><span>Subtotal</span><span>${peso(subtotal)}</span></div>
    <div class="receipt-total-row"><span>VAT (12%)</span><span>${peso(taxAmount)}</span></div>
    <div class="receipt-total-row receipt-grand"><span>TOTAL</span><span>${peso(totalAmount)}</span></div>
    ${paymentMethod === 'cash' ? `
      <div class="receipt-total-row"><span>Cash</span><span>${peso(amountTendered)}</span></div>
      <div class="receipt-total-row"><span>Change</span><span>${peso(changeAmount)}</span></div>
    ` : ''}
  `;

  $('receiptMeta').innerHTML = `
    <div>${fmtReceiptTime(new Date().toISOString())}</div>
    <div>Cashier: ${cashierName}</div>
    <div>Receipt #${saleId.slice(0, 8).toUpperCase()}</div>
  `;

  document.body.classList.add('printing-receipt');
  window.print();

  // A 2s fallback in case afterprint doesn't fire in some browser: without
  // this, leaving 'printing-receipt' stuck on <body> would make the NEXT
  // print job (e.g. Price List) incorrectly show only the receipt area.
  setTimeout(() => document.body.classList.remove('printing-receipt'), 2000);
}

// afterprint fires once the dialog closes, whether the person actually
// printed or cancelled — the normal, immediate cleanup path. The timeout
// above is just a safety net for browsers that skip it.
window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-receipt');
});
