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

  // ---------------------------------------------------------------------------
  // TRUE BEARING-EDGE EXTRACTION (WORLD-SPACE VERTEX SAMPLING)
  // ---------------------------------------------------------------------------

  function getWorldPositions(mesh) {
    if (!mesh) return null;
    try {
      const vb = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      if (!vb || !vb.length) return null;
      mesh.computeWorldMatrix(true);
      const wm = mesh.getWorldMatrix ? mesh.getWorldMatrix() : mesh.computeWorldMatrix(true);
      const out = [];
      for (let i = 0; i < vb.length; i += 3) {
        const v = new BABYLON.Vector3(vb[i], vb[i + 1], vb[i + 2]);
        const w = BABYLON.Vector3.TransformCoordinates(v, wm);
        out.push(w);
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function findTopPlateMesh(wallId) {
    const prefix = `wall-${wallId}-`;
    let best = null;
    let bestPlanLen = -1;

    for (let i = 0; i < (scene.meshes || []).length; i++) {
      const m = scene.meshes[i];
      if (!m) continue;
      if (m.isDisposed && m.isDisposed()) continue;
      if (!m.metadata || m.metadata.dynamic !== true) continue;

      const nm = String(m.name || "");
      if (!nm.startsWith(prefix)) continue;
      if (!nm.endsWith("plate-top")) continue;

      try {
        const pts = getWorldPositions(m);
        if (!pts || !pts.length) continue;

        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }
        const dx = Math.abs(maxX - minX);
        const dz = Math.abs(maxZ - minZ);
        const planLen = Math.max(dx, dz);
        if (Number.isFinite(planLen) && planLen > bestPlanLen) {
          bestPlanLen = planLen;
          best = m;
        }
      } catch (e) {}
    }

    return best;
  }

  function extractBearingLineFromTopPlateMesh(mesh, wallId) {
    if (!mesh) return null;

    const pts = getWorldPositions(mesh);
    if (!pts || !pts.length) return null;

    // Find top surface band (max Y within epsilon)
    let maxY = -Infinity;
    let minY = Infinity;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.y > maxY) maxY = p.y;
      if (p.y < minY) minY = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    if (!Number.isFinite(maxY)) return null;

    const ySpan = Math.max(1e-6, maxY - minY);
    const yEps = Math.max(1e-5, ySpan * 0.02);

    const topPts = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (Math.abs(p.y - maxY) <= yEps) topPts.push(p);
    }
    if (!topPts.length) return null;

    // Determine primary run axis on plan (X vs Z)
    const dx = Math.abs(maxX - minX);
    const dz = Math.abs(maxZ - minZ);
    const runAxis = (dx >= dz) ? "x" : "z";

    // From top pts, find the two Z-edge (or X-edge) bands on the top surface.
    // For front/back walls, thickness is along Z; we derive two edge-lines and take their midpoint-line
    // (gives the bearing line centered on the plate thickness, avoiding bbox center drift).
    const zSpan = Math.max(1e-6, maxZ - minZ);
    const xSpan = Math.max(1e-6, maxX - minX);
    const edgeEpsZ = Math.max(1e-5, zSpan * 0.03);
    const edgeEpsX = Math.max(1e-5, xSpan * 0.03);

    function endpointsForBand(filterFn) {
      let a = null;
      let b = null;
      let bestA = Infinity;
      let bestB = -Infinity;

      for (let i = 0; i < topPts.length; i++) {
        const p = topPts[i];
        if (!filterFn(p)) continue;

        const t = (runAxis === "x") ? p.x : p.z;

        if (t < bestA) {
          bestA = t;
          a = p;
        }
        if (t > bestB) {
          bestB = t;
          b = p;
        }
      }

      if (!a || !b) return null;

      // Stabilize endpoints in case multiple points share extreme t:
      // pick points with extreme t, but average the orthogonal coordinate + y among near-extreme points.
      const tA = bestA;
      const tB = bestB;
      const tolT = Math.max(1e-5, (runAxis === "x" ? xSpan : zSpan) * 0.01);

      let accA = new BABYLON.Vector3(0, 0, 0), nA = 0;
      let accB = new BABYLON.Vector3(0, 0, 0), nB = 0;

      for (let i = 0; i < topPts.length; i++) {
        const p = topPts[i];
        if (!filterFn(p)) continue;
        const t = (runAxis === "x") ? p.x : p.z;
        if (Math.abs(t - tA) <= tolT) { accA.addInPlace(p); nA++; }
        if (Math.abs(t - tB) <= tolT) { accB.addInPlace(p); nB++; }
      }

      const p0 = (nA > 0) ? accA.scale(1 / nA) : a;
      const p1 = (nB > 0) ? accB.scale(1 / nB) : b;

      return { p0, p1 };
    }

    // Two opposite thickness-edge lines on top surface
    const bandNear = (runAxis === "x")
      ? endpointsForBand((p) => Math.abs(p.z - minZ) <= edgeEpsZ)
      : endpointsForBand((p) => Math.abs(p.x - minX) <= edgeEpsX);

    const bandFar = (runAxis === "x")
      ? endpointsForBand((p) => Math.abs(p.z - maxZ) <= edgeEpsZ)
      : endpointsForBand((p) => Math.abs(p.x - maxX) <= edgeEpsX);

    // If we can't detect both edges, fall back to using all top points for endpoints.
    let p0 = null, p1 = null;
    if (bandNear && bandFar) {
      // Bearing line centered on thickness: average corresponding endpoints
      p0 = bandNear.p0.add(bandFar.p0).scale(0.5);
      p1 = bandNear.p1.add(bandFar.p1).scale(0.5);
    } else {
      // Fallback endpoints from all top points
      const any = endpointsForBand(() => true);
      if (!any) return null;
      p0 = any.p0;
      p1 = any.p1;
    }

    // Ensure p0->p1 goes along run axis increasing (for stability)
    if (runAxis === "x" && p0.x > p1.x) { const t = p0; p0 = p1; p1 = t; }
    if (runAxis === "z" && p0.z > p1.z) { const t = p0; p0 = p1; p1 = t; }

    const dir = new BABYLON.Vector3(p1.x - p0.x, 0, p1.z - p0.z);
    const dirLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    const dirN = dirLen > 1e-9 ? dir.scale(1 / dirLen) : new BABYLON.Vector3(1, 0, 0);

    const mid = new BABYLON.Vector3((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);

    return {
      meshName: String(mesh.name || ""),
      wallId: String(wallId || ""),
      runAxis,
      p0_m: p0,
      p1_m: p1,
      mid_m: mid,
      dirXZ_m: dirN,
      topY_mid_m: mid.y
    };
  }

  // Plates (front/back) via vertex-sampled bearing lines
  const frontPlateMesh = findTopPlateMesh("front");
  const backPlateMesh = findTopPlateMesh("back");

  let frontLine = extractBearingLineFromTopPlateMesh(frontPlateMesh, "front");
  let backLine = extractBearingLineFromTopPlateMesh(backPlateMesh, "back");

  // Fallback if walls hidden/not built: synthetic lines spanning the footprint center
  if (!frontLine) {
    const y = Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000);
    const p0 = new BABYLON.Vector3(wallMinX_m, y, wallMinZ_m);
    const p1 = new BABYLON.Vector3(wallMaxX_m, y, wallMinZ_m);
    frontLine = {
      meshName: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
      wallId: "front",
      runAxis: "x",
      p0_m: p0,
      p1_m: p1,
      mid_m: p0.add(p1).scale(0.5),
      dirXZ_m: new BABYLON.Vector3(1, 0, 0),
      topY_mid_m: y
    };
  }
  if (!backLine) {
    const y = Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000);
    const p0 = new BABYLON.Vector3(wallMinX_m, y, wallMaxZ_m);
    const p1 = new BABYLON.Vector3(wallMaxX_m, y, wallMaxZ_m);
    backLine = {
      meshName: backPlateMesh ? String(backPlateMesh.name || "") : "",
      wallId: "back",
      runAxis: "x",
      p0_m: p0,
      p1_m: p1,
      mid_m: p0.add(p1).scale(0.5),
      dirXZ_m: new BABYLON.Vector3(1, 0, 0),
      topY_mid_m: y
    };
  }

  // Defensive: ensure "front" is smaller Z than "back" by comparing midpoints
  if (Number.isFinite(frontLine.mid_m.z) && Number.isFinite(backLine.mid_m.z) && frontLine.mid_m.z > backLine.mid_m.z) {
    const tmp = frontLine; frontLine = backLine; backLine = tmp;
  }

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

  // ---------------------------------------------------------------------------
  // PROPOSAL C IMPLEMENTATION:
  // 1) Yaw-align roof so its long edge runs parallel to the front/back plate bearing line.
  // 2) Snap FRONT underside bearing line onto FRONT plate bearing line (line coincidence via translation).
  // 3) Pitch about that FRONT line until BACK underside line matches BACK plate height (choose sign by best fit).
  // 4) Do NOT introduce iterative "fitting loops"; pick best of ±angle.
  // ---------------------------------------------------------------------------

  // Determine target line direction (world XZ) from front plate bearing edge
  const worldLineDir = new BABYLON.Vector3(frontLine.dirXZ_m.x, 0, frontLine.dirXZ_m.z);
  const worldLineDirLen = Math.sqrt(worldLineDir.x * worldLineDir.x + worldLineDir.z * worldLineDir.z);
  const worldLineDirN = worldLineDirLen > 1e-9 ? worldLineDir.scale(1 / worldLineDirLen) : new BABYLON.Vector3(1, 0, 0);

  // Determine which local axis is "long" (X or Z) for the roof footprint
  const spanX = Math.abs(localMaxX - localMinX);
  const spanZ = Math.abs(localMaxZ - localMinZ);
  const longAxisLocal = (spanX >= spanZ) ? "x" : "z";
  const longAxisLocalVec = (longAxisLocal === "x") ? new BABYLON.Vector3(1, 0, 0) : new BABYLON.Vector3(0, 0, 1);

  // Pitch axis local is perpendicular to long axis local
  const pitchAxisLocal = (longAxisLocal === "x") ? "z" : "x";

  // Local underside bearing lines (y=0) at min/max along pitch axis local
  const frontEdgeLocalP0 = (pitchAxisLocal === "z")
    ? new BABYLON.Vector3(localMinX, 0, localMinZ)
    : new BABYLON.Vector3(localMinX, 0, localMinZ);

  const frontEdgeLocalP1 = (pitchAxisLocal === "z")
    ? new BABYLON.Vector3(localMaxX, 0, localMinZ)
    : new BABYLON.Vector3(localMinX, 0, localMaxZ);

  const backEdgeLocalP0 = (pitchAxisLocal === "z")
    ? new BABYLON.Vector3(localMinX, 0, localMaxZ)
    : new BABYLON.Vector3(localMaxX, 0, localMinZ);

  const backEdgeLocalP1 = (pitchAxisLocal === "z")
    ? new BABYLON.Vector3(localMaxX, 0, localMaxZ)
    : new BABYLON.Vector3(localMaxX, 0, localMaxZ);

  const roofFrontMidLocal = frontEdgeLocalP0.add(frontEdgeLocalP1).scale(0.5);
  const roofBackMidLocal = backEdgeLocalP0.add(backEdgeLocalP1).scale(0.5);

  // ---- Step 1: Yaw-align local long axis to world plate line direction ----
  const dotYaw = clamp(longAxisLocalVec.x * worldLineDirN.x + longAxisLocalVec.z * worldLineDirN.z, -1, 1);
  const crossYawY = (longAxisLocalVec.x * worldLineDirN.z - longAxisLocalVec.z * worldLineDirN.x);
  const yaw = (Math.acos(dotYaw)) * (crossYawY >= 0 ? 1 : -1);
  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = qYaw;

  // Helper to get transformed world point for a local point at current roofRoot transform
  function worldOfLocal(localPt) {
    try {
      const wm = roofRoot.getWorldMatrix();
      return BABYLON.Vector3.TransformCoordinates(localPt, wm);
    } catch (e) {
      return null;
    }
  }

  // ---- Step 2: Translate so FRONT underside line coincides (midpoint match) with FRONT plate bearing line ----
  const worldRoofFrontMid = worldOfLocal(roofFrontMidLocal);
  const worldRoofBackMid_pre = worldOfLocal(roofBackMidLocal);

  const targetFrontMid = frontLine.mid_m;
  const targetBackMid = backLine.mid_m;

  if (worldRoofFrontMid) {
    // Match XZ to plate, then match Y at midpoint
    roofRoot.position.x += (targetFrontMid.x - worldRoofFrontMid.x);
    roofRoot.position.z += (targetFrontMid.z - worldRoofFrontMid.z);

    // Recompute after XZ move to set Y
    const wf2 = worldOfLocal(roofFrontMidLocal);
    if (wf2) roofRoot.position.y += (targetFrontMid.y - wf2.y);
    else roofRoot.position.y = targetFrontMid.y;
  } else {
    roofRoot.position.x = targetFrontMid.x;
    roofRoot.position.y = targetFrontMid.y;
    roofRoot.position.z = targetFrontMid.z;
  }

  // Axis for pitching = along FRONT plate bearing line direction in world
  const axisU = new BABYLON.Vector3(worldLineDirN.x, 0, worldLineDirN.z);
  const axisULen = Math.sqrt(axisU.x * axisU.x + axisU.z * axisU.z);
  const axisUN = axisULen > 1e-9 ? axisU.scale(1 / axisULen) : new BABYLON.Vector3(1, 0, 0);

  // Choose pivot point on the front bearing line: use target front midpoint
  const pivotP = new BABYLON.Vector3(targetFrontMid.x, targetFrontMid.y, targetFrontMid.z);

  // Compute current (post-translation, yaw-only) roof back midpoint world
  const worldRoofBackMid0 = worldOfLocal(roofBackMidLocal);

  // Distance from pivot line to back midpoint in the horizontal plane (runPerp)
  const up = new BABYLON.Vector3(0, 1, 0);
  const wPerp = BABYLON.Vector3.Cross(axisUN, up); // perpendicular in XZ
  const wLen = Math.sqrt(wPerp.x * wPerp.x + wPerp.z * wPerp.z);
  const wN = wLen > 1e-9 ? wPerp.scale(1 / wLen) : new BABYLON.Vector3(0, 0, 1);

  let runPerp_m = 0;
  if (worldRoofBackMid0) {
    const v = worldRoofBackMid0.subtract(pivotP);
    runPerp_m = Math.abs(v.x * wN.x + v.z * wN.z);
  } else {
    // fallback using plate separation
    const v = targetBackMid.subtract(pivotP);
    runPerp_m = Math.abs(v.x * wN.x + v.z * wN.z);
  }
  runPerp_m = Math.max(1e-6, runPerp_m);

  // Desired rise at back (midpoint)
  const rise_m = Number(targetBackMid.y) - Number(targetFrontMid.y);

  // Candidate pitch magnitude
  const magAngle = Math.atan2(rise_m, runPerp_m);

  function applyPitchAboutWorldAxis(angleRad) {
    const qP = BABYLON.Quaternion.RotationAxis(axisUN, angleRad);

    // Rotate current orientation about world axis: qNew = qP * qCurrent
    const qCur = roofRoot.rotationQuaternion || BABYLON.Quaternion.Identity();
    const qNew = qP.multiply(qCur);

    // Rotate position around pivot point
    const pos = roofRoot.position.clone();
    const rel = pos.subtract(pivotP);
    const relRot = BABYLON.Vector3.TransformCoordinates(rel, qP.toRotationMatrix());
    const posNew = pivotP.add(relRot);

    roofRoot.rotationQuaternion = qNew;
    roofRoot.position = posNew;
  }

  function evalBackErrorForAngle(angleRad) {
    // Save
    const savePos = roofRoot.position.clone();
    const saveRot = roofRoot.rotationQuaternion ? roofRoot.rotationQuaternion.clone() : null;

    // Apply
    applyPitchAboutWorldAxis(angleRad);

    // Measure back midpoint Y error (targetBackMid.y - actual)
    const wb = worldOfLocal(roofBackMidLocal);
    const err = wb ? (Number(targetBackMid.y) - wb.y) : Infinity;

    // Restore
    roofRoot.position = savePos;
    roofRoot.rotationQuaternion = saveRot || BABYLON.Quaternion.Identity();

    return err;
  }

  // Pick sign by best absolute error (no iteration)
  const errPlus = evalBackErrorForAngle(magAngle);
  const errMinus = evalBackErrorForAngle(-magAngle);
  const chosenAngle = (Math.abs(errPlus) <= Math.abs(errMinus)) ? magAngle : -magAngle;

  // ---- Step 3: Pitch about front bearing line ----
  applyPitchAboutWorldAxis(chosenAngle);

  // ---- Step 4: (Non-drifting) re-snap FRONT midpoint Y only after pitch (keeps front line seated) ----
  const wfAfter = worldOfLocal(roofFrontMidLocal);
  if (wfAfter) {
    roofRoot.position.y += (targetFrontMid.y - wfAfter.y);
  } else {
    roofRoot.position.y = targetFrontMid.y;
  }

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
    const worldFrontNow = worldOfLocal(roofFrontMidLocal);
    const worldBackNow = worldOfLocal(roofBackMidLocal);
    const backErr_m = (worldBackNow ? (Number(targetBackMid.y) - worldBackNow.y) : null);

    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.roofFit = {
        plates: {
          front: {
            mesh: String(frontLine.meshName || ""),
            p0: { x: frontLine.p0_m.x, y: frontLine.p0_m.y, z: frontLine.p0_m.z },
            p1: { x: frontLine.p1_m.x, y: frontLine.p1_m.y, z: frontLine.p1_m.z },
            mid: { x: frontLine.mid_m.x, y: frontLine.mid_m.y, z: frontLine.mid_m.z },
            runAxis: String(frontLine.runAxis || "")
          },
          back: {
            mesh: String(backLine.meshName || ""),
            p0: { x: backLine.p0_m.x, y: backLine.p0_m.y, z: backLine.p0_m.z },
            p1: { x: backLine.p1_m.x, y: backLine.p1_m.y, z: backLine.p1_m.z },
            mid: { x: backLine.mid_m.x, y: backLine.mid_m.y, z: backLine.mid_m.z },
            runAxis: String(backLine.runAxis || "")
          }
        },
        roof: {
          longAxisLocal: longAxisLocal,
          pitchAxisLocal: pitchAxisLocal
        },
        solve: {
          yaw_rad: yaw,
          pitch_rad: chosenAngle,
          rise_m: rise_m,
          runPerp_m: runPerp_m,
          backError_mm: backErr_m == null ? null : (backErr_m * 1000)
        }
      };

      // Plate midpoints
      mkDbgSphere("roof-dbg-frontPlateMid", frontLine.mid_m.x, frontLine.mid_m.y, frontLine.mid_m.z, true);
      mkDbgSphere("roof-dbg-backPlateMid", backLine.mid_m.x, backLine.mid_m.y, backLine.mid_m.z, false);

      // Roof contact midpoints
      if (worldFrontNow) mkDbgSphere("roof-dbg-frontContactMid", worldFrontNow.x, worldFrontNow.y, worldFrontNow.z, true);
      if (worldBackNow) mkDbgSphere("roof-dbg-backContactMid", worldBackNow.x, worldBackNow.y, worldBackNow.z, false);
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
