// FILE: docs/src/elements/roof.js
/**
 * Roof:
 * - PENT: existing logic unchanged.
 * - APEX: adds gable roof with repeated trusses + ridge + purlins + simple sheathing.
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

  const style = String(state && state.roof && state.roof.style ? state.roof.style : "apex");

  if (style === "pent") {
    buildPent(state, ctx);
    return;
  }

  if (style === "apex") {
    buildApex(state, ctx);
    return;
  }

  // Unsupported styles: do nothing.
}

export function updateBOM(state) {
  const tbody = document.getElementById("roofBomTable");
  if (!tbody) return;

  tbody.innerHTML = "";

  const style = String(state && state.roof && state.roof.style ? state.roof.style : "apex");

  if (style === "pent") {
    updateBOM_Pent(state, tbody);
    return;
  }

  if (style === "apex") {
    updateBOM_Apex(state, tbody);
    return;
  }

  appendPlaceholderRow(tbody, "Roof not enabled.");
}

/* ----------------------------- PENT (existing) ----------------------------- */

function buildPent(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;
  if (!isPentEnabled(state)) return;

  const data = computeRoofData_Pent(state);
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
  // - So the roof's "span axis" (A axis) must align to WORLD +X.
  const slopeAxisWorld = new BABYLON.Vector3(1, 0, 0);
  const pitchAxisWorld = new BABYLON.Vector3(0, 0, 1); // rotate about Z to raise +X end

  // Source axis in roof local that represents A (rafter span axis):
  // data.isWShort => A maps to local X, else A maps to local Z
  const slopeAxisLocal = data.isWShort ? new BABYLON.Vector3(1, 0, 0) : new BABYLON.Vector3(0, 0, 1);

  // Yaw around Y to align slopeAxisLocal -> +X
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

function updateBOM_Pent(state, tbody) {
  if (!isPentEnabled(state)) {
    appendPlaceholderRow(tbody, "Roof not enabled.");
    return;
  }

  const data = computeRoofData_Pent(state);

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

function computeRoofData_Pent(state) {
  const dims = resolveDims(state);

  const roofW = Math.max(1, Math.floor(Number(dims?.roof?.w_mm)));
  const roofD = Math.max(1, Math.floor(Number(dims?.roof?.d_mm)));

  const frameW = Math.max(1, Math.floor(Number(dims?.frame?.w_mm)));
  const frameD = Math.max(1, Math.floor(Number(dims?.frame?.d_mm)));

  const originX_mm = 0;
  const originZ_mm = 0;

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

/* ------------------------------ APEX (new) ------------------------------ */

function buildApex(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  const dims = resolveDims(state);

  const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
  const l_mm = Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
  const r_mm = Math.max(0, Math.floor(Number(ovh.r_mm || 0)));
  const f_mm = Math.max(0, Math.floor(Number(ovh.f_mm || 0)));
  const b_mm = Math.max(0, Math.floor(Number(ovh.b_mm || 0)));

  const frameW_mm = Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? state?.w ?? 1)));
  const frameD_mm = Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? state?.d ?? 1)));

  // Roof plan (outer) in mm
  const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? frameW_mm)));
  const roofD_mm = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? frameD_mm)));

  // Truss layout (rotation-invariant):
  // A = span axis (shorter of roofW/roofD), B = ridge/run axis (longer)
  const A_mm = Math.min(roofW_mm, roofD_mm);
  const B_mm = Math.max(roofW_mm, roofD_mm);

  // Ridge runs along B. If width is the long axis, ridge should run along world X; otherwise along world Z.
  const ridgeAlongWorldX = frameW_mm >= frameD_mm;

  // Rise: deterministic from span (no new UI constants). Only affects apex style.
  const rise_mm = clamp(Math.floor(A_mm * 0.20), 200, 900);

  // Timber section (matches existing roof timber orientation policy: uses CONFIG.timber.w / CONFIG.timber.d swapped)
  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w)));
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d)));
  const memberW_mm = baseD; // width in plan
  const memberD_mm = baseW; // vertical depth

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

  function mkBoxCenteredLocal(name, Lx_mm, Ly_mm, Lz_mm, cx_mm, cy_mm, cz_mm, parentNode, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx_mm / 1000, height: Ly_mm / 1000, depth: Lz_mm / 1000 },
      scene
    );
    mesh.position = new BABYLON.Vector3(cx_mm / 1000, cy_mm / 1000, cz_mm / 1000);
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  // Root at identity in local coords:
  // local X = span axis A, local Z = ridge axis B, local Y up.
  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.metadata = { dynamic: true };
  roofRoot.position = new BABYLON.Vector3(0, 0, 0);
  roofRoot.rotationQuaternion = BABYLON.Quaternion.Identity();

  // Truss spacing along B @600 (matches project roof policy)
  const spacing = 600;
  const trussPos = [];
  const maxP = Math.max(0, B_mm - memberW_mm);
  let p = 0;
  while (p <= maxP) { trussPos.push(Math.floor(p)); p += spacing; }
  if (trussPos.length) {
    const last = trussPos[trussPos.length - 1];
    if (Math.abs(last - maxP) > 0) trussPos.push(Math.floor(maxP));
  } else {
    trussPos.push(0);
  }

  // Geometry helpers for sloped rafters in local X-Y plane (depth extrudes along Z by memberW)
  const halfSpan_mm = A_mm / 2;
  const rafterLen_mm = Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm);
  const slopeAng = Math.atan2(rise_mm, halfSpan_mm);

  function buildTruss(idx, z0_mm) {
    const tr = new BABYLON.TransformNode(`roof-truss-${idx}`, scene);
    tr.metadata = { dynamic: true };
    tr.parent = roofRoot;
    tr.position = new BABYLON.Vector3(0, 0, z0_mm / 1000);

    // Bottom chord (tie) along span at y=0
    mkBoxBottomLocal(
      `roof-truss-${idx}-tie`,
      A_mm,
      memberD_mm,
      memberW_mm,
      0,
      0,
      0,
      tr,
      joistMat,
      { roof: "apex", part: "truss", member: "tie" }
    );

    // Left rafter: from x=0,y=0 up to ridge at x=halfSpan,y=rise
    {
      const cx = halfSpan_mm / 2;
      const cy = rise_mm / 2 + memberD_mm / 2;
      const r = mkBoxCenteredLocal(
        `roof-truss-${idx}-rafter-L`,
        rafterLen_mm,
        memberD_mm,
        memberW_mm,
        cx,
        cy,
        memberW_mm / 2,
        tr,
        joistMat,
        { roof: "apex", part: "truss", member: "rafterL" }
      );
      r.rotation = new BABYLON.Vector3(0, 0, slopeAng);
    }

    // Right rafter: mirrored about center
    {
      const cx = halfSpan_mm + (halfSpan_mm / 2);
      const cy = rise_mm / 2 + memberD_mm / 2;
      const r = mkBoxCenteredLocal(
        `roof-truss-${idx}-rafter-R`,
        rafterLen_mm,
        memberD_mm,
        memberW_mm,
        cx,
        cy,
        memberW_mm / 2,
        tr,
        joistMat,
        { roof: "apex", part: "truss", member: "rafterR" }
      );
      r.rotation = new BABYLON.Vector3(0, 0, -slopeAng);
    }

    // Simple web(s) for visual truss (non-structural; deterministic)
    {
      const webH = Math.max(1, Math.floor(rise_mm * 0.55));
      const webLen = Math.sqrt((halfSpan_mm / 2) * (halfSpan_mm / 2) + (webH) * (webH));
      const webAng = Math.atan2(webH, (halfSpan_mm / 2));

      const cx = halfSpan_mm / 2;
      const cy = webH / 2 + memberD_mm / 2;

      const w = mkBoxCenteredLocal(
        `roof-truss-${idx}-web-1`,
        webLen,
        memberD_mm,
        memberW_mm,
        cx,
        cy,
        memberW_mm / 2,
        tr,
        joistMat,
        { roof: "apex", part: "truss", member: "web" }
      );
      w.rotation = new BABYLON.Vector3(0, 0, webAng);
    }
  }

  for (let i = 0; i < trussPos.length; i++) buildTruss(i, trussPos[i]);

  // Ridge beam along B at (x=A/2, y=rise)
  mkBoxBottomLocal(
    "roof-ridge",
    memberW_mm,
    memberD_mm,
    B_mm,
    Math.max(0, Math.floor(halfSpan_mm - memberW_mm / 2)),
    rise_mm / 1000,
    0,
    roofRoot,
    joistMat,
    { roof: "apex", part: "ridge" }
  );

  // Two purlins along B (one each slope) at ~half rise
  const purlY_mm = Math.floor(rise_mm * 0.5);
  const purlX1_mm = Math.max(0, Math.floor(A_mm * 0.25 - memberW_mm / 2));
  const purlX2_mm = Math.max(0, Math.floor(A_mm * 0.75 - memberW_mm / 2));

  mkBoxBottomLocal(
    "roof-purlin-L",
    memberW_mm,
    memberD_mm,
    B_mm,
    purlX1_mm,
    purlY_mm / 1000,
    0,
    roofRoot,
    joistMat,
    { roof: "apex", part: "purlin", side: "L" }
  );
  mkBoxBottomLocal(
    "roof-purlin-R",
    memberW_mm,
    memberD_mm,
    B_mm,
    purlX2_mm,
    purlY_mm / 1000,
    0,
    roofRoot,
    joistMat,
    { roof: "apex", part: "purlin", side: "R" }
  );

  // Simple sheathing as two sloped OSB "panels" (visual)
  // Panel thickness = 18mm, depth = B, length along slope = rafterLen
  const osbThk = 18;
  {
    const cx = halfSpan_mm / 2;
    const cy = rise_mm / 2 + osbThk / 2;
    const left = mkBoxCenteredLocal(
      "roof-apex-osb-L",
      rafterLen_mm,
      osbThk,
      B_mm,
      cx,
      cy,
      B_mm / 2,
      roofRoot,
      osbMat,
      { roof: "apex", part: "osb", side: "L" }
    );
    left.rotation = new BABYLON.Vector3(0, 0, slopeAng);
  }
  {
    const cx = halfSpan_mm + (halfSpan_mm / 2);
    const cy = rise_mm / 2 + osbThk / 2;
    const right = mkBoxCenteredLocal(
      "roof-apex-osb-R",
      rafterLen_mm,
      osbThk,
      B_mm,
      cx,
      cy,
      B_mm / 2,
      roofRoot,
      osbMat,
      { roof: "apex", part: "osb", side: "R" }
    );
    right.rotation = new BABYLON.Vector3(0, 0, -slopeAng);
  }

  // ---- Placement in world: align plan min corner to [-l,-f], then lift to wall height ----
  const targetMinX_m = (-l_mm) / 1000;
  const targetMinZ_m = (-f_mm) / 1000;

  // Yaw so local Z (ridge axis) aligns to world X when width is long, else to world Z.
  // local basis: X=span(A), Z=ridge(B)
  const yaw = ridgeAlongWorldX ? (Math.PI / 2) : 0;
  roofRoot.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // Corners of local roof rectangle (0..roofW, 0..roofD) in LOCAL XZ:
  // Our constructed roof rectangle is A x B in local XZ, but roofW/roofD may be swapped depending on which is short.
  const localW_mm = A_mm;
  const localD_mm = B_mm;

  const cornersLocal = [
    new BABYLON.Vector3(0, 0, 0),
    new BABYLON.Vector3(localW_mm / 1000, 0, 0),
    new BABYLON.Vector3(0, 0, localD_mm / 1000),
    new BABYLON.Vector3(localW_mm / 1000, 0, localD_mm / 1000),
  ];

  function worldOfLocal(pLocal) {
    try {
      const wm = roofRoot.getWorldMatrix();
      return BABYLON.Vector3.TransformCoordinates(pLocal, wm);
    } catch (e) {
      return null;
    }
  }

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

  const wallH_mm = Math.max(100, Math.floor(Number(state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400)));
  roofRoot.position.y = wallH_mm / 1000;

  // ---- Debug ----
  try {
    if (typeof window !== "undefined" && window.__dbg) {
      window.__dbg.roofFit = {
        mode: "apex-gable",
        frame: { w_mm: frameW_mm, d_mm: frameD_mm },
        overhang_mm: { l: l_mm, r: r_mm, f: f_mm, b: b_mm },
        spanA_mm: A_mm,
        runB_mm: B_mm,
        rise_mm: rise_mm,
        ridgeAlongWorldX: ridgeAlongWorldX,
      };
    }
  } catch (e) {}
}

function updateBOM_Apex(state, tbody) {
  const dims = resolveDims(state);

  const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? state?.w ?? 1)));
  const roofD_mm = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? state?.d ?? 1)));

  const A_mm = Math.min(roofW_mm, roofD_mm);
  const B_mm = Math.max(roofW_mm, roofD_mm);

  const baseW = Math.max(1, Math.floor(Number(CONFIG.timber.w)));
  const baseD = Math.max(1, Math.floor(Number(CONFIG.timber.d)));
  const memberW_mm = baseD;
  const memberD_mm = baseW;

  const rise_mm = clamp(Math.floor(A_mm * 0.20), 200, 900);
  const halfSpan_mm = A_mm / 2;
  const rafterLen_mm = Math.round(Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm));

  // Truss count @600 along B
  const spacing = 600;
  const pos = [];
  const maxP = Math.max(0, B_mm - memberW_mm);
  let p = 0;
  while (p <= maxP) { pos.push(Math.floor(p)); p += spacing; }
  if (pos.length) {
    const last = pos[pos.length - 1];
    if (Math.abs(last - maxP) > 0) pos.push(Math.floor(maxP));
  } else {
    pos.push(0);
  }
  const trussQty = pos.length;

  const rows = [];

  rows.push({
    item: "Roof Truss (assembly)",
    qty: trussQty,
    L: B_mm,
    W: A_mm,
    notes: "apex; spacing @600mm; rise_mm=" + String(rise_mm),
  });

  rows.push({
    item: "Truss Tie (bottom chord)",
    qty: trussQty,
    L: A_mm,
    W: memberW_mm,
    notes: "D (mm): " + String(memberD_mm),
  });

  rows.push({
    item: "Truss Rafter",
    qty: trussQty * 2,
    L: rafterLen_mm,
    W: memberW_mm,
    notes: "D (mm): " + String(memberD_mm),
  });

  rows.push({
    item: "Ridge Beam",
    qty: 1,
    L: B_mm,
    W: memberW_mm,
    notes: "D (mm): " + String(memberD_mm),
  });

  rows.push({
    item: "Purlin",
    qty: 2,
    L: B_mm,
    W: memberW_mm,
    notes: "D (mm): " + String(memberD_mm),
  });

  rows.push({
    item: "Roof OSB (visual panels)",
    qty: 2,
    L: rafterLen_mm,
    W: B_mm,
    notes: "18mm OSB; one per slope (visual)",
  });

  rows.sort((a, b) => String(a.item).localeCompare(String(b.item)));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    appendRow5(tbody, [r.item, String(r.qty), String(r.L), String(r.W), r.notes || ""]);
  }

  if (!rows.length) appendPlaceholderRow(tbody, "Roof cutting list not yet generated.");
}

/* ------------------------------ Shared helpers ------------------------------ */

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
