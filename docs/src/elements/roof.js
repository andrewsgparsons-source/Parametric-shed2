// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 * - Rafters/joists @600mm spacing (literal).
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm (literal).
 * - Rafters span the shortest roof dimension (A = min(w,d)); placed along the long axis (B = max(w,d)).
 * - “Rotate 90 degrees” cross-section orientation vs prior attempt:
 *   Uses CONFIG.timber.w / CONFIG.timber.d but swaps which local axis gets which value consistently.
 *
 * PENT PITCH (along X):
 * - x=0 => left bearing (top of left wall top plates)
 * - x=roofW => right bearing (top of right wall top plates)
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

  if (!isPentEnabled(state)) return;

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

  // Axis-aligned box with lower-corner placement
  function mkBoxLC(name, Lx, Ly, Lz, posLC, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx / 1000, height: Ly / 1000, depth: Lz / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(
      (posLC.x + Lx / 2) / 1000,
      (posLC.y + Ly / 2) / 1000,
      (posLC.z + Lz / 2) / 1000
    );
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    return mesh;
  }

  // Rotated around Z; position specified as center in mm
  function mkBoxCenterRotZ(name, Lx, Ly, Lz, centerMM, rotZ, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx / 1000, height: Ly / 1000, depth: Lz / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(centerMM.x / 1000, centerMM.y / 1000, centerMM.z / 1000);
    mesh.rotation = new BABYLON.Vector3(0, 0, rotZ || 0);
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    return mesh;
  }

  // Map A/B (short/long axes) into world X/Z
  function mapABtoXZ_ForRafter(a0, b0, aLen, bLen, isWShort) {
    // aLen is rafter length along short span axis
    // bLen is the rafter "thickness" along the placement axis
    if (isWShort) return { x0: a0, z0: b0, lenX: aLen, lenZ: bLen };
    return { x0: b0, z0: a0, lenX: bLen, lenZ: aLen };
  }

  function mapABtoXZ_ForRim(a0, b0, aLen, bLen, isWShort) {
    // aLen is rim thickness along short span axis (A)
    // bLen is rim run length along long axis (B)
    if (isWShort) return { x0: a0, z0: b0, lenX: aLen, lenZ: bLen };
    return { x0: b0, z0: a0, lenX: bLen, lenZ: aLen };
  }

  // ---- Derive roof bearing from ACTUAL wall top plates in the scene (no guessed constants) ----
  const bearing = computeBearingsFromWallTopPlates(scene);

  // Fallback to prior behavior if wall plates cannot be found (avoid breaking render)
  const leftBearingY_m = bearing ? bearing.leftBearingY_m : (data.fallbackBaseY_mm / 1000);
  const rightBearingY_m = bearing ? bearing.rightBearingY_m : (data.fallbackBaseY_mm / 1000);
  const roofW_m = Math.max(1, data.roofW_mm) / 1000;

  function clamp01(t) {
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }

  function bearingYAtX_mm(x_mm) {
    const t = roofW_m > 0 ? clamp01((Math.max(0, Math.min(data.roofW_mm, Math.floor(Number(x_mm || 0))))) / data.roofW_mm) : 0;
    const y_m = leftBearingY_m + (rightBearingY_m - leftBearingY_m) * t;
    return y_m * 1000;
  }

  // Pitch angle derived from actual bearings (matches walls)
  const pitchAngle_rad = roofW_m > 0 ? Math.atan2((rightBearingY_m - leftBearingY_m), roofW_m) : 0;
  const cosA = Math.cos(pitchAngle_rad);
  const invCos = cosA !== 0 ? (1 / cosA) : 1;

  // ---- Rim Joists (front/back at ends of A; run along B) ----
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  // Front rim (A = 0)
  {
    const mapped = mapABtoXZ_ForRim(0, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const xSample = Math.floor(mapped.x0 + mapped.lenX / 2);
    const y0_mm = bearingYAtX_mm(xSample);
    mkBoxLC(
      "roof-rim-front",
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      { x: mapped.x0, y: y0_mm, z: mapped.z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }

  // Back rim (A = A - thickness)
  {
    const mapped = mapABtoXZ_ForRim(rimBackA0_mm, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const xSample = Math.floor(mapped.x0 + mapped.lenX / 2);
    const y0_mm = bearingYAtX_mm(xSample);
    mkBoxLC(
      "roof-rim-back",
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      { x: mapped.x0, y: y0_mm, z: mapped.z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // ---- Rafters (span along A, placed along B @600) ----
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];

    const b0_mm = data.isWShort ? Math.floor(r.z0_mm) : Math.floor(r.x0_mm);
    const mappedPlan = mapABtoXZ_ForRafter(0, b0_mm, data.rafterLenPlan_mm, data.rafterW_mm, data.isWShort);

    if (data.raftersSpanX) {
      // Spans X: rotate around Z by pitch; bottom sits on bearing line.
      // Keep plan projection the same by stretching along X by invCos.
      const Lx_slope = Math.max(1, Math.floor(data.rafterLenPlan_mm * invCos));

      const x0 = 0;
      const x1 = data.roofW_mm;
      const cx = (x0 + x1) / 2;

      const yBearingCenter_mm = bearingYAtX_mm(cx);
      const cy = yBearingCenter_mm + (data.rafterD_mm / 2);

      const cz = mappedPlan.z0 + (mappedPlan.lenZ / 2);

      mkBoxCenterRotZ(
        `roof-rafter-${i}`,
        Lx_slope,
        data.rafterD_mm,
        mappedPlan.lenZ,
        { x: cx, y: cy, z: cz },
        pitchAngle_rad,
        joistMat,
        { roof: "pent", part: "rafter" }
      );
    } else {
      // Spans Z: not rotated; bottom sits on bearing at its X location.
      const xAt = Math.floor(mappedPlan.x0 + (mappedPlan.lenX / 2));
      const y0_mm = bearingYAtX_mm(xAt);
      mkBoxLC(
        `roof-rafter-${i}`,
        mappedPlan.lenX,
        data.rafterD_mm,
        mappedPlan.lenZ,
        { x: mappedPlan.x0, y: y0_mm, z: mappedPlan.z0 },
        joistMat,
        { roof: "pent", part: "rafter" }
      );
    }
  }

  // ---- OSB boards (tilted to follow roof plane; plan extents preserved) ----
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];

    const x0p = Math.floor(p.x0_mm);
    const x1p = Math.floor(p.x0_mm + p.xLenPlan_mm);
    const cx = (x0p + x1p) / 2;
    const cz = p.z0_mm + (p.zLen_mm / 2);

    const xLenSlope_mm = Math.max(1, Math.floor(p.xLenPlan_mm * invCos));
    const yBearingCenter_mm = bearingYAtX_mm(cx);
    const yBottom_mm = yBearingCenter_mm + data.rafterD_mm;
    const cy = yBottom_mm + (data.osbThickness_mm / 2);

    mkBoxCenterRotZ(
      `roof-osb-${i}`,
      xLenSlope_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      { x: cx, y: cy, z: cz },
      pitchAngle_rad,
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }
}

export function updateBOM(state) {
  const tbody = document.getElementById("roofBomTable");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!isPentEnabled(state)) {
    appendPlaceholderRow(tbody, "Roof not enabled.");
    return;
  }

  const data = computeRoofData(state);

  const rows = [];

  // Rim joists (2x)
  rows.push({
    item: "Roof Rim Joist",
    qty: 2,
    L: data.B_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm),
  });

  // Rafters (grouped) — length logic unchanged by Y positioning
  rows.push({
    item: "Roof Rafter",
    qty: data.rafters.length,
    L: data.raftersSpanX ? data.rafterLenSlope_mm : data.rafterLenPlan_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm) + "; spacing @600mm; pent roof",
  });

  // OSB pieces (group identical cut sizes)
  const osbPieces = [];
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    osbPieces.push({
      L: Math.max(1, Math.floor(p.L_mm)),
      W: Math.max(1, Math.floor(p.W_mm)),
      notes: "18mm OSB; " + (p.kind === "std" ? "standard sheet" : "rip/trim"),
    });
  }

  const grouped = groupByLWN(osbPieces);
  const gKeys = Object.keys(grouped);
  gKeys.sort((a, b) => String(a).localeCompare(String(b)));

  for (let i = 0; i < gKeys.length; i++) {
    const k = gKeys[i];
    const g = grouped[k];
    rows.push({
      item: "Roof OSB",
      qty: g.qty,
      L: g.L,
      W: g.W,
      notes: g.notes,
    });
  }

  // Stable sort: Item, L, W, Notes
  rows.sort((a, b) => {
    const ai = String(a.item),
      bi = String(b.item);
    if (ai !== bi) return ai.localeCompare(bi);
    const aL = Number(a.L),
      bL = Number(b.L);
    if (aL !== bL) return aL - bL;
    const aW = Number(a.W),
      bW = Number(b.W);
    if (aW !== bW) return aW - bW;
    return String(a.notes).localeCompare(String(b.notes));
  });

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    appendRow5(tbody, [r.item, String(r.qty), String(r.L), String(r.W), r.notes]);
  }

  if (!rows.length) {
    appendPlaceholderRow(tbody, "Roof cutting list not yet generated.");
  }
}

function isPentEnabled(state) {
  return !!(state && state.roof && String(state.roof.style || "") === "pent");
}

function appendRow5(tbody, cols) {
  const tr = document.createElement("tr");
  for (let i = 0; i < cols.length; i++) {
    const td = document.createElement("td");
    td.textContent = cols[i] == null ? "" : String(cols[i]);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function appendPlaceholderRow(tbody, msg) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 5;
  td.textContent = String(msg || "");
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function groupByLWN(pieces) {
  const out = {};
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const L = Math.max(1, Math.floor(Number(p.L || 0)));
    const W = Math.max(1, Math.floor(Number(p.W || 0)));
    const notes = String(p.notes || "");
    const key = String(L) + "x" + String(W) + "|" + notes;
    if (!out[key]) out[key] = { qty: 0, L: L, W: W, notes: notes };
    out[key].qty += 1;
  }
  return out;
}

/**
 * Derive left/right roof bearing heights from wall top plates already in the scene.
 * - candidates: mesh.name starts with "wall-" and contains "plate-top"
 * - split into left/right by world-space centerX near min/max among candidates
 * - bearing for each side = max boundingBox.maximumWorld.y in that group
 *
 * Returns { leftBearingY_m, rightBearingY_m } in Babylon world units (meters), or null if not found.
 */
function computeBearingsFromWallTopPlates(scene) {
  try {
    const candidates = scene.meshes
      .filter(
        (m) =>
          m &&
          typeof m.name === "string" &&
          m.name.startsWith("wall-") &&
          m.name.indexOf("plate-top") !== -1 &&
          m.getBoundingInfo
      );

    if (!candidates.length) return null;

    const info = [];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      let bi = null;
      try {
        bi = m.getBoundingInfo();
      } catch (e) {
        bi = null;
      }
      if (!bi || !bi.boundingBox) continue;

      const bb = bi.boundingBox;
      const minW = bb.minimumWorld;
      const maxW = bb.maximumWorld;

      const centerX = (minW.x + maxW.x) / 2;
      const halfW = Math.max(0, (maxW.x - minW.x) / 2);
      const maxY = maxW.y;

      info.push({ m, centerX, halfW, maxY });
    }

    if (!info.length) return null;

    let minCX = info[0].centerX;
    let maxCX = info[0].centerX;
    let maxHalfW = info[0].halfW;

    for (let i = 1; i < info.length; i++) {
      const it = info[i];
      if (it.centerX < minCX) minCX = it.centerX;
      if (it.centerX > maxCX) maxCX = it.centerX;
      if (it.halfW > maxHalfW) maxHalfW = it.halfW;
    }

    // Tolerance derived from actual mesh extents (no invented mm constants).
    const tol = maxHalfW;

    const left = [];
    const right = [];

    for (let i = 0; i < info.length; i++) {
      const it = info[i];
      if (it.centerX <= (minCX + tol)) left.push(it);
      if (it.centerX >= (maxCX - tol)) right.push(it);
    }

    if (!left.length || !right.length) return null;

    let leftY = left[0].maxY;
    for (let i = 1; i < left.length; i++) leftY = Math.max(leftY, left[i].maxY);

    let rightY = right[0].maxY;
    for (let i = 1; i < right.length; i++) rightY = Math.max(rightY, right[i].maxY);

    return { leftBearingY_m: leftY, rightBearingY_m: rightY };
  } catch (e) {
    return null;
  }
}

function computeRoofData(state) {
  // Roof extents: state.w/state.d are assumed resolved by orchestration
  const roofW = Math.max(1, Math.floor(Number(state.w)));
  const roofD = Math.max(1, Math.floor(Number(state.d)));

  // Base Y fallback: wall height (legacy behavior for when wall plates can't be found)
  const wallH = Math.max(
    100,
    Math.floor(
      state && state.walls && state.walls.height_mm != null ? Number(state.walls.height_mm) : 2400
    )
  );

  // A = shortest (rafter span), B = longest (placement axis)
  const A = Math.min(roofW, roofD);
  const B = Math.max(roofW, roofD);

  // Determine mapping to X/Z:
  // If roofW is the short axis => A->X, B->Z
  // Else => A->Z, B->X
  const isWShort = roofW <= roofD;

  const spacing = 600;

  // Timber section from CONFIG, rotated orientation:
  // Here: horizontal thickness uses baseD; vertical uses baseW.
  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w))); // typically 50
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d))); // typically 100

  const rafterW_mm = baseD;
  const rafterD_mm = baseW;

  const rafterLenPlan_mm = A;

  // True slope length (kept as prior logic; does not depend on Y placement alone)
  const p = state && state.roof && state.roof.pent ? state.roof.pent : null;
  const minH = Math.max(100, Math.floor(p && p.minHeight_mm != null ? Number(p.minHeight_mm) : wallH));
  const maxH = Math.max(100, Math.floor(p && p.maxHeight_mm != null ? Number(p.maxHeight_mm) : wallH));
  const rise_mm = (maxH - minH);

  const raftersSpanX = isWShort; // A maps to X only when W is short
  const rafterLenSlope_mm = raftersSpanX
    ? Math.max(1, Math.floor(Math.sqrt((rafterLenPlan_mm * rafterLenPlan_mm) + (rise_mm * rise_mm))))
    : rafterLenPlan_mm;

  // Placement positions along B: include 0; step 600; ensure last at (B - rafterW_mm) if possible
  const pos = [];
  const maxP = Math.max(0, B - rafterW_mm);

  let pPos = 0;
  while (pPos <= maxP) {
    pos.push(Math.floor(pPos));
    pPos += spacing;
  }
  if (pos.length) {
    const last = pos[pos.length - 1];
    if (Math.abs(last - maxP) > 0) pos.push(Math.floor(maxP));
  } else {
    pos.push(0);
  }

  const rafters = [];
  for (let i = 0; i < pos.length; i++) {
    const b0 = pos[i];

    // Store world anchors deterministically (used by build3D mapping)
    if (isWShort) {
      // A->X, B->Z
      rafters.push({ len_mm: rafterLenPlan_mm, x0_mm: 0, z0_mm: b0 });
    } else {
      // A->Z, B->X
      rafters.push({ len_mm: rafterLenPlan_mm, x0_mm: b0, z0_mm: 0 });
    }
  }

  // OSB tiling in AB space: 1220 along A, 2440 along B (no stagger)
  const osbAB = computeOsbPiecesNoStagger(A, B);

  // Map AB pieces to X/Z consistent with rafter mapping
  const mappedAll = [];
  for (let i = 0; i < osbAB.all.length; i++) {
    const p2 = osbAB.all[i];

    if (isWShort) {
      // A->X, B->Z
      mappedAll.push({
        kind: p2.kind,
        x0_mm: p2.a0_mm,
        z0_mm: p2.b0_mm,
        xLenPlan_mm: p2.W_mm,
        zLen_mm: p2.L_mm,
        L_mm: p2.L_mm,
        W_mm: p2.W_mm,
      });
    } else {
      // A->Z, B->X
      mappedAll.push({
        kind: p2.kind,
        x0_mm: p2.b0_mm,
        z0_mm: p2.a0_mm,
        xLenPlan_mm: p2.L_mm,
        zLen_mm: p2.W_mm,
        L_mm: p2.L_mm,
        W_mm: p2.W_mm,
      });
    }
  }

  return {
    roofW_mm: roofW,
    roofD_mm: roofD,
    A_mm: A,
    B_mm: B,
    isWShort: isWShort,

    rafterW_mm,
    rafterD_mm,
    rafterLenPlan_mm,
    rafterLenSlope_mm,
    raftersSpanX,
    rafters,

    osbThickness_mm: 18,
    osb: { all: mappedAll, totalArea_mm2: osbAB.totalArea_mm2 },

    // fallback base if wall plates cannot be read
    fallbackBaseY_mm: wallH,
  };
}

/**
 * No-stagger tiling for 1220×2440 sheets in AB space:
 * - A axis uses 1220
 * - B axis uses 2440
 * Returns all pieces with A/B origins (a0_mm,b0_mm) and sizes (W_mm along A, L_mm along B).
 */
function computeOsbPiecesNoStagger(A_mm, B_mm) {
  const A = Math.max(1, Math.floor(A_mm));
  const B = Math.max(1, Math.floor(B_mm));

  const SHEET_A = 1220;
  const SHEET_B = 2440;

  const aFull = Math.floor(A / SHEET_A);
  const bFull = Math.floor(B / SHEET_B);

  const aRem = A - aFull * SHEET_A;
  const bRem = B - bFull * SHEET_B;

  const all = [];

  function pushPiece(kind, a0, b0, W, L) {
    all.push({ kind, a0_mm: a0, b0_mm: b0, W_mm: W, L_mm: L });
  }

  // Full sheets
  for (let bi = 0; bi < bFull; bi++) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("std", ai * SHEET_A, bi * SHEET_B, SHEET_A, SHEET_B);
    }
  }

  // A remainder strip across full B rows (aRem × 2440)
  if (aRem > 0 && bFull > 0) {
    for (let bi = 0; bi < bFull; bi++) {
      pushPiece("rip", aFull * SHEET_A, bi * SHEET_B, aRem, SHEET_B);
    }
  }

  // B remainder strip across full A cols (1220 × bRem)
  if (bRem > 0 && aFull > 0) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("rip", ai * SHEET_A, bFull * SHEET_B, SHEET_A, bRem);
    }
  }

  // Corner remainder (aRem × bRem)
  if (aRem > 0 && bRem > 0) {
    pushPiece("rip", aFull * SHEET_A, bFull * SHEET_B, aRem, bRem);
  }

  // Total area
  let area = 0;
  for (let i = 0; i < all.length; i++) {
    area += Math.max(0, all[i].W_mm) * Math.max(0, all[i].L_mm);
  }

  return { all, totalArea_mm2: area };
}
