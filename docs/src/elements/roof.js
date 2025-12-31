// FILE: docs/src/elements/roof.js
/**
 * Roof (PENT only).
 *
 * RADICAL MODE (selected "2"):
 * - Build roof members directly in WORLD SPACE (no rigid-body roofRoot yaw/pitch fit).
 * - Derive roof pitch from TRUE bearing edges on the FRONT/BACK TOP PLATES using world-space vertex sampling.
 * - Place rafters/rims/OSB on the solved roof plane analytically (per-piece), keeping all other policies literal:
 *   - Spacing @600mm
 *   - OSB 1220×2440 no-stagger, thickness 18mm
 *   - Timber section orientation (uses CONFIG.timber.w / CONFIG.timber.d with swapped axes as before)
 *
 * IMPORTANT:
 * - All roof meshes:
 *   - name prefix "roof-"
 *   - metadata.dynamic === true
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

  // ---- Helpers ----
  function mkBoxWorld(name, Lx_mm, Ly_mm, Lz_mm, cx_m, cy_m, cz_m, rotQuat, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx_mm / 1000, height: Ly_mm / 1000, depth: Lz_mm / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(cx_m, cy_m, cz_m);
    mesh.rotationQuaternion = rotQuat || BABYLON.Quaternion.Identity();
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
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

  function collectWorldVertices(mesh) {
    try {
      if (!mesh) return null;
      const vd = BABYLON.VertexData.ExtractFromMesh(mesh, true, true);
      if (!vd || !vd.positions || !vd.positions.length) return null;

      mesh.computeWorldMatrix(true);
      const wm = mesh.getWorldMatrix();

      const out = [];
      const p = vd.positions;
      for (let i = 0; i < p.length; i += 3) {
        const v = BABYLON.Vector3.TransformCoordinates(
          new BABYLON.Vector3(p[i], p[i + 1], p[i + 2]),
          wm
        );
        out.push(v);
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  // Extract TRUE bearing edge samples from a sloped top plate:
  // - take top-face vertices (y near maxY)
  // - pick the outer edge by Z extreme (front=minZ, back=maxZ)
  // - return samples (x,y) along that edge
  function bearingEdgeSamplesXY(plateMesh, which /* "front"|"back" */) {
    const verts = collectWorldVertices(plateMesh);
    if (!verts || !verts.length) return null;

    let maxY = -Infinity;
    for (let i = 0; i < verts.length; i++) {
      const y = verts[i].y;
      if (Number.isFinite(y) && y > maxY) maxY = y;
    }
    if (!Number.isFinite(maxY)) return null;

    // Top face selection epsilon (meters)
    const epsY = 0.001; // 1mm
    const top = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (Math.abs(v.y - maxY) <= epsY) top.push(v);
    }
    if (!top.length) return null;

    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < top.length; i++) {
      const z = top[i].z;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;

    const edgeZ = (which === "front") ? minZ : maxZ;

    // Edge selection epsilon (meters)
    const epsZ = 0.004; // 4mm (covers numeric jitter + triangulation)
    const edge = [];
    for (let i = 0; i < top.length; i++) {
      const v = top[i];
      if (Math.abs(v.z - edgeZ) <= epsZ) edge.push(v);
    }
    if (!edge.length) return null;

    // Reduce duplicates & return (x,y) points
    const samples = [];
    const seen = new Set();
    for (let i = 0; i < edge.length; i++) {
      const v = edge[i];
      const kx = Math.round(v.x * 10000); // 0.1mm bins
      const ky = Math.round(v.y * 10000);
      const key = String(kx) + "|" + String(ky);
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({ x: v.x, y: v.y });
    }

    // Sort along x for stability
    samples.sort((a, b) => a.x - b.x);

    return { edgeZ_m: edgeZ, samples };
  }

  function fitLineYofX(points) {
    // Least squares fit: y = m*x + c
    if (!points || points.length < 2) return null;

    let n = 0;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;

    for (let i = 0; i < points.length; i++) {
      const x = Number(points[i].x);
      const y = Number(points[i].y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }

    if (n < 2) return null;

    const denom = (n * sumXX - sumX * sumX);
    if (Math.abs(denom) < 1e-12) return null;

    const m = (n * sumXY - sumX * sumY) / denom;
    const c = (sumY - m * sumX) / n;

    if (!Number.isFinite(m) || !Number.isFinite(c)) return null;
    return { m, c };
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // ---- Footprint extents derived from actual wall bounds (no guessed offsets) ----
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

  const roofW_mm = Math.max(1, Math.floor((roofMaxX_m - roofMinX_m) * 1000));
  const roofD_mm = Math.max(1, Math.floor((roofMaxZ_m - roofMinZ_m) * 1000));

  // ---- Timber section from CONFIG, rotated orientation (unchanged policy) ----
  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w))); // typically 50
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d))); // typically 100
  const rafterW_mm = baseD; // width in plan
  const rafterD_mm = baseW; // vertical
  const osbThickness_mm = 18;

  // ---- TRUE bearing edge extraction (world-space vertex sampling) ----
  const frontPlateMesh = findTopPlateMesh("front");
  const backPlateMesh = findTopPlateMesh("back");

  const frontEdge = bearingEdgeSamplesXY(frontPlateMesh, "front");
  const backEdge = bearingEdgeSamplesXY(backPlateMesh, "back");

  // Primary pitch solve: fit y = m*x + c using both edges’ samples
  let pitch = null;
  if (frontEdge && backEdge) {
    const pts = []
      .concat(frontEdge.samples || [])
      .concat(backEdge.samples || []);
    pitch = fitLineYofX(pts);
  } else if (frontEdge) {
    pitch = fitLineYofX(frontEdge.samples || []);
  } else if (backEdge) {
    pitch = fitLineYofX(backEdge.samples || []);
  }

  // Fallback pitch from state (mirrors walls.js comment: pitch runs along X)
  const baseH_mm = Math.max(100, Math.floor(Number(state?.walls?.height_mm ?? 2400)));
  const minH_mm = Math.max(100, Math.floor(Number(state?.roof?.pent?.minHeight_mm ?? baseH_mm)));
  const maxH_mm = Math.max(100, Math.floor(Number(state?.roof?.pent?.maxHeight_mm ?? baseH_mm)));
  const frameW_mm = Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? Math.max(1, Math.floor(Number(state?.w ?? 1))))));

  if (!pitch) {
    const m = ((maxH_mm - minH_mm) / Math.max(1, frameW_mm)) / 1000; // (mm/mm) -> m/m
    // Assume x=0 at wallMinX_m (world)
    const c = (minH_mm / 1000) - m * (wallMinX_m);
    pitch = { m, c };
  }

  const mSlope = Number(pitch.m);
  const cSlope = Number(pitch.c);
  const angle = Math.atan(mSlope);
  const cosA = Math.cos(angle);
  const cosSafe = Math.max(1e-6, Math.abs(cosA));

  // ---- WORLD-SPACE PLACEMENT POLICY for PENT ----
  // Rafters run along X (parallel to front/back plates), placed along Z @600mm.
  // This matches the pent roof pitch definition used in walls.js (height varies along X).
  const spacing = 600;
  const maxP = Math.max(0, roofD_mm - rafterW_mm);

  const zPos = [];
  let p = 0;
  while (p <= maxP) {
    zPos.push(Math.floor(p));
    p += spacing;
  }
  if (zPos.length) {
    const last = zPos[zPos.length - 1];
    if (Math.abs(last - maxP) > 0) zPos.push(Math.floor(maxP));
  } else {
    zPos.push(0);
  }

  const qPitch = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 0, 1), angle);

  // ---- Place rim joists (front/back edges in Z, run along X) ----
  // Place them on the SAME roof plane underside as rafters (rigid members aligned to plane).
  function centerYForBottomOnPlane(xCenter_m, memberH_mm) {
    // For a box rotated about Z by angle, bottom line is y = m*x + c when:
    // Ty = c + m*Tx + (H / (2*cos(angle)))
    return cSlope + mSlope * xCenter_m + ((memberH_mm / 1000) / (2 * cosSafe));
  }

  // Rim at front (z = roofMinZ)
  {
    const Lx = roofW_mm;
    const Ly = rafterD_mm;
    const Lz = rafterW_mm;

    const cx = (roofMinX_m + roofMaxX_m) * 0.5;
    const cz = (roofMinZ_m + (roofMinZ_m + (Lz / 1000))) * 0.5;
    const cy = centerYForBottomOnPlane(cx, Ly);

    mkBoxWorld(
      "roof-rim-front",
      Lx,
      Ly,
      Lz,
      cx,
      cy,
      cz,
      qPitch,
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }

  // Rim at back (z = roofMaxZ - rafterW)
  {
    const Lx = roofW_mm;
    const Ly = rafterD_mm;
    const Lz = rafterW_mm;

    const z0 = roofMaxZ_m - (Lz / 1000);
    const cx = (roofMinX_m + roofMaxX_m) * 0.5;
    const cz = (z0 + (z0 + (Lz / 1000))) * 0.5;
    const cy = centerYForBottomOnPlane(cx, Ly);

    mkBoxWorld(
      "roof-rim-back",
      Lx,
      Ly,
      Lz,
      cx,
      cy,
      cz,
      qPitch,
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // ---- Place rafters along Z @600 (span X) ----
  for (let i = 0; i < zPos.length; i++) {
    const b0 = zPos[i];

    const Lx = roofW_mm;      // span X
    const Ly = rafterD_mm;    // vertical
    const Lz = rafterW_mm;    // thickness along Z

    const z0_m = roofMinZ_m + (b0 / 1000);

    const cx = (roofMinX_m + roofMaxX_m) * 0.5;
    const cz = z0_m + (Lz / 1000) * 0.5;
    const cy = centerYForBottomOnPlane(cx, Ly);

    mkBoxWorld(
      `roof-rafter-${i}`,
      Lx,
      Ly,
      Lz,
      cx,
      cy,
      cz,
      qPitch,
      joistMat,
      { roof: "pent", part: "rafter", spacing: "600" }
    );
  }

  // ---- OSB tiling (no stagger) in XZ footprint, pitched to sit on TOP of rafters ----
  // Top-of-rafter plane is offset above bottom plane by (rafterD / cos(angle)).
  const topPlaneC = cSlope + ((rafterD_mm / 1000) / cosSafe);

  function centerYForOsbBottomOnTopPlane(xCenter_m) {
    // OSB box rotated by same angle; its bottom should lie on topPlane:
    // Ty = topPlaneC + m*Tx + (T / (2*cos(angle)))
    return topPlaneC + mSlope * xCenter_m + ((osbThickness_mm / 1000) / (2 * cosSafe));
  }

  const osbAB = computeOsbPiecesNoStagger(roofW_mm, roofD_mm); // A=X, B=Z in world
  for (let i = 0; i < osbAB.all.length; i++) {
    const p2 = osbAB.all[i];

    const x0_m = roofMinX_m + (p2.a0_mm / 1000);
    const z0_m = roofMinZ_m + (p2.b0_mm / 1000);

    const Lx = p2.W_mm; // along X
    const Lz = p2.L_mm; // along Z
    const Ly = osbThickness_mm;

    const cx = x0_m + (Lx / 1000) * 0.5;
    const cz = z0_m + (Lz / 1000) * 0.5;
    const cy = centerYForOsbBottomOnTopPlane(cx);

    mkBoxWorld(
      `roof-osb-${i}`,
      Lx,
      Ly,
      Lz,
      cx,
      cy,
      cz,
      qPitch,
      osbMat,
      { roof: "pent", part: "osb", kind: p2.kind }
    );
  }

  // ---- Debug spheres + dbg payload (roof.js only) ----
  function mkDbgSphere(name, x_m, y_m, z_m, kind) {
    try {
      const s = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.06 }, scene);
      s.position = new BABYLON.Vector3(x_m, y_m, z_m);
      const mat = new BABYLON.StandardMaterial(name + "-mat", scene);
      if (kind === "front") mat.emissiveColor = new BABYLON.Color3(0.1, 0.9, 0.1);
      else if (kind === "back") mat.emissiveColor = new BABYLON.Color3(0.9, 0.1, 0.1);
      else mat.emissiveColor = new BABYLON.Color3(0.1, 0.4, 0.9);
      s.material = mat;
      s.metadata = { dynamic: true };
      return s;
    } catch (e) {
      return null;
    }
  }

  try {
    if (typeof window !== "undefined" && window.__dbg) {
      // Sample errors at front/back along center Z of footprint
      const xA = roofMinX_m;
      const xB = roofMaxX_m;

      const yPlaneA = mSlope * xA + cSlope;
      const yPlaneB = mSlope * xB + cSlope;

      window.__dbg.roofFit = {
        mode: "world-space-per-piece",
        pitch: { m: mSlope, c: cSlope, angle: angle },
        roof: {
          minX: roofMinX_m, maxX: roofMaxX_m,
          minZ: roofMinZ_m, maxZ: roofMaxZ_m,
          w_mm: roofW_mm, d_mm: roofD_mm
        },
        plates: {
          frontMesh: frontPlateMesh ? String(frontPlateMesh.name || "") : "",
          backMesh: backPlateMesh ? String(backPlateMesh.name || "") : "",
          frontEdgeZ: frontEdge ? Number(frontEdge.edgeZ_m) : null,
          backEdgeZ: backEdge ? Number(backEdge.edgeZ_m) : null,
          frontSamples: frontEdge ? (frontEdge.samples || []).length : 0,
          backSamples: backEdge ? (backEdge.samples || []).length : 0
        },
        planeYAt: { xMin: yPlaneA, xMax: yPlaneB }
      };

      // Visualize plane endpoints (underside) at mid Z
      const midZ = (roofMinZ_m + roofMaxZ_m) * 0.5;
      mkDbgSphere("roof-dbg-plane-xmin", roofMinX_m, yPlaneA, midZ, "front");
      mkDbgSphere("roof-dbg-plane-xmax", roofMaxX_m, yPlaneB, midZ, "back");

      // Visualize extracted bearing edge Z lines (at mean sample x)
      if (frontEdge && frontEdge.samples && frontEdge.samples.length) {
        const fx = frontEdge.samples[Math.floor(frontEdge.samples.length / 2)].x;
        const fy = frontEdge.samples[Math.floor(frontEdge.samples.length / 2)].y;
        mkDbgSphere("roof-dbg-front-bearing", fx, fy, Number(frontEdge.edgeZ_m), "front");
      }
      if (backEdge && backEdge.samples && backEdge.samples.length) {
        const bx = backEdge.samples[Math.floor(backEdge.samples.length / 2)].x;
        const by = backEdge.samples[Math.floor(backEdge.samples.length / 2)].y;
        mkDbgSphere("roof-dbg-back-bearing", bx, by, Number(backEdge.edgeZ_m), "back");
      }
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

  const dims = resolveDims(state);
  const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  // Timber section from CONFIG, rotated orientation (unchanged policy)
  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w))); // typically 50
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d))); // typically 100
  const rafterW_mm = baseD;
  const rafterD_mm = baseW;

  // Rafters: run along X (roofW), placed along Z @600
  const spacing = 600;
  const maxP = Math.max(0, roofD - rafterW_mm);

  const pos = [];
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

  const rows = [];

  // Rim joists (front/back), run along roofW
  rows.push({
    item: "Roof Rim Joist",
    qty: 2,
    L: roofW,
    W: rafterW_mm,
    notes: "D (mm): " + String(rafterD_mm),
  });

  rows.push({
    item: "Roof Rafter",
    qty: pos.length,
    L: roofW,
    W: rafterW_mm,
    notes: "D (mm): " + String(rafterD_mm) + "; spacing @600mm; pent roof",
  });

  // OSB pieces (no stagger): A=roofW, B=roofD
  const osbAB = computeOsbPiecesNoStagger(roofW, roofD);

  const osbPieces = [];
  for (let i = 0; i < osbAB.all.length; i++) {
    const pp = osbAB.all[i];
    osbPieces.push({
      L: Math.max(1, Math.floor(pp.L_mm)),
      W: Math.max(1, Math.floor(pp.W_mm)),
      notes: "18mm OSB; " + (pp.kind === "std" ? "standard sheet" : "rip/trim"),
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

/**
 * No-stagger tiling for 1220×2440 sheets in AB space:
 * - A axis uses 1220
 * - B axis uses 2440
 * Returns all pieces with A/B origins (a0_mm,b0_mm) and sizes (W_mm along A, L_mm along B).
 *
 * Here we use:
 * - A = world X span (roofW)
 * - B = world Z span (roofD)
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
