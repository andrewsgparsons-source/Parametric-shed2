// src/elements/base.js
// 3D + Cutting List for Base (ported 1:1 from reference single-file)
import { CONFIG } from '../params.js';

let shedRoot = null;
/** @type {{ base:BABYLON.Mesh[], frame:BABYLON.Mesh[], ins:BABYLON.Mesh[], deck:BABYLON.Mesh[] }} */
let meshes = { base: [], frame: [], ins: [], deck: [] };

function getLayout(state) {
  const isWShort = state.w < state.d;
  const rimLen = isWShort ? state.d : state.w;
  const joistSpan = isWShort ? state.w : state.d;
  const innerJoistLen = joistSpan - (CONFIG.timber.w * 2);
  const positions = [CONFIG.timber.w / 2];
  let cursor = CONFIG.spacing;
  while (cursor < rimLen - CONFIG.timber.w) {
    positions.push(cursor);
    cursor += CONFIG.spacing;
  }
  positions.push(rimLen - CONFIG.timber.w / 2);
  return { isWShort, rimLen, joistSpan, innerJoistLen, positions };
}

export function updateBOM(state) {
  const unitsMode = (document.getElementById("unitsSelect")?.value) || "mm";
  const L = getLayout(state);

  function mmToInFracStr(mm) {
    const inches = mm / 25.4;
    const whole = Math.floor(inches);
    const frac = Math.round((inches - whole) * 16);
    const adjWhole = frac === 16 ? whole + 1 : whole;
    const adjFrac = frac === 16 ? 0 : frac;
    return adjFrac === 0 ? `${adjWhole}"` : `${adjWhole}-${adjFrac}/16"`;
  }
  function fmtSize(a, b) {
    const mmTxt = `${a}mm × ${b}mm}`;
    // fix stray brace from reference? maintain original behavior
    const mmBase = `${a}mm × ${b}mm`;
    if (unitsMode !== "both") return mmBase;
    return `${mmBase} (${mmToInFracStr(a)} × ${mmToInFracStr(b)})`;
  }
  function fmtLenOnly(a) {
    const mmTxt = `${a}mm`;
    if (unitsMode !== "both") return mmTxt;
    return `${mmTxt} (${mmToInFracStr(a)})`;
  }

  const csvRows = [];
  function pushCsv(section, item, qty, Lmm, Wmm, notes) {
    const Lin = (Lmm ? mmToInFracStr(Lmm) : "");
    const Win = (Wmm ? mmToInFracStr(Wmm) : "");
    csvRows.push([section, item, qty, Lmm || "", Wmm || "", Lin, Win, notes || ""]);
  }

  // ----- Timber -----
  let timberHtml = "";
  let timberCount = 0;

  // Rim Joists (2)
  timberHtml += `<tr><td>Rim Joists</td><td>2</td><td class="highlight">${fmtLenOnly(L.rimLen)}</td><td>Section 50×100</td></tr>`;
  pushCsv("Timber Frame", "Rim Joist", 2, L.rimLen, "", "50×100 section");
  timberCount += 2;

  // Inner Joists (count = positions.length)
  timberHtml += `<tr><td>Inner Joists</td><td>${L.positions.length}</td><td class="highlight">${fmtLenOnly(L.innerJoistLen)}</td><td>Section 50×100</td></tr>`;
  pushCsv("Timber Frame", "Inner Joist", L.positions.length, L.innerJoistLen, "", "50×100 section");
  timberCount += L.positions.length;

  document.getElementById("timberTableBody").innerHTML = timberHtml;
  document.getElementById("timberTotals").textContent = `Total pieces: ${timberCount}`;

  // ----- OSB Decking (mirror 3D placement) -----
  const sheetShort = CONFIG.decking.w;   // 1220
  const sheetLong  = CONFIG.decking.d;   // 2440
  const joistsAlongX = L.isWShort;
  const sheetX = joistsAlongX ? sheetShort : sheetLong;
  const sheetZ = joistsAlongX ? sheetLong  : sheetShort;
  const fullCols = Math.floor(state.w / sheetX);
  const fullRows = Math.floor(state.d / sheetZ);
  const rectW = fullCols * sheetX;
  const rectD = fullRows * sheetZ;

  const osbMap = {};

  // Full-sheet rectangle counts
  if (fullCols > 0 && fullRows > 0) {
    const fullCount = fullCols * fullRows;
    const keyFull = `${sheetX}x${sheetZ}`;
    osbMap[keyFull] = (osbMap[keyFull] || 0) + fullCount;
  }

  // Bottom strip with staggering
  {
    let rowIndex = 0;
    for (let z = rectD; z < state.d; z += sheetZ) {
      const sd = Math.min(sheetZ, state.d - z);
      const offset = (rowIndex % 2 === 1) ? (sheetX / 2) : 0;
      for (let x = -offset; x < state.w; x += sheetX) {
        const drawXStart = Math.max(0, x);
        const drawXEnd   = Math.min(state.w, x + sheetX);
        const sw = Math.round(drawXEnd - drawXStart);
        const sh = Math.round(sd);
        if (sw > 10 && sh > 10) {
          const key = `${sw}x${sh}`;
          osbMap[key] = (osbMap[key] || 0) + 1;
        }
      }
      rowIndex++;
    }
  }

  // Right strip with staggering
  {
    let rowIndex = 0;
    for (let z = 0; z < rectD; z += sheetZ) {
      const sd = Math.min(sheetZ, rectD - z);
      const offset = (rowIndex % 2 === 1) ? (sheetX / 2) : 0;
      for (let x = rectW - offset; x < state.w; x += sheetX) {
        const drawXStart = Math.max(rectW, x);
        const drawXEnd   = Math.min(state.w, x + sheetX);
        const sw = Math.round(drawXEnd - drawXStart);
        const sh = Math.round(sd);
        if (sw > 10 && sh > 10) {
          const key = `${sw}x${sh}`;
          osbMap[key] = (osbMap[key] || 0) + 1;
        }
      }
      rowIndex++;
    }
  }

  const osbStd = {};
  const osbRip = {};
  Object.keys(osbMap).forEach(key => {
    const [wStr, hStr] = key.split('x');
    const w = parseInt(wStr, 10);
    const h = parseInt(hStr, 10);
    const isFull = (w === sheetX && h === sheetZ);
    if (isFull) osbStd[key] = (osbStd[key] || 0) + osbMap[key];
    else osbRip[key] = (osbRip[key] || 0) + osbMap[key];
  });

  function renderOsbTable(map, bodyId, totalsId, label) {
    let html = "";
    let count = 0;
    Object.keys(map).sort((a,b)=> {
      const [aw,ah]=a.split('x').map(Number), [bw,bh]=b.split('x').map(Number);
      return ah-bh || aw-bw;
    }).forEach(key => {
      const [wStr, hStr] = key.split('x');
      const w = parseInt(wStr,10), h = parseInt(hStr,10);
      const qty = map[key];
      const pieceName = `Piece ${w}x${h}`;
      const notes = label;
      html += `<tr><td>${pieceName}</td><td>${qty}</td><td class="highlight">${w}mm × ${h}mm</td><td>${notes}</td></tr>`;
      pushCsv("OSB Decking", pieceName, qty, w, h, notes);
      count += qty;
    });
    document.getElementById(bodyId).innerHTML = html || `<tr><td colspan="4">None</td></tr>`;
    document.getElementById(totalsId).textContent = `Total ${label.toLowerCase()}: ${count}`;
  }
  renderOsbTable(osbStd, "osbStdBody", "osbStdTotals", "Standard Sheet");
  renderOsbTable(osbRip, "osbRipBody", "osbRipTotals", "Rip/Trim Cut");

  // PIR Rip Cuts Only
  const gW = CONFIG.insulation.w;
  const gL = CONFIG.insulation.d;
  const pirRipCuts = {};
  let totalPirArea = 0;
  for (let i = 0; i < L.positions.length - 1; i++) {
    const start = L.positions[i] + 25;
    const currentBayW = (L.positions[i+1] - 25) - start;
    for (let z = 0; z < L.innerJoistLen; z += gL) {
      const zL = Math.min(gL, L.innerJoistLen - z);
      const pieceL = L.isWShort ? zL : currentBayW;
      const pieceW = L.isWShort ? currentBayW : zL;
      const lmm = Math.round(pieceL);
      const wmm = Math.round(pieceW);
      if (lmm > 0 && wmm > 0) {
        totalPirArea += (lmm * wmm);
        const isFull = (lmm === gL && wmm === gW) || (lmm === gW && wmm === gL);
        if (!isFull) {
          const key = `${lmm}x${wmm}`;
          pirRipCuts[key] = (pirRipCuts[key] || 0) + 1;
        }
      }
    }
  }
  let pirRipHtml = "";
  Object.keys(pirRipCuts).forEach(key => {
    const [lStr, wStr] = key.split('x');
    const lmm = parseInt(lStr, 10);
    const wmm = parseInt(wStr, 10);
    pirRipHtml += `<tr><td>PIR ${key}</td><td>${pirRipCuts[key]}</td><td class="highlight">${lmm}mm x ${wmm}mm</td><td>Cut Board</td></tr>`;
  });
  document.getElementById("pirRipBody").innerHTML = pirRipHtml || `<tr><td colspan="4">None</td></tr>`;
  const pirSheetArea = gW * gL;
  const pirMinSheets = pirSheetArea > 0 ? Math.ceil(totalPirArea / pirSheetArea) : 0;
  const pirSummaryEl = document.getElementById("pirSummary");
  if (pirSummaryEl) { pirSummaryEl.textContent = `Minimum full sheets required (by area): ${pirMinSheets}`; }

  // Plastic Grid Tiles
  const g = CONFIG.grid.size;
  let gridCuts = {};
  for (let x = 0; x < state.w; x += g) {
    const sw = Math.min(g, state.w - x);
    for (let z = 0; z < state.d; z += g) {
      const sd = Math.min(g, state.d - z);
      if (sw > 0 && sd > 0) {
        const key = `${sw}x${sd}`;
        gridCuts[key] = (gridCuts[key] || 0) + 1;
      }
    }
  }
  let gridHtml = "";
  Object.keys(gridCuts).forEach(key => {
    const [wStr, hStr] = key.split('x');
    const sw = parseInt(wStr, 10);
    const sd = parseInt(hStr, 10);
    const isFull = (sw === g && sd === g);
    gridHtml += `<tr>
      <td>Grid ${key}</td>
      <td>${gridCuts[key]}</td>
      <td class="highlight">${sw}mm x ${sd}mm</td>
      <td>${isFull ? "Full Tile" : "Cut Tile"}</td>
    </tr>`;
  });
  document.getElementById("gridBody").innerHTML = gridHtml || `<tr><td colspan="4">None</td></tr>`;

  // OSB area-based minimum sheets
  let totalOSBArea = 0;
  Object.keys(osbMap).forEach(key => {
    const [wStr, hStr] = key.split('x');
    const w = parseInt(wStr, 10);
    const h = parseInt(hStr, 10);
    const qty = osbMap[key];
    totalOSBArea += qty * w * h;
  });
  const sheetArea = sheetX * sheetZ;
  const minSheets = sheetArea > 0 ? Math.ceil(totalOSBArea / sheetArea) : 0;
  const osbSummaryEl = document.getElementById("osbSummary");
  if (osbSummaryEl) { osbSummaryEl.textContent = `Minimum full sheets required (by area): ${minSheets}`; }

  // Renumber section headings
  const h4s = Array.from(document.querySelectorAll('#bomPage .schedule-section > h4'));
  h4s.forEach((h, idx) => { h.textContent = `${idx+1}. ${h.textContent.replace(/^\d+\.\s*/, '')}`; });

  // Export/Print wiring (idempotent)
  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn && !exportBtn._wired) {
    exportBtn._wired = true;
    exportBtn.addEventListener("click", () => {
      const header = ["Section","Item","Qty","L_mm","W_mm","L_in","W_in","Notes"];
      const rows = [header, ...csvRows].map(r => r.map(v => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(",")).join("\n");
      const blob = new Blob([rows], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "cutting_list.csv";
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    });
  }
  const printBtn = document.getElementById("printBtn");
  if (printBtn && !printBtn._wired) {
    printBtn._wired = true;
    printBtn.addEventListener("click", () => window.print());
  }
  const unitsSel = document.getElementById("unitsSelect");
  if (unitsSel && !unitsSel._wired) {
    unitsSel._wired = true;
    unitsSel.addEventListener("change", () => updateBOM(state));
  }
}

export function build3D(state, ctx) {
  const { scene } = ctx;
  if (!shedRoot) shedRoot = new BABYLON.TransformNode("root", scene);

  // Dispose previous
  Object.values(meshes).flat().forEach(m => { if (m && !m.isDisposed()) m.dispose(); });
  meshes = { base: [], frame: [], ins: [], deck: [] };

  const L = getLayout(state);
  const yB = 25, yF = 100, yI = 125, yD = 159;

  if (state.vis.base) {
    const mat = new BABYLON.StandardMaterial("m_base", scene); mat.diffuseColor = new BABYLON.Color3(0.1,0.1,0.1);
    for (let x=0; x<state.w; x+=500) {
      for (let z=0; z<state.d; z+=500) {
        const bw = Math.min(500, state.w - x);
        const bd = Math.min(500, state.d - z);
        const b = BABYLON.MeshBuilder.CreateBox("g", { width:bw*0.001, height:50*0.001, depth:bd*0.001 }, scene);
        b.position = new BABYLON.Vector3((x + bw/2)*0.001, yB*0.001, (z + bd/2)*0.001);
        b.material = mat; b.parent = shedRoot;
        if (b.enableEdgesRendering) { b.enableEdgesRendering(); b.edgesWidth = 1; b.edgesColor = new BABYLON.Color4(0.2,0.2,0.2,1); }
        else { (scene._baseHL || (scene._baseHL = new BABYLON.HighlightLayer("baseHL", scene))).addMesh(b, new BABYLON.Color3(0.2,0.2,0.2)); }
        meshes.base.push(b);
      }
    }
  }

  if (state.vis.frame) {
    const mat = new BABYLON.StandardMaterial("m_frame", scene); mat.diffuseColor = new BABYLON.Color3(0.5,0.4,0.3);
    [0, L.joistSpan - 50].forEach(o => {
      const r = BABYLON.MeshBuilder.CreateBox("r", {
        width: (L.isWShort ? 50 : L.rimLen) * 0.001,
        height: 100 * 0.001,
        depth: (L.isWShort ? L.rimLen : 50) * 0.001
      }, scene);
      r.position = L.isWShort
        ? new BABYLON.Vector3((o+25)*0.001, yF*0.001, (L.rimLen/2)*0.001)
        : new BABYLON.Vector3((L.rimLen/2)*0.001, yF*0.001, (o+25)*0.001);
      r.material = mat; r.parent = shedRoot; meshes.frame.push(r);
    });
    L.positions.forEach(p => {
      const j = BABYLON.MeshBuilder.CreateBox("j", {
        width: (L.isWShort ? L.innerJoistLen : 50) * 0.001,
        height: 100 * 0.001,
        depth: (L.isWShort ? 50 : L.innerJoistLen) * 0.001
      }, scene);
      const mid = (L.innerJoistLen/2 + 50) * 0.001;
      j.position = L.isWShort
        ? new BABYLON.Vector3(mid, yF*0.001, p*0.001)
        : new BABYLON.Vector3(p*0.001, yF*0.001, mid);
      j.material = mat; j.parent = shedRoot; meshes.frame.push(j);
    });
  }

  if (state.vis.ins) {
    const mat = new BABYLON.StandardMaterial("m_ins", scene); mat.diffuseColor = new BABYLON.Color3(0.9,0.85,0.7);
    for (let i=0; i<L.positions.length - 1; i++) {
      const start = L.positions[i] + 25;
      const currentBayW = (L.positions[i+1] - 25) - start;
      for (let z=0; z < L.innerJoistLen; z += 2400) {
        const zL = Math.min(2400, L.innerJoistLen - z);
        const ins = BABYLON.MeshBuilder.CreateBox("i", {
          width: (L.isWShort ? zL : currentBayW) * 0.001,
          height: 50 * 0.001,
          depth: (L.isWShort ? currentBayW : zL) * 0.001
        }, scene);
        const mB = (start + currentBayW/2) * 0.001; const mS = (z + zL/2 + 50) * 0.001;
        ins.position = L.isWShort ? new BABYLON.Vector3(mS, yI*0.001, mB) : new BABYLON.Vector3(mB, yI*0.001, mS);
        ins.material = mat; ins.parent = shedRoot; meshes.ins.push(ins);
        ins.enableEdgesRendering(); ins.edgesWidth = 2; ins.edgesColor = new BABYLON.Color4(0.2, 0.2, 0.2, 1);
      }
    }
  }

  if (state.vis.deck) {
    const mat = new BABYLON.StandardMaterial("m_deck", scene); mat.diffuseColor = new BABYLON.Color3(0.8,0.7,0.6);

    // Decking placement (full-rectangle-first + staggering)
    const sheetShort = CONFIG.decking.w;  // 1220
    const sheetLong  = CONFIG.decking.d;  // 2440
    const joistsAlongX = L.isWShort;
    const sheetX = joistsAlongX ? sheetShort : sheetLong;
    const sheetZ = joistsAlongX ? sheetLong  : sheetShort;
    const fullCols = Math.floor(state.w / sheetX);
    const fullRows = Math.floor(state.d / sheetZ);
    const rectW = fullCols * sheetX;
    const rectD = fullRows * sheetZ;

    // full-sheet rectangle
    for (let r = 0; r < fullRows; r++) {
      for (let c = 0; c < fullCols; c++) {
        const sw = sheetX, sd = sheetZ;
        const x0 = c * sheetX, z0 = r * sheetZ;
        const d = BABYLON.MeshBuilder.CreateBox("d", { width: sw*0.001, height: 18*0.001, depth: sd*0.001 }, scene);
        d.position = new BABYLON.Vector3((x0 + sw/2)*0.001, yD*0.001, (z0 + sd/2)*0.001);
        d.material = mat; d.parent = shedRoot;
        d.enableEdgesRendering(); d.edgesWidth = 4; d.edgesColor = new BABYLON.Color4(0,0,0,1);
        meshes.deck.push(d);
      }
    }

    // bottom strip
    {
      let rowIndex = 0;
      for (let z = rectD; z < state.d; z += sheetZ) {
        const sd = Math.min(sheetZ, state.d - z);
        const offset = (rowIndex % 2 === 1) ? (sheetX / 2) : 0;
        for (let x = -offset; x < state.w; x += sheetX) {
          const drawXStart = Math.max(0, x);
          const drawXEnd   = Math.min(state.w, x + sheetX);
          const sw = Math.round(drawXEnd - drawXStart);
          if (sw > 10 && sd > 10) {
            const d = BABYLON.MeshBuilder.CreateBox("d", { width: sw*0.001, height: 18*0.001, depth: sd*0.001 }, scene);
            d.position = new BABYLON.Vector3((drawXStart + sw/2)*0.001, yD*0.001, (z + sd/2)*0.001);
            d.material = mat; d.parent = shedRoot;
            d.enableEdgesRendering(); d.edgesWidth = 4; d.edgesColor = new BABYLON.Color4(0,0,0,1);
            meshes.deck.push(d);
          }
        }
        rowIndex++;
      }
    }

    // right strip
    {
      let rowIndex = 0;
      for (let z = 0; z < rectD; z += sheetZ) {
        const sd = Math.min(sheetZ, rectD - z);
        const offset = (rowIndex % 2 === 1) ? (sheetX / 2) : 0;
        for (let x = rectW - offset; x < state.w; x += sheetX) {
          const drawXStart = Math.max(rectW, x);
          const drawXEnd   = Math.min(state.w, x + sheetX);
          const sw = Math.round(drawXEnd - drawXStart);
          if (sw > 10 && sd > 10) {
            const d = BABYLON.MeshBuilder.CreateBox("d", { width: sw*0.001, height: 18*0.001, depth: sd*0.001 }, scene);
            d.position = new BABYLON.Vector3((drawXStart + sw/2)*0.001, yD*0.001, (z + sd/2)*0.001);
            d.material = mat; d.parent = shedRoot;
            d.enableEdgesRendering(); d.edgesWidth = 4; d.edgesColor = new BABYLON.Color4(0,0,0,1);
            meshes.deck.push(d);
          }
        }
        rowIndex++;
      }
    }
  }
}
