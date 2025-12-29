// src/bom/index.js

export function renderBOM(sections) {
  const tbody = document.getElementById('bomTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const row of sections) {
    const tr = document.createElement('tr');
    const [item, qty, L, W, notes] = row;
    appendCell(tr, item);
    appendCell(tr, String(qty));
    appendCell(tr, String(L));
    appendCell(tr, String(W));
    appendCell(tr, notes || '');
    tbody.appendChild(tr);
  }
}

function appendCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}
