// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 * - Rafters/joists @600mm spacing (literal).
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm (literal).
 * - Joists are re-oriented 90° (swap cross-section axes vs base joists): 50×100 becomes 100×50 in BOM W/D and in mesh dims.
 *
 * All roof meshes:
 * - name prefix "roof-"
 * - metadata.dynamic === true
 */

export function build3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  // Dispose previous roof meshes
  scene.meshes
    .filter((m) => m && m.metadata && m.metadata.dynamic === true && typeof m.name === "string" && m.name.startsWith("roof-"))
    .forEach((m) => {
      try { if (!m.isDisposed()) m.dispose(false, true); } catch (e) {}
    });

  if (!state || !state.roof || String(state.roof.style || "") !== "pent") return;

  const data = computeRoofData(state);

  const joistMat = materials && materials.timber ? materials.timber : null;

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

  // Joists (run along X, spaced along Z)
  for (let i = 0; i < data.joists.length; i++) {
    const j = data.joists[i];

    // Re-oriented cross-section: height=50, depth=100 (swap compared to 50×100)
    mkBox(
      `roof-joist-${i}`,
      j.len,
      data.joistD_mm, // vertical
      data.joistW_mm, // depth (Z thickness)
      { x: 0, y: data.baseY_mm, z: j.z_mm },
      joistMat,
      { roof: "pent", part: "joist" }
    );
  }

  // OSB boards laid above joists
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    // Boards are placed in the roof plane spanning X/Z. Thickness is vertical (Y).
    mkBox(
      `roof-osb-${i}`,
      p.xLen_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      { x: p.x0_mm, y: data.baseY_mm + data.joistD_mm, z: p.z0_mm },
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }
}

export function updateBOM(state) {
  const joistsBody = document.getElementById("roofJoistsBody");
  const osbStdBody = document.getElementById("roofOsbStdBody");
  const osbRipBody = document.getElementById("roofOsbRipBody");
  const osbSummary = document.getElementById("roofOsbSummary");

  if (!joistsBody || !osbStdBody || !osbRipBody || !osbSummary) return;

  joistsBody.innerHTML = "";
  osbStdBody.innerHTML = "";
  osbRipBody.innerHTML = "";
  osbSummary.textContent = "";

  if (!state || !state.roof || String(state.roof.style || "") !== "pent") {
    // Keep section empty when not pent
    return;
  }

  const data = computeRoofData(state);

  // ---- Roof Joists ----
  // Single piece type for now: identical length and section for all joists.
  appendRow6(joistsBody, [
    "Roof Joist",
    String(data.joists.length),
    String(data.joistLen_mm),
    String(data.joistW_mm),
    String(data.joistD_mm),
    "spacing @600mm, pent roof",
  ]);

  // ---- Roof OSB (18mm) ----
  const stdGrouped = groupBySize(data.osb.std, /*isOsb*/ true);
  const ripGrouped = groupBySize(data.osb.rip, /*isOsb*/ true);

  const stdKeys = Object.keys(stdGrouped).sort((a, b) => String(a).localeCompare(String(b)));
  for (let i = 0; i < stdKeys.length; i++) {
    const k = stdKeys[i];
    const g = stdGrouped[k];
    appendRow6(osbStdBody, [
      "Roof OSB",
      String(g.qty),
      String(g.L),
      String(g.W),
      String(data.osbThickness_mm),
      "standard sheet",
    ]);
  }

  const ripKeys = Object.keys(ripGrouped).sort((a, b) => String(a).localeCompare(String(b)));
  for (let i = 0; i < ripKeys.length; i++) {
    const k = ripKeys[i];
    const g = ripGrouped[k];
    appendRow6(osbRipBody, [
      "Roof OSB",
      String(g.qty),
      String(g.L),
      String(g.W),
      String(data.osbThickness_mm),
      "rip/trim",
    ]);
  }

  const sheetArea = 1220 * 2440;
  const minSheets = Math.max(0, Math.ceil(data.osb.totalArea_mm2 / sheetArea));
  osbSummary.textContent = "Minimum full sheets required (by area): " + String(minSheets);
}

function appendRow6(tbody, cols) {
  const tr = document.createElement("tr");
  for (let i = 0; i < cols.length; i++) {
    const td = document.createElement("td");
    td.textContent = cols[i] == null ? "" : String(cols[i]);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function groupBySize(pieces, isOsb) {
  const out = {};
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const L = Math.max(1, Math.floor(isOsb ? (p.L_mm || 0) : 0));
    const W = Math.max(1, Math.floor(isOsb ? (p.W_mm || 0) : 0));
    const key = String(L) + "x" + String(W);
    if (!out[key]) out[key] = { qty: 0, L, W };
    out[key].qty += 1;
  }
  return out;
}

function computeRoofData(state) {
  // Roof extents: use state.w / state.d as provided by orchestration.
  const w = Math.max(1, Math.floor(state.w));
  const d = Math.max(1, Math.floor(state.d));

  const wallH = Math.max(100, Math.floor(state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400));

  // Timber section (literal 50×100). Re-oriented 90° => swap W/D in cutting list and mesh dims.
  const baseW = 50;
  const baseD = 100;
  const joistW_mm = baseD; // swapped
  const joistD_mm = baseW; // swapped (vertical)
  const joistLen_mm = w;

  const spacing = 600;

  // Deterministic Z positions: include 0; step @600; ensure last at (d - joistW_mm) if possible.
  const zPositions = [];
  const zMax = Math.max(0, d - joistW_mm);

  let z = 0;
  while (z <= zMax) {
    zPositions.push(Math.floor(z));
    z += spacing;
  }
  if (zPositions.length) {
    const last = zPositions[zPositions.length - 1];
    if (Math.abs(last - zMax) > 0) {
      if (zMax >= 0) zPositions.push(Math.floor(zMax));
    }
  } else {
    zPositions.push(0);
  }

  // Joists list for 3D
  const joists = zPositions.map((z_mm) => ({ z_mm, len: joistLen_mm }));

  // OSB tiling: A/B no-stagger on roof plane (X/Z).
  // Use A = min(w,d), B = max(w,d). Then map A/B to X/Z deterministically based on which axis is long.
  const A = Math.min(w, d);
  const B = Math.max(w, d);
  const longAxis = (w >= d) ? "x" : "z"; // B runs along long axis
  const osb = computeOsbPiecesNoStagger(A, B);

  // Map AB pieces back to X/Z
  // Convention:
  // - Piece length (L_mm) runs along B axis.
  // - Piece width  (W_mm) runs along A axis.
  // If longAxis === "x": B->X, A->Z
  // Else: B->Z, A->X
  const mappedAll = [];
  for (let i = 0; i < osb.all.length; i++) {
    const p = osb.all[i];
    if (longAxis === "x") {
      mappedAll.push({
        kind: p.kind,
        x0_mm: p.b0_mm,
        z0_mm: p.a0_mm,
        xLen_mm: p.L_mm,
        zLen_mm: p.W_mm,
        L_mm: p.L_mm,
        W_mm: p.W_mm
      });
    } else {
      mappedAll.push({
        kind: p.kind,
        x0_mm: p.a0_mm,
        z0_mm: p.b0_mm,
        xLen_mm: p.W_mm,
        zLen_mm: p.L_mm,
        L_mm: p.L_mm,
        W_mm: p.W_mm
      });
    }
  }

  const std = osb.std.map((p) => ({ L_mm: p.L_mm, W_mm: p.W_mm }));
  const rip = osb.rip.map((p) => ({ L_mm: p.L_mm, W_mm: p.W_mm }));

  return {
    roofW_mm: w,
    roofD_mm: d,
    baseY_mm: wallH,
    joistW_mm,
    joistD_mm,
    joistLen_mm,
    joists,
    osbThickness_mm: 18,
    osb: {
      std,
      rip,
      all: mappedAll,
      totalArea_mm2: osb.totalArea_mm2
    }
  };
}

/**
 * No-stagger tiling for 1220×2440 sheets.
 * A axis uses 1220; B axis uses 2440.
 * Returns:
 * - std: full sheets
 * - rip: non-full pieces (including edge strips and corner)
 * - all: pieces with A/B origins for 3D mapping
 * - totalArea_mm2: sum of all pieces area
 */
function computeOsbPiecesNoStagger(A_mm, B_mm) {
  const A = Math.max(1, Math.floor(A_mm));
  const B = Math.max(1, Math.floor(B_mm));

  const SHEET_A = 1220;
  const SHEET_B = 2440;

  const aFull = Math.floor(A / SHEET_A);
  const bFull = Math.floor(B / SHEET_B);

  const aRem = A - (aFull * SHEET_A);
  const bRem = B - (bFull * SHEET_B);

  const std = [];
  const rip = [];
  const all = [];

  function pushPiece(kind, a0, b0, W, L) {
    const p = { kind, a0_mm: a0, b0_mm: b0, W_mm: W, L_mm: L };
    all.push(p);
    if (kind === "std") std.push({ W_mm: W, L_mm: L });
    else rip.push({ W_mm: W, L_mm: L });
  }

  // Full sheets
  for (let bi = 0; bi < bFull; bi++) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("std", ai * SHEET_A, bi * SHEET_B, SHEET_A, SHEET_B);
    }
  }

  // A remainder strip across full B rows
  if (aRem > 0 && bFull > 0) {
    for (let bi = 0; bi < bFull; bi++) {
      pushPiece("rip", aFull * SHEET_A, bi * SHEET_B, aRem, SHEET_B);
    }
  }

  // B remainder strip across full A cols
  if (bRem > 0 && aFull > 0) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("rip", ai * SHEET_A, bFull * SHEET_B, SHEET_A, bRem);
    }
  }

  // Corner remainder
  if (aRem > 0 && bRem > 0) {
    pushPiece("rip", aFull * SHEET_A, bFull * SHEET_B, aRem, bRem);
  }

  // Total area
  let area = 0;
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    area += (Math.max(0, p.W_mm) * Math.max(0, p.L_mm));
  }

  return { std, rip, all, totalArea_mm2: area };
}
