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

  // Truss layout (rotation-invariant):
  // A = span axis (shorter of roofW/roofD), B = ridge/run axis (longer)
  const A_mm = Math.min(roofW_mm, roofD_mm);
  const B_mm = Math.max(roofW_mm, roofD_mm);

  // Ridge runs along B. If ROOF width is the long axis (incl. overhang), ridge should run along world X; otherwise along world Z.
  const ridgeAlongWorldX = roofW_mm >= roofD_mm;

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

  const ridgeFrameLen_mm = ridgeAlongWorldX ? frameW_mm : frameD_mm;
  const ridgeStart_mm = ridgeAlongWorldX ? l_mm : f_mm;

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

  // Yaw so local Z (ridge axis) aligns to world X when width is long, else to world Z.
  // local basis: X=span(A), Z=ridge(B)
  const yaw = ridgeAlongWorldX ? (Math.PI / 2) : 0;
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
        ridgeAlongWorldX: ridgeAlongWorldX,
        osbOffset_mm: (memberD_mm / 2) + (18 / 2)
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

    const ridgeAlongWorldX = roofW_mm >= roofD_mm;
    const ridgeFrameLen_mm = ridgeAlongWorldX ? frameW_mm : frameD_mm;
    const ridgeStart_mm = ridgeAlongWorldX ? l_mm : f_mm;

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
}import { initInstancesUI } from "./instances.js";

function $(id) { return document.getElementById(id); }
function setDisplay(el, val) { if (el && el.style) el.style.display = val; }
function setAriaHidden(el, hidden) { if (el) el.setAttribute("aria-hidden", String(!!hidden)); }

var WALL_OVERHANG_MM = 25;
var WALL_RISE_MM = 168;

function shiftWallMeshes(scene, dx_mm, dy_mm, dz_mm) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("wall-") !== 0) continue;
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  }
}

function shiftRoofMeshes(scene, dx_mm, dy_mm, dz_mm) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("roof-") !== 0) continue;
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  }
}

function ensureRequiredDomScaffolding() {
  function ensureEl(tag, id, parent) {
    var el = $(id);
    if (el) return el;
    el = document.createElement(tag);
    el.id = id;
    (parent || document.body).appendChild(el);
    return el;
  }

  // Ensure core view containers exist so view switching + BOM rendering does not crash.
  var bomPage = $("bomPage") || ensureEl("div", "bomPage", document.body);
  var wallsPage = $("wallsBomPage") || ensureEl("div", "wallsBomPage", document.body);
  var roofPage = $("roofBomPage") || ensureEl("div", "roofBomPage", document.body);

  // Make sure they start hidden (view system will show/hide).
  if (bomPage && bomPage.style && bomPage.style.display === "") bomPage.style.display = "none";
  if (wallsPage && wallsPage.style && wallsPage.style.display === "") wallsPage.style.display = "none";
  if (roofPage && roofPage.style && roofPage.style.display === "") roofPage.style.display = "none";

  // Walls cutting list table (renderBOM targets #bomTable)
  if (!$("bomTable")) {
    var t = document.createElement("table");
    t.id = "bomTable";
    var tb = document.createElement("tbody");
    t.appendChild(tb);
    wallsPage.appendChild(t);
  }

  // Base cutting list common targets (Base module writes into these IDs)
  if (!$("timberTableBody")) {
    var timberTable = document.createElement("table");
    timberTable.id = "timberTable";
    var thead1 = document.createElement("thead");
    var trh1 = document.createElement("tr");
    trh1.innerHTML = "<th>Item</th><th>Qty</th><th>L</th><th>W</th><th>D</th><th>Notes</th>";
    thead1.appendChild(trh1);
    timberTable.appendChild(thead1);
    var tbody1 = document.createElement("tbody");
    tbody1.id = "timberTableBody";
    timberTable.appendChild(tbody1);
    bomPage.appendChild(timberTable);
  }
  if (!$("timberTotals")) {
    var tt = document.createElement("div");
    tt.id = "timberTotals";
    bomPage.appendChild(tt);
  }
  if (!$("osbStdBody")) {
    var osbStd = document.createElement("table");
    osbStd.id = "osbStdTable";
    var tbody2 = document.createElement("tbody");
    tbody2.id = "osbStdBody";
    osbStd.appendChild(tbody2);
    bomPage.appendChild(osbStd);
  }
  if (!$("osbRipBody")) {
    var osbRip = document.createElement("table");
    osbRip.id = "osbRipTable";
    var tbody3 = document.createElement("tbody");
    tbody3.id = "osbRipBody";
    osbRip.appendChild(tbody3);
    bomPage.appendChild(osbRip);
  }
  if (!$("pirBody")) {
    var pir = document.createElement("table");
    pir.id = "pirTable";
    var tbody4 = document.createElement("tbody");
    tbody4.id = "pirBody";
    pir.appendChild(tbody4);
    bomPage.appendChild(pir);
  }
  if (!$("gridBody")) {
    var grid = document.createElement("table");
    grid.id = "gridTable";
    var tbody5 = document.createElement("tbody");
    tbody5.id = "gridBody";
    grid.appendChild(tbody5);
    bomPage.appendChild(grid);
  }

  // Roof cutting list target (roof module renders into #roofBomTable if present)
  if (!$("roofBomTable")) {
    var roofTable = document.createElement("table");
    roofTable.id = "roofBomTable";
    var roofTbody = document.createElement("tbody");
    roofTable.appendChild(roofTbody);
    roofPage.appendChild(roofTable);
  }
}

function initApp() {
  try {
    ensureRequiredDomScaffolding();

    var canvas = $("renderCanvas");
    var statusOverlayEl = $("statusOverlay");

    if (!canvas) {
      window.__dbg.lastError = "renderCanvas not found";
      return;
    }

    var ctx = null;
    try {
      ctx = boot(canvas);
    } catch (e) {
      window.__dbg.lastError = "boot(canvas) failed: " + String(e && e.message ? e.message : e);
      return;
    }

    window.__dbg.engine = (ctx && ctx.engine) ? ctx.engine : null;
    window.__dbg.scene = (ctx && ctx.scene) ? ctx.scene : null;
    window.__dbg.camera = (ctx && ctx.camera) ? ctx.camera : null;

    try {
      var eng = window.__dbg.engine;
      if (eng && eng.onEndFrameObservable && typeof eng.onEndFrameObservable.add === "function") {
        eng.onEndFrameObservable.add(function () { window.__dbg.frames += 1; });
      }
    } catch (e) {}

    var store = createStateStore(DEFAULTS);

    var vWallsEl = $("vWalls");
    var vRoofEl = $("vRoof");
    var vRoofStructureEl = $("vRoofStructure");
    var vRoofOsbEl = $("vRoofOsb");
    var vBaseAllEl = $("vBaseAll");
    var vBaseEl = $("vBase");
    var vFrameEl = $("vFrame");
    var vInsEl = $("vIns");
    var vDeckEl = $("vDeck");
    var vCladdingEl = $("vCladding");

    var vWallFrontEl = $("vWallFront");
    var vWallBackEl = $("vWallBack");
    var vWallLeftEl = $("vWallLeft");
    var vWallRightEl = $("vWallRight");

    var dimModeEl = $("dimMode");
    var wInputEl = $("wInput");
    var dInputEl = $("dInput");

    var roofStyleEl = $("roofStyle");

    var roofMinHeightEl = $("roofMinHeight");
    var roofMaxHeightEl = $("roofMaxHeight");

    // Apex roof absolute heights (mm). IDs may vary across UI versions; accept common fallbacks.
    // These map to state.roof.apex.heightToEaves_mm / heightToCrest_mm (see wiring below).
    var roofApexEavesHeightEl =
      $("roofApexEavesHeight") || $("roofHeightToEaves") || $("roofEavesHeight") || $("apexEavesHeight") || $("apexHeightToEaves") || $("roofApexHeightToEaves");
    var roofApexCrestHeightEl =
      $("roofApexCrestHeight") || $("roofHeightToCrest") || $("roofCrestHeight") || $("apexCrestHeight") || $("apexHeightToCrest") || $("roofApexHeightToCrest");

    // Apex roof: truss count + spacing readout (mm only)
    var roofApexTrussCountEl = $("roofApexTrussCount");
    var roofApexTrussSpacingEl = $("roofApexTrussSpacing");

    var overUniformEl = $("roofOverUniform");
    var overFrontEl = $("roofOverFront");
    var overBackEl = $("roofOverBack");
    var overLeftEl = $("roofOverLeft");
    var overRightEl = $("roofOverRight");

    var wallSectionEl = $("wallSection"); // NEW
    var wallsVariantEl = $("wallsVariant");
    var wallHeightEl = $("wallHeight");

    var addDoorBtnEl = $("addDoorBtn");
    var removeAllDoorsBtnEl = $("removeAllDoorsBtn");
    var doorsListEl = $("doorsList");

    var addWindowBtnEl = $("addWindowBtn");
    var removeAllWindowsBtnEl = $("removeAllWindowsBtn");
    var windowsListEl = $("windowsList");

    var instanceSelectEl = $("instanceSelect");
    var saveInstanceBtnEl = $("saveInstanceBtn");
    var loadInstanceBtnEl = $("loadInstanceBtn");
    var instanceNameInputEl = $("instanceNameInput");
    var saveAsInstanceBtnEl = $("saveAsInstanceBtn");
    var deleteInstanceBtnEl = $("deleteInstanceBtn");
    var instancesHintEl = $("instancesHint");

    function applyWallHeightUiLock(state) {
      if (!wallHeightEl) return;

      var style = "";
      try {
        style = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "";
      } catch (e0) { style = ""; }
      if (!style && roofStyleEl) style = String(roofStyleEl.value || "");

      if (style === "pent") {
        wallHeightEl.disabled = true;
        wallHeightEl.setAttribute("aria-disabled", "true");
        wallHeightEl.title = "Disabled for pent roof (use Roof Min/Max Height).";
      } else {
        wallHeightEl.disabled = false;
        try { wallHeightEl.removeAttribute("aria-disabled"); } catch (e1) {}
        try { wallHeightEl.removeAttribute("title"); } catch (e2) {}
      }
    }

    var asPosInt = function (v, def) {
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? n : def;
    };
    var asNonNegInt = function (v, def) {
      if (def === undefined) def = 0;
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    var asNullableInt = function (v) {
      if (v == null || v === "") return null;
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

    // Apex trusses: run length + deterministic spacing (must match roof.js placement basis)
    function apexMemberW_mm() {
      // Must match docs/src/elements/roof.js apex: memberW_mm = CONFIG.timber.d
      var mw = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.d : 100));
      return (Number.isFinite(mw) && mw > 0) ? mw : 100;
    }

    function getApexTrussCountFromState(state) {
      var n = null;
      try { n = state && state.roof && state.roof.apex && state.roof.apex.trussCount != null ? Math.floor(Number(state.roof.apex.trussCount)) : null; } catch (e) { n = null; }
      return (Number.isFinite(n) && n >= 2) ? n : null;
    }

    function computeLegacyApexTrussCount(state) {
      // Mirrors roof.js apex truss position generation (spacing=600, last forced to maxP), but on FRAME ridge span.
      var spacing = 600;
      var R = resolveDims(state || {});

      var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(Number(R.roof.w_mm))) : 1;
      var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(Number(R.roof.d_mm))) : 1;

      var frameW = (R && R.frame && R.frame.w_mm != null) ? Math.max(1, Math.floor(Number(R.frame.w_mm))) : 1;
      var frameD = (R && R.frame && R.frame.d_mm != null) ? Math.max(1, Math.floor(Number(R.frame.d_mm))) : 1;

      var ovh = (R && R.overhang) ? R.overhang : null;
      var l_mm = (ovh && ovh.l_mm != null) ? Math.max(0, Math.floor(Number(ovh.l_mm))) : 0;
      var f_mm = (ovh && ovh.f_mm != null) ? Math.max(0, Math.floor(Number(ovh.f_mm))) : 0;

      var ridgeAlongWorldX = (roofW >= roofD);
      var ridgeFrameLen_mm = ridgeAlongWorldX ? frameW : frameD;
      var ridgeStart_mm = ridgeAlongWorldX ? l_mm : f_mm;

      var memberW = apexMemberW_mm();

      var minP = Math.max(0, Math.floor(ridgeStart_mm));
      var maxP = Math.max(minP, Math.floor(ridgeStart_mm + ridgeFrameLen_mm - memberW));

      var pos = [];
      var p = minP;
      while (p <= maxP) { pos.push(Math.floor(p)); p += spacing; }
      if (pos.length) {
        var last = pos[pos.length - 1];
        if (Math.abs(last - maxP) > 0) pos.push(Math.floor(maxP));
      } else {
        pos.push(minP);
      }

      // Count includes both gable ends.
      var n = pos.length;
      return (Number.isFinite(n) && n >= 2) ? n : 2;
    }

    function getApexTrussRunMm(state) {
      // Must match roof.js apex run basis used for left-edge z0_mm placement: run = ridgeFrameLen_mm - memberW_mm
      var R = resolveDims(state || {});

      var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(Number(R.roof.w_mm))) : 1;
      var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(Number(R.roof.d_mm))) : 1;

      var frameW = (R && R.frame && R.frame.w_mm != null) ? Math.max(1, Math.floor(Number(R.frame.w_mm))) : 1;
      var frameD = (R && R.frame && R.frame.d_mm != null) ? Math.max(1, Math.floor(Number(R.frame.d_mm))) : 1;

      var ridgeAlongWorldX = (roofW >= roofD);
      var ridgeFrameLen_mm = ridgeAlongWorldX ? frameW : frameD;

      var memberW = apexMemberW_mm();
      return Math.max(0, Math.floor(ridgeFrameLen_mm - memberW));
    }

    function computeApexTrussSpacingText(state) {
      var style = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "apex";
      if (style !== "apex") return "—";

      var n = getApexTrussCountFromState(state);
      if (n == null) n = computeLegacyApexTrussCount(state);

      var run_mm = getApexTrussRunMm(state);
      var denom = (n - 1);
      if (denom <= 0) return "—";

      var spacing = run_mm / denom;
      if (!isFinite(spacing)) return "—";

      return String(Math.round(spacing));
    }

    // Ensure deterministic default truss count (so UI + geometry have a stable baseline).
    try {
      var sInitApex = store.getState();
      var hasApexCount = !!(sInitApex && sInitApex.roof && sInitApex.roof.apex && sInitApex.roof.apex.trussCount != null);
      if (!hasApexCount) {
        store.setState({ roof: { apex: { trussCount: computeLegacyApexTrussCount(sInitApex) } } });
      }
    } catch (eInitApex) {}

    // Ensure cladding toggle has a deterministic default (matches current checkbox if state missing).
    try {
      var sInitClad = store.getState();
      var hasClad = !!(sInitClad && sInitClad.vis && typeof sInitClad.vis.cladding === "boolean");
      if (!hasClad && vCladdingEl) {
        store.setState({ vis: { cladding: !!vCladdingEl.checked } });
      }
    } catch (eInitClad) {}

    function getWallsEnabled(state) {
      var vis = state && state.vis ? state.vis : null;
      if (vis && typeof vis.walls === "boolean") return vis.walls;
      if (vis && typeof vis.wallsEnabled === "boolean") return vis.wallsEnabled;
      return true;
    }

    function getRoofEnabled(state) { return (state && state.vis && typeof state.vis.roof === "boolean") ? state.vis.roof : true; }
    function getBaseEnabled(state) { return (state && state.vis && typeof state.vis.baseAll === "boolean") ? state.vis.baseAll : true; }
    function getCladdingEnabled(state) { return (state && state.vis && typeof state.vis.cladding === "boolean") ? state.vis.cladding : true; }

    function applyCladdingVisibility(scene, on) {
      if (!scene || !scene.meshes) return;

      var visible = (on !== false);

      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;

        var nm = String(m.name || "");
        var isClad = (nm.indexOf("clad-") === 0) || (m.metadata && m.metadata.cladding === true);
        if (!isClad) continue;

        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    function getWallParts(state) {
      var vis = state && state.vis ? state.vis : null;

      if (vis && vis.walls && typeof vis.walls === "object") {
        return {
          front: vis.walls.front !== false,
          back: vis.walls.back !== false,
          left: vis.walls.left !== false,
          right: vis.walls.right !== false
        };
      }

      if (vis && vis.wallsParts && typeof vis.wallsParts === "object") {
        return {
          front: vis.wallsParts.front !== false,
          back: vis.wallsParts.back !== false,
          left: vis.wallsParts.left !== false,
          right: vis.wallsParts.right !== false
        };
      }

      return { front: true, back: true, left: true, right: true };
    }

    function resume3D() {
      var engine = window.__dbg.engine;
      var camera = window.__dbg.camera;

      setDisplay(canvas, "block");
      setAriaHidden(canvas, false);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, true);

      try { if (engine && typeof engine.resize === "function") engine.resize(); } catch (e) {}
      try { if (camera && typeof camera.attachControl === "function") camera.attachControl(canvas, true); } catch (e) {}
    }

    function showWallsBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "block");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, false);
      setAriaHidden(roofPage, true);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    function showBaseBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "block");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, false);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, true);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    function showRoofBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "block");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, false);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    // ---- NEW: deterministic view snapping helpers (camera + framing) ----
    function getActiveSceneCamera() {
      var scene = window.__dbg && window.__dbg.scene ? window.__dbg.scene : null;
      var camera = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      return { scene: scene, camera: camera };
    }

    function isFiniteVec3(v) {
      return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
    }

    function computeModelBoundsWorld(scene) {
      var BAB = window.BABYLON;
      if (!scene || !BAB) return null;

      var min = new BAB.Vector3(+Infinity, +Infinity, +Infinity);
      var max = new BAB.Vector3(-Infinity, -Infinity, -Infinity);
      var any = false;

      var meshes = scene.meshes || [];
      for (var i = 0; i < meshes.length; i++) {
        var m = meshes[i];
        if (!m) continue;
        if (m.isDisposed && m.isDisposed()) continue;
        if (m.isVisible === false) continue;

        var nm = String(m.name || "");
        var isModel =
          (m.metadata && m.metadata.dynamic === true) ||
          nm.indexOf("wall-") === 0 || nm.indexOf("roof-") === 0 || nm.indexOf("base-") === 0 || nm.indexOf("clad-") === 0;
        if (!isModel) continue;

        try { m.computeWorldMatrix(true); } catch (e0) {}

        var bi = null;
        try { bi = (typeof m.getBoundingInfo === "function") ? m.getBoundingInfo() : null; } catch (e1) { bi = null; }
        if (!bi || !bi.boundingBox) continue;

        var bb = bi.boundingBox;
        var mi = bb.minimumWorld, ma = bb.maximumWorld;
        if (!isFiniteVec3(mi) || !isFiniteVec3(ma)) continue;

        any = true;
        min.x = Math.min(min.x, mi.x); min.y = Math.min(min.y, mi.y); min.z = Math.min(min.z, mi.z);
        max.x = Math.max(max.x, ma.x); max.y = Math.max(max.y, ma.y); max.z = Math.max(max.z, ma.z);
      }

      if (!any) return null;

      var center = min.add(max).scale(0.5);
      var ext = max.subtract(min).scale(0.5);
      return { min: min, max: max, center: center, extents: ext };
    }

    function setOrthoForView(camera, viewName, bounds) {
      var BAB = window.BABYLON;
      if (!BAB || !camera || !bounds) return;

      try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e0) {}

      var ext = bounds.extents;
      var margin = 1.10;

      var halfW = 1, halfH = 1;

      if (viewName === "plan") {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.z));
      } else if (viewName === "front" || viewName === "back") {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.y));
      } else if (viewName === "left" || viewName === "right") {
        halfW = Math.max(0.01, Math.abs(ext.z));
        halfH = Math.max(0.01, Math.abs(ext.y));
      } else {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.y));
      }

      halfW *= margin;
      halfH *= margin;

      try {
        camera.orthoLeft = -halfW;
        camera.orthoRight = +halfW;
        camera.orthoBottom = -halfH;
        camera.orthoTop = +halfH;
      } catch (e1) {}
    }

    function setArcRotateOrientation(camera, viewName) {
      var PI = Math.PI;

      var alpha = camera.alpha != null ? camera.alpha : 0;
      var beta = camera.beta != null ? camera.beta : (PI / 2);

      if (viewName === "plan") {
        beta = 0.0001;
        alpha = PI / 2;
      } else if (viewName === "front") {
        beta = PI / 2;
        alpha = PI / 2;
      } else if (viewName === "back") {
        beta = PI / 2;
        alpha = -PI / 2;
      } else if (viewName === "right") {
        beta = PI / 2;
        alpha = 0;
      } else if (viewName === "left") {
        beta = PI / 2;
        alpha = PI;
      }

      try { camera.alpha = alpha; } catch (e0) {}
      try { camera.beta = beta; } catch (e1) {}
    }

    function frameCameraToBounds(camera, bounds, viewName) {
      var BAB = window.BABYLON;
      if (!BAB || !camera || !bounds) return;

      var c = bounds.center;

      try {
        if (typeof camera.setTarget === "function") camera.setTarget(c);
        else if (camera.target) camera.target = c;
      } catch (e0) {}

      var ext = bounds.extents;
      var maxDim = Math.max(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
      var safeR = Math.max(0.5, maxDim * 4.0);

      try { if (camera.radius != null) camera.radius = safeR; } catch (e1) {}

      setOrthoForView(camera, viewName, bounds);

      try {
        if (camera.minZ != null) camera.minZ = 0.01;
        if (camera.maxZ != null) camera.maxZ = Math.max(100, safeR * 50);
      } catch (e2) {}
    }

    function snapCameraToView(viewName) {
      var BAB = window.BABYLON;
      var sc = getActiveSceneCamera();
      var scene = sc.scene;
      var camera = sc.camera;

      if (!BAB || !scene || !camera) return false;

      var bounds = computeModelBoundsWorld(scene);
      if (!bounds) return false;

      var isArcRotate = (camera.alpha != null && camera.beta != null && camera.radius != null);

      try {
        if (isArcRotate) {
          setArcRotateOrientation(camera, viewName);
          frameCameraToBounds(camera, bounds, viewName);
        } else {
          var c = bounds.center;
          var ext = bounds.extents;
          var maxDim = Math.max(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
          var dist = Math.max(0.5, maxDim * 4.0);

          var pos = null;
          if (viewName === "plan") pos = new BAB.Vector3(c.x, c.y + dist, c.z);
          else if (viewName === "front") pos = new BAB.Vector3(c.x, c.y, c.z + dist);
          else if (viewName === "back") pos = new BAB.Vector3(c.x, c.y, c.z - dist);
          else if (viewName === "right") pos = new BAB.Vector3(c.x + dist, c.y, c.z);
          else if (viewName === "left") pos = new BAB.Vector3(c.x - dist, c.y, c.z);

          if (pos) {
            try { camera.position = pos; } catch (e0) {}
            try { if (typeof camera.setTarget === "function") camera.setTarget(c); } catch (e1) {}
          }

          try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e2) {}
          setOrthoForView(camera, viewName, bounds);
        }

        try { window.__dbg.viewSnap.last = { view: viewName, t: Date.now() }; } catch (e3) {}

        return true;
      } catch (e) {
        window.__dbg.lastError = "snapCameraToView failed: " + String(e && e.message ? e.message : e);
        return false;
      }
    }
    // ---- END view snapping helpers ----

    // Expose hooks for views.js (no dependency/import changes).
    window.__viewHooks = {
      resume3D: resume3D,
      showWallsBOM: showWallsBOM,
      showBaseBOM: showBaseBOM,
      showRoofBOM: showRoofBOM,

      // NEW: camera snap API for views.js
      getActiveSceneCamera: getActiveSceneCamera,
      snapCameraToView: snapCameraToView
    };

    function getWallOuterDimsFromState(state) {
      var R = resolveDims(state);
      var w = Math.max(1, Math.floor(R.base.w_mm + (2 * WALL_OVERHANG_MM)));
      var d = Math.max(1, Math.floor(R.base.d_mm + (2 * WALL_OVERHANG_MM)));
      return { w_mm: w, d_mm: d };
    }

    function currentWallThicknessFromState(state) {
      var v = (state && state.walls && state.walls.variant) ? String(state.walls.variant) : "insulated";
      var sec = (state && state.walls && state.walls[v] && state.walls[v].section) ? state.walls[v].section : null;
      var h = sec && sec.h != null ? Math.floor(Number(sec.h)) : (v === "basic" ? 75 : 100);
      return (Number.isFinite(h) && h > 0) ? h : (v === "basic" ? 75 : 100);
    }

    function currentStudWFromState(state) {
      var v = (state && state.walls && state.walls.variant) ? String(state.walls.variant) : "insulated";
      var sec = (state && state.walls && state.walls[v] && state.walls[v].section) ? state.walls[v].section : null;
      var w = sec && sec.w != null ? Math.floor(Number(sec.w)) : 50;
      return (Number.isFinite(w) && w > 0) ? w : 50;
    }

    function currentPlateYFromState(state) {
      return currentStudWFromState(state);
    }

    function currentStudLenFromState(state) {
      var plateY = currentPlateYFromState(state);
      var H = state && state.walls && state.walls.height_mm != null ? Math.max(100, Math.floor(Number(state.walls.height_mm))) : 2400;
      return Math.max(1, H - 2 * plateY);
    }

    function getWallLengthsForOpenings(state) {
      var dims = getWallOuterDimsFromState(state);
      var thk = currentWallThicknessFromState(state);
      return {
        front: Math.max(1, Math.floor(dims.w_mm)),
        back: Math.max(1, Math.floor(dims.w_mm)),
        left: Math.max(1, Math.floor(dims.d_mm - 2 * thk)),
        right: Math.max(1, Math.floor(dims.d_mm - 2 * thk)),
        _thk: thk
      };
    }

    function safeDispose() {
      try {
        try { disposeAll(ctx); return; } catch (e) {}
        try { disposeAll(ctx && ctx.scene ? ctx.scene : null); return; } catch (e) {}
        try { disposeAll(); } catch (e) {}
      } catch (e) {}
    }

    function isPentRoofStyle(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      return roofStyle === "pent";
    }

    function isApexRoofStyle(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      return roofStyle === "apex";
    }

    function clampHeightMm(v, def) {
      var n = Math.max(100, Math.floor(Number(v)));
      return Number.isFinite(n) ? n : def;
    }

    // Read apex absolute height fields with backwards-compatible key fallbacks.
    // NOTE: Geometry/derived wall height is handled in params.js / roof.js; this is UI/state wiring only.
    function getApexHeightsFromState(state) {
      var a = (state && state.roof && state.roof.apex) ? state.roof.apex : null;

      function pick(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (obj && obj[k] != null) {
            var n = Math.floor(Number(obj[k]));
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
        return null;
      }

      var eaves = pick(a, ["heightToEaves_mm", "eavesHeight_mm", "eaves_mm", "heightEaves_mm"]);
      var crest = pick(a, ["heightToCrest_mm", "crestHeight_mm", "crest_mm", "heightCrest_mm"]);

      return { eaves: eaves, crest: crest };
    }

    function getPentMinMax(state) {
      var base = (state && state.walls && state.walls.height_mm != null) ? clampHeightMm(state.walls.height_mm, 2400) : 2400;
      var p = (state && state.roof && state.roof.pent) ? state.roof.pent : null;
      var minH = clampHeightMm(p && p.minHeight_mm != null ? p.minHeight_mm : base, base);
      var maxH = clampHeightMm(p && p.maxHeight_mm != null ? p.maxHeight_mm : base, base);
      return { minH: minH, maxH: maxH };
    }

    function computePentDisplayHeight(state) {
      var mm = getPentMinMax(state);
      var mid = Math.round((mm.minH + mm.maxH) / 2);
      return Math.max(100, mid);
    }

    function getPentHeightsFromState(state) {
      var base = (state && state.walls && state.walls.height_mm != null) ? clampHeightMm(state.walls.height_mm, 2400) : 2400;
      var p = (state && state.roof && state.roof.pent) ? state.roof.pent : null;
      var minH = clampHeightMm(p && p.minHeight_mm != null ? p.minHeight_mm : base, base);
      var maxH = clampHeightMm(p && p.maxHeight_mm != null ? p.maxHeight_mm : base, base);
      return { minH: minH, maxH: maxH, base: base };
    }

    function render(state) {
      try {
        window.__dbg.buildCalls += 1;

        var R = resolveDims(state);
        var baseState = Object.assign({}, state, { w: R.base.w_mm, d: R.base.d_mm });

        var wallDims = getWallOuterDimsFromState(state);
        var wallState = Object.assign({}, state, { w: wallDims.w_mm, d: wallDims.d_mm });

        // Apex only: allow params.resolveDims(...) to provide a derived wall height that satisfies
        // absolute "Height to Eaves" (ground->underside at wall line) once that logic is implemented there.
        // No effect unless R.walls.height_mm is populated by params.js, and does NOT change pent behavior.
        try {
          var roofStyleNow = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
          if (roofStyleNow === "apex" && R && R.walls && R.walls.height_mm != null) {
            wallState = Object.assign({}, wallState, {
              walls: Object.assign({}, wallState.walls || {}, { height_mm: Math.floor(Number(R.walls.height_mm)) })
            });
          }
        } catch (eWallDerive) {}

        safeDispose();

        if (getBaseEnabled(state)) {
          if (Base && typeof Base.build3D === "function") Base.build3D(baseState, ctx);
        }

        if (getWallsEnabled(state)) {
          if (Walls && typeof Walls.build3D === "function") Walls.build3D(wallState, ctx);
          shiftWallMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
        }

        var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";

        // Build roof for supported styles (pent + apex). (No behavior change for pent.)
        if (getRoofEnabled(state) && (roofStyle === "pent" || roofStyle === "apex")) {
          var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(R.roof.w_mm)) : Math.max(1, Math.floor(R.base.w_mm));
          var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(R.roof.d_mm)) : Math.max(1, Math.floor(R.base.d_mm));
          var roofState = Object.assign({}, state, { w: roofW, d: roofD });

          if (Roof && typeof Roof.build3D === "function") Roof.build3D(roofState, ctx);
          shiftRoofMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);

          if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(roofState);
        } else {
          try {
            if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(Object.assign({}, state, { roof: Object.assign({}, state.roof || {}, { style: roofStyle }) }));
          } catch (e0) {}
        }

        if (Walls && typeof Walls.updateBOM === "function") {
          var wallsBom = Walls.updateBOM(wallState);
          if (wallsBom && wallsBom.sections) renderBOM(wallsBom.sections);
        }

        if (Base && typeof Base.updateBOM === "function") Base.updateBOM(baseState);

        try {
          var _cladOn = getCladdingEnabled(state);
          applyCladdingVisibility(ctx.scene, _cladOn);
          requestAnimationFrame(function () {
            try { applyCladdingVisibility(ctx.scene, _cladOn); } catch (e0) {}
          });
        } catch (e1) {}
      } catch (e) {
        window.__dbg.lastError = "render() failed: " + String(e && e.message ? e.message : e);
      }
    }

    function getOpeningsFromState(state) {
      return (state && state.walls && Array.isArray(state.walls.openings)) ? state.walls.openings : [];
    }

    function setOpenings(nextOpenings) {
      store.setState({ walls: { openings: nextOpenings } });
    }

    function getDoorsFromState(state) {
      var openings = getOpeningsFromState(state);
      var doors = [];
      for (var i = 0; i < openings.length; i++) {
        var d = openings[i];
        if (d && d.type === "door") doors.push(d);
      }
      return doors;
    }

    function getWindowsFromState(state) {
      var openings = getOpeningsFromState(state);
      var wins = [];
      for (var i = 0; i < openings.length; i++) {
        var w = openings[i];
        if (w && w.type === "window") wins.push(w);
      }
      return wins;
    }

    function getOpeningById(state, id) {
      var openings = getOpeningsFromState(state);
      for (var i = 0; i < openings.length; i++) {
        var o = openings[i];
        if (o && String(o.id || "") === String(id)) return o;
      }
      return null;
    }

    function validateDoors(state) {
      var res = { invalidById: {}, invalidIds: [] };
      var doors = getDoorsFromState(state);
      var lens = getWallLengthsForOpenings(state);
      var minGap = 50;

      function wallLen(wall) {
        return lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;
      }

      for (var i = 0; i < doors.length; i++) {
        var d = doors[i];
        var wall = String(d.wall || "front");
        var L = wallLen(wall);
        var w = Math.max(1, Math.floor(Number(d.width_mm || 900)));
        var x = Math.floor(Number(d.x_mm || 0));

        var minX = minGap;
        var maxX = Math.max(minX, L - w - minGap);

        if (x < minX || x > maxX) {
          res.invalidById[String(d.id)] =
            "Invalid: too close to corner/end.\n" +
            "Allowed X range: " + minX + " .. " + maxX + " (mm)";
        }
      }

      var byWall = { front: [], back: [], left: [], right: [] };
      for (var j = 0; j < doors.length; j++) {
        var dd = doors[j];
        var ww = String(dd.wall || "front");
        if (!byWall[ww]) byWall[ww] = [];
        byWall[ww].push(dd);
      }

      function intervalsOverlapOrTooClose(a0, a1, b0, b1, gap) {
        if (a1 + gap <= b0) return false;
        if (b1 + gap <= a0) return false;
        return true;
      }

      Object.keys(byWall).forEach(function (wall) {
        var list = byWall[wall] || [];
        for (var a = 0; a < list.length; a++) {
          for (var b = a + 1; b < list.length; b++) {
            var da = list[a], db = list[b];
            var ax = Math.floor(Number(da.x_mm || 0));
            var aw = Math.max(1, Math.floor(Number(da.width_mm || 900)));
            var bx = Math.floor(Number(db.x_mm || 0));
            var bw = Math.max(1, Math.floor(Number(db.width_mm || 900)));

            var a0 = ax, a1 = ax + aw;
            var b0 = bx, b1 = bx + bw;

            if (intervalsOverlapOrTooClose(a0, a1, b0, b1, minGap)) {
              if (!res.invalidById[String(da.id)]) res.invalidById[String(da.id)] = "Invalid: overlaps or is too close (<50mm) to another door on " + wall + ".";
              if (!res.invalidById[String(db.id)]) res.invalidById[String(db.id)] = "Invalid: overlaps or is too close (<50mm) to another door on " + wall + ".";
            }
          }
        }
      });

      Object.keys(res.invalidById).forEach(function (k) { res.invalidIds.push(k); });
      return res;
    }

    function validateWindows(state) {
      var res = { invalidById: {}, invalidIds: [] };
      var wins = getWindowsFromState(state);
      var lens = getWallLengthsForOpenings(state);
      var minGap = 50;

      var studLen = currentStudLenFromState(state);
      var thkY = currentWallThicknessFromState(state);

      function wallLen(wall) {
        return lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;
      }

      for (var i = 0; i < wins.length; i++) {
        var w0 = wins[i];
        var wall = String(w0.wall || "front");
        var L = wallLen(wall);

        var w = Math.max(1, Math.floor(Number(w0.width_mm || 900)));
        var x = Math.floor(Number(w0.x_mm || 0));

        var y = Math.floor(Number(w0.y_mm || 0));
        var h = Math.max(1, Math.floor(Number(w0.height_mm || 600)));

        var minX = minGap;
        var maxX = Math.max(minX, L - w - minGap);

        if (x < minX || x > maxX) {
          res.invalidById[String(w0.id)] =
            "Invalid: too close to corner/end.\n" +
            "Allowed X range: " + minX + " .. " + maxX + " (mm)";
        }

        if (y < 0) {
          res.invalidById[String(w0.id)] = "Invalid: Window Y must be ≥ 0 (mm).";
        } else if ((y + h + thkY) > studLen) {
          res.invalidById[String(w0.id)] =
            "Invalid: window exceeds the wall frame height.\n" +
            "Max (Y + H) allowed: " + Math.max(0, (studLen - thkY)) + " (mm)";
        }
      }

      var byWall = { front: [], back: [], left: [], right: [] };
      for (var j = 0; j < wins.length; j++) {
        var ww2 = wins[j];
        var wl = String(ww2.wall || "front");
        if (!byWall[wl]) byWall[wl] = [];
        byWall[wl].push(ww2);
      }

      function intervalsOverlapOrTooClose(a0, a1, b0, b1, gap) {
        if (a1 + gap <= b0) return false;
        if (b1 + gap <= a0) return false;
        return true;
      }

      Object.keys(byWall).forEach(function (wall) {
        var list = byWall[wall] || [];
        for (var a = 0; a < list.length; a++) {
          for (var b = a + 1; b < list.length; b++) {
            var da = list[a], db = list[b];
            var ax = Math.floor(Number(da.x_mm || 0));
            var aw = Math.max(1, Math.floor(Number(da.width_mm || 900)));
            var bx = Math.floor(Number(db.x_mm || 0));
            var bw = Math.max(1, Math.floor(Number(db.width_mm || 900)));

            var a0 = ax, a1 = ax + aw;
            var b0 = bx, b1 = bx + bw;

            if (intervalsOverlapOrTooClose(a0, a1, b0, b1, minGap)) {
              if (!res.invalidById[String(da.id)]) res.invalidById[String(da.id)] = "Invalid: overlaps or is too close (<50mm) to another window on " + wall + ".";
              if (!res.invalidById[String(db.id)]) res.invalidById[String(db.id)] = "Invalid: overlaps or is too close (<50mm) to another window on " + wall + ".";
            }
          }
        }
      });

      Object.keys(res.invalidById).forEach(function (k) { res.invalidIds.push(k); });
      return res;
    }

    function subtractIntervals(base, forb) {
      var out = base.slice();
      forb.forEach(function (f) {
        var next = [];
        for (var i = 0; i < out.length; i++) {
          var seg = out[i];
          var a = seg[0], b = seg[1];
          var fa = f[0], fb = f[1];
          if (fb < a || fa > b) { next.push(seg); continue; }
          if (fa <= a && fb >= b) { continue; }
          if (fa > a) next.push([a, fa - 1]);
          if (fb < b) next.push([fb + 1, b]);
        }
        out = next;
      });
      return out;
    }

    function computeSnapX_ForType(state, openingId, type) {
      var d = getOpeningById(state, openingId);
      if (!d || String(d.type || "") !== type) return null;

      var minGap = 50;
      var wall = String(d.wall || "front");
      var lens = getWallLengthsForOpenings(state);
      var L = lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;

      var w = Math.max(1, Math.floor(Number(d.width_mm || 900)));
      var desired = Math.floor(Number(d.x_mm || 0));

      var minX = minGap;
      var maxX = Math.max(minX, L - w - minGap);

      var base = [[minX, maxX]];
      var openings = (type === "door" ? getDoorsFromState(state) : getWindowsFromState(state))
        .filter(function (x) { return String(x.id || "") !== String(openingId) && String(x.wall || "front") === wall; });

      var forb = [];
      for (var i = 0; i < openings.length; i++) {
        var o = openings[i];
        var ox = Math.floor(Number(o.x_mm || 0));
        var ow = Math.max(1, Math.floor(Number(o.width_mm || 900)));
        var fa = (ox - minGap - w);
        var fb = (ox + ow + minGap);
        forb.push([fa, fb]);
      }

      var allowed = subtractIntervals(base, forb);
      if (!allowed.length) return clamp(desired, minX, maxX);

      var best = null;
      var bestDist = Infinity;

      for (var k = 0; k < allowed.length; k++) {
        var seg = allowed[k];
        var a = seg[0], b = seg[1];
        var x = clamp(desired, a, b);
        var dist = Math.abs(x - desired);
        if (dist < bestDist) { bestDist = dist; best = x; }
      }

      return best == null ? clamp(desired, minX, maxX) : best;
    }

    var _invalidSyncGuard = false;

    function syncInvalidOpeningsIntoState() {
      if (_invalidSyncGuard) return;

      var s = store.getState();
      var dv = validateDoors(s);
      var wv = validateWindows(s);

      var curDoors = (s && s.walls && Array.isArray(s.walls.invalidDoorIds)) ? s.walls.invalidDoorIds.map(String) : [];
      var curWins = (s && s.walls && Array.isArray(s.walls.invalidWindowIds)) ? s.walls.invalidWindowIds.map(String) : [];

      var nextDoors = dv.invalidIds.slice().sort();
      var nextWins = wv.invalidIds.slice().sort();

      function sameArr(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      }

      var curDoorsS = curDoors.slice().sort();
      var curWinsS = curWins.slice().sort();

      var need = (!sameArr(curDoorsS, nextDoors)) || (!sameArr(curWinsS, nextWins));
      if (need) {
        _invalidSyncGuard = true;
        store.setState({ walls: { invalidDoorIds: nextDoors, invalidWindowIds: nextWins } });
        _invalidSyncGuard = false;
      }

      return { doors: dv, windows: wv };
    }

    var snapNoticeDoorById = {};
    var snapNoticeWinById = {};

    function patchOpeningById(openingId, patch) {
      var s = store.getState();
      var cur = getOpeningsFromState(s);
      var next = [];
      for (var i = 0; i < cur.length; i++) {
        var o = cur[i];
        if (o && String(o.id || "") === String(openingId)) next.push(Object.assign({}, o, patch));
        else next.push(o);
      }
      setOpenings(next);
    }

    function wireCommitOnly(inputEl, onCommit) {
      inputEl.addEventListener("blur", function () { onCommit(); });
      inputEl.addEventListener("keydown", function (e) {
        if (!e) return;
        if (e.key === "Enter") {
          e.preventDefault();
          try { e.target.blur(); } catch (ex) {}
        }
      });
    }

    function renderDoorsUi(state, validation) {
      if (!doorsListEl) return;
      doorsListEl.innerHTML = "";

      var doors = getDoorsFromState(state);

      for (var i = 0; i < doors.length; i++) {
        (function (door) {
          var id = String(door.id || "");

          var item = document.createElement("div");
          item.className = "doorItem";

          var top = document.createElement("div");
          top.className = "doorTop";

          var wallLabel = document.createElement("label");
          wallLabel.textContent = "Wall";
          var wallSel = document.createElement("select");
          wallSel.innerHTML =
            '<option value="front">front</option>' +
            '<option value="back">back</option>' +
            '<option value="left">left</option>' +
            '<option value="right">right</option>';
          wallSel.value = String(door.wall || "front");
          wallLabel.appendChild(wallSel);

          var actions = document.createElement("div");
          actions.className = "doorActions";

          var snapBtn = document.createElement("button");
          snapBtn.type = "button";
          snapBtn.className = "snapBtn";
          snapBtn.textContent = "Snap to nearest viable position";

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.textContent = "Remove";

          actions.appendChild(snapBtn);
          actions.appendChild(rmBtn);

          top.appendChild(wallLabel);
          top.appendChild(actions);

          var row = document.createElement("div");
          row.className = "row3";

          function makeNum(labelTxt, v, min, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(min);
            inp.step = String(step);
            inp.value = String(v == null ? "" : v);
            lab.appendChild(inp);
            return { lab: lab, inp: inp };
          }

          var xField = makeNum("Door X (mm)", Math.floor(Number(door.x_mm ?? 0)), 0, 10);
          var wField = makeNum("Door W (mm)", Math.floor(Number(door.width_mm ?? 900)), 100, 10);
          var hField = makeNum("Door H (mm)", Math.floor(Number(door.height_mm ?? 2000)), 100, 10);

          row.appendChild(xField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          var msg = document.createElement("div");
          msg.className = "doorMsg";

          var invalidMsg = validation && validation.invalidById ? validation.invalidById[id] : null;
          var notice = snapNoticeDoorById[id] ? snapNoticeDoorById[id] : null;

          if (invalidMsg) {
            msg.textContent = String(invalidMsg);
            msg.classList.add("show");
            snapBtn.classList.add("show");
          } else if (notice) {
            msg.textContent = String(notice);
            msg.classList.add("show");
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: asNonNegInt(xField.inp.value, Math.floor(Number(door.x_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: asPosInt(wField.inp.value, Math.floor(Number(door.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: asPosInt(hField.inp.value, Math.floor(Number(door.height_mm ?? 2000))) } );
          });

          wallSel.addEventListener("change", function () {
            patchOpeningById(id, { wall: String(wallSel.value || "front") });
          });

          snapBtn.addEventListener("click", function () {
            var s = store.getState();
            var snapped = computeSnapX_ForType(s, id, "door");
            if (snapped == null) return;
            patchOpeningById(id, { x_mm: snapped });

            snapNoticeDoorById[id] = "Snapped to " + snapped + "mm.";
            setTimeout(function () {
              if (snapNoticeDoorById[id] === ("Snapped to " + snapped + "mm.")) delete snapNoticeDoorById[id];
              syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
            }, 1500);
          });

          rmBtn.addEventListener("click", function () {
            var s = store.getState();
            var cur = getOpeningsFromState(s);
            var next = [];
            for (var k = 0; k < cur.length; k++) {
              var o = cur[k];
              if (o && o.type === "door" && String(o.id || "") === id) continue;
              next.push(o);
            }
            delete snapNoticeDoorById[id];
            setOpenings(next);
          });

          item.appendChild(top);
          item.appendChild(row);
          item.appendChild(msg);

          doorsListEl.appendChild(item);
        })(doors[i]);
      }

      if (!doors.length) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No doors.";
        doorsListEl.appendChild(empty);
      }
    }

    function renderWindowsUi(state, validation) {
      if (!windowsListEl) return;
      windowsListEl.innerHTML = "";

      var wins = getWindowsFromState(state);

      for (var i = 0; i < wins.length; i++) {
        (function (win) {
          var id = String(win.id || "");

          var item = document.createElement("div");
          item.className = "windowItem";

          var top = document.createElement("div");
          top.className = "windowTop";

          var wallLabel = document.createElement("label");
          wallLabel.textContent = "Wall";
          var wallSel = document.createElement("select");
          wallSel.innerHTML =
            '<option value="front">front</option>' +
            '<option value="back">back</option>' +
            '<option value="left">left</option>' +
            '<option value="right">right</option>';
          wallSel.value = String(win.wall || "front");
          wallLabel.appendChild(wallSel);

          var actions = document.createElement("div");
          actions.className = "windowActions";

          var snapBtn = document.createElement("button");
          snapBtn.type = "button";
          snapBtn.className = "snapBtn";
          snapBtn.textContent = "Snap to nearest viable position";

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.textContent = "Remove";

          actions.appendChild(snapBtn);
          actions.appendChild(rmBtn);

          top.appendChild(wallLabel);
          top.appendChild(actions);

          var row = document.createElement("div");
          row.className = "row4";

          function makeNum(labelTxt, v, min, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(min);
            inp.step = String(step);
            inp.value = String(v == null ? "" : v);
            lab.appendChild(inp);
            return { lab: lab, inp: inp };
          }

          var xField = makeNum("Win X (mm)", Math.floor(Number(win.x_mm ?? 0)), 0, 10);
          var yField = makeNum("Win Y (mm)", Math.floor(Number(win.y_mm ?? 0)), 0, 10);
          var wField = makeNum("Win W (mm)", Math.floor(Number(win.width_mm ?? 900)), 100, 10);
          var hField = makeNum("Win H (mm)", Math.floor(Number(win.height_mm ?? 600)), 100, 10);

          row.appendChild(xField.lab);
          row.appendChild(yField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          var msg = document.createElement("div");
          msg.className = "windowMsg";

          var invalidMsg = validation && validation.invalidById ? validation.invalidById[id] : null;
          var notice = snapNoticeWinById[id] ? snapNoticeWinById[id] : null;

          if (invalidMsg) {
            msg.textContent = String(invalidMsg);
            msg.classList.add("show");
            snapBtn.classList.add("show");
          } else if (notice) {
            msg.textContent = String(notice);
            msg.classList.add("show");
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: asNonNegInt(xField.inp.value, Math.floor(Number(win.x_mm ?? 0))) });
          });
          wireCommitOnly(yField.inp, function () {
            patchOpeningById(id, { y_mm: asNonNegInt(yField.inp.value, Math.floor(Number(win.y_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: asPosInt(wField.inp.value, Math.floor(Number(win.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: asPosInt(hField.inp.value, Math.floor(Number(win.height_mm ?? 600))) });
          });

          wallSel.addEventListener("change", function () {
            patchOpeningById(id, { wall: String(wallSel.value || "front") });
          });

          snapBtn.addEventListener("click", function () {
            var s = store.getState();
            var snapped = computeSnapX_ForType(s, id, "window");
            if (snapped == null) return;
            patchOpeningById(id, { x_mm: snapped });

            snapNoticeWinById[id] = "Snapped to " + snapped + "mm.";
            setTimeout(function () {
              if (snapNoticeWinById[id] === ("Snapped to " + snapped + "mm.")) delete snapNoticeWinById[id];
              syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
            }, 1500);
          });

          rmBtn.addEventListener("click", function () {
            var s = store.getState();
            var cur = getOpeningsFromState(s);
            var next = [];
            for (var k = 0; k < cur.length; k++) {
              var o = cur[k];
              if (o && o.type === "window" && String(o.id || "") === id) continue;
              next.push(o);
            }
            delete snapNoticeWinById[id];
            setOpenings(next);
          });

          item.appendChild(top);
          item.appendChild(row);
          item.appendChild(msg);

          windowsListEl.appendChild(item);
        })(wins[i]);
      }

      if (!wins.length) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No windows.";
        windowsListEl.appendChild(empty);
      }
    }

    function syncUiFromState(state, validations) {
      try {
        if (dimModeEl) dimModeEl.value = (state && state.dimMode) ? state.dimMode : "base";

        if (wInputEl && dInputEl) {
          var m0 = (state && state.dimMode) ? String(state.dimMode) : "base";
          try {
            var R0 = resolveDims(state || {});
            if (m0 === "frame") {
              wInputEl.value = String(R0.frame.w_mm);
              dInputEl.value = String(R0.frame.d_mm);
            } else if (m0 === "roof") {
              wInputEl.value = String(R0.roof.w_mm);
              dInputEl.value = String(R0.roof.d_mm);
            } else {
              wInputEl.value = String(R0.base.w_mm);
              dInputEl.value = String(R0.base.d_mm);
            }
          } catch (e0) {
            if (wInputEl && state && state.w != null) wInputEl.value = String(state.w);
            if (dInputEl && state && state.d != null) dInputEl.value = String(state.d);
          }
        }

        if (roofStyleEl) {
          roofStyleEl.value = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
        }

        // Apex trusses UI (mm only): count + computed spacing readout
        try {
          var _roofStyleNow = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "apex";
          if (roofApexTrussCountEl) {
            var n0 = getApexTrussCountFromState(state);
            if (n0 == null) n0 = computeLegacyApexTrussCount(state);
            roofApexTrussCountEl.value = String(n0);
            // Keep usable even if hidden by CSS/layout; but disable when not apex to avoid accidental edits.
            roofApexTrussCountEl.disabled = (_roofStyleNow !== "apex");
            roofApexTrussCountEl.setAttribute("aria-disabled", String(_roofStyleNow !== "apex"));
          }
          if (roofApexTrussSpacingEl) {
            roofApexTrussSpacingEl.textContent = computeApexTrussSpacingText(state);
          }
        } catch (eApexUi) {}

        var isPent = isPentRoofStyle(state);
        if (roofMinHeightEl && roofMaxHeightEl) {
          var ph = getPentHeightsFromState(state);
          roofMinHeightEl.value = String(ph.minH);
          roofMaxHeightEl.value = String(ph.maxH);
          roofMinHeightEl.disabled = !isPent;
          roofMaxHeightEl.disabled = !isPent;
        }

        // Apex absolute eaves/crest heights (mm)
        try {
          var isApex = isApexRoofStyle(state);
          var ah = getApexHeightsFromState(state);

          if (roofApexEavesHeightEl) {
            roofApexEavesHeightEl.disabled = !isApex;
            roofApexEavesHeightEl.setAttribute("aria-disabled", String(!isApex));
            if (isApex && ah.eaves != null) roofApexEavesHeightEl.value = String(ah.eaves);
          }

          if (roofApexCrestHeightEl) {
            roofApexCrestHeightEl.disabled = !isApex;
            roofApexCrestHeightEl.setAttribute("aria-disabled", String(!isApex));
            if (isApex && ah.crest != null) roofApexCrestHeightEl.value = String(ah.crest);
          }
        } catch (eApexSync) {}

        if (state && state.overhang) {
          if (overUniformEl) overUniformEl.value = String(state.overhang.uniform_mm != null ? state.overhang.uniform_mm : 0);
          if (overLeftEl) overLeftEl.value = state.overhang.left_mm == null ? "" : String(state.overhang.left_mm);
          if (overRightEl) overRightEl.value = state.overhang.right_mm == null ? "" : String(state.overhang.right_mm);
          if (overFrontEl) overFrontEl.value = state.overhang.front_mm == null ? "" : String(state.overhang.front_mm);
          if (overBackEl) overBackEl.value = state.overhang.back_mm == null ? "" : String(state.overhang.back_mm);
        }

        if (vBaseAllEl) vBaseAllEl.checked = getBaseEnabled(state);
        if (vBaseEl) vBaseEl.checked = !!(state && state.vis && state.vis.base);
        if (vFrameEl) vFrameEl.checked = !!(state && state.vis && state.vis.frame);
        if (vInsEl) vInsEl.checked = !!(state && state.vis && state.vis.ins);
        if (vDeckEl) vDeckEl.checked = !!(state && state.vis && state.vis.deck);

        if (vWallsEl) vWallsEl.checked = getWallsEnabled(state);
        if (vRoofEl) vRoofEl.checked = getRoofEnabled(state);
        if (vCladdingEl) vCladdingEl.checked = getCladdingEnabled(state);

        var rp = (state && state.vis && state.vis.roofParts && typeof state.vis.roofParts === "object") ? state.vis.roofParts : null;
        if (vRoofStructureEl) vRoofStructureEl.checked = rp ? (rp.structure !== false) : true;
        if (vRoofOsbEl) vRoofOsbEl.checked = rp ? (rp.osb !== false) : true;

        var parts = getWallParts(state);
        if (vWallFrontEl) vWallFrontEl.checked = !!parts.front;
        if (vWallBackEl) vWallBackEl.checked = !!parts.back;
        if (vWallLeftEl) vWallLeftEl.checked = !!parts.left;
        if (vWallRightEl) vWallRightEl.checked = !!parts.right;

        if (wallsVariantEl && state && state.walls && state.walls.variant) wallsVariantEl.value = state.walls.variant;

        if (wallHeightEl) {
          if (isPent) {
            wallHeightEl.value = String(computePentDisplayHeight(state));
          } else if (state && state.walls && state.walls.height_mm != null) {
            wallHeightEl.value = String(state.walls.height_mm);
          }
        }

        if (wallSectionEl && state && state.walls) {
          var h = null;
          try {
            if (state.frame && state.frame.depth_mm != null) h = state.frame.depth_mm;
            else if (state.walls.insulated && state.walls.insulated.section && state.walls.insulated.section.h != null) h = state.walls.insulated.section.h;
            else if (state.walls.basic && state.walls.basic.section && state.walls.basic.section.h != null) h = state.walls.basic.section.h;
          } catch (e) {}
          wallSectionEl.value = (Math.floor(Number(h)) === 75) ? "50x75" : "50x100";
        }

        applyWallHeightUiLock(state);

        var dv = validations && validations.doors ? validations.doors : null;
        var wv = validations && validations.windows ? validations.windows : null;

        renderDoorsUi(state, dv);
        renderWindowsUi(state, wv);
      } catch (e) {
        window.__dbg.lastError = "syncUiFromState failed: " + String(e && e.message ? e.message : e);
      }
    }

    function updateOverlay() {
      if (!statusOverlayEl) return;

      var hasBabylon = typeof window.BABYLON !== "undefined";
      var cw = canvas ? (canvas.clientWidth || 0) : 0;
      var ch = canvas ? (canvas.clientHeight || 0) : 0;

      var engine = window.__dbg.engine;
      var scene = window.__dbg.scene;
      var camera = window.__dbg.camera;

      var meshes = (scene && scene.meshes) ? scene.meshes.length : 0;
      var err = String(window.__dbg.lastError || "").slice(0, 200);

      statusOverlayEl.textContent =
        "BABYLON loaded: " + hasBabylon + "\n" +
        "Canvas: " + cw + " x " + ch + "\n" +
        "Engine: " + (!!engine) + "\n" +
        "Scene: " + (!!scene) + "\n" +
        "Camera: " + (!!camera) + "\n" +
        "Frames: " + window.__dbg.frames + "\n" +
        "BuildCalls: " + window.__dbg.buildCalls + "\n" +
        "Meshes: " + meshes + "\n" +
        "LastError: " + err;
    }

    if (roofStyleEl) {
      roofStyleEl.addEventListener("change", function () {
        var v = String(roofStyleEl.value || "apex");
        if (v !== "apex" && v !== "pent" && v !== "hipped") v = "apex";
        store.setState({ roof: { style: v } });
        applyWallHeightUiLock(store.getState());
      });
    }

    function commitPentHeightsFromInputs() {
      if (!roofMinHeightEl || !roofMaxHeightEl) return;
      var s = store.getState();
      var base = (s && s.walls && s.walls.height_mm != null) ? clampHeightMm(s.walls.height_mm, 2400) : 2400;
      var minH = clampHeightMm(roofMinHeightEl.value, base);
      var maxH = clampHeightMm(roofMaxHeightEl.value, base);
      store.setState({ roof: { pent: { minHeight_mm: minH, maxHeight_mm: maxH } } });
    }

    // Apex: absolute heights from ground (mm)
    function commitApexHeightsFromInputs() {
      if (!roofApexEavesHeightEl || !roofApexCrestHeightEl) return;

      var s = store.getState();
      if (!isApexRoofStyle(s)) return;

      var eaves = clampHeightMm(roofApexEavesHeightEl.value, 2400);
      var crest = clampHeightMm(roofApexCrestHeightEl.value, eaves);

      // Deterministic validity rule:
      // If crest < eaves, clamp crest UP to eaves (never invert the roof).
      if (crest < eaves) crest = eaves;

      // Reflect clamp immediately in UI so the user sees the correction.
      try { roofApexCrestHeightEl.value = String(crest); } catch (e0) {}

      store.setState({ roof: { apex: { heightToEaves_mm: eaves, heightToCrest_mm: crest } } });
    }

    if (roofMinHeightEl) roofMinHeightEl.addEventListener("input", function () {
      if (!isPentRoofStyle(store.getState())) return;
      commitPentHeightsFromInputs();
    });
    if (roofMaxHeightEl) roofMaxHeightEl.addEventListener("input", function () {
      if (!isPentRoofStyle(store.getState())) return;
      commitPentHeightsFromInputs();
    });

    // Commit-only (blur/Enter) so changes deterministically trigger state->rebuild in the same pathway as other controls.
    if (roofApexEavesHeightEl) wireCommitOnly(roofApexEavesHeightEl, commitApexHeightsFromInputs);
    if (roofApexCrestHeightEl) wireCommitOnly(roofApexCrestHeightEl, commitApexHeightsFromInputs);

    // Apex trusses (incl. gable ends): user-selected count
    if (roofApexTrussCountEl) {
      roofApexTrussCountEl.addEventListener("input", function () {
        var s = store.getState();
        var style = (s && s.roof && s.roof.style != null) ? String(s.roof.style) : "apex";
        if (style !== "apex") return;

        var n = Math.floor(Number(roofApexTrussCountEl.value));
        if (!Number.isFinite(n)) n = computeLegacyApexTrussCount(s);
        n = clamp(n, 2, 200);

        store.setState({ roof: { apex: { trussCount: n } } });
      });
    }

    if (vWallsEl) {
      vWallsEl.addEventListener("change", function (e) {
        var s = store.getState();
        var on = !!(e && e.target && e.target.checked);

        if (s && s.vis && typeof s.vis.walls === "boolean") store.setState({ vis: { walls: on } });
        else if (s && s.vis && typeof s.vis.wallsEnabled === "boolean") store.setState({ vis: { wallsEnabled: on } });
        else store.setState({ vis: { walls: on } });
      });
    }

    if (vRoofEl) vRoofEl.addEventListener("change", function(e){ store.setState({ vis: { roof: !!e.target.checked } }); console.log("[vis] roof=", !!e.target.checked); });

    if (vCladdingEl) vCladdingEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      try { applyCladdingVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { cladding: on } });
      console.log("[vis] cladding=", on ? "ON" : "OFF");
    });

    if (vRoofStructureEl) vRoofStructureEl.addEventListener("change", function (e) {
      var s = store.getState();
      var cur = (s && s.vis && s.vis.roofParts && typeof s.vis.roofParts === "object") ? s.vis.roofParts : null;
      var next = cur ? Object.assign({}, cur) : {};
      next.structure = !!(e && e.target && e.target.checked);
      store.setState({ vis: { roofParts: next } });
    });

    if (vRoofOsbEl) vRoofOsbEl.addEventListener("change", function (e) {
      var s = store.getState();
      var cur = (s && s.vis && s.vis.roofParts && typeof s.vis.roofParts === "object") ? s.vis.roofParts : null;
      var next = cur ? Object.assign({}, cur) : {};
      next.osb = !!(e && e.target && e.target.checked);
      store.setState({ vis: { roofParts: next } });
    });

    if (vBaseAllEl) vBaseAllEl.addEventListener("change", function(e){ var on = !!(e && e.target && e.target.checked); store.setState({ vis: { baseAll: on } }); console.log("[vis] base=", on ? "ON" : "OFF"); });

    if (vBaseEl) vBaseEl.addEventListener("change", function (e) { store.setState({ vis: { base: !!e.target.checked } }); });
    if (vFrameEl) vFrameEl.addEventListener("change", function (e) { store.setState({ vis: { frame: !!e.target.checked } }); });
    if (vInsEl) vInsEl.addEventListener("change", function (e) { store.setState({ vis: { ins: !!e.target.checked } }); });
    if (vDeckEl) vDeckEl.addEventListener("change", function (e) { store.setState({ vis: { deck: !!e.target.checked } }); });

    function patchWallPart(key, value) {
      var s = store.getState();
      if (s && s.vis && s.vis.walls && typeof s.vis.walls === "object") {
        store.setState({ vis: { walls: (function(){ var o={}; o[key]=value; return o; })() } });
        return;
      }
      if (s && s.vis && s.vis.wallsParts && typeof s.vis.wallsParts === "object") {
        store.setState({ vis: { wallsParts: (function(){ var o={}; o[key]=value; return o; })() } });
        return;
      }
      store.setState({ _noop: Date.now() });
    }

    if (vWallFrontEl) vWallFrontEl.addEventListener("change", function (e) { patchWallPart("front", !!e.target.checked); });
    if (vWallBackEl)  vWallBackEl.addEventListener("change",  function (e) { patchWallPart("back",  !!e.target.checked); });
    if (vWallLeftEl)  vWallLeftEl.addEventListener("change",  function (e) { patchWallPart("left",  !!e.target.checked); });
    if (vWallRightEl) vWallRightEl.addEventListener("change", function (e) { patchWallPart("right", !!e.target.checked); });

    if (dimModeEl) {
      dimModeEl.addEventListener("change", function () {
        store.setState({ dimMode: dimModeEl.value });
        syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
      });
    }

    function writeActiveDims() {
      var s = store.getState();
      var w = asPosInt(wInputEl ? wInputEl.value : null, 1000);
      var d = asPosInt(dInputEl ? dInputEl.value : null, 1000);

      var mode = (s && s.dimMode) ? String(s.dimMode) : "base";

      var G = 50;
      try {
        if (s && s.dimGap_mm != null) {
          var gg = Math.floor(Number(s.dimGap_mm));
          if (Number.isFinite(gg) && gg >= 0) G = gg;
        }
      } catch (e0) {}

      var ovh = null;
      try {
        var R = resolveDims(s);
        ovh = R && R.overhang ? R.overhang : null;
      } catch (e1) { ovh = null; }

      var sumX = (ovh && ovh.l_mm != null ? Math.floor(Number(ovh.l_mm)) : 0) + (ovh && ovh.r_mm != null ? Math.floor(Number(ovh.r_mm)) : 0);
      var sumZ = (ovh && ovh.f_mm != null ? Math.floor(Number(ovh.f_mm)) : 0) + (ovh && ovh.b_mm != null ? Math.floor(Number(ovh.b_mm)) : 0);

      if (!Number.isFinite(sumX)) sumX = 0;
      if (!Number.isFinite(sumZ)) sumZ = 0;

      var frameW = 1;
      var frameD = 1;

      if (mode === "frame") {
        frameW = w;
        frameD = d;
      } else if (mode === "roof") {
        frameW = Math.max(1, Math.floor(w - sumX));
        frameD = Math.max(1, Math.floor(d - sumZ));
      } else { // base
        frameW = Math.max(1, Math.floor(w + G));
        frameD = Math.max(1, Math.floor(d + G));
      }

      var baseW = Math.max(1, Math.floor(frameW - G));
      var baseD = Math.max(1, Math.floor(frameD - G));
      var roofW = Math.max(1, Math.floor(frameW + sumX));
      var roofD = Math.max(1, Math.floor(frameD + sumZ));

      store.setState({
        dim: { frameW_mm: frameW, frameD_mm: frameD },
        dimInputs: {
          baseW_mm: baseW,
          baseD_mm: baseD,
          frameW_mm: frameW,
          frameD_mm: frameD,
          roofW_mm: roofW,
          roofD_mm: roofD
        }
      });
    }
    if (wInputEl) wInputEl.addEventListener("input", writeActiveDims);
    if (dInputEl) dInputEl.addEventListener("input", writeActiveDims);

    if (overUniformEl) {
      overUniformEl.addEventListener("input", function () {
        var n = Math.max(0, Math.floor(Number(overUniformEl.value || 0)));
        store.setState({ overhang: { uniform_mm: Number.isFinite(n) ? n : 0 } });
      });
    }
    if (overLeftEl)  overLeftEl.addEventListener("input",  function () { store.setState({ overhang: { left_mm:  asNullableInt(overLeftEl.value) } }); });
    if (overRightEl) overRightEl.addEventListener("input", function () { store.setState({ overhang: { right_mm: asNullableInt(overRightEl.value) } }); });
    if (overFrontEl) overFrontEl.addEventListener("input", function () { store.setState({ overhang: { front_mm: asNullableInt(overFrontEl.value) } }); });
    if (overBackEl)  overBackEl.addEventListener("input",  function () { store.setState({ overhang: { back_mm:  asNullableInt(overBackEl.value) } }); });

    function sectionHFromSelectValue(v) {
      return (String(v || "").toLowerCase() === "50x75") ? 75 : 100;
    }
    function frameGaugeFromSelectValue(v) {
      var depth = sectionHFromSelectValue(v);
      return { thickness_mm: 50, depth_mm: depth };
    }
    if (wallSectionEl) {
      wallSectionEl.addEventListener("change", function () {
        var g = frameGaugeFromSelectValue(wallSectionEl.value);
        store.setState({
          frame: { thickness_mm: g.thickness_mm, depth_mm: g.depth_mm },
          walls: {
            insulated: { section: { w: g.thickness_mm, h: g.depth_mm } },
            basic: { section: { w: g.thickness_mm, h: g.depth_mm } }
          }
        });
      });
    }

    if (wallsVariantEl) wallsVariantEl.addEventListener("change", function () { store.setState({ walls: { variant: wallsVariantEl.value } }); });
    if (wallHeightEl) wallHeightEl.addEventListener("input", function () {
      if (wallHeightEl && wallHeightEl.disabled === true) return;
      store.setState({ walls: { height_mm: asPosInt(wallHeightEl.value, 2400) } });
    });

    if (addDoorBtnEl) {
      addDoorBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var lens = getWallLengthsForOpenings(s);
        var openings = getOpeningsFromState(s);

        var id = "door" + String(window.__dbg.doorSeq++);
        var wall = "front";
        var w = 900;
        var h = 2000;
        var L = lens[wall] || 1000;
        var x = Math.floor((L - w) / 2);

        openings.push({ id: id, wall: wall, type: "door", enabled: true, x_mm: x, width_mm: w, height_mm: h });
        setOpenings(openings);
      });
    }

    if (removeAllDoorsBtnEl) {
      removeAllDoorsBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var cur = getOpeningsFromState(s);
        var next = [];
        for (var i = 0; i < cur.length; i++) {
          var o = cur[i];
          if (o && o.type === "door") continue;
          next.push(o);
        }
        snapNoticeDoorById = {};
        setOpenings(next);
      });
    }

    if (addWindowBtnEl) {
      addWindowBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var lens = getWallLengthsForOpenings(s);
        var openings = getOpeningsFromState(s);

        var id = "win" + String(window.__dbg.windowSeq++);
        var wall = "front";
        var w = 900;
        var h = 600;
        var y = 900;
        var L = lens[wall] || 1000;
        var x = Math.floor((L - w) / 2);

        openings.push({ id: id, wall: wall, type: "window", enabled: true, x_mm: x, y_mm: y, width_mm: w, height_mm: h });
        setOpenings(openings);
      });
    }

    if (removeAllWindowsBtnEl) {
      removeAllWindowsBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var cur = getOpeningsFromState(s);
        var next = [];
        for (var i = 0; i < cur.length; i++) {
          var o = cur[i];
          if (o && o.type === "window") continue;
          next.push(o);
        }
        snapNoticeWinById = {};
        setOpenings(next);
      });
    }

    store.onChange(function (s) {
      var v = syncInvalidOpeningsIntoState();
      syncUiFromState(s, v);
      applyWallHeightUiLock(s);
      render(s);
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

    initInstancesUI({
      store: store,
      ids: {
        instanceSelect: "instanceSelect",
        saveInstanceBtn: "saveInstanceBtn",
        loadInstanceBtn: "loadInstanceBtn",
        instanceNameInput: "instanceNameInput",
        saveAsInstanceBtn: "saveAsInstanceBtn",
        deleteInstanceBtn: "deleteInstanceBtn",
        instancesHint: "instancesHint"
      },
      dbg: window.__dbg
    });

    try {
      var s0 = store.getState();
      if (s0 && s0.roof && s0.roof.pent && s0.roof.pent.minHeight_mm != null && s0.roof.pent.maxHeight_mm != null) {
      } else {
        var baseH = (s0 && s0.walls && s0.walls.height_mm != null) ? clampHeightMm(s0.walls.height_mm, 2400) : 2400;
        store.setState({ roof: { pent: { minHeight_mm: baseH, maxHeight_mm: baseH } } });
      }
    } catch (e0) {}

    syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
    applyWallHeightUiLock(store.getState());
    render(store.getState());
    resume3D();

    window.__dbg.initFinished = true;
  } catch (e) {
    window.__dbg.lastError = "initApp() failed: " + String(e && e.message ? e.message : e);
    window.__dbg.initFinished = false;
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
