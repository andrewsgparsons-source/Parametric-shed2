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

  // ---- True bearing-edge extraction (world-space vertex sampling) ----
  function extractBearingEdgeWorld(mesh) {
    if (!mesh) return null;

    let positions = null;
    try {
      positions = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    } catch (e) {
      positions = null;
    }
    if (!positions || positions.length < 9) return null;

    let wm = null;
    try {
      mesh.computeWorldMatrix(true);
      wm = mesh.getWorldMatrix();
    } catch (e) {
      wm = null;
    }
    if (!wm) return null;

    const verts = [];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const vLocal = new BABYLON.Vector3(positions[i], positions[i + 1], positions[i + 2]);
      const vWorld = BABYLON.Vector3.TransformCoordinates(vLocal, wm);
      if (!Number.isFinite(vWorld.x) || !Number.isFinite(vWorld.y) || !Number.isFinite(vWorld.z)) continue;
      verts.push(vWorld);
      if (vWorld.y < minY) minY = vWorld.y;
      if (vWorld.y > maxY) maxY = vWorld.y;
    }
    if (!verts.length || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;

    // For sloped prisms, "top" is not constant Y. Use midpoint threshold.
    const yThresh = (minY + maxY) * 0.5;
    const topVerts = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.y >= (yThresh - 1e-6)) topVerts.push(v);
    }
    if (topVerts.length < 2) return null;

    // Determine dominant axis in XZ among top vertices
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < topVerts.length; i++) {
      const v = topVerts[i];
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    const dx = Math.abs(maxX - minX);
    const dz = Math.abs(maxZ - minZ);
    const axis = (dx >= dz) ? "x" : "z";

    // Build endpoints as averaged centers of the two top corners at each end (centerline through thickness)
    const eps = 1e-5;

    const groupA = [];
    const groupB = [];
    if (axis === "x") {
      for (let i = 0; i < topVerts.length; i++) {
        const v = topVerts[i];
        if (Math.abs(v.x - minX) <= eps) groupA.push(v);
        else if (Math.abs(v.x - maxX) <= eps) groupB.push(v);
      }
    } else {
      for (let i = 0; i < topVerts.length; i++) {
        const v = topVerts[i];
        if (Math.abs(v.z - minZ) <= eps) groupA.push(v);
        else if (Math.abs(v.z - maxZ) <= eps) groupB.push(v);
      }
    }

    function avg(list) {
      if (!list || !list.length) return null;
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < list.length; i++) {
        sx += list[i].x; sy += list[i].y; sz += list[i].z;
      }
      const inv = 1 / list.length;
      return new BABYLON.Vector3(sx * inv, sy * inv, sz * inv);
    }

    let p0 = avg(groupA);
    let p1 = avg(groupB);

    // Fallback: pick min/max along axis
    if (!p0 || !p1) {
      let vMin = topVerts[0], vMax = topVerts[0];
      for (let i = 1; i < topVerts.length; i++) {
        const v = topVerts[i];
        const a = axis === "x" ? v.x : v.z;
        const amin = axis === "x" ? vMin.x : vMin.z;
        const amax = axis === "x" ? vMax.x : vMax.z;
        if (a < amin) vMin = v;
        if (a > amax) vMax = v;
      }
      p0 = vMin.clone();
      p1 = vMax.clone();
    }

    const mid = new BABYLON.Vector3((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);

    return {
      name: String(mesh.name || ""),
      mesh,
      axis,
      p0_m: p0,
      p1_m: p1,
      mid_m: mid,
    };
  }

  let frontPlateMesh = findTopPlateMesh("front");
  let backPlateMesh = findTopPlateMesh("back");

  let frontPlate = extractBearingEdgeWorld(frontPlateMesh);
  let backPlate = extractBearingEdgeWorld(backPlateMesh);

  // Fallback plate info if meshes missing (walls hidden/not built)
  if (!frontPlate || !frontPlate.p0_m || !frontPlate.p1_m || !frontPlate.mid_m) {
    const y = Math.max(0.1, Math.floor(Number(data.minH_mm || 2400)) / 1000);
    frontPlate = {
      name: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
      mesh: frontPlateMesh || null,
      axis: "x",
      p0_m: new BABYLON.Vector3(roofMinX_m, y, wallMinZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, y, wallMinZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, y, wallMinZ_m),
    };
  }
  if (!backPlate || !backPlate.p0_m || !backPlate.p1_m || !backPlate.mid_m) {
    const y = Math.max(0.1, Math.floor(Number(data.maxH_mm || 2400)) / 1000);
    backPlate = {
      name: backPlateMesh ? String(backPlateMesh.name || "") : "",
      mesh: backPlateMesh || null,
      axis: "x",
      p0_m: new BABYLON.Vector3(roofMinX_m, y, wallMaxZ_m),
      p1_m: new BABYLON.Vector3(roofMaxX_m, y, wallMaxZ_m),
      mid_m: new BABYLON.Vector3((roofMinX_m + roofMaxX_m) * 0.5, y, wallMaxZ_m),
    };
  }

  // Defensive: ensure front/back are ordered by world Z (front = smaller Z) using mids
  if (
    Number.isFinite(frontPlate.mid_m && frontPlate.mid_m.z) &&
    Number.isFinite(backPlate.mid_m && backPlate.mid_m.z) &&
    frontPlate.mid_m.z > backPlate.mid_m.z
  ) {
    const tmp = frontPlate;
    frontPlate = backPlate;
    backPlate = tmp;
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

  const extX = Math.abs(localMaxX - localMinX);
  const extZ = Math.abs(localMaxZ - localMinZ);

  // Local "long axis" is whichever plan extent is larger (roof assembly)
  const longAxisLocal = (extX >= extZ) ? "x" : "z";
  const pitchAxisLocal = (longAxisLocal === "x") ? "z" : "x";

  // Local bearing-edge endpoints on underside (y=0), using local bounds
  function mkLocalEdgeEndpoints(which) {
    // which: "front" => min along pitch; "back" => max along pitch
    const longMin = (longAxisLocal === "x") ? localMinX : localMinZ;
    const longMax = (longAxisLocal === "x") ? localMaxX : localMaxZ;

    const pitchVal = (pitchAxisLocal === "x")
      ? (which === "front" ? localMinX : localMaxX)
      : (which === "front" ? localMinZ : localMaxZ);

    if (longAxisLocal === "x") {
      // varying x, fixed z (pitch is z) OR fixed x (pitch is x) handled by pitchAxisLocal
      if (pitchAxisLocal === "z") {
        return [
          new BABYLON.Vector3(longMin, 0, pitchVal),
          new BABYLON.Vector3(longMax, 0, pitchVal),
        ];
      }
      // pitchAxisLocal === "x": fixed x, varying z
      return [
        new BABYLON.Vector3(pitchVal, 0, longMin),
        new BABYLON.Vector3(pitchVal, 0, longMax),
      ];
    } else {
      // longAxisLocal === "z"
      if (pitchAxisLocal === "x") {
        return [
          new BABYLON.Vector3(pitchVal, 0, longMin),
          new BABYLON.Vector3(pitchVal, 0, longMax),
        ];
      }
      // pitchAxisLocal === "z": fixed z, varying x
      return [
        new BABYLON.Vector3(longMin, 0, pitchVal),
        new BABYLON.Vector3(longMax, 0, pitchVal),
      ];
    }
  }

  const LF = mkLocalEdgeEndpoints("front");
  const LB = mkLocalEdgeEndpoints("back");

  const LF0 = LF[0], LF1 = LF[1];
  const LB0 = LB[0], LB1 = LB[1];

  const WF0 = frontPlate.p0_m;
  const WF1 = frontPlate.p1_m;
  const WB0 = backPlate.p0_m;
  const WB1 = backPlate.p1_m;

  // ---- Proposal A: 4-point rigid fit using orthonormal bases (no scaling) ----
  function safeNormalize(v, fallback) {
    try {
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (len > 1e-9) return new BABYLON.Vector3(v.x / len, v.y / len, v.z / len);
    } catch (e) {}
    return fallback ? fallback.clone() : new BABYLON.Vector3(1, 0, 0);
  }

  function sub(a, b) { return new BABYLON.Vector3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function add(a, b) { return new BABYLON.Vector3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function mul(a, s) { return new BABYLON.Vector3(a.x * s, a.y * s, a.z * s); }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return new BABYLON.Vector3(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x
    );
  }

  function buildBasisFromEdges(PF0, PF1, PB0, PB1) {
    const cF = mul(add(PF0, PF1), 0.5);
    const cB = mul(add(PB0, PB1), 0.5);

    const x = safeNormalize(sub(PF1, PF0), new BABYLON.Vector3(1, 0, 0));
    let zRaw = sub(cB, cF);
    // remove component along x
    zRaw = sub(zRaw, mul(x, dot(zRaw, x)));
    let z = safeNormalize(zRaw, null);

    // If front/back mids are nearly colinear with x, pick an arbitrary perpendicular
    if (!z || (Math.abs(z.x) + Math.abs(z.y) + Math.abs(z.z) < 1e-9)) {
      z = safeNormalize(cross(new BABYLON.Vector3(0, 1, 0), x), new BABYLON.Vector3(0, 0, 1));
    }

    let y = safeNormalize(cross(z, x), new BABYLON.Vector3(0, 1, 0));
    // re-orthonormalize z
    z = safeNormalize(cross(x, y), new BABYLON.Vector3(0, 0, 1));

    return { x, y, z, cF, cB, c: mul(add(cF, cB), 0.5) };
  }

  const basisW = buildBasisFromEdges(WF0, WF1, WB0, WB1);
  const basisL = buildBasisFromEdges(LF0, LF1, LB0, LB1);

  // Rotation mapping local basis -> world basis: R = [W] * [L]^T
  function matFromBasis(b) {
    // columns are basis vectors (x,y,z)
    return BABYLON.Matrix.FromValues(
      b.x.x, b.y.x, b.z.x, 0,
      b.x.y, b.y.y, b.z.y, 0,
      b.x.z, b.y.z, b.z.z, 0,
      0,     0,     0,     1
    );
  }

  const MW = matFromBasis(basisW);
  const ML = matFromBasis(basisL);

  // ML^T
  const MLT = BABYLON.Matrix.Transpose(ML);
  const Rm = MW.multiply(MLT);

  const Rq = BABYLON.Quaternion.FromRotationMatrix(Rm);

  // Translation: t = cW - R * cL
  const cL = basisL.c;
  const cW = basisW.c;

  const RcL = BABYLON.Vector3.TransformCoordinates(cL, Rm);
  const t = sub(cW, RcL);

  roofRoot.rotationQuaternion = Rq;
  roofRoot.position = t;

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

  // Compute post-fit contact points (local edge mids transformed)
  let worldLF = null, worldLB = null;
  try {
    const wm = roofRoot.getWorldMatrix();
    const lfMid = mul(add(LF0, LF1), 0.5);
    const lbMid = mul(add(LB0, LB1), 0.5);
    worldLF = BABYLON.Vector3.TransformCoordinates(lfMid, wm);
    worldLB = BABYLON.Vector3.TransformCoordinates(lbMid, wm);
  } catch (e) {}

  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.roofFit = {
        frontPlate: {
          name: String(frontPlate.name || ""),
          p0: { x: Number(WF0.x), y: Number(WF0.y), z: Number(WF0.z) },
          p1: { x: Number(WF1.x), y: Number(WF1.y), z: Number(WF1.z) },
          mid: { x: Number(frontPlate.mid_m.x), y: Number(frontPlate.mid_m.y), z: Number(frontPlate.mid_m.z) },
          axis: String(frontPlate.axis || "")
        },
        backPlate: {
          name: String(backPlate.name || ""),
          p0: { x: Number(WB0.x), y: Number(WB0.y), z: Number(WB0.z) },
          p1: { x: Number(WB1.x), y: Number(WB1.y), z: Number(WB1.z) },
          mid: { x: Number(backPlate.mid_m.x), y: Number(backPlate.mid_m.y), z: Number(backPlate.mid_m.z) },
          axis: String(backPlate.axis || "")
        },
        localEdges: {
          longAxisLocal: String(longAxisLocal),
          pitchAxisLocal: String(pitchAxisLocal),
          LF0: { x: Number(LF0.x), y: Number(LF0.y), z: Number(LF0.z) },
          LF1: { x: Number(LF1.x), y: Number(LF1.y), z: Number(LF1.z) },
          LB0: { x: Number(LB0.x), y: Number(LB0.y), z: Number(LB0.z) },
          LB1: { x: Number(LB1.x), y: Number(LB1.y), z: Number(LB1.z) }
        }
      };

      // Plate endpoints
      mkDbgSphere("roof-dbg-frontPlate-p0", Number(WF0.x), Number(WF0.y), Number(WF0.z), true);
      mkDbgSphere("roof-dbg-frontPlate-p1", Number(WF1.x), Number(WF1.y), Number(WF1.z), true);
      mkDbgSphere("roof-dbg-backPlate-p0", Number(WB0.x), Number(WB0.y), Number(WB0.z), false);
      mkDbgSphere("roof-dbg-backPlate-p1", Number(WB1.x), Number(WB1.y), Number(WB1.z), false);

      // Roof fitted edge mids
      if (worldLF) mkDbgSphere("roof-dbg-roofFrontEdgeMid", Number(worldLF.x), Number(worldLF.y), Number(worldLF.z), true);
      if (worldLB) mkDbgSphere("roof-dbg-roofBackEdgeMid", Number(worldLB.x), Number(worldLB.y), Number(worldLB.z), false);
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
