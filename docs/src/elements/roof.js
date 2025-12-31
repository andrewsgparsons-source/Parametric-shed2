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

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function quatFromToXZ(fromVec, toVec) {
    const a = new BABYLON.Vector3(fromVec.x, 0, fromVec.z);
    const b = new BABYLON.Vector3(toVec.x, 0, toVec.z);
    const la = a.length();
    const lb = b.length();
    if (la < 1e-9 || lb < 1e-9) return BABYLON.Quaternion.Identity();
    a.scaleInPlace(1 / la);
    b.scaleInPlace(1 / lb);

    const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
    if (dot > 0.999999) return BABYLON.Quaternion.Identity();

    // 180° case
    if (dot < -0.999999) {
      return BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), Math.PI);
    }

    const crossY = (a.x * b.z - a.z * b.x);
    const ang = Math.acos(dot);
    return BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), ang * (crossY >= 0 ? 1 : -1));
  }

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

  // Extract the *outer top edge* line from a plate mesh in WORLD SPACE.
  // For sloped plates created by walls.js mkSlopedPlateAlongX, the mesh has 8 vertices:
  // indices 4..7 are the top ring. We use those so we don't "lose" the slope by using bbox maxY.
  function plateOuterTopEdgeInfo(mesh, wantOuter /* "minZ" | "maxZ" */) {
    if (!mesh) return null;
    try {
      mesh.computeWorldMatrix(true);
      const wm = mesh.getWorldMatrix();

      const vcount = (typeof mesh.getTotalVertices === "function") ? mesh.getTotalVertices() : 0;
      const pos = (typeof mesh.getVerticesData === "function")
        ? mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind)
        : null;

      // Sloped custom prism path (8 verts)
      if (pos && vcount === 8 && pos.length >= 8 * 3) {
        const topIdx = [4, 5, 6, 7];
        const topWorld = [];
        for (let k = 0; k < topIdx.length; k++) {
          const i = topIdx[k] * 3;
          const lp = new BABYLON.Vector3(pos[i + 0], pos[i + 1], pos[i + 2]);
          const wp = BABYLON.Vector3.TransformCoordinates(lp, wm);
          topWorld.push(wp);
        }

        // Pick the two vertices on the outer edge by z extreme among the top ring.
        let extremeZ = wantOuter === "minZ" ? Infinity : -Infinity;
        for (let i = 0; i < topWorld.length; i++) {
          const z = topWorld[i].z;
          if (wantOuter === "minZ") { if (z < extremeZ) extremeZ = z; }
          else { if (z > extremeZ) extremeZ = z; }
        }

        // Collect verts close to that extreme (tolerance)
        const tol = 1e-4;
        const edge = [];
        for (let i = 0; i < topWorld.length; i++) {
          const z = topWorld[i].z;
          if (Math.abs(z - extremeZ) <= tol) edge.push(topWorld[i]);
        }

        // Fallback if tolerance too tight: take the closest two by z
        if (edge.length < 2) {
          topWorld.sort((a, b) => (wantOuter === "minZ" ? (a.z - b.z) : (b.z - a.z)));
          edge.length = 0;
          edge.push(topWorld[0], topWorld[1]);
        }

        // Ensure we have exactly 2 endpoints (choose farthest apart)
        let p0 = edge[0], p1 = edge[1];
        if (edge.length > 2) {
          let bestD = -1;
          for (let i = 0; i < edge.length; i++) {
            for (let j = i + 1; j < edge.length; j++) {
              const d = BABYLON.Vector3.DistanceSquared(edge[i], edge[j]);
              if (d > bestD) { bestD = d; p0 = edge[i]; p1 = edge[j]; }
            }
          }
        }

        // Long axis direction (XZ)
        const dir = new BABYLON.Vector3(p1.x - p0.x, 0, p1.z - p0.z);
        const len = dir.length();
        const dirN = (len > 1e-9) ? dir.scale(1 / len) : new BABYLON.Vector3(1, 0, 0);

        const mid = new BABYLON.Vector3((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);

        return {
          name: String(mesh.name || ""),
          mesh,
          p0_m: p0,
          p1_m: p1,
          mid_m: mid,
          dirLong_m: dirN,
          topY_m: mid.y
        };
      }

      // Box/other mesh fallback: use bbox top at outer Z face and X endpoints.
      const bi = mesh.getBoundingInfo && mesh.getBoundingInfo();
      if (!bi || !bi.boundingBox) return null;
      const bb = bi.boundingBox;

      const minX = bb.minimumWorld.x, maxX = bb.maximumWorld.x;
      const minZ = bb.minimumWorld.z, maxZ = bb.maximumWorld.z;
      const topY = bb.maximumWorld.y;

      const zOuter = (wantOuter === "minZ") ? minZ : maxZ;

      const p0 = new BABYLON.Vector3(minX, topY, zOuter);
      const p1 = new BABYLON.Vector3(maxX, topY, zOuter);

      const dir = new BABYLON.Vector3(p1.x - p0.x, 0, p1.z - p0.z);
      const len = dir.length();
      const dirN = (len > 1e-9) ? dir.scale(1 / len) : new BABYLON.Vector3(1, 0, 0);

      const mid = new BABYLON.Vector3((p0.x + p1.x) * 0.5, topY, zOuter);

      return {
        name: String(mesh.name || ""),
        mesh,
        p0_m: p0,
        p1_m: p1,
        mid_m: mid,
        dirLong_m: dirN,
        topY_m: topY
      };
    } catch (e) {
      return null;
    }
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

  // ---- Plate targets in WORLD SPACE: use OUTER top edges ----
  const frontPlateMesh = findTopPlateMesh("front");
  const backPlateMesh = findTopPlateMesh("back");

  // For the front wall (at smaller Z), the outer face is at minZ.
  // For the back wall (at larger Z), the outer face is at maxZ.
  let frontEdge = plateOuterTopEdgeInfo(frontPlateMesh, "minZ");
  let backEdge = plateOuterTopEdgeInfo(backPlateMesh, "maxZ");

  // Fallback targets if plates missing (walls hidden/not built)
  if (!frontEdge) {
    frontEdge = {
      name: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
      mesh: frontPlateMesh || null,
      p0_m: new BABYLON.Vector3(roofMinX_m, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000), wallMinZ_m),
      dirLong_m: new BABYLON.Vector3(1, 0, 0),
      topY_m: Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000)
    };
  }
  if (!backEdge) {
    backEdge = {
      name: backPlateMesh ? String(backPlateMesh.name || "") : "",
      mesh: backPlateMesh || null,
      p0_m: new BABYLON.Vector3(roofMinX_m, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000), wallMaxZ_m),
      dirLong_m: new BABYLON.Vector3(1, 0, 0),
      topY_m: Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000)
    };
  }

  // Defensive ordering by Z (front = smaller Z)
  if (Number.isFinite(frontEdge.mid_m.z) && Number.isFinite(backEdge.mid_m.z) && frontEdge.mid_m.z > backEdge.mid_m.z) {
    const tmp = frontEdge;
    frontEdge = backEdge;
    backEdge = tmp;
  }

  // Long axis in WORLD is the plate top-edge direction (XZ)
  let longAxisVec = new BABYLON.Vector3(frontEdge.dirLong_m.x, 0, frontEdge.dirLong_m.z);
  if (longAxisVec.length() < 1e-9) longAxisVec = new BABYLON.Vector3(1, 0, 0);
  longAxisVec.normalize();

  // Pitch axis is perpendicular to long axis in XZ, oriented from front -> back
  let pitchAxisVec = BABYLON.Vector3.Cross(new BABYLON.Vector3(0, 1, 0), longAxisVec);
  pitchAxisVec.y = 0;
  if (pitchAxisVec.length() < 1e-9) pitchAxisVec = new BABYLON.Vector3(0, 0, 1);
  pitchAxisVec.normalize();

  const fb = new BABYLON.Vector3(backEdge.mid_m.x - frontEdge.mid_m.x, 0, backEdge.mid_m.z - frontEdge.mid_m.z);
  if (fb.length() > 1e-9) {
    fb.normalize();
    if ((fb.x * pitchAxisVec.x + fb.z * pitchAxisVec.z) < 0) pitchAxisVec.scaleInPlace(-1);
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

  // Local underside contact points at the *pitch ends* of the roof footprint.
  // We always define them along the local axis that corresponds to WORLD pitchAxis (after yaw).
  const roofCenterLocal = new BABYLON.Vector3(midX, 0, midZ);

  // These are provisional in local; after yaw we recompute by transforming them, so we keep them as
  // "min/max on the axis orthogonal to long axis".
  const frontContactLocal = new BABYLON.Vector3(midX, 0, localMinZ);
  const backContactLocal = new BABYLON.Vector3(midX, 0, localMaxZ);

  // ---- Step A: identity ----
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();
  try { roofRoot.computeWorldMatrix(true); } catch (e) {}

  // ---- Step B: yaw so rafters (local axis) align to WORLD long axis (plate edge direction) ----
  const rafterAxisLocal = data.isWShort ? "x" : "z";
  const rafterAxisLocalVec = (rafterAxisLocal === "x")
    ? new BABYLON.Vector3(1, 0, 0)
    : new BABYLON.Vector3(0, 0, 1);

  const qYaw = quatFromToXZ(rafterAxisLocalVec, longAxisVec);

  // ---- Step C: pitch around WORLD long axis by angle from edge mids ----
  const rise_m = Number(backEdge.mid_m.y) - Number(frontEdge.mid_m.y);

  const fbRunVec = new BABYLON.Vector3(
    Number(backEdge.mid_m.x) - Number(frontEdge.mid_m.x),
    0,
    Number(backEdge.mid_m.z) - Number(frontEdge.mid_m.z)
  );
  let run_m = Math.abs(fbRunVec.x * pitchAxisVec.x + fbRunVec.z * pitchAxisVec.z);
  run_m = Math.max(1e-6, run_m);

  const angle = Math.atan2(rise_m, run_m);
  const qPitch = BABYLON.Quaternion.RotationAxis(longAxisVec, angle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);
  try { roofRoot.computeWorldMatrix(true); } catch (e) {}

  // ---- Step D: translate so FRONT underside contact hits FRONT plate outer top edge MID ----
  let worldFront = null;
  try {
    roofRoot.computeWorldMatrix(true);
    const wm = roofRoot.getWorldMatrix();
    worldFront = BABYLON.Vector3.TransformCoordinates(frontContactLocal, wm);
  } catch (e) {}

  if (worldFront) {
    roofRoot.position.x += (frontEdge.mid_m.x - worldFront.x);
    roofRoot.position.y += (frontEdge.mid_m.y - worldFront.y);
    roofRoot.position.z += (frontEdge.mid_m.z - worldFront.z);
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  } else {
    roofRoot.position = new BABYLON.Vector3(frontEdge.mid_m.x, frontEdge.mid_m.y, frontEdge.mid_m.z);
    try { roofRoot.computeWorldMatrix(true); } catch (e) {}
  }

  // ---- Validate back contact error (debug only; no iterative fitting) ----
  let worldBack = null;
  let backErrVec = null;
  try {
    roofRoot.computeWorldMatrix(true);
    const wm2 = roofRoot.getWorldMatrix();
    worldBack = BABYLON.Vector3.TransformCoordinates(backContactLocal, wm2);
    backErrVec = new BABYLON.Vector3(
      backEdge.mid_m.x - worldBack.x,
      backEdge.mid_m.y - worldBack.y,
      backEdge.mid_m.z - worldBack.z
    );
  } catch (e) {}

  // ---- Debug visuals + dbg object (roof.js only) ----
  function mkDbgSphere(name, x_m, y_m, z_m, r, g, b) {
    try {
      const s = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.06 }, scene);
      s.position = new BABYLON.Vector3(x_m, y_m, z_m);
      const mat = new BABYLON.StandardMaterial(name + "-mat", scene);
      mat.emissiveColor = new BABYLON.Color3(r, g, b);
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
          name: String(frontEdge.name || ""),
          mid: { x: Number(frontEdge.mid_m.x), y: Number(frontEdge.mid_m.y), z: Number(frontEdge.mid_m.z) },
          p0: { x: Number(frontEdge.p0_m.x), y: Number(frontEdge.p0_m.y), z: Number(frontEdge.p0_m.z) },
          p1: { x: Number(frontEdge.p1_m.x), y: Number(frontEdge.p1_m.y), z: Number(frontEdge.p1_m.z) },
        },
        backPlate: {
          name: String(backEdge.name || ""),
          mid: { x: Number(backEdge.mid_m.x), y: Number(backEdge.mid_m.y), z: Number(backEdge.mid_m.z) },
          p0: { x: Number(backEdge.p0_m.x), y: Number(backEdge.p0_m.y), z: Number(backEdge.p0_m.z) },
          p1: { x: Number(backEdge.p1_m.x), y: Number(backEdge.p1_m.y), z: Number(backEdge.p1_m.z) },
        },
        longAxis: { x: Number(longAxisVec.x), z: Number(longAxisVec.z) },
        pitchAxis: { x: Number(pitchAxisVec.x), z: Number(pitchAxisVec.z) },
        rise_m: rise_m,
        run_m: run_m,
        angle_rad: angle,
        backError_mm: backErrVec ? { x: backErrVec.x * 1000, y: backErrVec.y * 1000, z: backErrVec.z * 1000 } : null
      };

      // plate edge endpoints (blue) and mids (green/red)
      mkDbgSphere("roof-dbg-frontMid", Number(frontEdge.mid_m.x), Number(frontEdge.mid_m.y), Number(frontEdge.mid_m.z), 0.1, 0.9, 0.1);
      mkDbgSphere("roof-dbg-backMid", Number(backEdge.mid_m.x), Number(backEdge.mid_m.y), Number(backEdge.mid_m.z), 0.9, 0.1, 0.1);

      mkDbgSphere("roof-dbg-frontP0", Number(frontEdge.p0_m.x), Number(frontEdge.p0_m.y), Number(frontEdge.p0_m.z), 0.1, 0.3, 0.9);
      mkDbgSphere("roof-dbg-frontP1", Number(frontEdge.p1_m.x), Number(frontEdge.p1_m.y), Number(frontEdge.p1_m.z), 0.1, 0.3, 0.9);

      mkDbgSphere("roof-dbg-backP0", Number(backEdge.p0_m.x), Number(backEdge.p0_m.y), Number(backEdge.p0_m.z), 0.1, 0.3, 0.9);
      mkDbgSphere("roof-dbg-backP1", Number(backEdge.p1_m.x), Number(backEdge.p1_m.y), Number(backEdge.p1_m.z), 0.1, 0.3, 0.9);

      if (worldFront) mkDbgSphere("roof-dbg-frontContact", worldFront.x, worldFront.y, worldFront.z, 0.0, 0.8, 0.0);
      if (worldBack) mkDbgSphere("roof-dbg-backContact", worldBack.x, worldBack.y, worldBack.z, 0.8, 0.0, 0.0);
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
