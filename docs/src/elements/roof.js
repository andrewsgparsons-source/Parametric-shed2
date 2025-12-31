// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 * - Rafters/joists @600mm spacing (literal).
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm (literal).
 * - Rafters span the shortest roof dimension (A = min(w,d)); placed along the long axis (B = max(w,d)).
 * - “Rotate 90 degrees” cross-section orientation vs prior attempt:
 *   Uses CONFIG.timber.w / CONFIG.timber.d but swaps which local axis gets which value consistently.
 *
 * All roof meshes:
 * - name prefix "roof-"
 * - metadata.dynamic === true
 */

import { CONFIG, resolveDims } from "../params.js";

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

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // Roof bearing plane in Y is derived from wall top plates logic + the known wall shift in index.js
  // Walls are shifted by +168mm in Y; X/Z by -25mm.
  const WALL_RISE_MM = 168;

  function bearingYAtWorldX_mm(worldX_mm) {
    // Convert world X back into wall-local frame X used by walls.js before shiftWallMeshes:
    // shiftWallMeshes(scene, -25, +168, -25) => worldX = localX - 25
    // => localX = worldX + 25
    const localX_mm = worldX_mm + 25;

    const frameW_mm = Math.max(1, Math.floor(Number(data.frameW_mm || data.roofW_mm || 1)));
    const t = clamp(localX_mm / frameW_mm, 0, 1);

    const minH = data.minWallH_mm;
    const maxH = data.maxWallH_mm;

    // Bearing plane equals TOP of wall system (top plates top) in world mm
    return (minH + WALL_RISE_MM) + (maxH - minH) * t;
  }

  // Map A/B (short/long axes) into world X/Z (in roof-local plan space)
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

  // ---- Rim Joists (front/back at ends of A; run along B) ----
  // Must sit inside footprint and not protrude:
  // - placed at A=0 edge and A=(A - thicknessA) edge.
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  // Front rim (A = 0)
  {
    const mapped = mapABtoXZ_ForRim(0, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const x0 = data.originX_mm + mapped.x0;
    const z0 = data.originZ_mm + mapped.z0;
    const cx = x0 + mapped.lenX / 2;
    const bearingY_mm = bearingYAtWorldX_mm(cx);

    mkBox(
      "roof-rim-front",
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      { x: x0, y: bearingY_mm, z: z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }

  // Back rim (A = A - thickness)
  {
    const mapped = mapABtoXZ_ForRim(rimBackA0_mm, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const x0 = data.originX_mm + mapped.x0;
    const z0 = data.originZ_mm + mapped.z0;
    const cx = x0 + mapped.lenX / 2;
    const bearingY_mm = bearingYAtWorldX_mm(cx);

    mkBox(
      "roof-rim-back",
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      { x: x0, y: bearingY_mm, z: z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // ---- Rafters (span along A, placed along B @600) ----
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];

    // Recover B placement from stored positions (deterministic, no new policy):
    // - if isWShort: B->Z, so b0 is r.z0_mm
    // - else:        B->X, so b0 is r.x0_mm
    const b0_mm = data.isWShort ? Math.floor(r.z0_mm) : Math.floor(r.x0_mm);
    const mapped = mapABtoXZ_ForRafter(
      0,
      b0_mm,
      data.rafterLen_mm,
      data.rafterW_mm,
      data.isWShort
    );

    const x0 = data.originX_mm + mapped.x0;
    const z0 = data.originZ_mm + mapped.z0;
    const cx = x0 + mapped.lenX / 2;
    const bearingY_mm = bearingYAtWorldX_mm(cx);

    mkBox(
      `roof-rafter-${i}`,
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      { x: x0, y: bearingY_mm, z: z0 },
      joistMat,
      { roof: "pent", part: "rafter" }
    );
  }

  // OSB boards laid above rafters (thickness vertical)
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];

    const x0 = data.originX_mm + p.x0_mm;
    const z0 = data.originZ_mm + p.z0_mm;
    const cx = x0 + p.xLen_mm / 2;
    const bearingY_mm = bearingYAtWorldX_mm(cx);

    mkBox(
      `roof-osb-${i}`,
      p.xLen_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      { x: x0, y: bearingY_mm + data.rafterD_mm, z: z0 },
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }
}

export function updateBOM(state) {
  const tbody = document.getElementById("roofBomTable");
  if (!tbody) return;

  // Always clear and render something deterministic
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
    L: data.isWShort ? data.roofD_mm : data.roofW_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm),
  });

  // Rafters (grouped)
  rows.push({
    item: "Roof Rafter",
    qty: data.rafters.length,
    L: data.rafterLen_mm,
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

function computeRoofData(state) {
  const R = resolveDims(state);

  // Resolved frame dims (used for pent pitch interpolation along X)
  const frameW = Math.max(
    1,
    Math.floor(
      Number(
        R && R.frame && R.frame.w_mm != null
          ? R.frame.w_mm
          : state && state.w != null
          ? state.w
          : 1
      )
    )
  );

  // Resolved roof extents already include overhang
  const roofW = Math.max(
    1,
    Math.floor(
      Number(
        R && R.roof && R.roof.w_mm != null
          ? R.roof.w_mm
          : state && state.w != null
          ? state.w
          : 1
      )
    )
  );
  const roofD = Math.max(
    1,
    Math.floor(
      Number(
        R && R.roof && R.roof.d_mm != null
          ? R.roof.d_mm
          : state && state.d != null
          ? state.d
          : 1
      )
    )
  );

  const oh = R && R.overhang ? R.overhang : null;
  const l_mm = Math.max(0, Math.floor(Number(oh && oh.l_mm != null ? oh.l_mm : 0)));
  const f_mm = Math.max(0, Math.floor(Number(oh && oh.f_mm != null ? oh.f_mm : 0)));

  // Plan origin must align to already-shifted walls:
  // shiftWallMeshes(..., -25, +168, -25)
  const WALL_OVERHANG_MM = 25;
  const originX_mm = -WALL_OVERHANG_MM - l_mm;
  const originZ_mm = -WALL_OVERHANG_MM - f_mm;

  // Wall heights for pent seating:
  // Prefer roof.pent min/max if present; otherwise fall back to state.walls.height_mm.
  const wallH = Math.max(
    100,
    Math.floor(
      state && state.walls && state.walls.height_mm != null
        ? Number(state.walls.height_mm)
        : 2400
    )
  );

  let minWallH_mm = wallH;
  let maxWallH_mm = wallH;

  try {
    const p = state && state.roof && state.roof.pent ? state.roof.pent : null;
    const mn = p && p.minHeight_mm != null ? Math.floor(Number(p.minHeight_mm)) : NaN;
    const mx = p && p.maxHeight_mm != null ? Math.floor(Number(p.maxHeight_mm)) : NaN;
    if (Number.isFinite(mn) && Number.isFinite(mx)) {
      minWallH_mm = Math.max(100, mn);
      maxWallH_mm = Math.max(100, mx);
    }
  } catch (e) {}

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

  const rafterLen_mm = A;

  // Placement positions along B: include 0; step 600; ensure last at (B - rafterW_mm) if possible
  const pos = [];
  const maxP = Math.max(0, B - rafterW_mm);

  let p = 0;
  while (p <= maxP) {
    pos.push(Math.floor(p));
    p += spacing;
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

    // Store roof-local anchors deterministically (used by build3D mapping)
    if (isWShort) {
      // A->X, B->Z
      rafters.push({
        len_mm: rafterLen_mm,
        x0_mm: 0,
        z0_mm: b0,
      });
    } else {
      // A->Z, B->X
      rafters.push({
        len_mm: rafterLen_mm,
        x0_mm: b0,
        z0_mm: 0,
      });
    }
  }

  // OSB tiling in AB space: 1220 along A, 2440 along B (no stagger)
  const osbAB = computeOsbPiecesNoStagger(A, B);

  // Map AB pieces to X/Z consistent with rafter mapping
  const mappedAll = [];
  for (let i = 0; i < osbAB.all.length; i++) {
    const p2 = osbAB.all[i];

    // In AB space:
    // - W_mm is along A (1220 direction)
    // - L_mm is along B (2440 direction)
    if (isWShort) {
      // A->X, B->Z
      mappedAll.push({
        kind: p2.kind,
        x0_mm: p2.a0_mm,
        z0_mm: p2.b0_mm,
        xLen_mm: p2.W_mm,
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
        xLen_mm: p2.L_mm,
        zLen_mm: p2.W_mm,
        L_mm: p2.L_mm,
        W_mm: p2.W_mm,
      });
    }
  }

  return {
    frameW_mm: frameW,
    roofW_mm: roofW,
    roofD_mm: roofD,
    originX_mm,
    originZ_mm,
    minWallH_mm,
    maxWallH_mm,
    A_mm: A,
    B_mm: B,
    isWShort: isWShort,
    rafterW_mm,
    rafterD_mm,
    rafterLen_mm,
    rafters,
    osbThickness_mm: 18,
    osb: {
      all: mappedAll,
      totalArea_mm2: osbAB.totalArea_mm2,
    },
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