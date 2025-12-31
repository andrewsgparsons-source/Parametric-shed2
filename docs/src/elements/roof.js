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
    const isRoof = nm.startsWith("roof-") && m.metadata && m.metadata.dynamic === true;
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

  // ---- Overhang footprint extents derived from actual wall bounds (no guessed offsets) ----
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

  // ---- Robust top-plate finder (front/back) ----
  function findTopPlateMesh(wallId) {
    const prefix = `wall-${wallId}-`;
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

      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const bb = bi.boundingBox;
        const dx = Math.abs(bb.maximumWorld.x - bb.minimumWorld.x);
        const dz = Math.abs(bb.maximumWorld.z - bb.minimumWorld.z);
        const planLen = Math.max(dx, dz);
        if (Number.isFinite(planLen) && planLen > bestLen) {
          bestLen = planLen;
          best = m;
        }
      } catch (e) {}
    }

    return best;
  }

  function plateInfoFromMesh(mesh) {
    if (!mesh) return null;
    try {
      mesh.computeWorldMatrix(true);
      const bi = mesh.getBoundingInfo && mesh.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const bb = bi.boundingBox;

      const minX = bb.minimumWorld.x, maxX = bb.maximumWorld.x;
      const minZ = bb.minimumWorld.z, maxZ = bb.maximumWorld.z;
      const dx = Math.abs(maxX - minX);
      const dz = Math.abs(maxZ - minZ);
      const planLen = Math.max(dx, dz);

      const cx = (minX + maxX) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const topY = bb.maximumWorld.y;

      let axis = "x";
      if (dz > dx) axis = "z";

      return {
        name: String(mesh.name || ""),
        mesh,
        topY_m: Number.isFinite(topY) ? topY : null,
        cx_m: Number.isFinite(cx) ? cx : null,
        cz_m: Number.isFinite(cz) ? cz : null,
        planLen_m: Number.isFinite(planLen) ? planLen : null,
        axis
      };
    } catch (e) {
      return null;
    }
  }

  let frontPlateMesh = findTopPlateMesh("front");
  let backPlateMesh = findTopPlateMesh("back");

  let frontPlate = plateInfoFromMesh(frontPlateMesh);
  let backPlate = plateInfoFromMesh(backPlateMesh);

  // Fallback plate info if meshes missing (walls hidden/not built)
  if (!frontPlate || frontPlate.topY_m == null || frontPlate.cx_m == null || frontPlate.cz_m == null) {
    frontPlate = {
      name: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
      mesh: frontPlateMesh || null,
      topY_m: Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000),
      cx_m: (roofMinX_m + roofMaxX_m) * 0.5,
      cz_m: wallMinZ_m,
      planLen_m: Math.abs(wallMaxX_m - wallMinX_m),
      axis: "x"
    };
  }
  if (!backPlate || backPlate.topY_m == null || backPlate.cx_m == null || backPlate.cz_m == null) {
    backPlate = {
      name: backPlateMesh ? String(backPlateMesh.name || "") : "",
      mesh: backPlateMesh || null,
      topY_m: Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000),
      cx_m: (roofMinX_m + roofMaxX_m) * 0.5,
      cz_m: wallMaxZ_m,
      planLen_m: Math.abs(wallMaxX_m - wallMinX_m),
      axis: "x"
    };
  }

  // Defensive: ensure front/back are ordered by world Z (front = smaller Z)
  if (Number.isFinite(frontPlate.cz_m) && Number.isFinite(backPlate.cz_m) && frontPlate.cz_m > backPlate.cz_m) {
    const tmp = frontPlate;
    frontPlate = backPlate;
    backPlate = tmp;
  }

  // ---- Determine long axis from plates (axis-aligned) ----
  let longAxisWorld = "x";
  if (frontPlate.axis === backPlate.axis) {
    longAxisWorld = frontPlate.axis;
  } else {
    const fL = Number(frontPlate.planLen_m);
    const bL = Number(backPlate.planLen_m);
    if (Number.isFinite(fL) && Number.isFinite(bL)) {
      longAxisWorld = (fL >= bL) ? frontPlate.axis : backPlate.axis;
    } else {
      longAxisWorld = frontPlate.axis;
    }
  }

  const longAxisVec = (longAxisWorld === "x")
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 0, 1);

  const pitchAxisWorld = (longAxisWorld === "x") ? "z" : "x";
  const pitchAxisVec = (pitchAxisWorld === "x")
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 0, 1);

  // ---- Build rigid roof assembly under roofRoot at identity (local underside y=0) ----
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();

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

  // ---- Compute combined local bounds of roof children (roofRoot is identity) ----
  let localMinX = Infinity, localMaxX = -Infinity, localMinZ = Infinity, localMaxZ = -Infinity;
  const kids = roofRoot.getChildMeshes ? roofRoot.getChildMeshes(false) : [];
  for (let i = 0; i < kids.length; i++) {
    const m = kids[i];
    if (!m) continue;
    try {
      m.computeWorldMatrix(true);
      const bi = m.getBoundingInfo && m.getBoundingInfo();
      if (!bi || !bi.boundingBox) continue;
      const bb = bi.boundingBox;
      const ax = bb.minimumWorld.x;
      const bx = bb.maximumWorld.x;
      const az = bb.minimumWorld.z;
      const bz = bb.maximumWorld.z;
      if (Number.isFinite(ax) && Number.isFinite(bx) && Number.isFinite(az) && Number.isFinite(bz)) {
        if (ax < localMinX) localMinX = ax;
        if (bx > localMaxX) localMaxX = bx;
        if (az < localMinZ) localMinZ = az;
        if (bz > localMaxZ) localMaxZ = bz;
      }
    } catch (e) {}
  }
  if (!Number.isFinite(localMinX) || !Number.isFinite(localMaxX) || !Number.isFinite(localMinZ) || !Number.isFinite(localMaxZ)) {
    localMinX = 0;
    localMaxX = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? 1))) / 1000;
    localMinZ = 0;
    localMaxZ = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? 1))) / 1000;
  }

  const midX = (localMinX + localMaxX) * 0.5;
  const midZ = (localMinZ + localMaxZ) * 0.5;

  const frontContactLocal = (pitchAxisWorld === "z")
    ? new BABYLON.Vector3(midX, 0, localMinZ)
    : new BABYLON.Vector3(localMinX, 0, midZ);

  const backContactLocal = (pitchAxisWorld === "z")
    ? new BABYLON.Vector3(midX, 0, localMaxZ)
    : new BABYLON.Vector3(localMaxX, 0, midZ);

  const roofCenterLocal = new BABYLON.Vector3(midX, 0, midZ);

  // ---- Step A: reset transforms (already identity) ----
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();
  try { roofRoot.computeWorldMatrix(true); } catch (e) {}

  // ---- Step B: yaw so rafters (local axis) align parallel to longAxisWorld ----
  const rafterAxisLocal = data.isWShort ? "x" : "z";
  const rafterAxisLocalVec = (rafterAxisLocal === "x")
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 0, 1);

  const dotYaw = clamp(rafterAxisLocalVec.x * longAxisVec.x + rafterAxisLocalVec.z * longAxisVec.z, -1, 1);
  const crossYawY = (rafterAxisLocalVec.x * longAxisVec.z - rafterAxisLocalVec.z * longAxisVec.x);
  const yaw = (Math.acos(dotYaw)) * (crossYawY >= 0 ? 1 : -1);

  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // ---- Step C: pitch around long axis by angle derived from plate heights/run ----
  const rise_m = (Number(backPlate.topY_m) - Number(frontPlate.topY_m));

  let run_m = 0;
  if (pitchAxisWorld === "z") run_m = Math.abs(Number(backPlate.cz_m) - Number(frontPlate.cz_m));
  else run_m = Math.abs(Number(backPlate.cx_m) - Number(frontPlate.cx_m));
  run_m = Math.max(1e-6, run_m);

  const angle = Math.atan2(rise_m, run_m);

  const qPitch = BABYLON.Quaternion.RotationAxis(longAxisVec, angle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);
  try { roofRoot.computeWorldMatrix(true); } catch (e) {}

  // ---- Step D: translate Y so front underside contact hits frontPlateTopY ----
  let worldFront = null;
  try {
    roofRoot.computeWorldMatrix(true);
    const wm = roofRoot.getWorldMatrix();
    worldFront = BABYLON.Vector3.TransformCoordinates(frontContactLocal, wm);
  } catch (e) {}

  if (worldFront) {
    const dy = Number(frontPlate.topY_m) - worldFront.y;
    roofRoot.position.y += dy;
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  } else {
    roofRoot.position.y = Number(frontPlate.topY_m);
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  }

  // ---- Step F: translate X/Z so roof plan centers over plate centers (average) ----
  let worldRoofCenter = null;
  try {
    roofRoot.computeWorldMatrix(true);
    const wm2 = roofRoot.getWorldMatrix();
    worldRoofCenter = BABYLON.Vector3.TransformCoordinates(roofCenterLocal, wm2);
  } catch (e) {}

  const targetCenterX = (Number(frontPlate.cx_m) + Number(backPlate.cx_m)) * 0.5;
  const targetCenterZ = (Number(frontPlate.cz_m) + Number(backPlate.cz_m)) * 0.5;

  if (worldRoofCenter) {
    roofRoot.position.x += (targetCenterX - worldRoofCenter.x);
    roofRoot.position.z += (targetCenterZ - worldRoofCenter.z);
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  } else {
    roofRoot.position.x = targetCenterX;
    roofRoot.position.z = targetCenterZ;
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  }

  // ---- Validate back contact (debug only; no iterative fitting) ----
  let worldBack = null;
  let backError_m = null;
  try {
    roofRoot.computeWorldMatrix(true);
    const wm3 = roofRoot.getWorldMatrix();
    worldBack = BABYLON.Vector3.TransformCoordinates(backContactLocal, wm3);
    backError_m = Number(backPlate.topY_m) - worldBack.y;
  } catch (e) {}

  // ---- Debug visuals + dbg object (roof.js only) ----
  function mkDbgSphere(name, x_m, y_m, z_m, isFront) {
    try {
      const s = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.06 }, scene);
      s.position = new BABYLON.Vector3(x_m, y_m, z_m);
      const mat = new BABYLON.StandardMaterial(name + "-mat", scene);
      if (isFront) mat.emissiveColor = new BABYLON.Color3(0.1, 0.9, 0.1);
      else mat.emissiveColor = new BABYLON.Color3(0.9, 0.1, 0.1);
      s.material = mat;
      s.metadata = { dynamic: true };
      return s;
    } catch (e) {
      return null;
    }
  }

  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.roofFit = {
        frontPlate: {
          name: String(frontPlate.name || ""),
          topY: Number(frontPlate.topY_m),
          cx: Number(frontPlate.cx_m),
          cz: Number(frontPlate.cz_m),
          planLen: Number(frontPlate.planLen_m)
        },
        backPlate: {
          name: String(backPlate.name || ""),
          topY: Number(backPlate.topY_m),
          cx: Number(backPlate.cx_m),
          cz: Number(backPlate.cz_m),
          planLen: Number(backPlate.planLen_m)
        },
        longAxis: { x: longAxisWorld === "x" ? 1 : 0, z: longAxisWorld === "z" ? 1 : 0 },
        pitchAxis: { x: pitchAxisWorld === "x" ? 1 : 0, z: pitchAxisWorld === "z" ? 1 : 0 },
        rise: rise_m,
        run: run_m,
        angle: angle,
        backError_mm: backError_m == null ? null : (backError_m * 1000)
      };

      mkDbgSphere("roof-dbg-frontPlate", Number(frontPlate.cx_m), Number(frontPlate.topY_m), Number(frontPlate.cz_m), true);
      mkDbgSphere("roof-dbg-backPlate", Number(backPlate.cx_m), Number(backPlate.topY_m), Number(backPlate.cz_m), false);

      if (worldFront) mkDbgSphere("roof-dbg-frontContact", worldFront.x, worldFront.y, worldFront.z, true);
      if (worldBack) mkDbgSphere("roof-dbg-backContact", worldBack.x, worldBack.y, worldBack.z, false);
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
