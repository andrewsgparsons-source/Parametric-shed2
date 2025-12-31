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

  // ---- HARD DISPOSAL (meshes + transform nodes), children before parents ----
  const roofNodes = new Set();
  const roofMeshes = [];

  // Collect roof transform nodes
  for (let i = 0; i < (scene.transformNodes || []).length; i++) {
    const n = scene.transformNodes[i];
    if (!n) continue;
    const nm = String(n.name || "");
    if (nm === "roof-root" || nm === "roof-tilt" || nm.startsWith("roof-")) roofNodes.add(n);
  }

  // Collect roof meshes (by name prefix OR parent-chain includes roof-root/roof-tilt)
  for (let i = 0; i < (scene.meshes || []).length; i++) {
    const m = scene.meshes[i];
    if (!m) continue;
    const nm = String(m.name || "");
    let isRoof = nm.startsWith("roof-");

    if (!isRoof) {
      try {
        let p = m.parent;
        while (p) {
          const pn = String(p.name || "");
          if (pn === "roof-root" || pn === "roof-tilt" || pn.startsWith("roof-")) {
            isRoof = true;
            break;
          }
          p = p.parent;
        }
      } catch (e) {}
    }

    if (isRoof) roofMeshes.push(m);
  }

  // Dispose meshes first
  for (let i = 0; i < roofMeshes.length; i++) {
    const m = roofMeshes[i];
    try {
      if (m && !m.isDisposed()) m.dispose(false, true);
    } catch (e) {}
  }

  // Dispose transform nodes (children before parents)
  const nodesArr = Array.from(roofNodes);
  nodesArr.sort((a, b) => {
    // deeper (more parents) first
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

  function topYForMeshes(meshes) {
    let maxY = -Infinity;
    let found = false;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
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
    return found && Number.isFinite(maxY) ? maxY : null;
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
    return { minX_m: minX, maxX_m: maxX, minZ_m: minZ, maxZ_m: maxZ };
  }

  function getWallMeshesByPrefix(prefix, mustInclude) {
    const out = [];
    for (let i = 0; i < (scene.meshes || []).length; i++) {
      const m = scene.meshes[i];
      if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
      const nm = String(m.name || "");
      if (!nm.startsWith(prefix)) continue;
      if (mustInclude && nm.indexOf(mustInclude) === -1) continue;
      out.push(m);
    }
    return out;
  }

  function getWallSideTopY_m(sidePrefix) {
    const top = getWallMeshesByPrefix(sidePrefix, "plate-top");
    const all = getWallMeshesByPrefix(sidePrefix, null);
    const y = (top.length ? topYForMeshes(top) : null) ?? topYForMeshes(all);
    return y;
  }

  function getWallTopAtX_m(sampleX_m, wallPrefixes /* array */, preferTopPlates) {
    // Prefer top plates, but allow fallback to all meshes of those walls
    const prefer = [];
    const all = [];
    for (let i = 0; i < wallPrefixes.length; i++) {
      const pfx = wallPrefixes[i];
      const a = getWallMeshesByPrefix(pfx, null);
      for (let j = 0; j < a.length; j++) all.push(a[j]);
      if (preferTopPlates) {
        const t = getWallMeshesByPrefix(pfx, "plate-top");
        for (let j = 0; j < t.length; j++) prefer.push(t[j]);
      }
    }
    const meshes = (preferTopPlates && prefer.length) ? prefer : all;

    let best = -Infinity;
    let found = false;

    // Filter by X-range containment
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const bb = bi.boundingBox;
        const minX = bb.minimumWorld.x;
        const maxX = bb.maximumWorld.x;
        if (sampleX_m >= minX && sampleX_m <= maxX) {
          const y = bb.maximumWorld.y;
          if (Number.isFinite(y)) {
            found = true;
            if (y > best) best = y;
          }
        }
      } catch (e) {}
    }

    if (found && Number.isFinite(best)) return best;

    // Fallback: max Y across those wall meshes
    const yAny = topYForMeshes(meshes);
    return yAny != null ? yAny : null;
  }

  function getWallTopAtZ_m(sampleZ_m, wallPrefixes /* array */, preferTopPlates) {
    const prefer = [];
    const all = [];
    for (let i = 0; i < wallPrefixes.length; i++) {
      const pfx = wallPrefixes[i];
      const a = getWallMeshesByPrefix(pfx, null);
      for (let j = 0; j < a.length; j++) all.push(a[j]);
      if (preferTopPlates) {
        const t = getWallMeshesByPrefix(pfx, "plate-top");
        for (let j = 0; j < t.length; j++) prefer.push(t[j]);
      }
    }
    const meshes = (preferTopPlates && prefer.length) ? prefer : all;

    let best = -Infinity;
    let found = false;

    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      try {
        m.computeWorldMatrix(true);
        const bi = m.getBoundingInfo && m.getBoundingInfo();
        if (!bi || !bi.boundingBox) continue;
        const bb = bi.boundingBox;
        const minZ = bb.minimumWorld.z;
        const maxZ = bb.maximumWorld.z;
        if (sampleZ_m >= minZ && sampleZ_m <= maxZ) {
          const y = bb.maximumWorld.y;
          if (Number.isFinite(y)) {
            found = true;
            if (y > best) best = y;
          }
        }
      } catch (e) {}
    }

    if (found && Number.isFinite(best)) return best;

    const yAny = topYForMeshes(meshes);
    return yAny != null ? yAny : null;
  }

  // --- Wall bounds (world) ---
  const allWallMeshes = getWallMeshesByPrefix("wall-", null);
  const wallBounds = boundsForMeshes(allWallMeshes);

  // If walls are hidden/missing, fallback plan anchoring to 0,0 and heights to state
  const wallMinX_m = wallBounds ? wallBounds.minX_m : 0;
  const wallMaxX_m = wallBounds ? wallBounds.maxX_m : (wallMinX_m + (Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? 1))) / 1000));
  const wallMinZ_m = wallBounds ? wallBounds.minZ_m : 0;
  const wallMaxZ_m = wallBounds ? wallBounds.maxZ_m : (wallMinZ_m + (Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? 1))) / 1000));

  // --- Side tops (prefer top plates) ---
  let leftTopY_m = getWallSideTopY_m("wall-left-");
  let rightTopY_m = getWallSideTopY_m("wall-right-");
  let frontTopY_m = getWallSideTopY_m("wall-front-");
  let backTopY_m = getWallSideTopY_m("wall-back-");

  // Fallback heights if walls missing
  if (leftTopY_m == null || rightTopY_m == null || frontTopY_m == null || backTopY_m == null) {
    const baseH_mm = Math.max(
      100,
      Math.floor(
        Number(state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400)
      )
    );
    const minH_mm = Math.max(
      100,
      Math.floor(
        Number(
          state && state.roof && state.roof.pent && state.roof.pent.minHeight_mm != null
            ? state.roof.pent.minHeight_mm
            : baseH_mm
        )
      )
    );
    const maxH_mm = Math.max(
      100,
      Math.floor(
        Number(
          state && state.roof && state.roof.pent && state.roof.pent.maxHeight_mm != null
            ? state.roof.pent.maxHeight_mm
            : baseH_mm
        )
      )
    );

    if (leftTopY_m == null) leftTopY_m = minH_mm / 1000;
    if (rightTopY_m == null) rightTopY_m = maxH_mm / 1000;
    if (frontTopY_m == null) frontTopY_m = Math.max(leftTopY_m, rightTopY_m);
    if (backTopY_m == null) backTopY_m = Math.max(leftTopY_m, rightTopY_m);
  }

  // --- Detect pitch axis from wall geometry (world), prefer top plates ---
  const lerp = (a, b, t) => a + (b - a) * t;
  const eps = 1e-5;

  const xA = lerp(wallMinX_m, wallMaxX_m, 0.2);
  const xB = lerp(wallMinX_m, wallMaxX_m, 0.8);

  const yA_x = getWallTopAtX_m(xA, ["wall-front-", "wall-back-"], true);
  const yB_x = getWallTopAtX_m(xB, ["wall-front-", "wall-back-"], true);

  let pitchAxis = "x";
  if (yA_x != null && yB_x != null && Math.abs(yB_x - yA_x) > eps) {
    pitchAxis = "x";
  } else {
    const zA = lerp(wallMinZ_m, wallMaxZ_m, 0.2);
    const zB = lerp(wallMinZ_m, wallMaxZ_m, 0.8);
    const yA_z = getWallTopAtZ_m(zA, ["wall-left-", "wall-right-"], true);
    const yB_z = getWallTopAtZ_m(zB, ["wall-left-", "wall-right-"], true);
    if (yA_z != null && yB_z != null && Math.abs(yB_z - yA_z) > eps) pitchAxis = "z";
    else pitchAxis = "x"; // deterministic fallback
  }

  // --- Compute rise/run/angle from actual wall bounds ---
  let run_m = 0;
  let rise_m = 0;
  let angle = 0;

  if (pitchAxis === "x") {
    const yMin = getWallTopAtX_m(wallMinX_m, ["wall-front-", "wall-back-"], true);
    const yMax = getWallTopAtX_m(wallMaxX_m, ["wall-front-", "wall-back-"], true);
    const y0 = (yMin != null ? yMin : leftTopY_m);
    const y1 = (yMax != null ? yMax : rightTopY_m);
    run_m = Math.max(1e-6, (wallMaxX_m - wallMinX_m));
    rise_m = (y1 - y0);
    angle = Math.atan2(Math.abs(rise_m), run_m);
  } else {
    const yMin = getWallTopAtZ_m(wallMinZ_m, ["wall-left-", "wall-right-"], true);
    const yMax = getWallTopAtZ_m(wallMaxZ_m, ["wall-left-", "wall-right-"], true);
    const y0 = (yMin != null ? yMin : frontTopY_m);
    const y1 = (yMax != null ? yMax : backTopY_m);
    run_m = Math.max(1e-6, (wallMaxZ_m - wallMinZ_m));
    rise_m = (y1 - y0);
    angle = Math.atan2(Math.abs(rise_m), run_m);
  }

  // --- Roof hierarchy: root anchored in world, tilt applied once ---
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };

  const roofTilt = new BABYLON.TransformNode("roof-tilt", scene);
  roofTilt.metadata = { dynamic: true };
  roofTilt.parent = roofRoot;

  // Plan alignment: roof min corner aligns to wall min corner minus overhang (no hardcoded offsets)
  const desiredRoofMinX_m = wallMinX_m - (Math.max(0, Math.floor(Number(ovh.l_mm || 0))) / 1000);
  const desiredRoofMinZ_m = wallMinZ_m - (Math.max(0, Math.floor(Number(ovh.f_mm || 0))) / 1000);

  // Seat at low-side bearing
  const lowY_m = Math.min(leftTopY_m, rightTopY_m);
  roofRoot.position = new BABYLON.Vector3(desiredRoofMinX_m, lowY_m, desiredRoofMinZ_m);

  // Apply pitch rotation around correct axis, anchored at low side
  const rot = new BABYLON.Vector3(0, 0, 0);
  if (angle <= 1e-9) {
    // flat
  } else if (pitchAxis === "x") {
    // Rotate about Z so +X rises when rise_m > 0
    if (rise_m > eps) rot.z = -angle;
    else if (rise_m < -eps) rot.z = +angle;
  } else {
    // pitch along Z => rotate about X so +Z rises when rise_m > 0
    // (sign chosen so +Z increases Y when rise_m > 0)
    if (rise_m > eps) rot.x = -angle;
    else if (rise_m < -eps) rot.x = +angle;
  }
  roofTilt.rotation = rot;

  // Debug dump
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.lastRoof = {
        variant: state && state.walls ? state.walls.variant : undefined,
        leftTopY_m,
        rightTopY_m,
        frontTopY_m,
        backTopY_m,
        pitchAxis,
        run_m,
        rise_m,
        angle_rad: angle,
        roofRoot: { x: roofRoot.position.x, y: roofRoot.position.y, z: roofRoot.position.z },
        roofTiltRot: { x: roofTilt.rotation.x, y: roofTilt.rotation.y, z: roofTilt.rotation.z },
        wallBounds: { minX: wallMinX_m, maxX: wallMaxX_m, minZ: wallMinZ_m, maxZ: wallMaxZ_m }
      };
    }
  } catch (e) {}

  // ---- Rim Joists (front/back at ends of A; run along B) ----
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, data.A_mm - rimThkA_mm);

  function mapABtoLocalXZ(a0, b0, aLen, bLen, isWShort) {
    // Roof-local coordinates (origin at roof min corner)
    if (isWShort) return { x0: a0, z0: b0, lenX: aLen, lenZ: bLen };
    return { x0: b0, z0: a0, lenX: bLen, lenZ: aLen };
  }

  // Front rim (A = 0)
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
      roofTilt,
      joistMat,
      { roof: "pent", part: "rim", edge: "front" }
    );
  }

  // Back rim (A = A - thickness)
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
      roofTilt,
      joistMat,
      { roof: "pent", part: "rim", edge: "back" }
    );
  }

  // ---- Rafters (span along A, placed along B @600) ----
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
      roofTilt,
      joistMat,
      { roof: "pent", part: "rafter" }
    );
  }

  // ---- OSB boards (bottom sits on top of rafters in local space) ----
  const osbBottomY_m = data.rafterD_mm / 1000;
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];

    mkBoxBottomLocal(
      `roof-osb-${i}`,
      p.xLen_mm,
      data.osbThickness_mm,
      p.zLen_mm,
      p.x0_mm,
      osbBottomY_m,
      p.z0_mm,
      roofTilt,
      osbMat,
      { roof: "pent", part: "osb", kind: p.kind }
    );
  }

  // Seat debug (kept lightweight)
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.lastRoofSeat = {
        leftTopY_m,
        rightTopY_m,
        roofRootY_m: roofRoot.position.y,
        rise_m,
        run_m,
        angle,
        rot: { x: roofTilt.rotation.x, y: roofTilt.rotation.y, z: roofTilt.rotation.z }
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

  // Roof-local origin is handled by roofRoot world positioning; keep roof-local at (0,0).
  const originX_mm = 0;
  const originZ_mm = 0;

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