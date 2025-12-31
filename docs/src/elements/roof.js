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

  // Dispose previous roof transform nodes
  (scene.transformNodes || [])
    .filter(
      (n) =>
        n &&
        n.metadata &&
        n.metadata.dynamic === true &&
        typeof n.name === "string" &&
        n.name.startsWith("roof-")
    )
    .forEach((n) => {
      try {
        n.dispose(false);
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

  function findWallTopY_m(scene, state) {
    let maxY = -Infinity;
    let found = false;
    for (let i = 0; i < scene.meshes.length; i++) {
      const m = scene.meshes[i];
      if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
      const nm = String(m.name || "");
      if (!nm.startsWith("wall-")) continue;
      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const y = bi.boundingBox.maximumWorld.y;
        if (Number.isFinite(y)) {
          found = true;
          if (y > maxY) maxY = y;
        }
      } catch (e) {}
    }

    if (found && Number.isFinite(maxY)) return maxY;

    const h = Math.max(
      100,
      Math.floor(
        Number(
          state && state.walls && state.walls.height_mm != null
            ? state.walls.height_mm
            : 2400
        )
      )
    );
    return h / 1000;
  }

  function findWallMinX_m(scene) {
    let minX = Infinity;
    let found = false;
    for (let i = 0; i < scene.meshes.length; i++) {
      const m = scene.meshes[i];
      if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
      const nm = String(m.name || "");
      if (!nm.startsWith("wall-")) continue;
      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const x = bi.boundingBox.minimumWorld.x;
        if (Number.isFinite(x)) {
          found = true;
          if (x < minX) minX = x;
        }
      } catch (e) {}
    }
    return found && Number.isFinite(minX) ? minX : 0;
  }

  function mkBoxBottomLocal(
    name,
    Lx_mm,
    Ly_mm,
    Lz_mm,
    x_mm,
    yBottom_m,
    z_mm,
    parentNode,
    mat,
    meta
  ) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx_mm / 1000, height: Ly_mm / 1000, depth: Lz_mm / 1000 },
      scene
    );

    mesh.position = new BABYLON.Vector3(
      (x_mm + Lx_mm / 2) / 1000,
      yBottom_m + (Ly_mm / 2) / 1000,
      (z_mm + Lz_mm / 2) / 1000
    );

    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  const wallTopY_m = findWallTopY_m(scene, state);
  const roofRootY_m = wallTopY_m;

  const minWallH_mm = Math.max(100, Math.floor(Number(data.minH_mm)));
  const maxWallH_mm = Math.max(100, Math.floor(Number(data.maxH_mm)));

  const rise_mm = Math.floor(maxWallH_mm - minWallH_mm);
  const run_mm = Math.max(1, Math.floor(Number(resolveDims(state)?.frame?.w_mm ?? data.frameW_mm ?? 1)));
  const angle = Math.atan2(rise_mm, run_mm);

  // Root pivot X derived from actual wall geometry (no guessed constants)
  const wallMinX_m = findWallMinX_m(scene);
  const pivotX_mm = wallMinX_m * 1000;

  // Roof hierarchy (prevents fragmentation; anchors Y exactly once)
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };
  roofRoot.position = new BABYLON.Vector3(wallMinX_m, roofRootY_m, 0);

  const roofTilt = new BABYLON.TransformNode("roof-tilt", scene);
  roofTilt.metadata = { dynamic: true };
  roofTilt.parent = roofRoot;
  roofTilt.rotation = new BABYLON.Vector3(0, 0, rise_mm === 0 ? 0 : angle);

  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.lastRoofSeat = {
        wallTopY_m,
        roofRootY_m,
        rise_mm,
        run_mm,
        angle: rise_mm === 0 ? 0 : angle,
      };
    }
  } catch (e) {}

  // ---- Rim Joists (front/back at ends of A; run along B) ----
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  function mapABtoWorldXZ_ForRim(a0, b0, aLen, bLen, isWShort) {
    if (isWShort) return { x0: data.originX_mm + a0, z0: data.originZ_mm + b0, lenX: aLen, lenZ: bLen };
    return { x0: data.originX_mm + b0, z0: data.originZ_mm + a0, lenX: bLen, lenZ: aLen };
  }

  function mapABtoWorldXZ_ForRafter(a0, b0, aLen, bLen, isWShort) {
    if (isWShort) return { x0: data.originX_mm + a0, z0: data.originZ_mm + b0, lenX: aLen, lenZ: bLen };
    return { x0: data.originX_mm + b0, z0: data.originZ_mm + a0, lenX: bLen, lenZ: aLen };
  }

  // Front rim (A = 0)
  {
    const m = mapABtoWorldXZ_ForRim(0, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const localX_mm = Math.floor(m.x0 - pivotX_mm);
    const localZ_mm = Math.floor(m.z0);
    mkBoxBottomLocal(
      "roof-rim-front",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      localX_mm,
      0,
      localZ_mm,
      roofTilt,
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }

  // Back rim (A = A - thickness)
  {
    const m = mapABtoWorldXZ_ForRim(rimBackA0_mm, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    const localX_mm = Math.floor(m.x0 - pivotX_mm);
    const localZ_mm = Math.floor(m.z0);
    mkBoxBottomLocal(
      "roof-rim-back",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      localX_mm,
      0,
      localZ_mm,
      roofTilt,
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // ---- Rafters (span along A, placed along B @600) ----
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];
    const mapped = mapABtoWorldXZ_ForRafter(0, r.b0_mm, data.rafterLen_mm, data.rafterW_mm, data.isWShort);
    const localX_mm = Math.floor(mapped.x0 - pivotX_mm);
    const localZ_mm = Math.floor(mapped.z0);

    mkBoxBottomLocal(
      `roof-rafter-${i}`,
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      localX_mm,
      0,
      localZ_mm,
      roofTilt,
      joistMat,
      { roof: "pent", part: "rafter" }
    );
  }

  // ---- OSB boards (bottom sits on top of rafters in local space) ----
  const osbBottomY_m = data.rafterD_mm / 1000;
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    const localX_mm = Math.floor(p.x0_mm - pivotX_mm);
    const localZ_mm = Math.floor(p.z0_mm);

    mkBoxBottomLocal(
      `roof-osb-${i}`,
      p.xLen_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      localX_mm,
      osbBottomY_m,
      localZ_mm,
      roofTilt,
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }

  // Optional debug (kept lightweight)
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.lastRoof = {
        isWShort: data.isWShort,
        roofW: data.roofW_mm,
        roofD: data.roofD_mm,
        originX: data.originX_mm,
        originZ: data.originZ_mm,
        minH: minWallH_mm,
        maxH: maxWallH_mm,
        slopeAxis: "X",
      };
    }
  } catch (e) {}
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
  const dims = resolveDims(state);

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  const frameW = Math.max(1, Math.floor(Number(dims?.frame?.w_mm)));
  const frameD = Math.max(1, Math.floor(Number(dims?.frame?.d_mm)));

  const ovh = dims?.overhang || { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };

  // Keep existing plan origin logic (do not change); includes symmetric overhang handling.
  const WALL_OVERHANG_MM = 25;
  const originX_mm = -WALL_OVERHANG_MM - Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
  const originZ_mm = -WALL_OVERHANG_MM - Math.max(0, Math.floor(Number(ovh.f_mm || 0)));

  // A = shortest (rafter span), B = longest (placement axis)
  const A = Math.min(roofW, roofD);
  const B = Math.max(roofW, roofD);

  // If roofW is the short axis => A->X, B->Z, else A->Z, B->X
  const isWShort = roofW <= roofD;

  const spacing = 600;

  // Timber section from CONFIG, rotated orientation:
  // Here: horizontal thickness uses baseD; vertical uses baseW.
  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w))); // typically 50
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d))); // typically 100

  const rafterW_mm = baseD;
  const rafterD_mm = baseW;

  const rafterLen_mm = A;

  // Placement positions along B
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
  for (let i = 0; i < pos.length; i++) rafters.push({ b0_mm: pos[i] });

  // OSB tiling in AB space: 1220 along A, 2440 along B (no stagger)
  const osbAB = computeOsbPiecesNoStagger(A, B);

  // Map AB pieces to world X/Z consistent with rafter mapping and origin shift
  const mappedAll = [];
  for (let i = 0; i < osbAB.all.length; i++) {
    const p2 = osbAB.all[i];
    if (isWShort) {
      // A->X, B->Z
      mappedAll.push({
        kind: p2.kind,
        x0_mm: originX_mm + p2.a0_mm,
        z0_mm: originZ_mm + p2.b0_mm,
        xLen_mm: p2.W_mm,
        zLen_mm: p2.L_mm,
        L_mm: p2.L_mm,
        W_mm: p2.W_mm,
      });
    } else {
      // A->Z, B->X
      mappedAll.push({
        kind: p2.kind,
        x0_mm: originX_mm + p2.b0_mm,
        z0_mm: originZ_mm + p2.a0_mm,
        xLen_mm: p2.L_mm,
        zLen_mm: p2.W_mm,
        L_mm: p2.L_mm,
        W_mm: p2.W_mm,
      });
    }
  }

  const minH = Math.max(
    100,
    Math.floor(
      Number(state?.roof?.pent?.minHeight_mm ?? state?.walls?.height_mm ?? 2400)
    )
  );
  const maxH = Math.max(
    100,
    Math.floor(
      Number(state?.roof?.pent?.maxHeight_mm ?? state?.walls?.height_mm ?? 2400)
    )
  );

  return {
    roofW_mm: roofW,
    roofD_mm: roofD,
    frameW_mm: frameW,
    frameD_mm: frameD,
    originX_mm,
    originZ_mm,
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
    minH_mm: minH,
    maxH_mm: maxH,
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