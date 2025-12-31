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

      // Prefer longer plan-length candidates (but actual bearing edge comes from vertex sampling below)
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

  // ---- TRUE bearing-edge extraction (world-space vertex sampling) ----
  function getWorldPositions(mesh) {
    if (!mesh) return null;
    try {
      const arr = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      if (!arr || arr.length < 3) return null;

      mesh.computeWorldMatrix(true);
      const wm = mesh.getWorldMatrix();

      const pts = [];
      for (let i = 0; i < arr.length; i += 3) {
        const v = new BABYLON.Vector3(arr[i], arr[i + 1], arr[i + 2]);
        const w = BABYLON.Vector3.TransformCoordinates(v, wm);
        if (Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)) pts.push(w);
      }
      return pts.length ? pts : null;
    } catch (e) {
      return null;
    }
  }

  function computeBearingEdge(mesh, frontOrBackHint) {
    const pts = getWorldPositions(mesh);
    if (!pts || !pts.length) return null;

    // Find top-surface band by Y (robust to slight FP noise)
    let yMax = -Infinity;
    for (let i = 0; i < pts.length; i++) if (pts[i].y > yMax) yMax = pts[i].y;
    if (!Number.isFinite(yMax)) return null;

    const epsY = 0.0005; // 0.5mm in meters
    const top = [];
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i].y - yMax) <= epsY) top.push(pts[i]);

    // If too few, widen slightly (still top band)
    if (top.length < 4) {
      const epsY2 = 0.002; // 2mm
      top.length = 0;
      for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i].y - yMax) <= epsY2) top.push(pts[i]);
    }
    if (top.length < 2) return null;

    // Compute plan extents on top band
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      sumX += p.x; sumY += p.y; sumZ += p.z;
    }

    const dx = Math.abs(maxX - minX);
    const dz = Math.abs(maxZ - minZ);

    // Determine length axis (plan)
    const longAxis = (dx >= dz) ? "x" : "z";
    const shortAxis = (longAxis === "x") ? "z" : "x";

    // Determine which side of thickness is the bearing edge.
    // Use wall bounds: "front" plate tends to sit near wallMinZ; "back" near wallMaxZ.
    // If caller gave a hint, trust it; else infer from centroid Z.
    const cx = sumX / top.length;
    const cy = sumY / top.length;
    const cz = sumZ / top.length;

    let which = frontOrBackHint;
    if (which !== "front" && which !== "back") {
      const dToFront = Math.abs(cz - wallMinZ_m);
      const dToBack = Math.abs(cz - wallMaxZ_m);
      which = (dToFront <= dToBack) ? "front" : "back";
    }

    // For bearing edge selection: for a front plate, choose the Z-min side; for back, Z-max side.
    // If the plate's long axis is Z (rare for front/back), apply similarly using X bounds.
    const epsEdge = 0.0008; // 0.8mm
    let edgeVal = 0;
    if (shortAxis === "z") {
      edgeVal = (which === "front") ? minZ : maxZ;
    } else {
      // shortAxis === "x"
      edgeVal = (which === "front") ? minX : maxX;
    }

    const edgePts = [];
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const v = (shortAxis === "z") ? p.z : p.x;
      if (Math.abs(v - edgeVal) <= epsEdge) edgePts.push(p);
    }

    // If the edge extraction is too sparse (custom meshes sometimes duplicate/omit),
    // fall back to using all top-band points but still compute endpoints along long axis.
    const usePts = edgePts.length >= 2 ? edgePts : top;

    // Endpoints along long axis on chosen edge/top band
    let pMin = null, pMax = null;
    let uMin = Infinity, uMax = -Infinity;
    for (let i = 0; i < usePts.length; i++) {
      const p = usePts[i];
      const u = (longAxis === "x") ? p.x : p.z;
      if (u < uMin) { uMin = u; pMin = p; }
      if (u > uMax) { uMax = u; pMax = p; }
    }
    if (!pMin || !pMax) return null;

    // Bearing-midpoint (for pitch/run and translation anchoring)
    const mid = new BABYLON.Vector3(
      (pMin.x + pMax.x) * 0.5,
      (pMin.y + pMax.y) * 0.5,
      (pMin.z + pMax.z) * 0.5
    );

    // Plan length (bearing edge)
    const planLen = Math.sqrt(
      Math.pow(pMax.x - pMin.x, 2) + Math.pow(pMax.z - pMin.z, 2)
    );

    const dirXZ = new BABYLON.Vector3(pMax.x - pMin.x, 0, pMax.z - pMin.z);
    const dirLen = Math.sqrt(dirXZ.x * dirXZ.x + dirXZ.z * dirXZ.z);
    const dir = dirLen > 1e-9 ? new BABYLON.Vector3(dirXZ.x / dirLen, 0, dirXZ.z / dirLen) : new BABYLON.Vector3(1, 0, 0);

    return {
      name: String(mesh.name || ""),
      mesh,
      which: which,
      p0_m: pMin.clone(),
      p1_m: pMax.clone(),
      mid_m: mid,
      cx_m: cx,
      cy_m: cy,
      cz_m: cz,
      topY_m: yMax, // still useful for debug
      planLen_m: planLen,
      longAxisHint: longAxis,
      dirXZ_m: dir
    };
  }

  let frontPlateMesh = findTopPlateMesh("front");
  let backPlateMesh = findTopPlateMesh("back");

  let frontBear = computeBearingEdge(frontPlateMesh, "front");
  let backBear = computeBearingEdge(backPlateMesh, "back");

  // Fallback if meshes missing (walls hidden/not built) - keep previous behavior shape
  if (!frontBear) {
    frontBear = {
      name: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
      mesh: frontPlateMesh || null,
      which: "front",
      p0_m: new BABYLON.Vector3(roofMinX_m, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      cx_m: (roofMinX_m + roofMaxX_m) * 0.5,
      cy_m: Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000),
      cz_m: wallMinZ_m,
      topY_m: Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000),
      planLen_m: Math.abs(wallMaxX_m - wallMinX_m),
      longAxisHint: "x",
      dirXZ_m: new BABYLON.Vector3(1, 0, 0)
    };
  }
  if (!backBear) {
    backBear = {
      name: backPlateMesh ? String(backPlateMesh.name || "") : "",
      mesh: backPlateMesh || null,
      which: "back",
      p0_m: new BABYLON.Vector3(roofMinX_m, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      cx_m: (roofMinX_m + roofMaxX_m) * 0.5,
      cy_m: Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000),
      cz_m: wallMaxZ_m,
      topY_m: Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000),
      planLen_m: Math.abs(wallMaxX_m - wallMinX_m),
      longAxisHint: "x",
      dirXZ_m: new BABYLON.Vector3(1, 0, 0)
    };
  }

  // Defensive: ensure "front" is the one with smaller Z in world (swap if needed)
  if (Number.isFinite(frontBear.mid_m.z) && Number.isFinite(backBear.mid_m.z) && frontBear.mid_m.z > backBear.mid_m.z) {
    const tmp = frontBear;
    frontBear = backBear;
    backBear = tmp;
  }

  // ---- Determine long axis (world) from bearing edge direction (not AABB) ----
  const longAxisVec = (() => {
    const f = frontBear && frontBear.dirXZ_m ? frontBear.dirXZ_m : null;
    const b = backBear && backBear.dirXZ_m ? backBear.dirXZ_m : null;
    let v = null;
    if (f && b) {
      const sx = f.x + b.x;
      const sz = f.z + b.z;
      const L = Math.sqrt(sx * sx + sz * sz);
      v = L > 1e-9 ? new BABYLON.Vector3(sx / L, 0, sz / L) : f.clone();
    } else if (f) v = f.clone();
    else if (b) v = b.clone();
    else v = new BABYLON.Vector3(1, 0, 0);
    // Ensure normalized
    const L2 = Math.sqrt(v.x * v.x + v.z * v.z);
    return L2 > 1e-9 ? new BABYLON.Vector3(v.x / L2, 0, v.z / L2) : new BABYLON.Vector3(1, 0, 0);
  })();

  // Pitch axis points from front bearing mid to back bearing mid in XZ
  const pitchAxisVec = (() => {
    const dx = Number(backBear.mid_m.x) - Number(frontBear.mid_m.x);
    const dz = Number(backBear.mid_m.z) - Number(frontBear.mid_m.z);
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L > 1e-9) return new BABYLON.Vector3(dx / L, 0, dz / L);
    // fallback to perpendicular in XZ
    return new BABYLON.Vector3(-longAxisVec.z, 0, longAxisVec.x);
  })();

  // For legacy local-contact selection logic, pick dominant axis labels (only used for local edge picking)
  const longAxisWorld = (Math.abs(longAxisVec.x) >= Math.abs(longAxisVec.z)) ? "x" : "z";
  const pitchAxisWorld = (Math.abs(pitchAxisVec.x) >= Math.abs(pitchAxisVec.z)) ? "x" : "z";

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

  // Local underside "front/back" contact midpoints (used for anchoring translation)
  const frontContactLocal = (pitchAxisWorld === "z")
    ? new BABYLON.Vector3(midX, 0, localMinZ)
    : new BABYLON.Vector3(localMinX, 0, midZ);

  const backContactLocal = (pitchAxisWorld === "z")
    ? new BABYLON.Vector3(midX, 0, localMaxZ)
    : new BABYLON.Vector3(localMaxX, 0, midZ);

  // ---- Step A: reset transforms (already identity) ----
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();

  // ---- Step B: yaw so rafters (local axis) align parallel to longAxisVec (world) ----
  const rafterAxisLocal = data.isWShort ? "x" : "z";
  const rafterAxisLocalVec = (rafterAxisLocal === "x")
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 0, 1);

  // Use dot/cross in XZ only
  const dotYaw = clamp(rafterAxisLocalVec.x * longAxisVec.x + rafterAxisLocalVec.z * longAxisVec.z, -1, 1);
  const crossYawY = (rafterAxisLocalVec.x * longAxisVec.z - rafterAxisLocalVec.z * longAxisVec.x);
  const yaw = (Math.acos(dotYaw)) * (crossYawY >= 0 ? 1 : -1);

  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // ---- Step C: pitch around long axis by angle derived from bearing-edge mids ----
  const rise_m = (Number(backBear.mid_m.y) - Number(frontBear.mid_m.y));

  // Run = distance between bearing mids projected onto pitch axis (XZ)
  const dMid = new BABYLON.Vector3(
    Number(backBear.mid_m.x) - Number(frontBear.mid_m.x),
    0,
    Number(backBear.mid_m.z) - Number(frontBear.mid_m.z)
  );
  const run_m_raw = Math.abs(dMid.x * pitchAxisVec.x + dMid.z * pitchAxisVec.z);
  const run_m = Math.max(1e-6, run_m_raw);

  const angle = Math.atan2(rise_m, run_m);

  const qPitch = BABYLON.Quaternion.RotationAxis(longAxisVec, angle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);

  // ---- Step D: translate so transformed front underside contact hits front bearing-mid (X/Y/Z) ----
  let worldFront = null;
  try {
    const wm = roofRoot.getWorldMatrix();
    worldFront = BABYLON.Vector3.TransformCoordinates(frontContactLocal, wm);
  } catch (e) {}

  if (worldFront) {
    roofRoot.position.x += (Number(frontBear.mid_m.x) - worldFront.x);
    roofRoot.position.y += (Number(frontBear.mid_m.y) - worldFront.y);
    roofRoot.position.z += (Number(frontBear.mid_m.z) - worldFront.z);
  } else {
    roofRoot.position.x = Number(frontBear.mid_m.x);
    roofRoot.position.y = Number(frontBear.mid_m.y);
    roofRoot.position.z = Number(frontBear.mid_m.z);
  }

  // ---- Validate back contact error (debug only; no iterative fitting) ----
  let worldBack = null;
  let backError_m = null;
  try {
    const wm3 = roofRoot.getWorldMatrix();
    worldBack = BABYLON.Vector3.TransformCoordinates(backContactLocal, wm3);
    backError_m = Number(backBear.mid_m.y) - worldBack.y;
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
          name: String(frontBear.name || ""),
          topY: Number(frontBear.topY_m),
          cx: Number(frontBear.cx_m),
          cz: Number(frontBear.cz_m),
          planLen: Number(frontBear.planLen_m),
          bear0: { x: Number(frontBear.p0_m.x), y: Number(frontBear.p0_m.y), z: Number(frontBear.p0_m.z) },
          bear1: { x: Number(frontBear.p1_m.x), y: Number(frontBear.p1_m.y), z: Number(frontBear.p1_m.z) },
          mid:   { x: Number(frontBear.mid_m.x), y: Number(frontBear.mid_m.y), z: Number(frontBear.mid_m.z) }
        },
        backPlate: {
          name: String(backBear.name || ""),
          topY: Number(backBear.topY_m),
          cx: Number(backBear.cx_m),
          cz: Number(backBear.cz_m),
          planLen: Number(backBear.planLen_m),
          bear0: { x: Number(backBear.p0_m.x), y: Number(backBear.p0_m.y), z: Number(backBear.p0_m.z) },
          bear1: { x: Number(backBear.p1_m.x), y: Number(backBear.p1_m.y), z: Number(backBear.p1_m.z) },
          mid:   { x: Number(backBear.mid_m.x), y: Number(backBear.mid_m.y), z: Number(backBear.mid_m.z) }
        },
        longAxis: { x: Number(longAxisVec.x), z: Number(longAxisVec.z) },
        pitchAxis: { x: Number(pitchAxisVec.x), z: Number(pitchAxisVec.z) },
        rise: rise_m,
        run: run_m,
        angle: angle,
        backError_mm: backError_m == null ? null : (backError_m * 1000)
      };

      // Plate bearing endpoints + mids
      mkDbgSphere("roof-dbg-frontBear0", Number(frontBear.p0_m.x), Number(frontBear.p0_m.y), Number(frontBear.p0_m.z), true);
      mkDbgSphere("roof-dbg-frontBear1", Number(frontBear.p1_m.x), Number(frontBear.p1_m.y), Number(frontBear.p1_m.z), true);
      mkDbgSphere("roof-dbg-frontBearMid", Number(frontBear.mid_m.x), Number(frontBear.mid_m.y), Number(frontBear.mid_m.z), true);

      mkDbgSphere("roof-dbg-backBear0", Number(backBear.p0_m.x), Number(backBear.p0_m.y), Number(backBear.p0_m.z), false);
      mkDbgSphere("roof-dbg-backBear1", Number(backBear.p1_m.x), Number(backBear.p1_m.y), Number(backBear.p1_m.z), false);
      mkDbgSphere("roof-dbg-backBearMid", Number(backBear.mid_m.x), Number(backBear.mid_m.y), Number(backBear.mid_m.z), false);

      // Roof contact mids
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
