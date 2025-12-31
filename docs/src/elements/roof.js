/**
 * Roof (PENT only).
 */
import { CONFIG, resolveDims } from "../params.js";

export function build3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  // ---- HARD DISPOSAL ----
  const roofMeshes = scene.meshes.filter(m => String(m.name).startsWith("roof-") && m.metadata?.dynamic);
  roofMeshes.forEach(m => m.dispose(false, true));
  
  const roofNodes = scene.transformNodes.filter(n => n.name === "roof-root" || n.name.startsWith("roof-"));
  roofNodes.sort((a, b) => {
    const depth = (n) => { let d=0, p=n.parent; while(p){d++; p=p.parent;} return d; };
    return depth(b) - depth(a);
  }).forEach(n => n.dispose(false));

  if (!isPentEnabled(state)) return;

  const data = computeRoofData(state);
  const dims = resolveDims(state);
  const ovh = dims?.overhang || { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
  const joistMat = materials?.timber || null;

  const osbMat = (() => {
      if (scene._roofOsbMat) return scene._roofOsbMat;
      const m = new BABYLON.StandardMaterial("roofOsbMat", scene);
      m.diffuseColor = new BABYLON.Color3(0.75, 0.62, 0.45);
      scene._roofOsbMat = m;
      return m;
  })();

  function mkBoxBottomLocal(name, Lx_mm, Ly_mm, Lz_mm, x_mm, yBottom_m, z_mm, parentNode, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, { width: Lx_mm / 1000, height: Ly_mm / 1000, depth: Lz_mm / 1000 }, scene);
    mesh.position = new BABYLON.Vector3((x_mm + Lx_mm / 2) / 1000, yBottom_m + (Ly_mm / 2) / 1000, (z_mm + Lz_mm / 2) / 1000);
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  // ---- Robust top-plate finder ----
  function findTopPlateMesh(wallId) {
    return scene.meshes.find(m => m.name.startsWith(`wall-${wallId}-`) && m.name.endsWith("plate-top") && !m.isDisposed());
  }

  function plateInfoFromMesh(mesh, wallId, isBack) {
    if (!mesh) {
        const fallbackY = isBack ? (data.maxH_mm / 1000) : (data.minH_mm / 1000);
        return { topY_m: fallbackY + 0.15, cx_m: 0, cz_m: isBack ? dims.frame.d_mm/1000 : 0, axis: "x" };
    }
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    return {
      topY_m: bb.maximumWorld.y,
      cx_m: (bb.minimumWorld.x + bb.maximumWorld.x) * 0.5,
      cz_m: (bb.minimumWorld.z + bb.maximumWorld.z) * 0.5,
      axis: Math.abs(bb.maximumWorld.z - bb.minimumWorld.z) > Math.abs(bb.maximumWorld.x - bb.minimumWorld.x) ? "z" : "x"
    };
  }

  let frontPlate = plateInfoFromMesh(findTopPlateMesh("front"), "front", false);
  let backPlate = plateInfoFromMesh(findTopPlateMesh("back"), "back", true);

  const roofRoot = new BABYLON.TransformNode("roof-root", scene);
  roofRoot.position = BABYLON.Vector3.Zero();

  // Build local structure
  const rimThkA_mm = data.rafterW_mm;
  const rimRunB_mm = data.B_mm;
  const isWShort = data.isWShort;

  const mapAB = (a0, b0, aL, bL) => isWShort ? {x:a0, z:b0, lx:aL, lz:bL} : {x:b0, z:a0, lx:bL, lz:aL};

  // Rim Joists
  const r1 = mapAB(0, 0, rimThkA_mm, rimRunB_mm);
  mkBoxBottomLocal("roof-rim-front", r1.lx, data.rafterD_mm, r1.lz, r1.x, 0, r1.z, roofRoot, joistMat);
  const r2 = mapAB(data.A_mm - rimThkA_mm, 0, rimThkA_mm, rimRunB_mm);
  mkBoxBottomLocal("roof-rim-back", r2.lx, data.rafterD_mm, r2.lz, r2.x, 0, r2.z, roofRoot, joistMat);

  // Rafters
  data.rafters.forEach((r, i) => {
    const rm = mapAB(0, r.b0_mm, data.rafterLen_mm, data.rafterW_mm);
    mkBoxBottomLocal(`roof-rafter-${i}`, rm.lx, data.rafterD_mm, rm.lz, rm.x, 0, rm.z, roofRoot, joistMat);
  });

  // OSB
  data.osb.all.forEach((p, i) => {
    mkBoxBottomLocal(`roof-osb-${i}`, p.xLen_mm, data.osbThickness_mm, p.zLen_mm, p.x0_mm, data.rafterD_mm/1000, p.z0_mm, roofRoot, osbMat);
  });

  // ---- ALIGNMENT CALCULATION ----
  const kids = roofRoot.getChildMeshes();
  let lMinX = Infinity, lMaxX = -Infinity, lMinZ = Infinity, lMaxZ = -Infinity;
  kids.forEach(m => {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    lMinX = Math.min(lMinX, bb.minimumWorld.x); lMaxX = Math.max(lMaxX, bb.maximumWorld.x);
    lMinZ = Math.min(lMinZ, bb.minimumWorld.z); lMaxZ = Math.max(lMaxZ, bb.maximumWorld.z);
  });

  const midX = (lMinX + lMaxX) * 0.5, midZ = (lMinZ + lMaxZ) * 0.5;
  const pitchAxisZ = (backPlate.cz_m - frontPlate.cz_m) > (backPlate.cx_m - frontPlate.cx_m);
  
  const frontContactLocal = pitchAxisZ ? new BABYLON.Vector3(midX, 0, lMinZ) : new BABYLON.Vector3(lMinX, 0, midZ);
  const roofCenterLocal = new BABYLON.Vector3(midX, 0, midZ);

  // Apply Yaw & Pitch
  const longAxisVec = pitchAxisZ ? new BABYLON.Vector3(1,0,0) : new BABYLON.Vector3(0,0,1);
  const rafterAxisLocalVec = isWShort ? new BABYLON.Vector3(1,0,0) : new BABYLON.Vector3(0,0,1);
  const yaw = Math.acos(BABYLON.Vector3.Dot(rafterAxisLocalVec, longAxisVec));
  const rise = backPlate.topY_m - frontPlate.topY_m;
  const run = pitchAxisZ ? Math.abs(backPlate.cz_m - frontPlate.cz_m) : Math.abs(backPlate.cx_m - frontPlate.cx_m);
  const angle = Math.atan2(rise, Math.max(0.001, run));

  roofRoot.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0,1,0), yaw)
    .multiply(BABYLON.Quaternion.RotationAxis(longAxisVec, angle));

  // FINAL POSITIONING (The fix)
  roofRoot.computeWorldMatrix(true); 
  const worldFront = BABYLON.Vector3.TransformCoordinates(frontContactLocal, roofRoot.getWorldMatrix());
  roofRoot.position.y += (frontPlate.topY_m - worldFront.y);

  roofRoot.computeWorldMatrix(true);
  const worldCenter = BABYLON.Vector3.TransformCoordinates(roofCenterLocal, roofRoot.getWorldMatrix());
  roofRoot.position.x += ((frontPlate.cx_m + backPlate.cx_m)*0.5 - worldCenter.x);
  roofRoot.position.z += ((frontPlate.cz_m + backPlate.cz_m)*0.5 - worldCenter.z);
}

// Keep all helper functions (isPentEnabled, computeRoofData, etc.) exactly as provided in previous file.
export function updateBOM(state) { /* ... same as previous ... */ }
function isPentEnabled(state) { return !!(state?.roof?.style === "pent"); }
function computeRoofData(state) { 
    const dims = resolveDims(state);
    const roofW = dims.roof.w_mm, roofD = dims.roof.d_mm;
    const A = Math.min(roofW, roofD), B = Math.max(roofW, roofD);
    const isWShort = roofW <= roofD;
    const rafterW_mm = CONFIG.timber.d, rafterD_mm = CONFIG.timber.w;
    
    // Spacing logic
    const pos = [];
    for(let p=0; p <= (B - rafterW_mm); p+=600) pos.push(Math.floor(p));
    pos.push(B - rafterW_mm);

    return { 
        A_mm: A, B_mm: B, isWShort, rafterW_mm, rafterD_mm, rafterLen_mm: A,
        rafters: [...new Set(pos)].map(p => ({b0_mm: p})),
        osb: computeOsbPiecesNoStagger(A, B, isWShort),
        osbThickness_mm: 18, minH_mm: state.roof?.pent?.minHeight_mm || 2400, maxH_mm: state.roof?.pent?.maxHeight_mm || 2400
    };
}

function computeOsbPiecesNoStagger(A, B, isWShort) {
    const all = [];
    for(let bi=0; bi<B; bi+=2440) {
        for(let ai=0; ai<A; ai+=1220) {
            const w = Math.min(1220, A-ai), l = Math.min(2440, B-bi);
            all.push({
                x0_mm: isWShort ? ai : bi, z0_mm: isWShort ? bi : ai,
                xLen_mm: isWShort ? w : l, zLen_mm: isWShort ? l : w,
                kind: (w===1220 && l===2440) ? "std" : "rip"
            });
        }
    }
    return { all };
}
