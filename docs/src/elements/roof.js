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

  // ---- Remove any prior APEX cladding-trim hooks/cutters (order-independent rebuild safety) ----
  try {
    if (scene._apexCladdingTrimObserver) {
      scene.onNewMeshAddedObservable.remove(scene._apexCladdingTrimObserver);
      scene._apexCladdingTrimObserver = null;
    }
    if (scene._apexCladdingTrimCutter && !scene._apexCladdingTrimCutter.isDisposed()) {
      scene._apexCladdingTrimCutter.dispose(false, true);
    }
    scene._apexCladdingTrimCutter = null;
    scene._apexRoofUnderside = null;
  } catch (e) {}

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

  const roofParts = getRoofParts(state);

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

  // ---- NEW: slope (hypotenuse) correction so roof reaches high wall (pent only) ----
  // Keep the pitch angle consistent with current logic (rise/run over the frame span),
  // but extend the physical sloped span so its horizontal projection still matches plan.
  const rise_mm = Math.max(0, Math.floor((maxH_mm - minH_mm)));
  const slopeAlongWorldX = !!data.isWShort;
  const run_mm = Math.max(1, Math.floor(slopeAlongWorldX ? frameW_mm : frameD_mm));
  const slopeLen_mm = Math.max(1, Math.round(Math.sqrt(run_mm * run_mm + rise_mm * rise_mm)));
  const slopeScale = run_mm > 0 ? (slopeLen_mm / run_mm) : 1;

  const A_phys_mm = Math.max(1, Math.round(data.A_mm * slopeScale));
  // ---- END slope correction inputs ----

  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const rimBackA0_mm = Math.max(0, A_phys_mm - rimThkA_mm);

  function mapABtoLocalXZ(a0, b0, aLen, bLen, isWShort) {
    if (isWShort) return { x0: a0, z0: b0, lenX: aLen, lenZ: bLen }; // A->X, B->Z
    return { x0: b0, z0: a0, lenX: bLen, lenZ: aLen }; // A->Z, B->X
  }

  if (roofParts.structure) {
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
      const mapped = mapABtoLocalXZ(0, r.b0_mm, A_phys_mm, data.rafterW_mm, data.isWShort);

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
  }

  if (roofParts.osb) {
    // OSB (bottom on top of rafters)
    const osbBottomY_m_local = data.rafterD_mm / 1000;
    for (let i = 0; i < data.osb.all.length; i++) {
      const p = data.osb.all[i];

      let x0_mm = p.x0_mm;
      let z0_mm = p.z0_mm;
      let xLen_mm = p.xLen_mm;
      let zLen_mm = p.zLen_mm;

      // Scale only along the sloped span axis so plan projection remains unchanged after pitch
      if (data.isWShort) {
        x0_mm = Math.round(Number(x0_mm) * slopeScale);
        xLen_mm = Math.max(1, Math.round(Number(xLen_mm) * slopeScale));
      } else {
        z0_mm = Math.round(Number(z0_mm) * slopeScale);
        zLen_mm = Math.max(1, Math.round(Number(zLen_mm) * slopeScale));
      }

      mkBoxBottomLocal(
        `roof-osb-${i}`,
        xLen_mm,
        data.osbThickness_mm,
        zLen_mm,
        x0_mm,
        osbBottomY_m_local,
        z0_mm,
        roofRoot,
        osbMat,
        { roof: "pent", part: "osb", kind: p.kind }
      );
    }
  }

  // ---- Analytic alignment (no wall mesh queries) ----
  // Authoritative roof plan extents in world:
  // - Frame is at world X:[0..frameW], Z:[0..frameD]
  // - Roof should cover X:[-l..frameW+r], Z:[-f..frameD+b]
  const targetMinX_m = (-l_mm) / 1000;
  const targetMinZ_m = (-f_mm) / 1000;

  // Rotation:
  // - Pent slope follows the shortest plan dimension:
  //   - If roofW <= roofD: slope along WORLD +X (span width)
  //   - If roofW >  roofD: slope along WORLD +Z (span depth)
  const slopeAxisWorld = slopeAlongWorldX ? new BABYLON.Vector3(1, 0, 0) : new BABYLON.Vector3(0, 0, 1);
  const pitchAxisWorld = slopeAlongWorldX ? new BABYLON.Vector3(0, 0, 1) : new BABYLON.Vector3(1, 0, 0);

  // Source axis in roof local that represents A (rafter span axis):
  // data.isWShort => A maps to local X, else A maps to local Z
  const slopeAxisLocal = data.isWShort ? new BABYLON.Vector3(1, 0, 0) : new BABYLON.Vector3(0, 0, 1);

  // Yaw around Y to align slopeAxisLocal -> slopeAxisWorld
  const dotYaw = clamp((slopeAxisLocal.x * slopeAxisWorld.x + slopeAxisLocal.z * slopeAxisWorld.z), -1, 1);
  const crossYawY = (slopeAxisLocal.x * slopeAxisWorld.z - slopeAxisLocal.z * slopeAxisWorld.x);
  let yaw = (Math.acos(dotYaw)) * (crossYawY >= 0 ? 1 : -1);
  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // Pitch angle derived from analytic rise/run over the SHORT frame span
  const rise_m = (maxH_mm - minH_mm) / 1000;
  const run_m = Math.max(1e-6, (slopeAlongWorldX ? frameW_mm : frameD_mm) / 1000);
  const angle = Math.atan2(rise_m, run_m);
  const qPitch = BABYLON.Quaternion.RotationAxis(pitchAxisWorld, slopeAlongWorldX ? angle : -angle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);

  // Step 1: translate in X/Z so rotated roof's PLAN min corner lands on targetMinX/Z.
  // Compute 4 plan corners of the *roof rectangle* in local (0..roofW, 0..roofD).
  const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? data.roofW_mm ?? 1)));
  const roofD_mm = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? data.roofD_mm ?? 1)));

  let roofW_phys_mm = roofW_mm;
  let roofD_phys_mm = roofD_mm;
  if (slopeAlongWorldX) roofW_phys_mm = Math.max(1, Math.round(roofW_mm * slopeScale));
  else roofD_phys_mm = Math.max(1, Math.round(roofD_mm * slopeScale));

  const cornersLocal = [
    new BABYLON.Vector3(0 / 1000, 0, 0 / 1000),
    new BABYLON.Vector3(roofW_phys_mm / 1000, 0, 0 / 1000),
    new BABYLON.Vector3(0 / 1000, 0, roofD_phys_mm / 1000),
    new BABYLON.Vector3(roofW_phys_mm / 1000, 0, roofD_phys_mm / 1000),
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

  // Step 2: translate Y so the underside at the LOW edge hits minH,
  // and (by construction) the HIGH edge hits maxH.
  // Choose two analytic bearing sample points at mid of the other frame axis.
  let pLowLocal = null;
  let pHighLocal = null;

  if (slopeAlongWorldX) {
    const midFrameZ_mm = Math.floor(frameD_mm / 2);
    pLowLocal = new BABYLON.Vector3((Math.round((l_mm) * slopeScale)) / 1000, 0, (f_mm + midFrameZ_mm) / 1000);
    pHighLocal = new BABYLON.Vector3((Math.round((l_mm + frameW_mm) * slopeScale)) / 1000, 0, (f_mm + midFrameZ_mm) / 1000);
  } else {
    const midFrameX_mm = Math.floor(frameW_mm / 2);
    pLowLocal = new BABYLON.Vector3((l_mm + midFrameX_mm) / 1000, 0, (Math.round((f_mm) * slopeScale)) / 1000);
    pHighLocal = new BABYLON.Vector3((l_mm + midFrameX_mm) / 1000, 0, (Math.round((f_mm + frameD_mm) * slopeScale)) / 1000);
  }

  const worldLow = worldOfLocal(pLowLocal);
  if (worldLow) {
    const targetYLow_m = (minH_mm / 1000);
    roofRoot.position.y += (targetYLow_m - worldLow.y);
  } else {
    roofRoot.position.y = (minH_mm / 1000);
  }

  // Debug-only: report high-edge error after final placement
  let worldHigh = null;
  let highError_m = null;
  try {
    worldHigh = worldOfLocal(pHighLocal);
    if (worldHigh) {
      const targetYHigh_m = (maxH_mm / 1000);
      highError_m = targetYHigh_m - worldHigh.y;
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
    if (roofParts.structure && typeof window !== "undefined" && window.__dbg) {
      const lowW = worldOfLocal(pLowLocal);
      const highW = worldOfLocal(pHighLocal);

      window.__dbg.roofFit = {
        mode: "analytic-bearing-lines",
        frame: { w_mm: frameW_mm, d_mm: frameD_mm },
        overhang_mm: { l: l_mm, r: r_mm, f: f_mm, b: b_mm },
        heights_mm: { minH: minH_mm, maxH: maxH_mm },
        rise_m: rise_m,
        run_m: run_m,
        angle: angle,
        highError_mm: highError_m == null ? null : (highError_m * 1000),
        run_mm: run_mm,
        rise_mm: rise_mm,
        slopeLen_mm: slopeLen_mm
      };

      // Visualize analytic bearing samples
      if (lowW) mkDbgSphere("roof-dbg-bearing-low", lowW.x, lowW.y, lowW.z, true);
      if (highW) mkDbgSphere("roof-dbg-bearing-high", highW.x, highW.y, highW.z, false);
    }
  } catch (e) {}
}

function updateBOM_Pent(state, tbody) {
  if (!isPentEnabled(state)) {
    appendPlaceholderRow(tbody, "Roof not enabled.");
    return;
  }

  const data = computeRoofData_Pent(state);

  // ---- NEW: match buildPent() slope-stretch so BOM matches 3D geometry ----
  // buildPent() scales the physical sloped axis by slopeScale to preserve plan projection after pitching.
  const rise_mm = Math.max(0, Math.floor((data.maxH_mm - data.minH_mm)));
  const run_mm = Math.max(1, Math.floor(data.isWShort ? data.frameW_mm : data.frameD_mm));
  const slopeLen_mm = Math.max(1, Math.round(Math.sqrt(run_mm * run_mm + rise_mm * rise_mm)));
  const slopeScale = run_mm > 0 ? (slopeLen_mm / run_mm) : 1;

  const rafterLenPhys_mm = Math.max(1, Math.round(Number(data.rafterLen_mm || 0) * slopeScale));
  // ---- END slope-scale for BOM ----

  const rows = [];

  // Rim joists (2x) (run along B, not slope-stretched)
  rows.push({
    item: "Roof Rim Joist",
    qty: 2,
    L: data.isWShort ? data.roofD_mm : data.roofW_mm,
    W: data.rafterW_mm,
    notes: "D (mm): " + String(data.rafterD_mm),
  });

  // Rafters (physical length along sloped axis)
  rows.push({
    item: "Roof Rafter",
    qty: data.rafters.length,
    L: rafterLenPhys_mm,
    W: data.rafterW_mm,
    notes:
      "D (mm): " +
      String(data.rafterD_mm) +
      "; spacing @600mm; pent roof; slopeLen_mm=" +
      String(slopeLen_mm),
  });

  // OSB pieces (group identical cut sizes)
  // buildPent() scales ONLY the sloped axis (A), which corresponds to p.W_mm in our AB piece representation.
  const osbPieces = [];
  for (let i = 0; i < data.osb.all.length; i++) {
    const p = data.osb.all[i];
    const Wplan = Math.max(1, Math.floor(p.W_mm));
    const Lplan = Math.max(1, Math.floor(p.L_mm));

    osbPieces.push({
      L: Lplan,
      W: Math.max(1, Math.round(Wplan * slopeScale)),
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

  const g = getRoofFrameGauge(state);
  const baseW = Math.max(1, Math.floor(Number(g.thickness_mm)));
  const baseD = Math.max(1, Math.floor(Number(g.depth_mm)));

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

  const roofParts = getRoofParts(state);

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

  // Truss layout (fixed orientation):
  // A = span axis across WIDTH (world X), B = ridge/run axis along DEPTH (world Z)
  const A_mm = roofW_mm;
  const B_mm = roofD_mm;

  // --- APEX HEIGHT CONTROLS (ground-referenced, mm) ---
  // UI intent:
  // - "Height to Eaves"  => ground -> UNDERSIDE of eaves at the wall line (mm)
  // - "Height to Crest"  => ground -> HIGHEST roof point (top of OSB at ridge/crest) (mm)
  //
  // Deterministic correction:
  // - If crest < eaves, we clamp crest := eaves (prevents inverted roof).
  // - Additionally, because eaves is an UNDERSIDE reference and crest is a TOP reference,
  //   we enforce crest >= eaves + OSB_THK_MM. If violated, clamp crest := eaves + OSB_THK_MM.
  //
  // NOTE: If either control is missing/unset, we keep legacy behavior (rise derived from span).
  const OSB_THK_MM = 18;

  function _numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function _firstFinite(/*...vals*/) {
    for (let i = 0; i < arguments.length; i++) {
      const n = _numOrNull(arguments[i]);
      if (n != null) return n;
    }
    return null;
  }

  const apex = (state && state.roof && state.roof.apex) ? state.roof.apex : null;

  // Support a few likely key names without renaming state keys.
  const eavesCtl_mm = _firstFinite(
    apex && apex.eavesHeight_mm,
    apex && apex.heightToEaves_mm,
    apex && apex.eaves_mm,
    apex && apex.minHeight_mm,
    apex && apex.heightEaves_mm
  );

  const crestCtl_mm = _firstFinite(
    apex && apex.crestHeight_mm,
    apex && apex.heightToCrest_mm,
    apex && apex.crest_mm,
    apex && apex.maxHeight_mm,
    apex && apex.ridgeHeight_mm,
    apex && apex.heightCrest_mm
  );

  // Legacy rise (used when controls are absent)
  let rise_mm = clamp(Math.floor(A_mm * 0.20), 200, 900);

  // Resolved targets (used only when BOTH are present)
  let eavesTargetAbs_mm = null;
  let crestTargetAbs_mm = null;

  if (eavesCtl_mm != null && crestCtl_mm != null) {
    const e0 = Math.max(0, Math.floor(eavesCtl_mm));
    let c0 = Math.max(0, Math.floor(crestCtl_mm));

    // Clamp crest >= eaves (deterministic)
    if (c0 < e0) c0 = e0;

    // Enforce crest >= eaves + OSB thickness (top vs underside reference)
    if (c0 < (e0 + OSB_THK_MM)) c0 = (e0 + OSB_THK_MM);

    eavesTargetAbs_mm = e0;
    crestTargetAbs_mm = c0;

    // Solve rise so that:
    // (crestTop - eavesUnderside) == rise + cos(theta)*OSB_THK_MM,
    // where theta is the roof pitch angle and cos(theta) depends on rise and half-span.
    const halfSpan_mm = Math.max(1, Math.floor(A_mm / 2));
    const delta_mm = Math.max(0, Math.floor(crestTargetAbs_mm - eavesTargetAbs_mm));

    const solveRiseFromDelta = (delta, halfSpan, osbThk) => {
      // If delta is smaller than OSB thickness, the best we can do is a "flat" roof (rise ~ 0),
      // but crest is still a TOP reference and eaves is an UNDERSIDE reference.
      // We deterministically treat delta := max(delta, osbThk).
      const target = Math.max(osbThk, Math.floor(delta));

      // f(rise) = rise + cos(theta(rise))*osbThk, monotonic increasing in rise.
      const f = (r) => {
        const rr = Math.max(0, Number(r));
        const den = Math.sqrt(halfSpan * halfSpan + rr * rr);
        const cosT = den > 1e-6 ? (halfSpan / den) : 1;
        return rr + (cosT * osbThk);
      };

      // Binary search (deterministic) on [0 .. hi]
      let lo = 0;
      let hi = Math.max(target + 2000, 1); // generous upper bound; avoids accidental clipping
      for (let it = 0; it < 32; it++) {
        const mid = (lo + hi) / 2;
        if (f(mid) >= target) hi = mid;
        else lo = mid;
      }
      return Math.max(0, Math.floor(hi));
    };

    rise_mm = solveRiseFromDelta(delta_mm, halfSpan_mm, OSB_THK_MM);
  }
  // --- END APEX HEIGHT CONTROLS ---

  // Timber section (matches existing roof timber orientation policy: uses thickness/depth swapped)
  const g = getRoofFrameGauge(state);
  const baseW = Math.max(1, Math.floor(Number(g.thickness_mm)));
  const baseD = Math.max(1, Math.floor(Number(g.depth_mm)));
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

  // Truss spacing along B:
  // RULE: gable-end trusses must align flush with WALL frame ends (no overhang from trusses).
  // Overhang at gable ends is expressed by purlins/OSB spanning the full roof plan.
  //
  // Trusses are placed along the ridge axis (local Z), but their usable range is the FRAME ridge length,
  // offset inward from the roof plan by the overhang on the ridge-min side.
  //
  // - Legacy (default): @600 with last forced to maxP (prior behavior, but on FRAME ridge span)
  // - New (when state.roof.apex.trussCount >= 2): evenly spaced across FRAME ridge span incl. both ends
  const spacing = 600;
  const trussPos = [];

  const ridgeFrameLen_mm = frameD_mm;
  const ridgeStart_mm = f_mm;

  const minP = Math.max(0, Math.floor(ridgeStart_mm));
  const maxP = Math.max(minP, Math.floor(ridgeStart_mm + ridgeFrameLen_mm - memberW_mm));

  let desiredCount = null;
  try {
    desiredCount = state && state.roof && state.roof.apex && state.roof.apex.trussCount != null
      ? Math.floor(Number(state.roof.apex.trussCount))
      : null;
  } catch (e) { desiredCount = null; }

  if (Number.isFinite(desiredCount) && desiredCount >= 2) {
    const n = desiredCount;
    const denom = (n - 1);
    const span = Math.max(0, Math.floor(maxP - minP));

    for (let i = 0; i < n; i++) {
      let z0 = minP;
      if (i === 0) z0 = minP;
      else if (i === (n - 1)) z0 = maxP;
      else z0 = Math.round(minP + (span * i) / denom);

      trussPos.push(Math.max(minP, Math.min(maxP, Math.floor(z0))));
    }
  } else {
    let p = minP;
    while (p <= maxP) { trussPos.push(Math.floor(p)); p += spacing; }
    if (trussPos.length) {
      const last = trussPos[trussPos.length - 1];
      if (Math.abs(last - maxP) > 0) trussPos.push(Math.floor(maxP));
    } else {
      trussPos.push(minP);
    }
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

    // King post: single vertical strut from tie midpoint to apex; top cap has two planar faces matching slopeAng.
    {
      const bottomY_mm = memberD_mm; // top of tie beam (tie bottom at 0, height memberD_mm)
      const postH_mm = Math.max(1, Math.floor(rise_mm - bottomY_mm));

      const capH_mm = Math.max(20, Math.min(Math.floor(postH_mm * 0.35), Math.floor(memberW_mm * 0.9)));
      const bodyH_mm = Math.max(1, postH_mm - capH_mm);

      const post = BABYLON.MeshBuilder.CreateBox(
        `roof-truss-${idx}-kingpost`,
        { width: memberW_mm / 1000, height: bodyH_mm / 1000, depth: memberD_mm / 1000 },
        scene
      );

      post.position = new BABYLON.Vector3(
        halfSpan_mm / 1000,
        (bottomY_mm + (bodyH_mm / 2)) / 1000,
        (memberW_mm / 2) / 1000
      );

      post.material = joistMat;
      post.metadata = Object.assign({ dynamic: true }, { roof: "apex", part: "truss", member: "kingpost" });
      post.parent = tr;

      const halfRun_mm = Math.max(1, Math.round(capH_mm / Math.max(1e-6, Math.tan(slopeAng))));
      const cap = BABYLON.MeshBuilder.ExtrudeShape(
        `roof-truss-${idx}-kingpost-cap`,
        {
          shape: [
            new BABYLON.Vector3(-halfRun_mm / 1000, 0, 0),
            new BABYLON.Vector3(0, capH_mm / 1000, 0),
            new BABYLON.Vector3(halfRun_mm / 1000, 0, 0),
            new BABYLON.Vector3(-halfRun_mm / 1000, 0, 0)
          ],
          path: [
            new BABYLON.Vector3(0, 0, -memberW_mm / 2000),
            new BABYLON.Vector3(0, 0, memberW_mm / 2000)
          ],
          cap: BABYLON.Mesh.CAP_ALL
        },
        scene
      );

      cap.position = new BABYLON.Vector3(
        halfSpan_mm / 1000,
        (bottomY_mm + bodyH_mm) / 1000,
        (memberW_mm / 2) / 1000
      );

      cap.material = joistMat;
      cap.metadata = post.metadata;
      cap.parent = tr;
    }
  }

  if (roofParts.structure) {
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

    // Purlins (apex):
    // - Exactly TWO at the ridge zone (one per slope).
    // - Then continue down each slope at 609mm centres measured ALONG SLOPE.
    // - Bottom purlin aligns to the overhang-defined eaves edge (outer roof edge), and final gap never exceeds 609mm.
    // - Cross-section matches rafters (memberW_mm x memberD_mm).
    const PURLIN_STEP_MM = 609;
    const PURLIN_CLEAR_MM = 1;

    const sinT = Math.sin(slopeAng);
    const cosT = Math.cos(slopeAng);

    // Offset outward from the roof surface so purlins sit on top of rafters (no visible embedding).
    // When rotated about Z by slopeAng, local +Y points outward normal for each slope.
    const purlinOutOffset_mm = (memberD_mm / 2) + PURLIN_CLEAR_MM;

    function mkPurlin(side, idx, cx_mm, cy_mm) {
      const name = `roof-purlin-${side}-${idx}`;
      const m = mkBoxCenteredLocal(
        name,
        memberW_mm,
        memberD_mm,
        B_mm,
        cx_mm,
        cy_mm,
        B_mm / 2,
        roofRoot,
        joistMat,
        { roof: "apex", part: "purlin", side: side }
      );
      m.rotation = new BABYLON.Vector3(0, 0, side === "L" ? slopeAng : -slopeAng);
      return m;
    }

    // Compute slope-distance for the bottom-edge purlin using outer-edge alignment in X.
    // For a box rotated about Z, half-width projects to X by cosT; outward normal contributes X by ±sinT.
    // Left slope: outer edge at x=0. Right slope: outer edge at x=A_mm.
    const xSurfBottomL_mm = Math.max(
      0,
      Math.min(
        halfSpan_mm,
        Math.round((memberW_mm / 2) * cosT + (sinT * purlinOutOffset_mm))
      )
    );
    const runBottom_mm = Math.max(0, Math.round(halfSpan_mm - xSurfBottomL_mm));
    const sBottom_mm = cosT > 1e-6 ? (runBottom_mm / cosT) : rafterLen_mm;

    // Generate slope stations: start at ridge (0), step 609, and ALWAYS include bottom station.
    const sList = [0];
    let sNext = PURLIN_STEP_MM;
    while (sNext < sBottom_mm) {
      sList.push(Math.round(sNext));
      sNext += PURLIN_STEP_MM;
    }
    const sBottomRounded = Math.round(sBottom_mm);
    if (sList[sList.length - 1] !== sBottomRounded) sList.push(sBottomRounded);

    for (let i = 0; i < sList.length; i++) {
      const s_mm = Math.max(0, Math.floor(Number(sList[i] || 0)));

      // Clamp within usable slope length
      const run_mm = Math.min(halfSpan_mm, Math.max(0, Math.round(s_mm * cosT)));
      const drop_mm = Math.min(rise_mm, Math.max(0, Math.round(s_mm * sinT)));

      // Roof surface (top of tie baseline at memberD_mm) in local XY:
      const ySurf_mm = memberD_mm + (rise_mm - drop_mm);

      // LEFT slope purlin
      {
        const xSurf_mm = Math.max(0, Math.min(halfSpan_mm, Math.round(halfSpan_mm - run_mm)));
        const cx_mm = xSurf_mm + (-sinT) * purlinOutOffset_mm;
        const cy_mm = ySurf_mm + (cosT) * purlinOutOffset_mm;
        mkPurlin("L", i, cx_mm, cy_mm);
      }

      // RIGHT slope purlin
      {
        const xSurf_mm = Math.max(halfSpan_mm, Math.min(A_mm, Math.round(halfSpan_mm + run_mm)));
        const cx_mm = xSurf_mm + (sinT) * purlinOutOffset_mm;
        const cy_mm = ySurf_mm + (cosT) * purlinOutOffset_mm;
        mkPurlin("R", i, cx_mm, cy_mm);
      }
    }
  }

  if (roofParts.osb) {
    // Simple sheathing as two sloped OSB "panels" (visual)
    // Panel thickness = 18mm, depth = B, length along slope = rafterLen
    // IMPORTANT: panels are offset to the OTHER SIDE of the purlins (outside of the roof plane).
    const osbThk = OSB_THK_MM;

    // Place OSB so its UNDERSIDE sits on the OUTER face of the purlins (plus tiny clearance),
    // measured along the same roof-normal direction used by purlins.
    const OSB_CLEAR_MM = 1;

    // For a slope angle theta, a unit normal (pointing "outwards") in local XY:
    // left slope (+theta): n = (-sin(theta), +cos(theta))
    // right slope (-theta): n = (+sin(theta), +cos(theta))
    const sinT = Math.sin(slopeAng);
    const cosT = Math.cos(slopeAng);

    // Mid-slope sample on the roof plane used by purlins (top of tie baseline at memberD_mm).
    const sMid_mm = rafterLen_mm / 2;
    const runMid_mm = Math.round(sMid_mm * cosT);
    const dropMid_mm = Math.round(sMid_mm * sinT);
    const ySurfMid_mm = memberD_mm + (rise_mm - dropMid_mm);

    // Offset from roof plane -> purlin outer face -> OSB center
    const osbOutOffset_mm = memberD_mm + OSB_CLEAR_MM + (osbThk / 2);

    {
      // Left panel: center aligned to mid-slope surface point, then pushed outward above purlins
      const xSurf_mm = (halfSpan_mm - runMid_mm);
      const cx = xSurf_mm + (-sinT) * osbOutOffset_mm;
      const cy = ySurfMid_mm + (cosT) * osbOutOffset_mm;

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
      // Right panel: center aligned to mid-slope surface point, then pushed outward above purlins
      const xSurf_mm = (halfSpan_mm + runMid_mm);
      const cx = xSurf_mm + (sinT) * osbOutOffset_mm;
      const cy = ySurfMid_mm + (cosT) * osbOutOffset_mm;

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
  }

  // ---- Placement in world: align plan min corner to [-l,-f], then lift to wall height ----
  const targetMinX_m = (-l_mm) / 1000;
  const targetMinZ_m = (-f_mm) / 1000;

  // Fixed apex orientation: ridge axis is world Z (no yaw).
  const yaw = 0;
  roofRoot.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);

  // Corners of local roof rectangle (0..localW, 0..localD) in LOCAL XZ:
  // Our constructed roof rectangle is A x B in local XZ.
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

  // APEX height positioning:
  // - If Height-to-Eaves + Height-to-Crest are provided, we position the roof in world-Y so that the
  //   OSB UNDERSIDE at the wall line lands exactly on Height-to-Eaves (ground-referenced, mm).
  // - Otherwise, keep legacy behavior: roof sits on top of the walls (roofRoot.y = wallH).
  if (Number.isFinite(eavesTargetAbs_mm) && Number.isFinite(crestTargetAbs_mm)) {
    // The roof plane used by purlins/OSB has baseline y = memberD_mm at the wall line (tie top).
    // OSB underside sits outward along the roof normal by (memberD_mm + OSB_CLEAR_MM).
    const OSB_CLEAR_MM = 1;

    const halfSpan_mm = Math.max(1, Math.floor(A_mm / 2));
    const den = Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm);
    const cosT = den > 1e-6 ? (halfSpan_mm / den) : 1;

    // Local Y of OSB underside at the wall line (before roofRoot world translation)
    const eavesUnderLocalY_mm = memberD_mm + cosT * (memberD_mm + OSB_CLEAR_MM);

    // Solve roofRoot world-Y so that:
    // roofRootY + eavesUnderLocalY == eavesTargetAbs
    roofRoot.position.y = (Number(eavesTargetAbs_mm) - eavesUnderLocalY_mm) / 1000;
  } else {
    roofRoot.position.y = wallH_mm / 1000;
  }

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
        ridgeAlongWorldX: false,
        osbOffset_mm: (memberD_mm / 2) + (18 / 2)
      };
    }
  } catch (e) {}

  // ---- APEX ONLY: deterministically trim wall cladding to roof UNDERSIDE (no roof geometry edits) ----
  // Uses analytic underside planes (function of X only) + CSG subtract (no rendering hacks).
  try {
    installApexCladdingTrim(scene, roofRoot, {
      A_mm: A_mm,
      B_mm: B_mm,
      rise_mm: rise_mm,
      memberD_mm: memberD_mm
    });
  } catch (e) {}
}

function updateBOM_Apex(state, tbody) {
  const dims = resolveDims(state);

  const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? state?.w ?? 1)));
  const roofD_mm = Math.max(1, Math.floor(Number(dims?.roof?.d_mm ?? state?.d ?? 1)));

  const A_mm = roofW_mm;
  const B_mm = roofD_mm;

  const g = getRoofFrameGauge(state);
  const baseW = Math.max(1, Math.floor(Number(g.thickness_mm)));
  const baseD = Math.max(1, Math.floor(Number(g.depth_mm)));
  const memberW_mm = baseD;
  const memberD_mm = baseW;

  const rise_mm = clamp(Math.floor(A_mm * 0.20), 200, 900);
  const halfSpan_mm = A_mm / 2;
  const rafterLen_mm = Math.round(Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm));

  // Truss quantity must match 3D logic:
  // - If trussCount >= 2 => use that exact count
  // - Else => fallback to legacy @600 spacing logic (but on FRAME ridge span, not roof overhang span)
  let desiredCount = null;
  try {
    desiredCount = state && state.roof && state.roof.apex && state.roof.apex.trussCount != null
      ? Math.floor(Number(state.roof.apex.trussCount))
      : null;
  } catch (e) { desiredCount = null; }

  let trussQty = null;

  if (Number.isFinite(desiredCount) && desiredCount >= 2) {
    trussQty = desiredCount;
  } else {
    const frameW_mm = Math.max(1, Math.floor(Number(dims?.frame?.w_mm ?? roofW_mm)));
    const frameD_mm = Math.max(1, Math.floor(Number(dims?.frame?.d_mm ?? roofD_mm)));

    const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
    const l_mm = Math.max(0, Math.floor(Number(ovh.l_mm || 0)));
    const r_mm = Math.max(0, Math.floor(Number(ovh.r_mm || 0)));
    const f_mm = Math.max(0, Math.floor(Number(ovh.f_mm || 0)));
    const b_mm = Math.max(0, Math.floor(Number(ovh.b_mm || 0)));

    const ridgeFrameLen_mm = frameD_mm;
    const ridgeStart_mm = f_mm;

    const spacing = 600;
    const pos = [];

    const minP = Math.max(0, Math.floor(ridgeStart_mm));
    const maxP = Math.max(minP, Math.floor(ridgeStart_mm + ridgeFrameLen_mm - memberW_mm));

    let p = minP;
    while (p <= maxP) { pos.push(Math.floor(p)); p += spacing; }
    if (pos.length) {
      const last = pos[pos.length - 1];
      if (Math.abs(last - maxP) > 0) pos.push(Math.floor(maxP));
    } else {
      pos.push(minP);
    }

    trussQty = pos.length;
  }

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

  // Purlin quantity must match buildApex():
  // - stations along slope: start at ridge (0), step 609mm along slope, always include bottom station
  // - TWO purlins per station (L + R)
  const slopeAng = Math.atan2(rise_mm, halfSpan_mm);
  const sinT = Math.sin(slopeAng);
  const cosT = Math.cos(slopeAng);

  const PURLIN_STEP_MM = 609;
  const PURLIN_CLEAR_MM = 1;
  const purlinOutOffset_mm = (memberD_mm / 2) + PURLIN_CLEAR_MM;

  const xSurfBottomL_mm = Math.max(
    0,
    Math.min(
      halfSpan_mm,
      Math.round((memberW_mm / 2) * cosT + (sinT * purlinOutOffset_mm))
    )
  );
  const runBottom_mm = Math.max(0, Math.round(halfSpan_mm - xSurfBottomL_mm));
  const sBottom_mm = cosT > 1e-6 ? (runBottom_mm / cosT) : rafterLen_mm;

  const sList = [0];
  let sNext = PURLIN_STEP_MM;
  while (sNext < sBottom_mm) {
    sList.push(Math.round(sNext));
    sNext += PURLIN_STEP_MM;
  }
  const sBottomRounded = Math.round(sBottom_mm);
  if (sList[sList.length - 1] !== sBottomRounded) sList.push(sBottomRounded);

  const purlinQty = 2 * sList.length;

  rows.push({
    item: "Purlin",
    qty: purlinQty,
    L: B_mm,
    W: memberW_mm,
    notes: "D (mm): " + String(memberD_mm) + "; stations=" + String(sList.length) + "; step=609mm",
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

function getRoofFrameGauge(state) {
  var cfgW = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.w : 50));
  var cfgD = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.d : 100));

  var t = null;
  var d = null;

  try {
    t = (state && state.frame && state.frame.thickness_mm != null) ? Math.floor(Number(state.frame.thickness_mm)) : null;
  } catch (e0) { t = null; }

  try {
    d = (state && state.frame && state.frame.depth_mm != null) ? Math.floor(Number(state.frame.depth_mm)) : null;
  } catch (e1) { d = null; }

  var thickness_mm = (Number.isFinite(t) && t > 0) ? t : ((Number.isFinite(cfgW) && cfgW > 0) ? cfgW : 50);
  var depth_mm = (Number.isFinite(d) && d > 0) ? d : ((Number.isFinite(cfgD) && cfgD > 0) ? cfgD : 100);

  return { thickness_mm: thickness_mm, depth_mm: depth_mm };
}

function getRoofParts(state) {
  var vis = state && state.vis ? state.vis : null;
  var rp = vis && vis.roofParts && typeof vis.roofParts === "object" ? vis.roofParts : null;
  return {
    structure: rp ? (rp.structure !== false) : true,
    osb: rp ? (rp.osb !== false) : true,
    covering: rp ? (rp.covering !== false) : true
  };
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* ------------------------------ APEX: cladding trim (CSG) ------------------------------ */

function installApexCladdingTrim(scene, roofRoot, params) {
  if (!scene || !roofRoot || !params) return;
  if (typeof BABYLON === "undefined" || !BABYLON.CSG) return;

  const A_mm = Math.max(1, Math.floor(Number(params.A_mm || 1)));
  const B_mm = Math.max(1, Math.floor(Number(params.B_mm || 1)));
  const rise_mm = Math.max(0, Math.floor(Number(params.rise_mm || 0)));
  const memberD_mm = Math.max(1, Math.floor(Number(params.memberD_mm || 1)));

  const halfSpan_mm = Math.max(1, Math.floor(A_mm / 2));
  const den = Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm);
  const cosT = den > 1e-6 ? (halfSpan_mm / den) : 1;
  const tanT = halfSpan_mm > 1e-6 ? (rise_mm / halfSpan_mm) : 0;
  const slopeAng = Math.atan2(rise_mm, halfSpan_mm);
  const sinT = Math.sin(slopeAng);

  // IMPORTANT: match buildApex() OSB underside reference used in placement logic.
  // OSB underside plane is offset from the tie-top roof plane along the roof normal.
  const OSB_CLEAR_MM = 1;
  const dNormal_mm = memberD_mm + OSB_CLEAR_MM;
  const offsetAlongY_atFixedX_mm = dNormal_mm / Math.max(1e-6, cosT);

  function yUnderLocal_mm(xLocal_mm) {
    const x = Math.max(0, Math.min(A_mm, Number(xLocal_mm)));
    if (x <= halfSpan_mm) return memberD_mm + tanT * x + offsetAlongY_atFixedX_mm;
    return memberD_mm + tanT * (A_mm - x) + offsetAlongY_atFixedX_mm;
  }

  function yUnderWorld_mm(xWorld_mm) {
    const xLocal_mm = (Number(xWorld_mm) / 1) - (roofRoot.position.x * 1000);
    return (roofRoot.position.y * 1000) + yUnderLocal_mm(xLocal_mm);
  }

  scene._apexRoofUnderside = {
    roof: "apex",
    A_mm,
    B_mm,
    rise_mm,
    memberD_mm,
    osbClear_mm: OSB_CLEAR_MM,
    yUnderAtXWorld_mm: yUnderWorld_mm
  };

  // Build one reusable cutter representing ALL space above the roof underside (union of both slopes).
  const cutter = buildApexUndersideCutter(scene, roofRoot, {
    A_mm,
    B_mm,
    slopeAng,
    sinT,
    cosT,
    yUnderLocal_mm
  });

  scene._apexCladdingTrimCutter = cutter;

  // Trim any existing cladding meshes now (in case walls were built before roof).
  const meshes = (scene.meshes || []).slice();
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    if (!m || m.isDisposed()) continue;
    if (!isLikelyWallCladdingMesh(m)) continue;
    if (m.metadata && m.metadata.trimmedToRoofApex === true) continue;
    trimMeshByApexCutter(scene, m, cutter);
  }

  // Order-independent: trim future cladding meshes as they are created.
  scene._apexCladdingTrimObserver = scene.onNewMeshAddedObservable.add((m) => {
    try {
      if (!m || m.isDisposed()) return;
      if (!isLikelyWallCladdingMesh(m)) return;
      if (m.metadata && m.metadata.trimmedToRoofApex === true) return;
      if (!scene._apexCladdingTrimCutter || scene._apexCladdingTrimCutter.isDisposed()) return;
      trimMeshByApexCutter(scene, m, scene._apexCladdingTrimCutter);
    } catch (e) {}
  });
}

function isLikelyWallCladdingMesh(mesh) {
  try {
    const nm = String(mesh && mesh.name ? mesh.name : "");
    if (!nm) return false;
    if (nm.startsWith("roof-")) return false;
    const md = mesh.metadata && typeof mesh.metadata === "object" ? mesh.metadata : null;

    // Conservative defaults: adjust once you confirm the repo’s real cladding tags.
    const mdHit =
      !!(md && (md.part === "cladding" || md.kind === "cladding" || md.element === "cladding" || md.isCladding === true));
    const nameHit =
      nm.includes("cladding") || nm.includes("clad") || nm.includes("wall-cladding") || nm.startsWith("cladding-");

    if (!(mdHit || nameHit)) return false;

    // CSG needs real geometry (skip instances/empties).
    if (typeof mesh.getTotalVertices === "function" && mesh.getTotalVertices() <= 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function buildApexUndersideCutter(scene, roofRoot, p) {
  const A_mm = Math.max(1, Math.floor(Number(p.A_mm || 1)));
  const B_mm = Math.max(1, Math.floor(Number(p.B_mm || 1)));
  const slopeAng = Number(p.slopeAng || 0);
  const sinT = Number(p.sinT || 0);
  const cosT = Number(p.cosT || 1);
  const yUnderLocal_mm = typeof p.yUnderLocal_mm === "function" ? p.yUnderLocal_mm : (() => 0);

  // Oversize cutter so it fully covers any cladding extents (walls + gable triangles).
  const PAD_MM = 4000;
  const W_mm = A_mm + PAD_MM;
  const D_mm = B_mm + PAD_MM;
  const H_mm = Math.max(6000, Math.floor((yUnderLocal_mm(A_mm / 2) + 4000)));

  const mk = (name, rotZ, nx, ny, anchorX_mm) => {
    const box = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: W_mm / 1000, height: H_mm / 1000, depth: D_mm / 1000 },
      scene
    );
    box.rotation = new BABYLON.Vector3(0, 0, rotZ);
    box.isVisible = false;
    box.setEnabled(false);
    box.metadata = { dynamic: true, roof: "apex", part: "cladding-cutter" };

    // Anchor point on underside plane at mid-ridge (z=B/2). Use eaves x for each slope.
    const yAnchor_mm = yUnderLocal_mm(anchorX_mm);
    const pLocal = new BABYLON.Vector3(anchorX_mm / 1000, yAnchor_mm / 1000, (B_mm / 2) / 1000);

    // Move box center so its "bottom" face sits on the plane and it extends outward (above plane).
    const n = new BABYLON.Vector3(nx, ny, 0); // unit normal
    const center = pLocal.add(n.scale((H_mm / 2) / 1000));

    box.position = new BABYLON.Vector3(
      roofRoot.position.x + center.x,
      roofRoot.position.y + center.y,
      roofRoot.position.z + center.z
    );

    return box;
  };

  // Left slope normal after +slopeAng rotation: (-sinT, +cosT)
  const left = mk("roof-apex-cutter-L", slopeAng, -sinT, cosT, 0);
  // Right slope normal after -slopeAng rotation: (+sinT, +cosT)
  const right = mk("roof-apex-cutter-R", -slopeAng, sinT, cosT, A_mm);

  const csg = BABYLON.CSG.FromMesh(left).union(BABYLON.CSG.FromMesh(right));
  const cutter = csg.toMesh("roof-apex-cladding-cutter", null, scene, true);
  cutter.isVisible = false;
  cutter.setEnabled(false);
  cutter.metadata = { dynamic: true, roof: "apex", part: "cladding-cutter" };

  try { left.dispose(false, true); } catch (e) {}
  try { right.dispose(false, true); } catch (e) {}

  return cutter;
}

function trimMeshByApexCutter(scene, mesh, cutter) {
  if (!scene || !mesh || !cutter) return;
  if (mesh.isDisposed() || cutter.isDisposed()) return;
  if (!BABYLON.CSG) return;

  // If your cladding is parented and expected to follow parent transforms, tell me;
  // we’ll switch to a parent-space trim. For now, we avoid silently breaking parenting.
  if (mesh.parent) return;

  let src = null;
  try {
    src = mesh.clone(mesh.name + "__trimSrc", null, false, true);
  } catch (e) {
    src = null;
  }
  if (!src) return;

  src.isVisible = false;
  src.setEnabled(false);

  try {
    src.bakeCurrentTransformIntoVertices();
    src.position = new BABYLON.Vector3(0, 0, 0);
    src.rotation = new BABYLON.Vector3(0, 0, 0);
    src.scaling = new BABYLON.Vector3(1, 1, 1);
    src.rotationQuaternion = null;
  } catch (e) {}

  let out = null;
  try {
    const res = BABYLON.CSG.FromMesh(src).subtract(BABYLON.CSG.FromMesh(cutter));
    out = res.toMesh(mesh.name, mesh.material || null, scene, true);
  } catch (e) {
    out = null;
  }

  try { src.dispose(false, true); } catch (e) {}
  if (!out) return;

  out.material = mesh.material || null;
  out.metadata = Object.assign({}, (mesh.metadata || {}), { trimmedToRoofApex: true });
  out.isVisible = mesh.isVisible;
  out.setEnabled(mesh.isEnabled());
  out.renderingGroupId = mesh.renderingGroupId;

  try { mesh.dispose(false, true); } catch (e) {}
}
