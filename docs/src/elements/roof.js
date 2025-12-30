// FILE: docs/src/elements/roof.js
/**
 * Roof element (PENT ONLY for now).
 * - Rafters @ 600mm spacing
 * - OSB roofing boards 1220x2440x18 (no-stagger tiling like floor)
 *
 * Notes:
 * - Roof is placed by reading current wall mesh bounds (name "wall-" + metadata.dynamic)
 *   to avoid relying on any wall rise/shift constants outside this module.
 * - If no wall meshes are present, roofTopY falls back to state.walls.height_mm.
 */

function mm(v) { return (v || 0) / 1000; }

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function getRoofTopY_FromWallsOrState(state, scene) {
  var wallTopY = null;

  try {
    if (scene && scene.meshes && scene.meshes.length) {
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
        if (typeof m.name !== "string" || m.name.indexOf("wall-") !== 0) continue;
        if (typeof m.getHierarchyBoundingVectors !== "function") continue;

        var bb = m.getHierarchyBoundingVectors(true);
        if (!bb || !bb.max) continue;

        var y = bb.max.y;
        if (wallTopY == null || y > wallTopY) wallTopY = y;
      }
    }
  } catch (e) {}

  if (wallTopY != null && isFinite(wallTopY)) return wallTopY;

  var h = 2400;
  try {
    if (state && state.walls && state.walls.height_mm != null) h = Math.max(100, Math.floor(Number(state.walls.height_mm)));
  } catch (e2) {}
  return mm(h);
}

function getWallFootprintCenter_FromWalls(scene) {
  var minX = null, maxX = null, minZ = null, maxZ = null;

  try {
    if (scene && scene.meshes && scene.meshes.length) {
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
        if (typeof m.name !== "string" || m.name.indexOf("wall-") !== 0) continue;
        if (typeof m.getHierarchyBoundingVectors !== "function") continue;

        var bb = m.getHierarchyBoundingVectors(true);
        if (!bb || !bb.min || !bb.max) continue;

        if (minX == null || bb.min.x < minX) minX = bb.min.x;
        if (maxX == null || bb.max.x > maxX) maxX = bb.max.x;
        if (minZ == null || bb.min.z < minZ) minZ = bb.min.z;
        if (maxZ == null || bb.max.z > maxZ) maxZ = bb.max.z;
      }
    }
  } catch (e) {}

  if (minX == null || maxX == null || minZ == null || maxZ == null) return null;
  return { cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5 };
}

function ensureOsbMaterial(scene) {
  try {
    if (scene && scene._roofOsbMat) return scene._roofOsbMat;
    if (typeof BABYLON === "undefined" || !BABYLON || !BABYLON.StandardMaterial) return null;

    var mat = new BABYLON.StandardMaterial("roof-osb-mat", scene);
    // keep simple; do not modify global materials or renderer setup
    scene._roofOsbMat = mat;
    return mat;
  } catch (e) {
    return null;
  }
}

function tileOsb_NoStagger(A_mm, B_mm) {
  var SHEET_A = 1220;
  var SHEET_B = 2440;

  var pieces = [];

  var A = Math.max(1, Math.floor(Number(A_mm || 0)));
  var B = Math.max(1, Math.floor(Number(B_mm || 0)));

  var b0 = 0;
  while (b0 < B) {
    var bLen = Math.min(SHEET_B, B - b0);
    var a0 = 0;
    while (a0 < A) {
      var aLen = Math.min(SHEET_A, A - a0);
      pieces.push({ a0: a0, b0: b0, a: aLen, b: bLen });
      a0 += SHEET_A;
    }
    b0 += SHEET_B;
  }

  return pieces;
}

function buildRafters(state, ctx, roofTopY, center) {
  if (typeof BABYLON === "undefined" || !BABYLON || !BABYLON.MeshBuilder) return;

  var scene = ctx && ctx.scene ? ctx.scene : null;
  var mats = ctx && ctx.materials ? ctx.materials : null;

  var timberMat = mats && mats.timber ? mats.timber : null;

  var w_mm = Math.max(1, Math.floor(Number(state && state.w != null ? state.w : 0)));
  var d_mm = Math.max(1, Math.floor(Number(state && state.d != null ? state.d : 0)));

  var longIsX = w_mm >= d_mm;
  var spanLen_mm = longIsX ? w_mm : d_mm;      // rafter spans across "roof width"
  var spaceAxisLen_mm = longIsX ? d_mm : w_mm; // spacing direction perpendicular to span

  var SPACING_MM = 600;
  var SEC_W_MM = 50;
  var SEC_H_MM = 100;

  var spanLen_m = mm(spanLen_mm);
  var secW_m = mm(SEC_W_MM);
  var secH_m = mm(SEC_H_MM);

  var cx = center && isFinite(center.cx) ? center.cx : 0;
  var cz = center && isFinite(center.cz) ? center.cz : 0;

  var start_mm = -Math.floor(spaceAxisLen_mm / 2);
  var end_mm = Math.floor(spaceAxisLen_mm / 2);

  // deterministic inclusive ends: place at start then every 600mm, and ensure one at end
  var positions_mm = [];
  var p = start_mm;
  while (p <= end_mm) {
    positions_mm.push(p);
    p += SPACING_MM;
  }
  if (!positions_mm.length || positions_mm[positions_mm.length - 1] !== end_mm) {
    positions_mm.push(end_mm);
  }

  for (var i = 0; i < positions_mm.length; i++) {
    var off_mm = positions_mm[i];

    var rafter = BABYLON.MeshBuilder.CreateBox(
      "roof-rafter-" + String(i),
      {
        width: longIsX ? spanLen_m : secW_m,
        height: secH_m,
        depth: longIsX ? secW_m : spanLen_m
      },
      scene
    );

    rafter.metadata = rafter.metadata || {};
    rafter.metadata.dynamic = true;

    rafter.material = timberMat || rafter.material;

    var x = longIsX ? cx : (cx + mm(off_mm));
    var z = longIsX ? (cz + mm(off_mm)) : cz;

    rafter.position.x = x;
    rafter.position.z = z;

    // sit on top of walls (roofTopY), rafter height goes upward
    rafter.position.y = roofTopY + (secH_m * 0.5);
  }

  return { longIsX: longIsX, spanLen_mm: spanLen_mm, spaceAxisLen_mm: spaceAxisLen_mm, secH_m: secH_m, center: { cx: cx, cz: cz } };
}

function buildOsbBoards(state, ctx, roofTopY, rafterInfo) {
  if (typeof BABYLON === "undefined" || !BABYLON || !BABYLON.MeshBuilder) return;

  var scene = ctx && ctx.scene ? ctx.scene : null;
  if (!scene) return;

  var w_mm = Math.max(1, Math.floor(Number(state && state.w != null ? state.w : 0)));
  var d_mm = Math.max(1, Math.floor(Number(state && state.d != null ? state.d : 0)));

  // A short axis, B long axis (mirrors floor convention: 2440 along long axis)
  var longIsX = !!(rafterInfo && rafterInfo.longIsX);
  var B_mm = longIsX ? w_mm : d_mm;
  var A_mm = longIsX ? d_mm : w_mm;

  var OSB_T_MM = 18;
  var osbT_m = mm(OSB_T_MM);

  var pieces = tileOsb_NoStagger(A_mm, B_mm);

  var osbMat = null;
  try {
    // prefer existing material if present; else create per-scene roof OSB
    var mats = ctx && ctx.materials ? ctx.materials : null;
    osbMat = (mats && (mats.osb || mats.deck || mats.ply)) ? (mats.osb || mats.deck || mats.ply) : null;
  } catch (e0) {}
  if (!osbMat) osbMat = ensureOsbMaterial(scene);

  var cx = rafterInfo && rafterInfo.center ? rafterInfo.center.cx : 0;
  var cz = rafterInfo && rafterInfo.center ? rafterInfo.center.cz : 0;

  // Place boards on top of rafters
  var baseY = roofTopY + (rafterInfo && rafterInfo.secH_m ? rafterInfo.secH_m : 0) + (osbT_m * 0.5);

  for (var i = 0; i < pieces.length; i++) {
    var pc = pieces[i];

    // Convert AB rectangle to XZ based on long axis
    var a0_mm = pc.a0, b0_mm = pc.b0;
    var a_mm = pc.a, b_mm = pc.b;

    // center coordinates in AB space, then map to XZ
    var aCenter_mm = a0_mm + a_mm / 2;
    var bCenter_mm = b0_mm + b_mm / 2;

    // AB origin at (-A/2, -B/2)
    var aLocal_mm = aCenter_mm - (A_mm / 2);
    var bLocal_mm = bCenter_mm - (B_mm / 2);

    var x = longIsX ? (cx + mm(bLocal_mm)) : (cx + mm(aLocal_mm));
    var z = longIsX ? (cz + mm(aLocal_mm)) : (cz + mm(bLocal_mm));

    var box = BABYLON.MeshBuilder.CreateBox(
      "roof-osb-" + String(i),
      {
        width: longIsX ? mm(b_mm) : mm(a_mm),
        height: osbT_m,
        depth: longIsX ? mm(a_mm) : mm(b_mm)
      },
      scene
    );

    box.metadata = box.metadata || {};
    box.metadata.dynamic = true;

    if (osbMat) box.material = osbMat;

    box.position.x = x;
    box.position.z = z;
    box.position.y = baseY;
  }
}

export function build3D(state, ctx) {
  try {
    if (!state || !isPlainObject(state) || !state.roof || String(state.roof.style || "") !== "pent") return;
    if (!ctx || !ctx.scene) return;

    var scene = ctx.scene;

    var roofTopY = getRoofTopY_FromWallsOrState(state, scene);
    var center = getWallFootprintCenter_FromWalls(scene);

    var rafterInfo = buildRafters(state, ctx, roofTopY, center);
    buildOsbBoards(state, ctx, roofTopY, rafterInfo);
  } catch (e) {}
}

export function updateBOM(state) {
  return null;
}
