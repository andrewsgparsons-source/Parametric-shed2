// FILE: docs/src/bom/index.js

export function renderBOM(sections) {
  const tbody = document.getElementById('bomTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const row of sections) {
    const tr = document.createElement('tr');

    // Backward compatible:
    // Legacy rows: [item, qty, L, W, notes]
    // New rows:    [item, qty, L, W, D, notes]
    const item = row && row.length ? row[0] : '';
    const qty = row && row.length > 1 ? row[1] : '';
    const L = row && row.length > 2 ? row[2] : '';
    const W = row && row.length > 3 ? row[3] : '';
    const hasDepth = row && row.length >= 6;
    const D = hasDepth ? row[4] : '';
    const notes = hasDepth ? row[5] : (row && row.length > 4 ? row[4] : '');

    appendCell(tr, item);
    appendCell(tr, String(qty));
    appendCell(tr, String(L));
    appendCell(tr, String(W));
    appendCell(tr, String(D));
    appendCell(tr, notes || '');
    tbody.appendChild(tr);
  }
}

function appendCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}
