// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 * - Rafters/joists @600mm spacing (literal).
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm (literal).
 * - Rafters span the shortest roof dimension (A = min(w,d)); placed along the long axis (B = max(w,d)).
 * - Timber cross-section orientation kept as-is: uses CONFIG.timber.w / CONFIG.timber.d with swapped axes.
 *
 * All roof meshes:
 * - name prefix "roof-"
 * - metadata.dynamic === true
 */

import { CONFIG, resolveDims } from "../params.js";

export function build3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  // ---- HARD DISPOSAL (meshes + transform nodes), children before parents ----
  const roofMeshes = [];
  const roofNodes = new Set();

  for (let i = 0; i < (scene.meshes || []).length; i++) {
    const m = scene.meshes[i];
    if (!m) continue;
    const nm = String(m.name || "");
    let isRoof = nm.startsWith("roof-") && m.metadata && m.metadata.dynamic === true;

    if (!isRoof) {
      // Parent-chain containment
      try {
        let p = m.parent;
        while (p) {
          const pn = String(p.name || "");
          if (pn === "roof-root" || pn.startsWith("roof-")) {
            isRoof = true;
            break;
          }
          p = p.parent;
        }
      } catch (e) {}
    }

    if (isRoof) roofMeshes.push(m);
  }

  for (let i = 0; i < (scene.transformNodes || []).length; i++) {
    const n = scene.transformNodes[i];
    if (!n) continue;
    const nm = String(n.name || "");
    if (nm === "roof-root" || nm.startsWith("roof-")) roofNodes.add(n);
  }

  // Dispose meshes first
  for (let i = 0; i < roofMeshes.length; i++) {
    const m = roofMeshes[i];
    try {
      if (m && !m.isDisposed()) m.dispose(false, true);
    } catch (e) {}
  }

  // Dispose transform nodes (deepest first)
  const nodesArr = Array.from(roofNodes);
  nodesArr.sort((a, b) => {
    const depth = (n) => {
      let d = 0;
      let p = n && n.parent;
      while (p) {
        d++;
        p = p.parent;
      }
      return d;
    };
    return depth(b) - depth(a);
  });
  for (let i = 0; i < nodesArr.length; i++) {
    const n = nodesArr[i];
    try {
      if (n) n.dispose(false);
    } catch (e) {}
  }

  if (!isPentEnabled(state)) return;

  const data = computeRoofData(state);
  const dims = resolveDims(state);
  const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };

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

  function mkBoxBottomLocal(name, Lx_mm, Ly_mm, Lz_mm, x_mm, yBottom_m, z_mm, parentNode, mat, meta) {
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

  function boundsForMeshes(meshes) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let found = false;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const bb = bi.boundingBox;
        const ax = bb.minimumWorld.x, bx = bb.maximumWorld.x;
        const az = bb.minimumWorld.z, bz = bb.maximumWorld.z;
        if (Number.isFinite(ax) && Number.isFinite(bx) && Number.isFinite(az) && Number.isFinite(bz)) {
          found = true;
          if (ax < minX) minX = ax;
          if (bx > maxX) maxX = bx;
          if (az < minZ) minZ = az;
          if (bz > maxZ) maxZ = bz;
        }
      } catch (e) {}
    }
    if (!found) return null;
    return { minX, maxX, minZ, maxZ };
  }

  // ---- Collect wall top plates (front/back) and pick the longest in-plan ----
  function platePlanLen_m(mesh) {
    try {
      mesh.computeWorldMatrix(true);
      const bi = mesh.getBoundingInfo && mesh.getBoundingInfo();
      if (!bi || !bi.boundingBox) return -1;
      const bb = bi.boundingBox;
      const dx = Math.abs(bb.maximumWorld.x - bb.minimumWorld.x);
      const dz = Math.abs(bb.maximumWorld.z - bb.minimumWorld.z);
      const L = Math.max(dx, dz);
      return Number.isFinite(L) ? L : -1;
    } catch (e) {
      return -1;
    }
  }

  function findDominantTopPlate(prefix) {
    let best = null;
    let bestLen = -1;

    for (let i = 0; i < (scene.meshes || []).length; i++) {
      const m = scene.meshes[i];
      if (!m) continue;
      if (m.isDisposed && m.isDisposed()) continue;
      if (!m.metadata || m.metadata.dynamic !== true) continue;

      const nm = String(m.name || "");
      if (!nm.startsWith(prefix)) continue;
      if (!nm.endsWith("plate-top")) continue;

      const L = platePlanLen_m(m);
      if (L > bestLen) {
        bestLen = L;
        best = m;
      }
    }

    return best;
  }

  const frontPlate = findDominantTopPlate("wall-front-");
  const backPlate = findDominantTopPlate("wall-back-");

  // ---- Roof footprint extents in world X/Z (keep existing overhang logic) ----
  const wallAll = [];
  for (let i = 0; i < (scene.meshes || []).length; i++) {
    const m = scene.meshes[i];
    if (!m) continue;
    const nm = String(m.name || "");
    if (!nm.startsWith("wall-")) continue;
    if (m.isDisposed && m.isDisposed()) continue;
    wallAll.push(m);
  }

  const wallBounds = boundsForMeshes(wallAll);
  const wallMinX_m = wallBounds ? wallBounds.minX : 0;
  const wallMaxX_m = wallBounds ? wallBounds.maxX : (wallMinX_m + (Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? 1))) / 1000));
  const wallMinZ_m = wallBounds ? wallBounds.minZ : 0;
  const wallMaxZ_m = wallBounds ? wallBounds.maxZ : (wallMinZ_m + (Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? 1))) / 1000));

  const l_m = Math.max(0, Math.floor(Number(ovh.l_mm || 0))) / 1000;
  const r_m = Math.max(0, Math.floor(Number(ovh.r_mm || 0))) / 1000;
  const f_m = Math.max(0, Math.floor(Number(ovh.f_mm || 0))) / 1000;
  const b_m = Math.max(0, Math.floor(Number(ovh.b_mm || 0))) / 1000;

  const roofMinX_m = wallMinX_m - l_m;
  const roofMaxX_m = wallMaxX_m + r_m;
  const roofMinZ_m = wallMinZ_m - f_m;
  const roofMaxZ_m = wallMaxZ_m + b_m;

  // ---- Single rigid roof root ----
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };

  // Keep plan origin placement EXACTLY as before (x/z)
  roofRoot.position = new BABYLON.Vector3(roofMinX_m, 0, roofMinZ_m);

  // ---- Build roof parts in ROOF-LOCAL model space at y=0 underside of rafters ----
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  function mapABtoLocalXZ(a0, b0, aLen, bLen, isWShort) {
    if (isWShort) return { x0: a0, z0: b0, lenX: aLen, lenZ: bLen }; // A->X, B->Z
    return { x0: b0, z0: a0, lenX: bLen, lenZ: aLen }; // A->Z, B->X
  }

  // Rim joists (front/back at ends of A; run along B)
  {
    const m = mapABtoLocalXZ(0, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    mkBoxBottomLocal(
      "roof-rim-front",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      m.x0,
      0,
      m.z0,
      roofRoot,
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }
  {
    const m = mapABtoLocalXZ(rimBackA0_mm, 0, rimThkA_mm, rimRunB_mm, data.isWShort);
    mkBoxBottomLocal(
      "roof-rim-back",
      m.lenX,
      data.rafterD_mm,
      m.lenZ,
      m.x0,
      0,
      m.z0,
      roofRoot,
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // Rafters (span A, placed along B @600)
  for (let i = 0; i < data.rafters.length; i++) {
    const r = data.rafters[i];
    const mapped = mapABtoLocalXZ(0, r.b0_mm, data.rafterLen_mm, data.rafterW_mm, data.isWShort);

    mkBoxBottomLocal(
      `roof-rafter-${i}`,
      mapped.lenX,
      data.rafterD_mm,
      mapped.lenZ,
      mapped.x0,
      0,
      mapped.z0,
      roofRoot,
      joistMat,
      { roof: "pent", part: "rafter" }
    );
  }

  // OSB (bottom on top of rafters)
  const osbBottomY_m_local = data.rafterD_mm / 1000;
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    mkBoxBottomLocal(
      `roof-osb-${i}`,
      p.xLen_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      p.x0_mm,
      osbBottomY_m_local,
      p.z0_mm,
      roofRoot,
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }

  // ---- Determine longAxis from front/back top plates and seat/pitch using their top Y ----
  function xzDirFromBBoxLongest(mesh) {
    try {
      mesh.computeWorldMatrix(true);
      const bi = mesh.getBoundingInfo && mesh.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const bb = bi.boundingBox;

      const dx = bb.maximumWorld.x - bb.minimumWorld.x;
      const dz = bb.maximumWorld.z - bb.minimumWorld.z;

      let vx = 0, vz = 0;
      if (Math.abs(dx) >= Math.abs(dz)) {
        vx = dx >= 0 ? 1 : -1;
        vz = 0;
      } else {
        vx = 0;
        vz = dz >= 0 ? 1 : -1;
      }

      const len = Math.hypot(vx, vz);
      if (len < 1e-9) return null;
      return { x: vx / len, z: vz / len };
    } catch (e) {
      return null;
    }
  }

  function xzNormalize(v) {
    const len = Math.hypot(v.x, v.z);
    if (!Number.isFinite(len) || len < 1e-9) return null;
    return { x: v.x / len, z: v.z / len };
  }

  function xzAdd(a, b) {
    return { x: (a.x + b.x), z: (a.z + b.z) };
  }

  function xzDot(a, b) {
    return (a.x * b.x + a.z * b.z);
  }

  function xzPerp(v) {
    return { x: -v.z, z: v.x };
  }

  function bboxCenterXZ(mesh) {
    try {
      mesh.computeWorldMatrix(true);
      const bi = mesh.getBoundingInfo && mesh.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const bb = bi.boundingBox;
      return {
        x: (bb.minimumWorld.x + bb.maximumWorld.x) * 0.5,
        z: (bb.minimumWorld.z + bb.maximumWorld.z) * 0.5
      };
    } catch (e) {
      return null;
    }
  }

  const frontTopY_m = (() => {
    try {
      if (!frontPlate) return null;
      frontPlate.computeWorldMatrix(true);
      const bi = frontPlate.getBoundingInfo && frontPlate.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const y = bi.boundingBox.maximumWorld.y;
      return Number.isFinite(y) ? y : null;
    } catch (e) {
      return null;
    }
  })();

  const backTopY_m = (() => {
    try {
      if (!backPlate) return null;
      backPlate.computeWorldMatrix(true);
      const bi = backPlate.getBoundingInfo && backPlate.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const y = bi.boundingBox.maximumWorld.y;
      return Number.isFinite(y) ? y : null;
    } catch (e) {
      return null;
    }
  })();

  let vFront = frontPlate ? xzDirFromBBoxLongest(frontPlate) : null;
  let vBack = backPlate ? xzDirFromBBoxLongest(backPlate) : null;

  let longAxis = null;
  if (vFront && vBack) {
    const s = xzAdd(vFront, vBack);
    longAxis = xzNormalize(s) || xzNormalize(vFront) || xzNormalize(vBack);
  } else {
    longAxis = xzNormalize(vFront || vBack || { x: 1, z: 0 });
  }
  if (!longAxis) longAxis = { x: 1, z: 0 };

  let pitchAxis = xzNormalize(xzPerp(longAxis));
  if (!pitchAxis) pitchAxis = { x: 0, z: 1 };

  // Determine rafter direction in roof-local plan (before transforms):
  // Rafters run along A (short span): local axis is X if isWShort else Z.
  const rafterLocalDir = data.isWShort ? { x: 1, z: 0 } : { x: 0, z: 1 };

  // Yaw so rafters become parallel to longAxis (plan)
  const yaw = (() => {
    const a = rafterLocalDir;
    const b = longAxis;
    const dot = clamp(xzDot(a, b), -1, 1);
    const crossY = (a.x * b.z - a.z * b.x);
    const ang = Math.acos(dot);
    return crossY >= 0 ? ang : -ang;
  })();

  // Front/back roof edges in world (by footprint Z extents)
  const frontEdgeZ_m = roofMinZ_m;
  const backEdgeZ_m = roofMaxZ_m;

  // Representative points (centers) on front/back edges for run computation
  const centerX_m = (roofMinX_m + roofMaxX_m) * 0.5;
  const pFront = { x: centerX_m, z: frontEdgeZ_m };
  const pBack = { x: centerX_m, z: backEdgeZ_m };

  const dXZ = { x: (pBack.x - pFront.x), z: (pBack.z - pFront.z) };
  const run_m = Math.max(1e-6, Math.abs(xzDot(dXZ, pitchAxis)));

  const yFront_m = (frontTopY_m != null) ? frontTopY_m : (Math.max(100, Math.floor(Number(data.minH_mm || 2400))) / 1000);
  const yBack_m = (backTopY_m != null) ? backTopY_m : (Math.max(100, Math.floor(Number(data.maxH_mm || 2400))) / 1000);

  const rise_m = (yBack_m - yFront_m);
  const angle_rad = Math.atan2(rise_m, run_m);

  // Pivot around FRONT edge line (roof-local): z=0 (since roofRoot local origin is roofMinZ)
  const roofW_m_local = (roofMaxX_m - roofMinX_m);
  const pivotLocal = new BABYLON.Vector3(roofW_m_local * 0.5, 0, 0);

  try {
    roofRoot.setPivotPoint(pivotLocal, BABYLON.Space.LOCAL);
  } catch (e) {}

  // Compose rotation as: pitch around rafterLocalDir (longAxis after yaw), then yaw about Y.
  // Using Babylon's multiplication order: q = qYaw.multiply(qPitch) applies qPitch then qYaw.
  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  const pitchAxisLocal = (() => {
    const ax = data.isWShort ? 1 : 0;
    const az = data.isWShort ? 0 : 1;
    return new BABYLON.Vector3(ax, 0, az);
  })();

  const qPitch = BABYLON.Quaternion.RotationAxis(pitchAxisLocal, angle_rad);

  roofRoot.rotationQuaternion = qYaw.multiply(qPitch);

  // Seat underside at FRONT edge to the front plate top Y
  roofRoot.position.y = yFront_m;

  // ---- Debug (safe, roof.js only) ----
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.roofSeat = {
        frontPlate: { name: frontPlate ? String(frontPlate.name || "") : "", topY_m: yFront_m },
        backPlate: { name: backPlate ? String(backPlate.name || "") : "", topY_m: yBack_m },
        longAxis: { x: longAxis.x, z: longAxis.z },
        angle_rad: angle_rad,
        run_m: run_m,
        rise_m: rise_m
      };

      const mkDbgSphere = (name, x_m, y_m, z_m, isFront) => {
        let s = null;
        try {
          s = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.06 }, scene);
          s.position = new BABYLON.Vector3(x_m, y_m, z_m);
          const mat = new BABYLON.StandardMaterial(name + "-mat", scene);
          if (isFront) mat.emissiveColor = new BABYLON.Color3(0.1, 0.9, 0.1);
          else mat.emissiveColor = new BABYLON.Color3(0.9, 0.1, 0.1);
          s.material = mat;
          s.metadata = { dynamic: true };
          return s;
        } catch (e) {
          try { if (s && !s.isDisposed()) s.dispose(false, true); } catch (e2) {}
          return null;
        }
      };

      const cF = frontPlate ? bboxCenterXZ(frontPlate) : { x: centerX_m, z: wallMinZ_m };
      const cB = backPlate ? bboxCenterXZ(backPlate) : { x: centerX_m, z: wallMaxZ_m };

      mkDbgSphere("roof-debug-frontPlate", cF.x, yFront_m, cF.z, true);
      mkDbgSphere("roof-debug-backPlate", cB.x, yBack_m, cB.z, false);
    }
  } catch (e) {}
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
    L: data.isWShort ? data.roofD_mm : data.roofW_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm),
  });

  // Rafters
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

  rows.sort((a, b) => {
    const ai = String(a.item), bi = String(b.item);
    if (ai !== bi) return ai.localeCompare(bi);
    const aL = Number(a.L), bL = Number(b.L);
    if (aL !== bL) return aL - bL;
    const aW = Number(a.W), bW = Number(b.W);
    if (aW !== bW) return aW - bW;
    return String(a.notes).localeCompare(String(b.notes));
  });

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    appendRow5(tbody, [r.item, String(r.qty), String(r.L), String(r.W), r.notes]);
  }

  if (!rows.length) appendPlaceholderRow(tbody, "Roof cutting list not yet generated.");
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

  // Roof-local origin is (0,0). World alignment is handled by roofRoot positioning.
  const originX_mm = 0;
  const originZ_mm = 0;

  // A = shortest (rafter span), B = longest (placement axis)
  const A = Math.min(roofW, roofD);
  const B = Math.max(roofW, roofD);

  // If roofW is the short axis => A->X, B->Z, else A->Z, B->X
  const isWShort = roofW <= roofD;

  const spacing = 600;

  // Timber section from CONFIG, rotated orientation:
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

  // Map AB pieces to roof-local X/Z consistent with rafter mapping
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

  const baseH_mm = Math.max(
    100,
    Math.floor(
      Number(state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400)
    )
  );
  const minH = Math.max(
    100,
    Math.floor(
      Number(
        state && state.roof && state.roof.pent && state.roof.pent.minHeight_mm != null
          ? state.roof.pent.minHeight_mm
          : baseH_mm
      )
    )
  );
  const maxH = Math.max(
    100,
    Math.floor(
      Number(
        state && state.roof && state.roof.pent && state.roof.pent.maxHeight_mm != null
          ? state.roof.pent.maxHeight_mm
          : baseH_mm
      )
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
```0