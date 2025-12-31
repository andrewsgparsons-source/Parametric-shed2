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

  // Minimal debug guard (no console)
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.lastRoof = {
        isWShort: !!data.isWShort,
        roofW: data.roofW_mm,
        roofD: data.roofD_mm,
        originX: data.originX_mm,
        originZ: data.originZ_mm,
        minH: data.minH_mm,
        maxH: data.maxH_mm,
        slopeAxis: "X",
      };
    }
  } catch (e) {}

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

  function mkBox(name, Lx, Ly, Lz, pos, mat, meta, rotZ_rad) {
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
    if (Number.isFinite(rotZ_rad) && rotZ_rad !== 0) {
      mesh.rotation = mesh.rotation || new BABYLON.Vector3(0, 0, 0);
      mesh.rotation.z = rotZ_rad;
    }
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    return mesh;
  }

  // ---- Bearing plane (single plane height function; fixes fragmentation) ----
  const plane = computeBearingPlaneFromWalls(scene, data);
  // Fallback: use roof.pent min/max + walls.height_mm if wall plates cannot be found.
  const planeK = plane.k; // meters per meter
  const planeC = plane.c; // meters (Y intercept in world: Y = k*X + c)
  const theta = plane.theta; // radians, tan(theta)=k

  // Helper: world-Y (meters) on bearing plane at world X (mm)
  function bearingY_m_atWorldXmm(x_mm) {
    const X_m = (x_mm) / 1000;
    return planeK * X_m + planeC;
  }

  // Convert a bearing plane (Y = kX + c) into a centerY (mm) for a rotated box:
  // For a box rotated about Z by theta, the bottom face becomes a plane:
  //   Y = kX + (cy - k*cx - (h/2)/cosθ)
  // To make bottom face equal bearing plane, set:
  //   cy = (k*cx + c) + (h/2)/cosθ
  function centerY_mm_forBottomOnPlane(xCenter_mm, height_mm) {
    const Xc_m = xCenter_mm / 1000;
    const cosT = Math.max(1e-9, Math.cos(theta));
    const yBottom_m = planeK * Xc_m + planeC;
    const cy_m = yBottom_m + (height_mm / 1000) / 2 / cosT;
    return cy_m * 1000;
  }

  // For an additional vertical separation between planes, expressed in *plane-normal* distance.
  // We use plane-parallel offset derived from rotated box geometry (keeps OSB sitting on rafter tops).
  function centerY_mm_forBottomOnPlaneWithParallelOffset(xCenter_mm, height_mm, planeYOffset_m) {
    const Xc_m = xCenter_mm / 1000;
    const cosT = Math.max(1e-9, Math.cos(theta));
    const yBottom_m = (planeK * Xc_m + planeC) + planeYOffset_m;
    const cy_m = yBottom_m + (height_mm / 1000) / 2 / cosT;
    return cy_m * 1000;
  }

  // Roof slope is along WORLD X (consistent with wall system: left=min at x=0 side).
  // Apply tilt only when a part spans along X; otherwise keep level but still seat to plane at its X.
  const partRotZ = theta;

  // ---- Rim Joists (front/back at ends of A; run along B) ----
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  // Rim pieces are placed in AB space then mapped to world X/Z with origin shift.
  // Front rim (A = 0)
  {
    const m = mapABtoWorldXZ_ForRim(0, 0, rimThkA_mm, rimRunB_mm, data.isWShort, data.originX_mm, data.originZ_mm);
    const xCenter_mm = m.x0 + m.lenX / 2;
    const yCenter_mm = centerY_mm_forBottomOnPlane(xCenter_mm, data.rafterD_mm);
    mkBox(
      "roof-rim-front",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      { x: m.x0, y: yCenter_mm - data.rafterD_mm / 2, z: m.z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "front" },
      partRotZ
    );
  }

  // Back rim (A = A - thickness)
  {
    const m = mapABtoWorldXZ_ForRim(rimBackA0_mm, 0, rimThkA_mm, rimRunB_mm, data.isWShort, data.originX_mm, data.originZ_mm);
    const xCenter_mm = m.x0 + m.lenX / 2;
    const yCenter_mm = centerY_mm_forBottomOnPlane(xCenter_mm, data.rafterD_mm);
    mkBox(
      "roof-rim-back",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      { x: m.x0, y: yCenter_mm - data.rafterD_mm / 2, z: m.z0 },
      joistMat,
      { roof: "pent", part: "rim", edge: "back" },
      partRotZ
    );
  }

  // ---- Rafters (span along A, placed along B @600) ----
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];

    const mapped = mapABtoWorldXZ_ForRafter(
      0,
      r.b0_mm,
      data.rafterLen_mm,
      data.rafterW_mm,
      data.isWShort,
      data.originX_mm,
      data.originZ_mm
    );

    const xCenter_mm = mapped.x0 + mapped.lenX / 2;

    // If the rafter spans along X, rotate and seat its bottom on the plane for all X (single plane, no stepping).
    // If it spans along Z (lenX is thickness), it can be level; still use plane at its constant X.
    const spansX = data.isWShort; // A->X when roofW is short => rafters span X
    if (spansX) {
      const yCenter_mm = centerY_mm_forBottomOnPlane(xCenter_mm, data.rafterD_mm);
      mkBox(
        `roof-rafter-${i}`,
        mapped.lenX,
        data.rafterD_mm,
        mapped.lenZ,
        { x: mapped.x0, y: yCenter_mm - data.rafterD_mm / 2, z: mapped.z0 },
        joistMat,
        { roof: "pent", part: "rafter" },
        partRotZ
      );
    } else {
      // Level placement (no rotation) at the plane height at this X.
      const yBottom_m = bearingY_m_atWorldXmm(xCenter_mm);
      const yBottom_mm = yBottom_m * 1000;
      mkBox(
        `roof-rafter-${i}`,
        mapped.lenX,
        data.rafterD_mm,
        mapped.lenZ,
        { x: mapped.x0, y: yBottom_mm, z: mapped.z0 },
        joistMat,
        { roof: "pent", part: "rafter" }
      );
    }
  }

  // ---- OSB boards laid above rafters (tilted; single plane) ----
  // OSB bottom must sit on rafter top plane.
  // For rotated rafters spanning X, the rafter top plane is parallel to bearing plane, offset by (rafterDepth / cosθ) in Y-intercept.
  // For level rafters (spanning Z), top is bearing + rafterDepth (vertical); however we still rotate OSB to match roof plane.
  const cosT = Math.max(1e-9, Math.cos(theta));
  const rafterTopYOffset_m_parallel = (data.rafterD_mm / 1000) / cosT;

  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    const xCenter_mm = p.x0_mm + p.xLen_mm / 2;

    const spansX = data.isWShort;
    if (spansX) {
      const yCenter_mm = centerY_mm_forBottomOnPlaneWithParallelOffset(
        xCenter_mm,
        data.osbThickness_mm,
        rafterTopYOffset_m_parallel
      );
      mkBox(
        `roof-osb-${i}`,
        p.xLen_mm,
        data.osbThickness_mm,
        p.zLen_mm,
        { x: p.x0_mm, y: yCenter_mm - data.osbThickness_mm / 2, z: p.z0_mm },
        osbMat,
        { roof: "pent", part: "osb", kind: p.kind },
        partRotZ
      );
    } else {
      // Level rafters: OSB still rotates to match the plane; seat OSB bottom at bearing plane + rafterDepth (vertical).
      // Convert that to an equivalent plane-parallel offset by projecting vertical onto the plane normal (small angles).
      // We avoid introducing new constants; compute it from theta.
      const vertOffset_m = data.rafterD_mm / 1000;
      const planeOffset_m_parallel = vertOffset_m / cosT;

      const yCenter_mm = centerY_mm_forBottomOnPlaneWithParallelOffset(
        xCenter_mm,
        data.osbThickness_mm,
        planeOffset_m_parallel
      );

      mkBox(
        `roof-osb-${i}`,
        p.xLen_mm,
        data.osbThickness_mm,
        p.zLen_mm,
        { x: p.x0_mm, y: yCenter_mm - data.osbThickness_mm / 2, z: p.z0_mm },
        osbMat,
        { roof: "pent", part: "osb", kind: p.kind },
        partRotZ
      );
    }
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function mapABtoWorldXZ_ForRafter(a0, b0, aLen, bLen, isWShort, originX_mm, originZ_mm) {
  // aLen is rafter length along short span axis
  // bLen is the rafter "thickness" along the placement axis
  if (isWShort) return { x0: originX_mm + a0, z0: originZ_mm + b0, lenX: aLen, lenZ: bLen };
  return { x0: originX_mm + b0, z0: originZ_mm + a0, lenX: bLen, lenZ: aLen };
}

function mapABtoWorldXZ_ForRim(a0, b0, aLen, bLen, isWShort, originX_mm, originZ_mm) {
  // aLen is rim thickness along short span axis (A)
  // bLen is rim run length along long axis (B)
  if (isWShort) return { x0: originX_mm + a0, z0: originZ_mm + b0, lenX: aLen, lenZ: bLen };
  return { x0: originX_mm + b0, z0: originZ_mm + a0, lenX: bLen, lenZ: aLen };
}

function computeRoofData(state) {
  // Use resolved dims (includes overhang) but keep roof-only behavior when pent is enabled.
  const dims = resolveDims(state);

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  const frameW = Math.max(1, Math.floor(Number(dims?.frame?.w_mm)));
  const frameD = Math.max(1, Math.floor(Number(dims?.frame?.d_mm)));

  const ovh = dims?.overhang || { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };

  // Coordinate reference: walls are shifted in index.js by -25mm in X/Z.
  // Roof origin must match that shifted frame origin, and then extend by per-side overhang.
  const WALL_OVERHANG_MM = 25;
  const originX_mm = -WALL_OVERHANG_MM - Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
  const originZ_mm = -WALL_OVERHANG_MM - Math.max(0, Math.floor(Number(ovh.f_mm || 0)));

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
    rafters.push({ b0_mm: pos[i] });
  }

  // OSB tiling in AB space: 1220 along A, 2440 along B (no stagger)
  const osbAB = computeOsbPiecesNoStagger(A, B);

  // Map AB pieces to world X/Z consistent with rafter mapping and origin shift
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

  const minH = Math.max(100, Math.floor(Number(state?.roof?.pent?.minHeight_mm ?? state?.walls?.height_mm ?? 2400)));
  const maxH = Math.max(100, Math.floor(Number(state?.roof?.pent?.maxHeight_mm ?? state?.walls?.height_mm ?? 2400)));

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

function computeBearingPlaneFromWalls(scene, data) {
  // Find all wall top plate meshes (including basic panel tops)
  const candidates = scene.meshes.filter((m) => {
    if (!m || !m.name || typeof m.name !== "string") return false;
    if (!m.name.startsWith("wall-")) return false;
    return m.name.indexOf("plate-top") >= 0;
  });

  // Fallback plane if none: use roof.pent min/max with wall rise inferred from current walls height.
  if (!candidates.length) {
    // World X reference: walls are shifted by -25mm in index.js
    const x0_m = (-25) / 1000;
    const frameW_m = Math.max(1, Math.floor(Number(data.frameW_mm))) / 1000;

    // Use state-driven heights in mm and assume they already include rise via walls build; we only need a consistent plane.
    const leftY_m = Math.max(0, Number.isFinite(data.minH_mm) ? data.minH_mm : 2400) / 1000;
    const rightY_m = Math.max(0, Number.isFinite(data.maxH_mm) ? data.maxH_mm : 2400) / 1000;

    const k = frameW_m > 0 ? (rightY_m - leftY_m) / frameW_m : 0;
    const c = leftY_m - k * x0_m;
    const theta = Math.atan(k);
    return { k, c, theta };
  }

  // Compute centerX and group by min/max centerX with tolerance based on bbox extents (no guessed constants)
  const items = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      const bi = m.getBoundingInfo && m.getBoundingInfo();
      if (!bi || !bi.boundingBox) continue;
      const bb = bi.boundingBox;
      const minW = bb.minimumWorld;
      const maxW = bb.maximumWorld;
      const centerX = (minW.x + maxW.x) / 2;
      const extX = Math.max(0, maxW.x - minW.x);
      items.push({ m, centerX, extX, topY: maxW.y });
    } catch (e) {}
  }

  if (!items.length) {
    const k = 0, c = 0, theta = 0;
    return { k, c, theta };
  }

  let minCX = items[0].centerX;
  let maxCX = items[0].centerX;
  let maxExtX = items[0].extX;
  for (let i = 1; i < items.length; i++) {
    minCX = Math.min(minCX, items[i].centerX);
    maxCX = Math.max(maxCX, items[i].centerX);
    maxExtX = Math.max(maxExtX, items[i].extX);
  }

  const tol = Math.max(1e-6, maxExtX); // bbox-based tolerance (meters)

  const left = [];
  const right = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (Math.abs(it.centerX - minCX) <= tol) left.push(it);
    if (Math.abs(it.centerX - maxCX) <= tol) right.push(it);
  }

  const leftBearingY = left.length
    ? left.reduce((a, b) => (b.topY > a ? b.topY : a), left[0].topY)
    : items.reduce((a, b) => (b.topY > a ? b.topY : a), items[0].topY);

  const rightBearingY = right.length
    ? right.reduce((a, b) => (b.topY > a ? b.topY : a), right[0].topY)
    : items.reduce((a, b) => (b.topY > a ? b.topY : a), items[0].topY);

  // Frame width is along WORLD X; reference X0 is the shifted wall frame origin (-25mm)
  const x0_m = (-25) / 1000;
  const frameW_m = Math.max(1, Math.floor(Number(data.frameW_mm))) / 1000;

  const k = frameW_m > 0 ? (rightBearingY - leftBearingY) / frameW_m : 0;
  const c = leftBearingY - k * x0_m;
  const theta = Math.atan(k);

  return { k, c, theta };
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