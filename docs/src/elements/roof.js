// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 * - Rafters @600mm spacing (literal).
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm (literal).
 * - Rafters span shortest roof dimension:
 *     A = min(roofW, roofD)  // span axis
 *     B = max(roofW, roofD)  // placement axis
 * - "Rotate 90 degrees" vs prior attempt:
 *     Cross-section orientation differs: rafter W/D output reflects the local axes used here.
 *
 * All roof meshes:
 * - name prefix "roof-"
 * - metadata.dynamic === true
 */

import { CONFIG } from "../params.js";

export function build3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  // Dispose previous roof meshes
  try {
    scene.meshes
      .filter(
        (m) =>
          m &&
          m.metadata &&
          m.metadata.dynamic === true &&
          typeof m.name === "string" &&
          m.name.startsWith("roof-")
      )
      .forEach((m) => {
        try {
          if (!m.isDisposed()) m.dispose(false, true);
        } catch (e) {}
      });
  } catch (e) {}

  if (!state || !state.roof || String(state.roof.style || "") !== "pent") return;

  const data = computeRoofData(state);

  const timberMat = materials && materials.timber ? materials.timber : null;

  const osbMat = (() => {
    try {
      if (scene._roofOsbMat) return scene._roofOsbMat;
      const m = new BABYLON.StandardMaterial("roofOsbMat", scene);
      m.diffuseColor = new BABYLON.Color3(0.75, 0.62, 0.45);
      scene._roofOsbMat = m;
      return m;
    } catch (e) {
      return null;
    }
  })();

  function mkBox(name, Lx, Ly, Lz, pos, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx / 1000, height: Ly / 1000, depth: Lz / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(
      (pos.x + Lx / 2) / 1000,
      (pos.y + Ly / 2) / 1000,
      (pos.z + Lz / 2) / 1000
    );
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    return mesh;
  }

  // Rafters (span axis A, placed along B)
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];

    // Cross-section orientation (rotated vs prior attempt):
    // Here: vertical = rafterD_mm, in-plane thickness = rafterW_mm.
    mkBox(
      `roof-rafter-${i}`,
      r.Lx_mm,
      data.rafterD_mm,
      r.Lz_mm,
      { x: r.x0_mm, y: data.baseY_mm, z: r.z0_mm },
      timberMat,
      { roof: "pent", part: "rafter" }
    );
  }

  // OSB pieces above rafters
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    mkBox(
      `roof-osb-${i}`,
      p.Lx_mm,
      data.osbThickness_mm,
      p.Lz_mm,
      { x: p.x0_mm, y: data.baseY_mm + data.rafterD_mm, z: p.z0_mm },
      osbMat,
      { roof: "pent", part: "osb" }
    );
  }
}

export function updateBOM(state) {
  const tbody = document.getElementById("roofBomTable");
  if (!tbody) return;

  tbody.innerHTML = "";

  const isPent = !!(state && state.roof && String(state.roof.style || "") === "pent");
  if (!isPent) {
    appendRow(tbody, ["Roof not enabled", "—", "—", "—", ""]);
    return;
  }

  const data = computeRoofData(state);

  const rows = [];

  // Rafters: group identical lengths/sections
  rows.push({
    item: "Roof Rafter",
    qty: data.rafters.length,
    L: data.spanA_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm) + "; spacing @600mm; pent roof"
  });

  // OSB pieces: group by cut size (L along B, W along A)
  const osbGrouped = {};
  for (let i = 0; i < data.osb.piecesAB.length; i++) {
    const p = data.osb.piecesAB[i];
    const L = Math.max(1, Math.floor(p.bLen_mm));
    const W = Math.max(1, Math.floor(p.aLen_mm));
    const key = String(L) + "x" + String(W);
    if (!osbGrouped[key]) osbGrouped[key] = { qty: 0, L: L, W: W };
    osbGrouped[key].qty += 1;
  }

  const keys = Object.keys(osbGrouped).sort((a, b) => {
    const aa = osbGrouped[a], bb = osbGrouped[b];
    if (aa.L !== bb.L) return aa.L - bb.L;
    if (aa.W !== bb.W) return aa.W - bb.W;
    return String(a).localeCompare(String(b));
  });

  for (let i = 0; i < keys.length; i++) {
    const g = osbGrouped[keys[i]];
    rows.push({
      item: "Roof OSB",
      qty: g.qty,
      L: g.L,
      W: g.W,
      notes: "18mm OSB"
    });
  }

  // Stable sort: Item then L then W then Notes
  rows.sort((a, b) => {
    const ia = String(a.item || "");
    const ib = String(b.item || "");
    if (ia !== ib) return ia.localeCompare(ib);
    const la = Number(a.L || 0), lb = Number(b.L || 0);
    if (la !== lb) return la - lb;
    const wa = Number(a.W || 0), wb = Number(b.W || 0);
    if (wa !== wb) return wa - wb;
    const na = String(a.notes || "");
    const nb = String(b.notes || "");
    return na.localeCompare(nb);
  });

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    appendRow(tbody, [
      r.item,
      String(r.qty),
      String(Math.floor(Number(r.L))),
      String(Math.floor(Number(r.W))),
      r.notes || ""
    ]);
  }
}

function appendRow(tbody, cols) {
  const tr = document.createElement("tr");
  for (let i = 0; i < cols.length; i++) {
    const td = document.createElement("td");
    td.textContent = cols[i] == null ? "" : String(cols[i]);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function computeRoofData(state) {
  // Roof extents are provided by orchestration as state.w/state.d for roof mode.
  const roofW = Math.max(1, Math.floor(Number(state && state.w != null ? state.w : 1)));
  const roofD = Math.max(1, Math.floor(Number(state && state.d != null ? state.d : 1)));

  const wallH = Math.max(
    100,
    Math.floor(
      state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400
    )
  );

  const spanA = Math.min(roofW, roofD);
  const placeB = Math.max(roofW, roofD);

  // A spans the shortest dimension; B is placement dimension.
  // Determine whether B runs along X or Z
  const bAxis = roofW >= roofD ? "x" : "z"; // long axis
  const aAxis = bAxis === "x" ? "z" : "x"; // short axis

  const spacing = 600;

  // Timber section from CONFIG; orientation rotated vs prior attempt
  const timberW = Math.max(1, Math.floor(Number(CONFIG && CONFIG.timber && CONFIG.timber.w != null ? CONFIG.timber.w : 50)));
  const timberD = Math.max(1, Math.floor(Number(CONFIG && CONFIG.timber && CONFIG.timber.d != null ? CONFIG.timber.d : 100)));

  // Cross-section orientation used here:
  // - vertical (Y) = timberD
  // - in-plane thickness across placement axis = timberW
  const rafterW_mm = timberW;
  const rafterD_mm = timberD;

  // Placement positions along B: include 0, step 600, ensure last at (B - thickness) if possible.
  const bMax = Math.max(0, placeB - rafterW_mm);
  const bPositions = [];
  let p = 0;
  while (p <= bMax) {
    bPositions.push(Math.floor(p));
    p += spacing;
  }
  if (bPositions.length) {
    const last = bPositions[bPositions.length - 1];
    if (Math.abs(last - bMax) > 0) bPositions.push(Math.floor(bMax));
  } else {
    bPositions.push(0);
  }

  // Build rafter boxes in X/Z
  // Each rafter spans A fully, with thickness rafterW_mm along placement axis.
  const rafters = [];
  for (let i = 0; i < bPositions.length; i++) {
    const b0 = bPositions[i];

    // Compute box footprint in X/Z depending on which axis is A/B.
    // aAxis length = spanA
    // bAxis thickness = rafterW_mm at offset b0
    if (bAxis === "x") {
      // B->X placement, A->Z span
      rafters.push({
        x0_mm: b0,
        z0_mm: 0,
        Lx_mm: rafterW_mm,
        Lz_mm: spanA
      });
    } else {
      // B->Z placement, A->X span
      rafters.push({
        x0_mm: 0,
        z0_mm: b0,
        Lx_mm: spanA,
        Lz_mm: rafterW_mm
      });
    }
  }

  // OSB tiling in AB (A across = 1220, B along = 2440), then map to XZ based on axis mapping.
  const osbThickness_mm = 18;
  const sheetA = Math.max(1, Math.floor(Number(CONFIG && CONFIG.decking && CONFIG.decking.w != null ? CONFIG.decking.w : 1220)));
  const sheetB = Math.max(1, Math.floor(Number(CONFIG && CONFIG.decking && CONFIG.decking.d != null ? CONFIG.decking.d : 2440)));

  const piecesAB = computePiecesAB_NoStagger(spanA, placeB, sheetA, sheetB);

  const osbAll = [];
  for (let i = 0; i < piecesAB.length; i++) {
    const q = piecesAB[i];
    if (bAxis === "x") {
      // B->X, A->Z
      osbAll.push({
        x0_mm: q.b0_mm,
        z0_mm: q.a0_mm,
        Lx_mm: q.bLen_mm,
        Lz_mm: q.aLen_mm
      });
    } else {
      // B->Z, A->X
      osbAll.push({
        x0_mm: q.a0_mm,
        z0_mm: q.b0_mm,
        Lx_mm: q.aLen_mm,
        Lz_mm: q.bLen_mm
      });
    }
  }

  return {
    roofW_mm: roofW,
    roofD_mm: roofD,
    spanA_mm: spanA,
    placeB_mm: placeB,
    aAxis: aAxis,
    bAxis: bAxis,
    baseY_mm: wallH,
    rafterW_mm: rafterW_mm,
    rafterD_mm: rafterD_mm,
    rafters: rafters,
    osbThickness_mm: osbThickness_mm,
    osb: {
      piecesAB: piecesAB,
      all: osbAll
    }
  };
}

/**
 * No-stagger tiling for sheets:
 * - A axis uses sheetA (e.g., 1220)
 * - B axis uses sheetB (e.g., 2440)
 * Order: full sheets, remainder column, remainder row, corner remainder.
 * Returns list of pieces in AB coordinates with sizes and origins.
 */
function computePiecesAB_NoStagger(A_mm, B_mm, sheetA, sheetB) {
  const A = Math.max(1, Math.floor(A_mm));
  const B = Math.max(1, Math.floor(B_mm));

  const aFull = Math.floor(A / sheetA);
  const bFull = Math.floor(B / sheetB);

  const rectA = aFull * sheetA;
  const rectB = bFull * sheetB;

  const remA = Math.max(0, A - rectA);
  const remB = Math.max(0, B - rectB);

  const pieces = [];

  // Full sheets
  for (let bi = 0; bi < bFull; bi++) {
    for (let ai = 0; ai < aFull; ai++) {
      pieces.push({ a0_mm: ai * sheetA, b0_mm: bi * sheetB, aLen_mm: sheetA, bLen_mm: sheetB });
    }
  }

  // Remainder column (remA × sheetB) for each full row
  if (remA > 0) {
    for (let bi = 0; bi < bFull; bi++) {
      pieces.push({ a0_mm: rectA, b0_mm: bi * sheetB, aLen_mm: remA, bLen_mm: sheetB });
    }
  }

  // Remainder row (sheetA × remB) for each full col
  if (remB > 0) {
    for (let ai = 0; ai < aFull; ai++) {
      pieces.push({ a0_mm: ai * sheetA, b0_mm: rectB, aLen_mm: sheetA, bLen_mm: remB });
    }
  }

  // Corner remainder
  if (remA > 0 && remB > 0) {
    pieces.push({ a0_mm: rectA, b0_mm: rectB, aLen_mm: remA, bLen_mm: remB });
  }

  return pieces;
}
