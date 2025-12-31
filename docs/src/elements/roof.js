// FILE: docs/src/elements/roof.js
/**
 * Roof
 * - PENT: existing analytic-bearing-lines implementation (must remain unchanged in behavior).
 * - APEX (NEW): gabled ends + trusses + purlins, built analytically from state + resolved dims.
 *
 * Global literals (unchanged):
 * - Spacing @600mm
 * - OSB sheets 1220×2440, no-stagger tiling, thickness 18mm
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

  for (let i = 0; i < roofMeshes.length; i++) {
    const m = roofMeshes[i];
    try {
      if (m && !m.isDisposed()) m.dispose(false, true);
    } catch (e) {}
  }

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

  const style = String(state?.roof?.style || "");
  if (style === "apex") {
    buildApex3D(state, ctx);
    return;
  }

  // -----------------------------
  // PENT (existing behavior path)
  // -----------------------------
  if (!isPentEnabled(state)) return;

  const data = computeRoofDataPent(state);
  const dims = resolveDims(state);

  const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
  const l_mm = Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
  const r_mm = Math.max(0, Math.floor(Number(ovh.r_mm || 0)));
  const f_mm = Math.max(0, Math.floor(Number(ovh.f_mm || 0)));
  const b_mm = Math.max(0, Math.floor(Number(ovh.b_mm || 0)));

  const frameW_mm = Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? state?.w ?? 1)));
  const frameD_mm = Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? state?.d ?? 1)));

  // Analytic pent heights (authoritative for roof bearing)
  const minH_mm = Math.max(100, Math.floor(Number(data.minH_mm || 2400)));
  const maxH_mm = Math.max(100, Math.floor(Number(data.maxH_mm || 2400)));

  // Materials
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

  // ---- Analytic alignment (no wall mesh queries) ----
  // Authoritative roof plan extents in world:
  // - Frame is at world X:[0..frameW], Z:[0..frameD]
  // - Roof should cover X:[-l..frameW+r], Z:[-f..frameD+b]
  const targetMinX_m = (-l_mm) / 1000;
  const targetMinZ_m = (-f_mm) / 1000;

  // Rotation:
  // - Pent slope is along WORLD +X (walls.js definition)
  // - Therefore the roof WIDTH axis (local +X) must align to WORLD +X.
  const slopeAxisWorld = new BABYLON.Vector3(1, 0, 0);
  const pitchAxisWorld = new BABYLON.Vector3(0, 0, 1); // rotate about Z to raise +X end

  // Source slope axis in roof local is ALWAYS local +X (roof width direction),
  // regardless of whether rafters span A along X or Z.
  const slopeAxisLocal = new BABYLON.Vector3(1, 0, 0);

  // Yaw around Y to align slopeAxisLocal -> +X (normally 0; kept robust)
  const dotYaw = clamp((slopeAxisLocal.x * slopeAxisWorld.x + slopeAxisLocal.z * slopeAxisWorld.z), -1, 1);
  const crossYawY = (slopeAxisLocal.x * slopeAxisWorld.z - slopeAxisLocal.z * slopeAxisWorld.x);
  let yaw = (Math.acos(dotYaw)) * (crossYawY >= 0 ? 1 : -1);
  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // Pitch angle derived from analytic rise/run (frameW)
  const rise_m = (maxH_mm - minH_mm) / 1000;
  const run_m = Math.max(1e-6, frameW_mm / 1000);
  const angle = Math.atan2(rise_m, run_m);
  const qPitch = BABYLON.Quaternion.RotationAxis(pitchAxisWorld, angle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);

  // Step 1: translate in X/Z so rotated roof's PLAN min corner lands on targetMinX/Z.
  // Compute 4 plan corners of the *roof rectangle* in local (0..roofW, 0..roofD).
  const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? data.roofW_mm ?? 1)));
  const roofD_mm = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? data.roofD_mm ?? 1)));

  const cornersLocal = [
    new BABYLON.Vector3(0 / 1000, 0, 0 / 1000),
    new BABYLON.Vector3(roofW_mm / 1000, 0, 0 / 1000),
    new BABYLON.Vector3(0 / 1000, 0, roofD_mm / 1000),
    new BABYLON.Vector3(roofW_mm / 1000, 0, roofD_mm / 1000),
  ];

  function worldOfLocal(pLocal) {
    try {
      const wm = roofRoot.getWorldMatrix();
      return BABYLON.Vector3.TransformCoordinates(pLocal, wm);
    } catch (e) {
      return null;
    }
  }

  // With position at (0,0,0), get minX/minZ in world for the rotated corners
  let minCornerX = Infinity;
  let minCornerZ = Infinity;
  for (let i = 0; i < cornersLocal.length; i++) {
    const wpt = worldOfLocal(cornersLocal[i]);
    if (!wpt) continue;
    if (Number.isFinite(wpt.x) && wpt.x < minCornerX) minCornerX = wpt.x;
    if (Number.isFinite(wpt.z) && wpt.z < minCornerZ) minCornerZ = wpt.z;
  }
  if (!Number.isFinite(minCornerX)) minCornerX = 0;
  if (!Number.isFinite(minCornerZ)) minCornerZ = 0;

  roofRoot.position.x += (targetMinX_m - minCornerX);
  roofRoot.position.z += (targetMinZ_m - minCornerZ);

  // Step 2: translate Y so the underside at frame's LEFT edge (x=0) hits minH,
  // and (by construction) frame RIGHT edge (x=frameW) hits maxH.
  // Choose two analytic bearing sample points at mid-depth of the frame.
  const midFrameZ_mm = Math.floor(frameD_mm / 2);
  const pLeftLocal = new BABYLON.Vector3((l_mm) / 1000, 0, (f_mm + midFrameZ_mm) / 1000);
  const pRightLocal = new BABYLON.Vector3((l_mm + frameW_mm) / 1000, 0, (f_mm + midFrameZ_mm) / 1000);

  const worldLeft = worldOfLocal(pLeftLocal);
  if (worldLeft) {
    const targetYLeft_m = (minH_mm / 1000);
    roofRoot.position.y += (targetYLeft_m - worldLeft.y);
  } else {
    roofRoot.position.y = (minH_mm / 1000);
  }

  // Debug-only: report right-edge error after final placement
  let worldRight = null;
  let rightError_m = null;
  try {
    worldRight = worldOfLocal(pRightLocal);
    if (worldRight) {
      const targetYRight_m = (maxH_mm / 1000);
      rightError_m = targetYRight_m - worldRight.y;
    }
  } catch (e) {}

  // ---- Debug visuals + dbg object (roof.js only) ----
  function mkDbgSphere(name, x_m, y_m, z_m, isGood) {
    try {
      const s = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.06 }, scene);
      s.position = new BABYLON.Vector3(x_m, y_m, z_m);
      const mat = new BABYLON.StandardMaterial(name + "-mat", scene);
      if (isGood) mat.emissiveColor = new BABYLON.Color3(0.1, 0.9, 0.1);
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
      const leftW = worldOfLocal(pLeftLocal);
      const rightW = worldOfLocal(pRightLocal);

      window.__dbg.roofFit = {
        mode: "analytic-bearing-lines",
        frame: { w_mm: frameW_mm, d_mm: frameD_mm },
        overhang_mm: { l: l_mm, r: r_mm, f: f_mm, b: b_mm },
        heights_mm: { minH: minH_mm, maxH: maxH_mm },
        rise_m: rise_m,
        run_m: run_m,
        angle: angle,
        rightError_mm: rightError_m == null ? null : (rightError_m * 1000),
      };

      // Visualize analytic bearing samples
      if (leftW) mkDbgSphere("roof-dbg-bearing-left", leftW.x, leftW.y, leftW.z, true);
      if (rightW) mkDbgSphere("roof-dbg-bearing-right", rightW.x, rightW.y, rightW.z, false);
    }
  } catch (e) {}
}

export function updateBOM(state) {
  // Backward-compatible with either:
  // - legacy DOM where #roofBomTable is a <tbody>
  // - current scaffolding where #roofBomTable is a <table>
  let host = document.getElementById("roofBomTable");
  if (!host) return;

  let tbody = host;
  if (host.tagName && String(host.tagName).toLowerCase() === "table") {
    tbody = (host.tBodies && host.tBodies[0]) ? host.tBodies[0] : null;
    if (!tbody) {
      tbody = document.createElement("tbody");
      host.appendChild(tbody);
    }
  }
  if (!tbody) return;

  tbody.innerHTML = "";

  const style = String(state?.roof?.style || "");

  if (style === "apex") {
    const data = computeRoofDataApex(state);

    const rows = [];

    rows.push({
      item: "Apex Truss",
      qty: data.trusses.length,
      L: data.A_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm) + "; includes tie chord + 2 rafters; spacing @600mm",
    });

    rows.push({
      item: "Apex Rafter",
      qty: data.trusses.length * 2,
      L: data.rafterLen_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm) + "; per truss x2",
    });

    rows.push({
      item: "Apex Tie Chord",
      qty: data.trusses.length,
      L: data.A_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm) + "; per truss x1",
    });

    rows.push({
      item: "Apex King Post",
      qty: data.trusses.length,
      L: data.rise_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm) + "; per truss x1",
    });

    rows.push({
      item: "Apex Ridge Beam",
      qty: 1,
      L: data.B_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm),
    });

    rows.push({
      item: "Apex Purlin",
      qty: 2,
      L: data.B_mm,
      W: data.rafterW_mm,
      notes: "D (mm): " + String(data.rafterD_mm) + "; one per slope",
    });

    // OSB pieces (group identical cut sizes) — per-slope pieces are just sizes
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
        item: "Apex Roof OSB",
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
    return;
  }

  // Default: PENT BOM (existing behavior)
  if (!isPentEnabled(state)) {
    appendPlaceholderRow(tbody, "Roof not enabled.");
    return;
  }

  const data = computeRoofDataPent(state);

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

// -----------------------------
// APEX 3D (NEW)
// -----------------------------
function buildApex3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  const dims = resolveDims(state);

  const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
  const l_mm = Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
  const r_mm = Math.max(0, Math.floor(Number(ovh.r_mm || 0)));
  const f_mm = Math.max(0, Math.floor(Number(ovh.f_mm || 0)));
  const b_mm = Math.max(0, Math.floor(Number(ovh.b_mm || 0)));

  const data = computeRoofDataApex(state);

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

  function mkBox(name, Lx_mm, Ly_mm, Lz_mm, pos_mm, parentNode, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx_mm / 1000, height: Ly_mm / 1000, depth: Lz_mm / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(
      (pos_mm.x + Lx_mm / 2) / 1000,
      (pos_mm.y + Ly_mm / 2) / 1000,
      (pos_mm.z + Lz_mm / 2) / 1000
    );
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  function mkOrientedBoxAlongSegment(name, sizeW_mm, sizeD_mm, p0_mm, p1_mm, parentNode, mat, meta) {
    const dx = (p1_mm.x - p0_mm.x);
    const dy = (p1_mm.y - p0_mm.y);
    const dz = (p1_mm.z - p0_mm.z);
    const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Create box with its LOCAL X axis = length
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: len / 1000, height: sizeD_mm / 1000, depth: sizeW_mm / 1000 },
      scene
    );

    // Midpoint
    const mx = (p0_mm.x + p1_mm.x) / 2;
    const my = (p0_mm.y + p1_mm.y) / 2;
    const mz = (p0_mm.z + p1_mm.z) / 2;

    mesh.position = new BABYLON.Vector3(mx / 1000, my / 1000, mz / 1000);

    // Rotate local +X to the segment direction
    const dir = new BABYLON.Vector3(dx / len, dy / len, dz / len);
    const q = quatFromTo(new BABYLON.Vector3(1, 0, 0), dir);
    mesh.rotationQuaternion = q;

    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  // ---- roof root ----
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();

  // Plan mapping:
  // We build A along local X and B along local Z.
  // If width is NOT the short side, swap to keep A spanning the shortest dimension in world.
  // - isWShort: A=roofW, B=roofD => local X aligns to WORLD X, local Z to WORLD Z (yaw 0)
  // - !isWShort: A=roofD, B=roofW => local X aligns to WORLD Z, local Z to WORLD X (yaw +90°)
  if (!data.isWShort) {
    roofRoot.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), Math.PI / 2);
  }

  // Translate so plan min corner lands on target min with overhangs
  roofRoot.position.x = (-l_mm) / 1000;
  roofRoot.position.z = (-f_mm) / 1000;

  // Heights:
  // eave = walls.height_mm (authoritative default already present)
  // ridge = state.roof.apex.ridgeHeight_mm if provided, else falls back to eave (flat if not provided)
  roofRoot.position.y = (data.eaveH_mm) / 1000;

  // ---- Ridge beam (along B) at x=A/2, y=rise ----
  // Place as axis-aligned local Z box (no rotation needed under our mapping).
  mkBox(
    "roof-apex-ridge",
    data.rafterW_mm,
    data.rafterD_mm,
    data.B_mm,
    { x: (data.A_mm / 2) - (data.rafterW_mm / 2), y: data.rise_mm, z: 0 },
    roofRoot,
    joistMat,
    { roof: "apex", part: "ridge" }
  );

  // ---- Purlins (along B) one per slope at mid-slope ----
  // Left slope purlin centered at x=A/4, y=rise/2
  mkBox(
    "roof-apex-purlin-left",
    data.rafterW_mm,
    data.rafterD_mm,
    data.B_mm,
    { x: (data.A_mm / 4) - (data.rafterW_mm / 2), y: Math.floor(data.rise_mm / 2), z: 0 },
    roofRoot,
    joistMat,
    { roof: "apex", part: "purlin", side: "left" }
  );
  // Right slope purlin centered at x=3A/4, y=rise/2
  mkBox(
    "roof-apex-purlin-right",
    data.rafterW_mm,
    data.rafterD_mm,
    data.B_mm,
    { x: (3 * data.A_mm / 4) - (data.rafterW_mm / 2), y: Math.floor(data.rise_mm / 2), z: 0 },
    roofRoot,
    joistMat,
    { roof: "apex", part: "purlin", side: "right" }
  );

  // ---- Trusses @600 along B (including ends) ----
  for (let i = 0; i < data.trusses.length; i++) {
    const t = data.trusses[i];
    const tr = new BABYLON.TransformNode(`roof-apex-truss-${i}`, scene);
    tr.metadata = { dynamic: true };
    tr.parent = roofRoot;
    tr.position = new BABYLON.Vector3(0, 0, (t.b0_mm) / 1000);
    tr.rotationQuaternion = BABYLON.Quaternion.Identity();

    // Tie chord (bottom chord) along A at y=0
    mkBox(
      `roof-apex-truss-${i}-tie`,
      data.A_mm,
      data.rafterD_mm,
      data.rafterW_mm,
      { x: 0, y: 0, z: -(data.rafterW_mm / 2) },
      tr,
      joistMat,
      { roof: "apex", part: "tie", trussIndex: i }
    );

    // King post (vertical) at x=A/2 from y=0 to y=rise
    mkBox(
      `roof-apex-truss-${i}-king`,
      data.rafterW_mm,
      data.rise_mm,
      data.rafterW_mm,
      { x: (data.A_mm / 2) - (data.rafterW_mm / 2), y: 0, z: -(data.rafterW_mm / 2) },
      tr,
      joistMat,
      { roof: "apex", part: "king", trussIndex: i }
    );

    // Rafters as oriented boxes from eave points to ridge point (in truss plane, z=0)
    const ridgePt = { x: data.A_mm / 2, y: data.rise_mm, z: 0 };
    const leftEave = { x: 0, y: 0, z: 0 };
    const rightEave = { x: data.A_mm, y: 0, z: 0 };

    mkOrientedBoxAlongSegment(
      `roof-apex-truss-${i}-rafter-left`,
      data.rafterW_mm,
      data.rafterD_mm,
      leftEave,
      ridgePt,
      tr,
      joistMat,
      { roof: "apex", part: "rafter", side: "left", trussIndex: i }
    );
    mkOrientedBoxAlongSegment(
      `roof-apex-truss-${i}-rafter-right`,
      data.rafterW_mm,
      data.rafterD_mm,
      rightEave,
      ridgePt,
      tr,
      joistMat,
      { roof: "apex", part: "rafter", side: "right", trussIndex: i }
    );
  }

  // ---- OSB on both slopes (no-stagger tiling) ----
  // We tile per-slope using A/2 × B rectangles in "plan" space, then rotate each sheet about Z axis to slope.
  // This keeps the good properties: 1220×2440, no-stagger, and shortest-span invariant.
  const osbThk = 18;
  const angle = data.angle_rad;

  function mkOsbPiece(name, x0_mm, z0_mm, xLen_mm, zLen_mm, slopeSign) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: xLen_mm / 1000, height: osbThk / 1000, depth: zLen_mm / 1000 },
      scene
    );
    mesh.material = osbMat;
    mesh.metadata = { dynamic: true, roof: "apex", part: "osb" };
    mesh.parent = roofRoot;

    // Rotate around local Z to match slope plane in XY.
    mesh.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 0, 1), slopeSign * angle);

    // Place so its bottom rides above rafters roughly:
    // We position by its center in local XZ, and compute its Y at that center from slope line.
    const cx = x0_mm + xLen_mm / 2;
    const cz = z0_mm + zLen_mm / 2;

    // slope y at x for left slope (0..A/2): y = (rise/(A/2))*x
    // for right slope (A/2..A): let xr = (A - x), y = (rise/(A/2))*xr
    let yAtCenter = 0;
    if (slopeSign > 0) {
      // left slope rises toward +X
      yAtCenter = (data.rise_mm * (cx / (data.A_mm / 2)));
    } else {
      // right slope rises toward -X
      const xr = (data.A_mm - cx);
      yAtCenter = (data.rise_mm * (xr / (data.A_mm / 2)));
    }
    yAtCenter = clamp(yAtCenter, 0, data.rise_mm);

    // Set center Y = slope height + rafter depth + half OSB thickness
    const cy = yAtCenter + data.rafterD_mm + (osbThk / 2);

    mesh.position = new BABYLON.Vector3(cx / 1000, cy / 1000, cz / 1000);

    return mesh;
  }

  // Left slope tiles over x:[0..A/2], z:[0..B]
  for (let i = 0; i < data.osbLeft.all.length; i++) {
    const p = data.osbLeft.all[i];
    mkOsbPiece(
      `roof-apex-osb-left-${i}`,
      p.a0_mm,             // a along half-span
      p.b0_mm,             // b along B
      p.W_mm,              // width across half-span axis (A/2)
      p.L_mm,              // length along B
      +1
    );
  }

  // Right slope tiles over x:[A/2..A], z:[0..B] (offset x by A/2)
  for (let i = 0; i < data.osbRight.all.length; i++) {
    const p = data.osbRight.all[i];
    mkOsbPiece(
      `roof-apex-osb-right-${i}`,
      (data.A_mm / 2) + p.a0_mm,
      p.b0_mm,
      p.W_mm,
      p.L_mm,
      -1
    );
  }
}

function quatFromTo(from, to) {
  const f = from.normalize();
  const t = to.normalize();
  const dot = clamp(BABYLON.Vector3.Dot(f, t), -1, 1);

  if (dot > 0.999999) return BABYLON.Quaternion.Identity();
  if (dot < -0.999999) {
    // 180°: choose any orthogonal axis
    const ortho = Math.abs(f.x) < 0.9 ? new BABYLON.Vector3(1, 0, 0) : new BABYLON.Vector3(0, 0, 1);
    const axis = BABYLON.Vector3.Cross(f, ortho).normalize();
    return BABYLON.Quaternion.RotationAxis(axis, Math.PI);
  }

  const axis = BABYLON.Vector3.Cross(f, t);
  const s = Math.sqrt((1 + dot) * 2);
  const invS = 1 / s;
  return new BABYLON.Quaternion(axis.x * invS, axis.y * invS, axis.z * invS, s * 0.5);
}

// -----------------------------
// DATA: PENT (existing)
// -----------------------------
function computeRoofDataPent(state) {
  const dims = resolveDims(state);

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  const frameW = Math.max(1, Math.floor(Number(dims?.frame?.w_mm)));
  const frameD = Math.max(1, Math.floor(Number(dims?.frame?.d_mm)));

  const originX_mm = 0;
  const originZ_mm = 0;

  // Shortest-span rule:
  const A = Math.min(roofW, roofD);
  const B = Math.max(roofW, roofD);

  const isWShort = roofW <= roofD;

  const spacing = 600;

  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w)));
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d)));

  const rafterW_mm = baseD;
  const rafterD_mm = baseW;

  const rafterLen_mm = A;

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

  const osbAB = computeOsbPiecesNoStagger(A, B);

  const mappedAll = [];
  for (let i = 0; i < osbAB.all.length; i++) {
    const p2 = osbAB.all[i];
    if (isWShort) {
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

// -----------------------------
// DATA: APEX (NEW)
// -----------------------------
function computeRoofDataApex(state) {
  const dims = resolveDims(state);

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  const frameW = Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? state?.w ?? 1)));
  const frameD = Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? state?.d ?? 1)));

  const isWShort = roofW <= roofD;

  // A = shortest span, B = longest run
  const A = Math.min(roofW, roofD);
  const B = Math.max(roofW, roofD);

  const spacing = 600;

  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w)));
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d)));
  const rafterW_mm = baseD;
  const rafterD_mm = baseW;

  // Heights: use walls height as eave default; ridgeHeight_mm optional (no guessed constants)
  const eaveH_mm = Math.max(100, Math.floor(Number(state?.walls?.height_mm ?? 2400)));
  const ridgeH_mm = Math.max(100, Math.floor(Number(state?.roof?.apex?.ridgeHeight_mm ?? eaveH_mm)));

  const rise_mm = Math.max(0, ridgeH_mm - eaveH_mm);
  const halfSpan = A / 2;
  const angle = Math.atan2(rise_mm / 1000, Math.max(1e-6, halfSpan / 1000));
  const rafterLen = Math.max(1, Math.floor(Math.sqrt(halfSpan * halfSpan + rise_mm * rise_mm)));

  // Truss positions along B @600 (include both ends)
  const trussPos = [];
  const maxP = Math.max(0, B);
  let p = 0;
  while (p <= maxP) {
    trussPos.push(Math.floor(p));
    p += spacing;
  }
  if (trussPos.length) {
    const last = trussPos[trussPos.length - 1];
    if (Math.abs(last - maxP) > 0) trussPos.push(Math.floor(maxP));
  } else {
    trussPos.push(0);
  }
  const trusses = trussPos.map((b0) => ({ b0_mm: b0 }));

  // OSB per slope: tile (A/2 × B) in A/B space with the same no-stagger rule
  const osbLeft = computeOsbPiecesNoStagger(Math.max(1, Math.floor(A / 2)), B);
  const osbRight = computeOsbPiecesNoStagger(Math.max(1, Math.floor(A / 2)), B);

  // Flatten for BOM convenience
  const osbAll = [];
  for (let i = 0; i < osbLeft.all.length; i++) osbAll.push(osbLeft.all[i]);
  for (let i = 0; i < osbRight.all.length; i++) osbAll.push(osbRight.all[i]);

  return {
    roofW_mm: roofW,
    roofD_mm: roofD,
    frameW_mm: frameW,
    frameD_mm: frameD,
    isWShort: isWShort,
    A_mm: A,
    B_mm: B,
    rafterW_mm: rafterW_mm,
    rafterD_mm: rafterD_mm,
    eaveH_mm: eaveH_mm,
    ridgeH_mm: ridgeH_mm,
    rise_mm: rise_mm,
    angle_rad: angle,
    rafterLen_mm: rafterLen,
    trusses: trusses,
    osbLeft: osbLeft,
    osbRight: osbRight,
    osb: { all: osbAll },
  };
}

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

  for (let bi = 0; bi < bFull; bi++) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("std", ai * SHEET_A, bi * SHEET_B, SHEET_A, SHEET_B);
    }
  }

  if (aRem > 0 && bFull > 0) {
    for (let bi = 0; bi < bFull; bi++) {
      pushPiece("rip", aFull * SHEET_A, bi * SHEET_B, aRem, SHEET_B);
    }
  }

  if (bRem > 0 && aFull > 0) {
    for (let ai = 0; ai < aFull; ai++) {
      pushPiece("rip", ai * SHEET_A, bFull * SHEET_B, SHEET_A, bRem);
    }
  }

  if (aRem > 0 && bRem > 0) {
    pushPiece("rip", aFull * SHEET_A, bFull * SHEET_B, aRem, bRem);
  }

  let area = 0;
  for (let i = 0; i < all.length; i++) {
    area += Math.max(0, all[i].W_mm) * Math.max(0, all[i].L_mm);
  }

  return { all, totalArea_mm2: area };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}