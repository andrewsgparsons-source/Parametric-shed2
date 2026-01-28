/**
 * @fileoverview Wall Builder - Creates timber-framed wall structures
 * 
 * Builds the four walls of the main building with proper framing:
 * - Bottom and top plates
 * - Studs at regular intervals (400mm centres)
 * - Door and window framing with headers, sills, and cripple studs
 * - External cladding (lapped boards)
 * - Optional insulation (PIR) and internal plywood lining
 * 
 * ## Wall Orientation
 * - **Front/Back**: Run along X axis, thickness extends in ±Z
 * - **Left/Right**: Run along Z axis, thickness extends in ±X
 * 
 * ## Corner Construction
 * - Front/Back walls are full building width
 * - Left/Right walls fit BETWEEN front/back (no overlap)
 * - Creates proper corner posts for structural integrity
 * 
 * ## Variants
 * - **Basic**: 75mm wall thickness (50×75mm studs)
 * - **Insulated**: 100mm wall thickness (50×100mm studs) + PIR insulation + ply lining
 * 
 * ## Roof Integration
 * - **Pent roof**: Wall heights vary along X (sloped top plates)
 * - **Apex roof**: Constant wall height to eaves, gable infill above on front/back
 * 
 * ## Key Measurements
 * - Stud width: 50mm
 * - Stud depth: 75mm (basic) or 100mm (insulated)
 * - Stud spacing: 400mm centres
 * - Plate height: 50mm
 * - Cladding: 140mm boards × 20mm thick
 * - Insulation: 50mm PIR (Celotex)
 * - Internal lining: 12mm plywood
 * 
 * @module elements/walls
 */

import { CONFIG, resolveDims } from "../params.js";

/**
 * Build four walls. Coordinates:
 * - Front/Back run along X, thickness extrudes +Z.
 * - Left/Right run along Z, thickness extrudes +X.
 *
 * Plate orientation:
 * - Top + bottom plates are rotated 90° about their length axis so studs land on the plate's wider face.
 *   => plate vertical height = studW (50), wall thickness = studH (75/100).
 *
 * BASIC variant panelization:
 * - If a basic wall length exceeds 2400mm, it is built as TWO separate panels split as evenly as possible.
 *
 * CORNER JOIN:
 * - Panels must NOT overlap/intersect at corners.
 * - Front/Back are full building frame width (dims.w).
 * - Left/Right run BETWEEN front/back, so their length is (dims.d - 2 * wallThickness)
 *   and they start at z = wallThickness.
 *
 * Openings:
 * - Doors: width_mm is the CLEAR OPENING (gap) between the uprights (studs).
 * - Windows: same horizontal logic, plus y_mm (from bottom plate top) and height_mm must fit within the stud cavity.
 *
 * PENT ROOF PITCH (conditioned on state.roof.style === "pent"):
 * - Pitch runs along X (width): x=0 => minHeight, x=frameW => maxHeight.
 * - Left wall uses minHeight; Right wall uses maxHeight.
 * - Front/Back walls vary height along X; studs use local heightAtX(studXCenter).
 * - Front/Back top plates are sloped prisms (not constant-height boxes).
 *
 * @param {any} state Derived state for walls (w/d already resolved to frame outer dims)
 * @param {{scene:BABYLON.Scene, materials:any}} ctx
 */
export function build3D(state, ctx, sectionContext) {
  const { scene, materials } = ctx;
  const variant = state.walls?.variant || "insulated";

  // Section context is OPTIONAL - when undefined, behaves exactly as legacy single-building mode
  // sectionContext = { sectionId: string, position: { x: number, y: number, z: number } }
  const sectionId = sectionContext?.sectionId;
  const sectionPos = sectionContext?.position || { x: 0, y: 0, z: 0 };

  // Precompute apex roof underside model once per rebuild (used only for gable cladding trim + height).
  const apexRoofModel = (state && state.roof && String(state.roof.style || "") === "apex")
    ? computeApexRoofUndersideModelMm(state)
    : null;

  // Wall height is normally driven by state.walls.height_mm.
  // APEX ONLY: "Height to Eaves" is the DRIVING dimension = underside of truss tie beams.
  // Wall frame height is DERIVED from eaves height.
  //
  // IMPORTANT: Walls are shifted up by WALL_RISE_MM (168mm) externally in index.js via shiftWallMeshes().
  // So the wall frame height (in local coords) must account for this shift.
  //
  // Calculation:
  // - Height to Eaves = tie beam underside (world Y) = wall_plate_top (world Y)
  // - Wall plate top (world) = wallH + WALL_RISE_MM
  // - Therefore: wallH = HeightToEaves - WALL_RISE_MM
  const WALL_RISE_MM = 168; // Floor frame rise (applied externally in index.js)

  let height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));
  if (state && state.roof && String(state.roof.style || "") === "apex") {
    const apexH = resolveApexHeightsMm(state);
    if (apexH && Number.isFinite(apexH.eaves_mm)) {
      // Wall frame height = eaves height - external wall rise shift
      const minWallH_mm = Math.max(100, 2 * 50 + 1); // 2 plates (approx) + 1mm
      height = Math.max(minWallH_mm, Math.floor(apexH.eaves_mm - WALL_RISE_MM));
      console.log(`[WALLS] Height to Eaves: ${apexH.eaves_mm}mm, WALL_RISE: ${WALL_RISE_MM}mm, Derived wall frame height: ${height}mm`);
    }
  }

  // Dispose existing meshes for this section (or all wall meshes in legacy mode)
  const meshPrefix = sectionId ? `section-${sectionId}-` : "";
  const wallPrefix = meshPrefix + "wall-";
  const cladPrefix = meshPrefix + "clad-";
  const cornerPrefix = meshPrefix + "corner-board-";

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith(wallPrefix))
    .forEach((m) => {
      if (!m.isDisposed()) m.dispose(false, true);
    });

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith(cladPrefix))
    .forEach((m) => {
      if (!m.isDisposed()) m.dispose(false, true);
    });

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith(cornerPrefix))
    .forEach((m) => {
      if (!m.isDisposed()) m.dispose(false, true);
    });


  const dims = {
    w: Math.max(1, Math.floor(state.w)),
    d: Math.max(1, Math.floor(state.d)),
  };

  const prof = resolveProfile(state, variant);

  const plateY = prof.studW;
  const wallThk = prof.studH;

  // ---- Cladding (Phase 1): external cladding, geometry only ----
  // Get cladding style from state (default to shiplap)
  const claddingStyle = state?.cladding?.style || "shiplap";

  // Cladding profile constants based on style
  let CLAD_H, CLAD_T, CLAD_DRIP, CLAD_BOTTOM_DROP_MM;
  let CLAD_Rt, CLAD_Ht, CLAD_Rb, CLAD_Hb;
  let CLAD_T_TOP, CLAD_T_BOTTOM; // For overlap wedge profile

  if (claddingStyle === "overlap") {
    // Overlap (featheredge) cladding - wedge profile
    CLAD_H = 150;           // Board height (exposed face)
    CLAD_T = 22;            // Max thickness (at top)
    CLAD_T_TOP = 22;        // Thick edge at top
    CLAD_T_BOTTOM = 6;      // Thin edge at bottom
    CLAD_DRIP = 30;         // Bottom overhang
    CLAD_BOTTOM_DROP_MM = 60;
    // For overlap, we use a simpler two-box approach
    CLAD_Rt = 0;
    CLAD_Ht = 0;
    CLAD_Rb = 0;
    CLAD_Hb = CLAD_H;       // Entire board is one piece
  } else {
    // Shiplap (default) - rabbeted profile
    CLAD_H = 140;
    CLAD_T = 20;
    CLAD_T_TOP = 20;
    CLAD_T_BOTTOM = 20;
    CLAD_DRIP = 30;
    CLAD_BOTTOM_DROP_MM = 60;
    CLAD_Rt = 5;
    CLAD_Ht = 45;
    CLAD_Rb = 5;
    CLAD_Hb = 20;
  }

  // DIAGNOSTIC: disabled (must not restrict walls/panels/courses)
  const __DIAG_ONE_FRONT_ONE_BOARD = false;

  // DEBUG containers
  try {
    if (!window.__dbg) window.__dbg = {};
    if (!window.__dbg.cladding) window.__dbg.cladding = {};
    if (!window.__dbg.cladding.walls) window.__dbg.cladding.walls = {};
    window.__dbg.cladding.walls = {};
  } catch (e) {}

  const dbgClad = (() => {
    try {
      const qs = new URLSearchParams(window.location.search || "");
      return qs.get("dbgClad") === "1";
    } catch (e) {
      return false;
    }
  })();

  const cladFitAgg = dbgClad
    ? {
        ok: true,
        eps_mm: 0.5,
        worst: { side: "left", mm: 0, wallName: "", wallIndex: null, panelIndex: null, courseIndex: null },
        samplesCount: 0,
      }
    : null;

  function recordCladFitSample(axis, wallId, panelIndex, courseIndex, panelMin, panelMax, cladMin, cladMax) {
    if (!cladFitAgg) return;
    if (!Number.isFinite(panelMin) || !Number.isFinite(panelMax) || !Number.isFinite(cladMin) || !Number.isFinite(cladMax)) return;

    const overhangLeft_mm = panelMin - cladMin;
    const overhangRight_mm = cladMax - panelMax;

    const eps = cladFitAgg.eps_mm;

    const leftBad = overhangLeft_mm > eps;
    const rightBad = overhangRight_mm > eps;

    if (leftBad || rightBad) cladFitAgg.ok = false;

    let side = null;
    let mm = 0;

    if (overhangLeft_mm >= overhangRight_mm) {
      side = "left";
      mm = overhangLeft_mm;
    } else {
      side = "right";
      mm = overhangRight_mm;
    }

    if (mm > Number(cladFitAgg.worst.mm || 0)) {
      cladFitAgg.worst = {
        side: side,
        mm: mm,
        wallName: String(wallId || ""),
        wallIndex: null,
        panelIndex: panelIndex != null ? Number(panelIndex) : null,
        courseIndex: courseIndex != null ? Number(courseIndex) : null,
      };
    }

    cladFitAgg.samplesCount += 1;
  }

const isPent = !!(state && state.roof && String(state.roof.style || "") === "pent");
  // For pent roofs, UI values are TOTAL building height (ground to roof top).
  // We need to subtract floor and roof stacks to get wall frame height.
  // FLOOR_STACK = grid (50) + frame depth + floor OSB (18)
  // ROOF_STACK = rafter depth + roof OSB (18)
  const GRID_HEIGHT_MM = 50;
  const OSB_THK_MM = 18;
  const frameDepth_mm = Math.floor(Number(CONFIG?.timber?.d ?? 100));
 const rafterDepth_mm = Math.floor(Number(CONFIG?.timber?.w ?? 50));  // rafter thickness for pent (lies flat)
  const FLOOR_STACK_MM = GRID_HEIGHT_MM + frameDepth_mm + OSB_THK_MM;
  const ROOF_STACK_MM = rafterDepth_mm + OSB_THK_MM;
  const pentStackAdjust = FLOOR_STACK_MM + ROOF_STACK_MM;
  const minH = isPent
    ? Math.max(100, Math.floor(Number(state?.roof?.pent?.minHeight_mm ?? height)) - pentStackAdjust)
    : height;
  const maxH = isPent
    ? Math.max(100, Math.floor(Number(state?.roof?.pent?.maxHeight_mm ?? height)) - pentStackAdjust)
    : height;
  
if (isPent) {
  console.log("PENT_DEBUG", {
    height,
    minH,
    maxH,
    plateY,
    roofFromStateMin: state?.roof?.pent?.minHeight_mm,
    roofFromStateMax: state?.roof?.pent?.maxHeight_mm,
  });
}

  const frameW = Math.max(1, dims.w);

  function heightAtX(x_mm) {
    const x = Math.max(0, Math.min(frameW, Math.floor(Number(x_mm))));
    const t = frameW > 0 ? x / frameW : 0;
    return Math.max(100, Math.floor(minH + (maxH - minH) * t));
  }

  const flags = normalizeWallFlags(state);

  const openings = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doorsAll = openings.filter((o) => o && o.type === "door" && o.enabled !== false);
  const winsAll = openings.filter((o) => o && o.type === "window" && o.enabled !== false);

  const invalidDoorIds = Array.isArray(state.walls?.invalidDoorIds) ? state.walls.invalidDoorIds.map(String) : [];
  const invalidWinIds = Array.isArray(state.walls?.invalidWindowIds) ? state.walls.invalidWindowIds.map(String) : [];
  const invalidDoorSet = new Set(invalidDoorIds);
  const invalidWinSet = new Set(invalidWinIds);

  const invalidMat = (() => {
    try {
      if (scene._invalidOpeningMat) return scene._invalidOpeningMat;
      const m = new BABYLON.StandardMaterial("invalidOpeningMat", scene);
      m.diffuseColor = new BABYLON.Color3(0.85, 0.1, 0.1);
      m.emissiveColor = new BABYLON.Color3(0.35, 0.0, 0.0);
      scene._invalidOpeningMat = m;
      return m;
    } catch (e) {
      return null;
    }
  })();

  function mkBox(name, Lx, Ly, Lz, pos, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      {
        width: Lx / 1000,
        height: Ly / 1000,
        depth: Lz / 1000,
      },
      scene
    );
    mesh.position = new BABYLON.Vector3(
      (pos.x + Lx / 2) / 1000,
      (pos.y + Ly / 2) / 1000,
      (pos.z + Lz / 2) / 1000
    );
    mesh.material = mat;
    mesh.metadata = Object.assign({ dynamic: true, sectionId: sectionId || null }, meta || {});
    return mesh;
  }

  function mkSlopedPlateAlongX(name, Lx, Lz, origin, yTopAtX0, yTopAtX1, mat, meta) {

      console.log("SLOPE_PLATE_DEBUG", {
    name,
    yTopAtX0,
    yTopAtX1,
    plateY,
  });
    
    const x0 = origin.x;
    const x1 = origin.x + Lx;
    const z0 = origin.z;
    const z1 = origin.z + Lz;

    const yTop0 = Math.max(0, Math.floor(Number(yTopAtX0)));
    const yTop1 = Math.max(0, Math.floor(Number(yTopAtX1)));
    const yBot0 = Math.max(0, yTop0 - plateY);
    const yBot1 = Math.max(0, yTop1 - plateY);

    const positions = [
      x0, yBot0, z0,
      x1, yBot1, z0,
      x1, yBot1, z1,
      x0, yBot0, z1,

      x0, yTop0, z0,
      x1, yTop1, z0,
      x1, yTop1, z1,
      x0, yTop0, z1,
    ].map((v, i) => (i % 3 === 1 ? v : v) / 1000);

    const indices = [
      0, 1, 2, 0, 2, 3, // bottom
      4, 6, 5, 4, 7, 6, // top
      0, 5, 1, 0, 4, 5, // z0 face
      3, 2, 6, 3, 6, 7, // z1 face
      0, 3, 7, 0, 7, 4, // x0 face
      1, 5, 6, 1, 6, 2  // x1 face
    ];

    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const mesh = new BABYLON.Mesh(name, scene);
    vd.applyToMesh(mesh, true);

    // Ensure the custom sloped prism renders solid from all view angles (avoid back-face culling artifacts)
    let useMat = mat;
    try {
      if (mat) {
        if (!scene._slopedPlateMat) {
          const c = mat.clone ? mat.clone("slopedPlateMat") : null;
          if (c) {
            c.backFaceCulling = false;
            scene._slopedPlateMat = c;
          } else {
            // Fallback: do not mutate shared plate material if clone isn't available
            scene._slopedPlateMat = null;
          }
        }
        if (scene._slopedPlateMat) useMat = scene._slopedPlateMat;
      }
    } catch (e) {}

    mesh.material = useMat;
    mesh.metadata = Object.assign({ dynamic: true, sectionId: sectionId || null }, meta || {});
    return mesh;
  }

  // ---- Deferred cladding build (one frame later) ----
  const claddingJobs = [];

  // Unique per build3D invocation
  const buildId = (() => {
    try {
      const n = Number(scene._claddingBuildSeq || 0) + 1;
      scene._claddingBuildSeq = n;
      return `${Date.now()}-${n}`;
    } catch (e) {
      return `${Date.now()}-0`;
    }
  })();

  try {
    if (!window.__dbg) window.__dbg = {};
    window.__dbg.claddingPass = {
      buildId,
      timestamp: Date.now(),
      deferredScheduled: false,
      deferredRan: false,
      staleSkip: false,
      claddingMeshesCreated: 0,
      anchorsUsed: [],
      jobsCount: 0,
      jobsProcessedByWallId: {},
      meshesCreatedByWallId: {},
      sampleOutsideByWallId: {},
      perWall: {}
    };
  } catch (e) {}

  function addCladdingForPanel(wallId, axis, panelIndex, panelStart, panelLen, origin, panelHeight, buildPass) {
    const isAlongX = axis === "x";

    // Log the origin coordinates used for cladding panel
    console.log(`[CLADDING_ORIGIN] Wall=${wallId}, Panel=${panelIndex}, origin.x=${origin.x}, origin.z=${origin.z}, panelStart=${panelStart}, panelLen=${panelLen}`);

    if (__DIAG_ONE_FRONT_ONE_BOARD) {
      if (!(String(wallId) === "front" && Number(panelIndex) === 1)) {
        return { created: 0, anchor: null, reason: "diagSkipNotFrontPanel1" };
      }
    }

// Use wood grain material from babylon.js (created in boot())
    // Fallback: create simple material if wood grain not available
    let mat = null;
    console.log("CLADDING_MAT_CHECK", {
      hasScene: !!scene,
      hasCladdingMatLight: !!(scene && scene._claddingMatLight),
      hasMaterials: !!materials,
      hasTimber: !!(materials && materials.timber)
    });
    if (scene && scene._claddingMatLight) {
      mat = scene._claddingMatLight;
    } else if (materials && materials.timber) {
      mat = materials.timber;
    } else {
      mat = new BABYLON.StandardMaterial("claddingMatLight_fallback", scene);
      mat.diffuseColor = new BABYLON.Color3(0.85, 0.72, 0.55);
      mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
      mat.emissiveColor = new BABYLON.Color3(0.14, 0.10, 0.06);
    }
    console.log("CLADDING_MAT_RESULT", mat ? mat.name : "NULL");
    const ph = Number(panelHeight);
    const panelHeightMm = Number.isFinite(ph) ? ph : height;

    // Calculate courses with extra padding to ensure we extend past the wall top
    // The roof trim will cut it back to the correct height
    // For apex roofs, only front/back (gable) walls need extra courses - left/right stop at eaves
    const isApexGableWall = roofStyle === "apex" && (String(wallId) === "front" || String(wallId) === "back");
    const needsExtraCourses = roofStyle === "pent" || isApexGableWall;
    let courses = Math.max(1, Math.ceil(panelHeightMm / CLAD_H) + (needsExtraCourses ? 2 : 0));
    if (__DIAG_ONE_FRONT_ONE_BOARD) courses = 1;
    
    console.log("CLAD_DEBUG", {
      wallId,
      panelIndex,
      variant,
      roofStyle,
      panelHeightMm,
      CLAD_H,
      courses,
      plateY,
    });
    
    if (courses < 1) return { created: 0, anchor: null, reason: "courses<1" };

    const parts = [];

    // Anchor cladding to TOP of the wall panel's own bottom plate (world-space), not assumed y=0.
    let wallBottomPlateBottomY_mm = 0;
    let wallBottomPlateTopY_mm = plateY;
    let claddingAnchorY_mm = plateY;
    let plateParent = null;

    let xMin_mm = null;
    let xMax_mm = null;
    let zMin_mm = null;
    let zMax_mm = null;

    try {
      const plateName =
        (variant === "basic")
          ? `wall-${wallId}-panel-${panelIndex}-plate-bottom`
          : `wall-${wallId}-plate-bottom`;

      const plateMesh = scene.getMeshByName ? scene.getMeshByName(plateName) : null;
      if (plateMesh) {
        plateParent = plateMesh.parent || null;
      }
      if (plateMesh && plateMesh.getBoundingInfo) {
        try { plateMesh.computeWorldMatrix(true); } catch (e0) {}
        const bi = plateMesh.getBoundingInfo();
        const bb = bi && bi.boundingBox ? bi.boundingBox : null;
        if (bb && bb.minimumWorld && bb.maximumWorld) {
          wallBottomPlateBottomY_mm = Number(bb.minimumWorld.y) * 1000;
          wallBottomPlateTopY_mm = Number(bb.maximumWorld.y) * 1000;
          const desiredFirstBottomY_mm = wallBottomPlateBottomY_mm - CLAD_BOTTOM_DROP_MM;
         claddingAnchorY_mm = wallBottomPlateTopY_mm - CLAD_BOTTOM_DROP_MM;
          
// Make sure cladding reaches at least the top plate height for this wall
// Try both possible naming schemes for the top plate
const topPlateNames = [
  `wall-${wallId}-panel-${panelIndex}-plate-top`,
  `wall-${wallId}-plate-top`,
];

let topPlateMesh = null;
if (scene.getMeshByName) {
  for (let i = 0; i < topPlateNames.length; i++) {
    const m = scene.getMeshByName(topPlateNames[i]);
    if (m) {
      topPlateMesh = m;
      break;
    }
  }
}

if (topPlateMesh && topPlateMesh.getBoundingInfo) {
  const bbTop = topPlateMesh.getBoundingInfo().boundingBox;
  const topPlateTopY_mm = bbTop.maximumWorld.y * 1000;

  const needCourses = Math.ceil(
    (topPlateTopY_mm - claddingAnchorY_mm) / CLAD_H
  );

  if (Number.isFinite(needCourses) && needCourses > courses) {
    courses = needCourses;
  }
}


          xMin_mm = Number(bb.minimumWorld.x) * 1000;
          xMax_mm = Number(bb.maximumWorld.x) * 1000;
          zMin_mm = Number(bb.minimumWorld.z) * 1000;
          zMax_mm = Number(bb.maximumWorld.z) * 1000;
          console.log(`[PLATE_BBOX] Wall=${wallId}, Panel=${panelIndex}, plateName=${plateName}, xMin=${xMin_mm}, xMax=${xMax_mm}, zMin=${zMin_mm}, zMax=${zMax_mm}`);
        }
      }
    } catch (e) {}

    // FIX: If bbox lookup failed, use deterministic fallback based on wall geometry
    // This ensures cladding is always generated even if plate mesh lookup fails
    if (!Number.isFinite(xMin_mm) || !Number.isFinite(xMax_mm) || !Number.isFinite(zMin_mm) || !Number.isFinite(zMax_mm)) {
      if (isAlongX) {
        // Front/back walls run along X
        xMin_mm = origin.x + panelStart;
        xMax_mm = origin.x + panelStart + panelLen;
        zMin_mm = origin.z;
        zMax_mm = origin.z + wallThk;
      } else {
        // Left/right walls run along Z
        xMin_mm = origin.x;
        xMax_mm = origin.x + wallThk;
        zMin_mm = origin.z + panelStart;
        zMax_mm = origin.z + panelStart + panelLen;
      }
      // Use default Y anchoring
      wallBottomPlateBottomY_mm = 0;
      wallBottomPlateTopY_mm = plateY;
      const desiredFirstBottomY_mm = wallBottomPlateBottomY_mm - CLAD_BOTTOM_DROP_MM;
      claddingAnchorY_mm = desiredFirstBottomY_mm - 95;
    }

    // Determine outside plane + outward sign per panel (bbox-derived), with deterministic fallback ONLY if bbox invalid
    let outsidePlaneZ_mm = null;
    let outwardSignZ = 1;
    let outsidePlaneX_mm = null;
    let outwardSignX = 1;
    let bboxMissingFallbackUsed = false;

    try {
      if (isAlongX) {
        const hasZ = Number.isFinite(zMin_mm) && Number.isFinite(zMax_mm);
        if (hasZ) {
          const zMid = (zMin_mm + zMax_mm) / 2;
          const buildMidZ = Number(dims && Number.isFinite(dims.d) ? (dims.d / 2) : 0);
          if (zMid < buildMidZ) {
            outsidePlaneZ_mm = zMin_mm;
            outwardSignZ = -1;
          } else {
            outsidePlaneZ_mm = zMax_mm;
            outwardSignZ = 1;
          }
        } else {
          bboxMissingFallbackUsed = true;
          if (String(wallId) === "front") {
            outwardSignZ = -1;
            outsidePlaneZ_mm = Number(origin && Number.isFinite(origin.z) ? origin.z : 0);
          } else if (String(wallId) === "back") {
            outwardSignZ = 1;
            outsidePlaneZ_mm = Number(origin && Number.isFinite(origin.z) ? origin.z : 0) + wallThk;
          } else {
            outwardSignZ = 1;
            outsidePlaneZ_mm = Number(origin && Number.isFinite(origin.z) ? origin.z : 0) + wallThk;
          }
        }

        try {
          if (buildPass && buildPass.sampleOutsideByWallId) {
            const k = String(wallId || "");
            if (!buildPass.sampleOutsideByWallId[k]) {
              buildPass.sampleOutsideByWallId[k] = {
                axis,
                outsidePlane_mm: outsidePlaneZ_mm,
                outwardSign: outwardSignZ
              };
            }
          }
        } catch (e) {}
      } else {
        const hasX = Number.isFinite(xMin_mm) && Number.isFinite(xMax_mm);
        if (hasX) {
          const xMid = (xMin_mm + xMax_mm) / 2;
          const buildMidX = Number(dims && Number.isFinite(dims.w) ? (dims.w / 2) : 0);
          if (xMid < buildMidX) {
            outsidePlaneX_mm = xMin_mm;
            outwardSignX = -1;
          } else {
            outsidePlaneX_mm = xMax_mm;
            outwardSignX = 1;
          }
        } else {
          bboxMissingFallbackUsed = true;
          if (String(wallId) === "left") {
            outwardSignX = -1;
            outsidePlaneX_mm = Number(origin && Number.isFinite(origin.x) ? origin.x : 0);
          } else if (String(wallId) === "right") {
            outwardSignX = 1;
            outsidePlaneX_mm = Number(origin && Number.isFinite(origin.x) ? origin.x : 0) + wallThk;
          } else {
            outwardSignX = 1;
            outsidePlaneX_mm = Number(origin && Number.isFinite(origin.x) ? origin.x : 0) + wallThk;
          }
        }

        try {
          if (buildPass && buildPass.sampleOutsideByWallId) {
            const k = String(wallId || "");
            if (!buildPass.sampleOutsideByWallId[k]) {
              buildPass.sampleOutsideByWallId[k] = {
                axis,
                outsidePlane_mm: outsidePlaneX_mm,
                outwardSign: outwardSignX
              };
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // DEBUG per wall/panel anchor
    try {
      const firstCourseBottomY_mm = claddingAnchorY_mm - CLAD_DRIP;
      const expectedFirstCourseBottomY_mm = claddingAnchorY_mm - 30;

      if (!window.__dbg) window.__dbg = {};
      if (!window.__dbg.cladding) window.__dbg.cladding = {};
      if (!window.__dbg.cladding.walls) window.__dbg.cladding.walls = {};

      if (!window.__dbg.cladding.walls[wallId]) window.__dbg.cladding.walls[wallId] = [];
      window.__dbg.cladding.walls[wallId].push({
        wallId,
        wallBottomPlateTopY_mm,
        wallBottomPlateBottomY_mm,
        claddingAnchorY_mm,
        firstCourseBottomY_mm,
        expectedFirstCourseBottomY_mm,
        delta_mm: (firstCourseBottomY_mm - expectedFirstCourseBottomY_mm),
      });

      if (buildPass && buildPass.anchorsUsed) {
        buildPass.anchorsUsed.push({
          wallId,
          panelIndex,
          wallBottomPlateTopY_mm,
          wallBottomPlateBottomY_mm,
          claddingAnchorY_mm,
          firstCourseBottomY_mm,
          expectedFirstCourseBottomY_mm,
          delta_mm: (firstCourseBottomY_mm - expectedFirstCourseBottomY_mm),
        });
      }
    } catch (e) {}

    const panelMinAxis_mm = (axis === "x") ? xMin_mm : zMin_mm;
    const panelMaxAxis_mm = (axis === "x") ? xMax_mm : zMax_mm;

    // APEX gable fix:
    // Ensure the merged cladding mesh is tall enough to reach ABOVE the roof underside so the CSG roof-trim
    // leaves a fully clad triangle (gable infill). Only for front/back (gable) walls.
    if (
      apexRoofModel &&
      isAlongX &&
      (String(wallId) === "front" || String(wallId) === "back")
    ) {
      try {
        const xA0 = origin.x + Math.floor(Number(panelStart || 0));
        const xA1 = xA0 + Math.floor(Number(panelLen || 0));

        // Sample roof underside at endpoints and at ridge intersection (if within span)
        let maxNeedY_mm = Math.max(
          apexRoofModel.yUnderAtWorldX_mm(xA0),
          apexRoofModel.yUnderAtWorldX_mm(xA1)
        );

        const rx = apexRoofModel.ridgeWorldX_mm;
        if (Number.isFinite(rx) && rx > xA0 && rx < xA1) {
          maxNeedY_mm = Math.max(maxNeedY_mm, apexRoofModel.yUnderAtWorldX_mm(rx));
        }

        // Add small pad so we never end up exactly coplanar with the cutter line.
        const pad_mm = 10;
        const requiredTop_mm = Math.floor(maxNeedY_mm + pad_mm);

        // Approx top coverage: top ~= claddingAnchorY_mm + courses * CLAD_H
        // (first course has an extra +125mm lift but we ignore it for a conservative lower bound).
        const needCourses = Math.max(1, Math.ceil((requiredTop_mm - claddingAnchorY_mm) / CLAD_H) + 1);
        if (Number.isFinite(needCourses) && needCourses > courses) courses = needCourses;
      } catch (e) {}

      if (courses < 1) return { created: 0, anchor: null, reason: "courses<1(apexAdjust)" };
    }

    // FIX: PENT roof - ensure side walls (left/right) have enough courses to reach wall height
    if (isPent && !isAlongX && (String(wallId) === "left" || String(wallId) === "right")) {
      const targetH = (String(wallId) === "left") ? minH : maxH;
      const pad_mm = 10;
      const requiredTop_mm = Math.floor(targetH + pad_mm);
      const needCourses = Math.max(1, Math.ceil((requiredTop_mm - claddingAnchorY_mm) / CLAD_H) + 1);
      if (Number.isFinite(needCourses) && needCourses > courses) courses = needCourses;
    }

    // FIX: PENT roof - ensure front/back walls have enough courses to reach the sloped top
if (isPent && isAlongX && (String(wallId) === "front" || String(wallId) === "back")) {
  try {
    const xA0 = origin.x + Math.floor(Number(panelStart || 0));
    const xA1 = xA0 + Math.floor(Number(panelLen || 0));

    // Sample the sloped top at both ends of this panel
    const h0 = heightAtX(xA0);
    const h1 = heightAtX(xA1);
    const pad_mm = 10;
    const requiredTop_mm = Math.floor(Math.max(h0, h1) + pad_mm);

    // Make sure the cladding stack reaches at least requiredTop_mm
    const needCourses = Math.max(
      1,
      Math.ceil((requiredTop_mm - claddingAnchorY_mm) / CLAD_H) + 1
    );

    if (Number.isFinite(needCourses) && needCourses > courses) {
      courses = needCourses;
    }
  } catch (e) {}
}
console.log("CLAD_COURSES_FINAL", {
  wallId,
  panelIndex,
  isPent,
  isAlongX,
  panelHeightMm,
  claddingAnchorY_mm,
  CLAD_H,
  courses,
});

    for (let i = 0; i < courses; i++) {
      const isFirst = i === 0;
const yBase = claddingAnchorY_mm + i * CLAD_H;

      // OVERLAP CLADDING: Create single wedge-like boards per course
      if (claddingStyle === "overlap") {
        const boardHeight = CLAD_H + (isFirst ? CLAD_DRIP : 0);
        const yBoard = yBase - (isFirst ? CLAD_DRIP : 0);
        // Overlap boards: bottom edge sits further out than top edge
        // This creates the characteristic shadow line
        const overlapOffset = 8; // mm offset for overlap effect

        if (isAlongX) {
          const wallOutsideFaceWorld = (outsidePlaneZ_mm !== null ? outsidePlaneZ_mm : (origin.z + wallThk));
          const outwardNormalZ = outwardSignZ;
          const xShift_mm = (Number.isFinite(xMin_mm) ? Math.max(0, xMin_mm - (origin.x + panelStart)) : 0);
          const panelLenAdj = Math.max(1, panelLen - xShift_mm);

          // Bottom part of board (thicker, sits further out)
          const bottomPartHeight = Math.floor(boardHeight * 0.4);
          const boardCenterZ_bottom = wallOutsideFaceWorld + outwardNormalZ * (CLAD_T_TOP / 2 + overlapOffset / 2);
          const zMin_bottom = boardCenterZ_bottom - (CLAD_T_TOP / 2);

          const b0 = mkBox(
            `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
            panelLenAdj,
            bottomPartHeight,
            CLAD_T_TOP,
            { x: origin.x + panelStart + xShift_mm, y: yBoard, z: zMin_bottom },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "bottom", style: "overlap" }
          );
          parts.push(b0);

          // Top part of board (thinner, sits closer to wall)
          const topPartHeight = boardHeight - bottomPartHeight;
          const boardCenterZ_top = wallOutsideFaceWorld + outwardNormalZ * (CLAD_T_BOTTOM / 2);
          const zMin_top = boardCenterZ_top - (CLAD_T_BOTTOM / 2);

          const b1 = mkBox(
            `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
            panelLenAdj,
            topPartHeight,
            CLAD_T_BOTTOM,
            { x: origin.x + panelStart + xShift_mm, y: yBoard + bottomPartHeight, z: zMin_top },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "upper", style: "overlap" }
          );
          parts.push(b1);
        } else {
          // LEFT/RIGHT walls (along Z axis)
          const wallOutsideFaceWorld = (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));
          const outwardNormalX = outwardSignX;
          const zStart_mm = (Number.isFinite(zMin_mm) ? zMin_mm : (origin.z + panelStart));
          const zEnd_mm = (Number.isFinite(zMax_mm) ? zMax_mm : (origin.z + panelStart + panelLen));
          const panelLenAdj = Math.max(1, zEnd_mm - zStart_mm);

          // Bottom part of board
          const bottomPartHeight = Math.floor(boardHeight * 0.4);
          const boardCenterX_bottom = wallOutsideFaceWorld + outwardNormalX * (CLAD_T_TOP / 2 + overlapOffset / 2);
          const xMin_bottom = boardCenterX_bottom - (CLAD_T_TOP / 2);

          const b0 = mkBox(
            `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
            CLAD_T_TOP,
            bottomPartHeight,
            panelLenAdj,
            { x: xMin_bottom, y: yBoard, z: zStart_mm },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "bottom", style: "overlap" }
          );
          parts.push(b0);

          // Top part of board
          const topPartHeight = boardHeight - bottomPartHeight;
          const boardCenterX_top = wallOutsideFaceWorld + outwardNormalX * (CLAD_T_BOTTOM / 2);
          const xMin_top = boardCenterX_top - (CLAD_T_BOTTOM / 2);

          const b1 = mkBox(
            `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
            CLAD_T_BOTTOM,
            topPartHeight,
            panelLenAdj,
            { x: xMin_top, y: yBoard + bottomPartHeight, z: zStart_mm },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "upper", style: "overlap" }
          );
          parts.push(b1);
        }
        continue; // Skip the shiplap code below
      }

      // SHIPLAP CLADDING (default): Two-part profile with rabbets
      // Drip: first course only; bottom edge at (claddingAnchorY_mm - 30mm)
      // Implemented as bottom-only extension (no change to X/Z extents)
      const yBottomStrip = yBase - (isFirst ? CLAD_DRIP : 0);
      const hBottomStrip = CLAD_Hb + (isFirst ? CLAD_DRIP : 0);

      const yUpperStrip = yBase + CLAD_Hb;
      const hUpperStrip = Math.max(1, CLAD_H - CLAD_Hb);

      if (isFirst) {
        const panelFrameBottomY_mm = wallBottomPlateBottomY_mm;
        const claddingBottomY_mm = yBottomStrip;
        const diff_mm = claddingBottomY_mm - panelFrameBottomY_mm;
        const pass = Math.abs(diff_mm + 60) <= 2;
        console.log("CLAD_Y_CHECK wall=" + String(wallId) + " panel=" + String(panelIndex) + " panelFrameBottomY_mm=" + Math.round(panelFrameBottomY_mm) + " claddingBottomY_mm=" + Math.round(claddingBottomY_mm) + " diff_mm=" + Math.round(diff_mm) + " " + (pass ? "PASS" : "FAIL"));
      }

      if (isAlongX) {
        const wallOutsideFaceWorld = (outsidePlaneZ_mm !== null ? outsidePlaneZ_mm : (origin.z + wallThk));
        const outwardNormalZ = outwardSignZ;

        // Solve center placement so INNER face is exactly on wallOutsideFaceWorld:
        // boardCenterWorldZ = wallOutsideFaceWorld + outwardNormalZ * (CLAD_T/2)
        // mkBox expects MIN corner => minZ = centerZ - CLAD_T/2
        const boardCenterWorldZ = wallOutsideFaceWorld + outwardNormalZ * (CLAD_T / 2);
        const zBottomMin = boardCenterWorldZ - (CLAD_T / 2);

        const xShift_mm = (Number.isFinite(xMin_mm) ? Math.max(0, xMin_mm - (origin.x + panelStart)) : 0);
        const panelLenAdj = Math.max(1, panelLen - xShift_mm);

        const b0 = mkBox(
          `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
          panelLenAdj,
          hBottomStrip,
          CLAD_T,
          { x: origin.x + panelStart + xShift_mm, y: yBottomStrip, z: zBottomMin },
          mat,
          { wallId, panelIndex, course: i, type: "cladding", part: "bottom", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
        );
        parts.push(b0);

        const tUpper = Math.max(1, CLAD_T - CLAD_Rb);
        const boardCenterWorldZ_upper = wallOutsideFaceWorld + outwardNormalZ * (tUpper / 2);
        const zUpperMin = boardCenterWorldZ_upper - (tUpper / 2);

        const b1 = mkBox(
          `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
          panelLenAdj,
          hUpperStrip,
          tUpper,
          { x: origin.x + panelStart + xShift_mm, y: yUpperStrip, z: zUpperMin },
          mat,
          { wallId, panelIndex, course: i, type: "cladding", part: "upper", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
        );
        parts.push(b1);

        if (cladFitAgg && Number.isFinite(panelMinAxis_mm) && Number.isFinite(panelMaxAxis_mm)) {
          let cladMin_mm = +Infinity;
          let cladMax_mm = -Infinity;

          const ms = [b0, b1];
          for (let k = 0; k < ms.length; k++) {
            const m = ms[k];
            if (!m || !m.getBoundingInfo) continue;
            try { m.computeWorldMatrix(true); } catch (e0) {}
            let bi = null;
            try { bi = m.getBoundingInfo(); } catch (e1) { bi = null; }
            const bb = bi && bi.boundingBox ? bi.boundingBox : null;
            if (!bb || !bb.minimumWorld || !bb.maximumWorld) continue;

            const vMin = bb.minimumWorld;
            const vMax = bb.maximumWorld;

            const aMin = Number(vMin.x) * 1000;
            const aMax = Number(vMax.x) * 1000;

            if (Number.isFinite(aMin)) cladMin_mm = Math.min(cladMin_mm, aMin);
            if (Number.isFinite(aMax)) cladMax_mm = Math.max(cladMax_mm, aMax);
          }

          if (cladMin_mm !== +Infinity && cladMax_mm !== -Infinity) {
            recordCladFitSample(axis, wallId, panelIndex, i, panelMinAxis_mm, panelMaxAxis_mm, cladMin_mm, cladMax_mm);
          }
        }
      } else {
        // LEFT/RIGHT walls (along Z axis)
        const wallOutsideFaceWorld = (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));
        const outwardNormalX = outwardSignX;

        // Solve center placement so INNER face is exactly on wallOutsideFaceWorld:
        // boardCenterWorldX = wallOutsideFaceWorld + outwardNormalX * (CLAD_T/2)
        // mkBox expects MIN corner => minX = centerX - CLAD_T/2
        const boardCenterWorldX = wallOutsideFaceWorld + outwardNormalX * (CLAD_T / 2);
        const xBottomMin = boardCenterWorldX - (CLAD_T / 2);

        // FIX: Use the actual panel Z extents for cladding length
        const zStart_mm = (Number.isFinite(zMin_mm) ? zMin_mm : (origin.z + panelStart));
        const zEnd_mm = (Number.isFinite(zMax_mm) ? zMax_mm : (origin.z + panelStart + panelLen));
        const panelLenAdj = Math.max(1, zEnd_mm - zStart_mm);
        console.log(`[CLADDING_Z_POSITION] Wall=${wallId}, Panel=${panelIndex}, Course=${i}, zMin_mm=${zMin_mm}, origin.z=${origin.z}, panelStart=${panelStart}, zStart_mm=${zStart_mm}, expected=${origin.z + panelStart}, DIFF=${zStart_mm - (origin.z + panelStart)}`);

        const b0 = mkBox(
          `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
          CLAD_T,
          hBottomStrip,
          panelLenAdj,
          { x: xBottomMin, y: yBottomStrip, z: zStart_mm },
          mat,
          { wallId, panelIndex, course: i, type: "cladding", part: "bottom", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
        );
        parts.push(b0);

        const tUpper = Math.max(1, CLAD_T - CLAD_Rb);
        const boardCenterWorldX_upper = wallOutsideFaceWorld + outwardNormalX * (tUpper / 2);
        const xUpperMin = boardCenterWorldX_upper - (tUpper / 2);

        const b1 = mkBox(
          `${meshPrefix}clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
          tUpper,
          hUpperStrip,
          panelLenAdj,
          { x: xUpperMin, y: yUpperStrip, z: zStart_mm },
          mat,
          { wallId, panelIndex, course: i, type: "cladding", part: "upper", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
        );
        parts.push(b1);

        if (cladFitAgg && Number.isFinite(panelMinAxis_mm) && Number.isFinite(panelMaxAxis_mm)) {
          let cladMin_mm = +Infinity;
          let cladMax_mm = -Infinity;

          const ms = [b0, b1];
          for (let k = 0; k < ms.length; k++) {
            const m = ms[k];
            if (!m || !m.getBoundingInfo) continue;
            try { m.computeWorldMatrix(true); } catch (e0) {}
            let bi = null;
            try { bi = m.getBoundingInfo(); } catch (e1) { bi = null; }
            const bb = bi && bi.boundingBox ? bi.boundingBox : null;
            if (!bb || !bb.minimumWorld || !bb.maximumWorld) continue;

            const vMin = bb.minimumWorld;
            const vMax = bb.maximumWorld;

            const aMin = Number(vMin.z) * 1000;
            const aMax = Number(vMax.z) * 1000;

            if (Number.isFinite(aMin)) cladMin_mm = Math.min(cladMin_mm, aMin);
            if (Number.isFinite(aMax)) cladMax_mm = Math.max(cladMax_mm, aMax);
          }

          if (cladMin_mm !== +Infinity && cladMax_mm !== -Infinity) {
            recordCladFitSample(axis, wallId, panelIndex, i, panelMinAxis_mm, panelMaxAxis_mm, cladMin_mm, cladMax_mm);
          }
        }
      }
    }

    if (parts.length === 0) {
      return {
        created: 0,
        anchor: {
          wallId,
          panelIndex,
          wallBottomPlateTopY_mm,
          wallBottomPlateBottomY_mm,
          claddingAnchorY_mm
        },
        reason: "parts.length==0",
        bboxMissingFallbackUsed
      };
    }

    // Merge into one mesh per panel
    let merged = null;
    try {
      merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    } catch (e) {
      merged = null;
    }

    let created = 0;

    if (merged) {
      // ---- NEW: cut openings (doors/windows) through merged cladding panel mesh ----

      try {
      
        const hasCSG =
          typeof BABYLON !== "undefined" &&
          BABYLON &&
          BABYLON.CSG &&
          typeof BABYLON.CSG.FromMesh === "function";

        if (hasCSG) {
          const panelA0 = Math.floor(Number(panelStart || 0));
          const panelA1 = Math.floor(Number(panelStart || 0) + Number(panelLen || 0));

          const doors = doorIntervalsForWall(String(wallId || ""));
          const wins = windowIntervalsForWall(String(wallId || ""));

          const CUT_EXTRA = 80;
          const cutDepth = Math.max(1, Math.floor(CLAD_T + 2 * CUT_EXTRA));

          const wallOutsideFaceWorld = isAlongX
            ? (outsidePlaneZ_mm !== null ? outsidePlaneZ_mm : (origin.z + wallThk))
            : (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));

          const outwardNormal = isAlongX ? outwardSignZ : outwardSignX;

          const cutMinOut_mm = (outwardNormal === 1)
            ? Math.floor(wallOutsideFaceWorld - CUT_EXTRA)
            : Math.floor(wallOutsideFaceWorld - (CLAD_T + CUT_EXTRA));

          const cutters = [];

          function addCutterSpan(a0, a1, y0, y1) {
            console.log(`[CUTTER_CLAMP] Wall=${wallId}, panelA0=${panelA0}, panelA1=${panelA1}, a0=${a0}, a1=${a1}`);
            const s0 = Math.max(panelA0, Math.floor(Number(a0)));
            const s1 = Math.min(panelA1, Math.floor(Number(a1)));
            console.log(`[CUTTER_RESULT] After clamping: s0=${s0}, s1=${s1}, len=${s1-s0}`);
            const len = Math.max(0, s1 - s0);
            const hh = Math.max(0, Math.floor(Number(y1)) - Math.floor(Number(y0)));
            if (len < 1 || hh < 1) return;

            const name = `cladcut-${String(wallId)}-panel-${String(panelIndex)}-${String(cutters.length)}`;
            let m = null;

            if (isAlongX) {
              // Front/back walls use origin.x directly (no plate bbox offset issue)
              const cutoutLeftEdge = origin.x + s0;
              const cutoutRightEdge = origin.x + s1;
              const cutoutX = origin.x + s0 + len / 2;
              console.log(`[CUTOUT_X] Wall=${wallId}, origin.x=${origin.x}, EDGES: Left=${cutoutLeftEdge}, Right=${cutoutRightEdge}`);
              m = BABYLON.MeshBuilder.CreateBox(
                name,
                { width: len / 1000, height: hh / 1000, depth: cutDepth / 1000 },
                scene
              );
              m.position = new BABYLON.Vector3(
                cutoutX / 1000,
                (Math.floor(Number(y0)) + hh / 2) / 1000,
                (cutMinOut_mm + cutDepth / 2) / 1000
              );
} else {
              // FIX: Use wall origin coordinates for left/right wall cutouts
              // s0 and s1 are already in wall coordinates (0 to wall_length),
              // so we add origin.z to convert to world coordinates.
              // This matches how front/back walls work (origin.x + s0)
              const cutoutLeftEdge = origin.z + s0;
              const cutoutRightEdge = origin.z + s1;
              const cutoutZ = origin.z + s0 + len / 2;
              console.log(`[CUTOUT_Z] Wall=${wallId}, origin.z=${origin.z}, s0=${s0}, s1=${s1}, cutoutZ=${cutoutZ}, EDGES: Left=${cutoutLeftEdge} (origin.z + s0), Right=${cutoutRightEdge} (origin.z + s1)`);
              m = BABYLON.MeshBuilder.CreateBox(
                name,
                { width: cutDepth / 1000, height: hh / 1000, depth: len / 1000 },
                scene
              );
              m.position = new BABYLON.Vector3(
                (cutMinOut_mm + cutDepth / 2) / 1000,
                (Math.floor(Number(y0)) + hh / 2) / 1000,
                cutoutZ / 1000
              );
            }

            if (m) cutters.push(m);
          }

console.log(`[CLADDING_CSG] Wall=${wallId}, Panel=${panelIndex}, PanelStart=${panelStart}, PanelLen=${panelLen}, Processing ${doors.length} doors for cutouts`);
for (let i = 0; i < doors.length; i++) {
            const d = doors[i];
            console.log(`[DOOR_CUTOUT] Wall=${wallId}, Panel=${panelIndex}, DoorID=${d.id}, d.x0=${d.x0}, d.x1=${d.x1}, calling addCutterSpan`);
            // Door cladding cut must use world coordinates (cladding is shifted by wallBottomPlateBottomY_mm)
            const y0 = wallBottomPlateBottomY_mm + plateY;
            const y1 = wallBottomPlateBottomY_mm + plateY + Math.max(1, Math.floor(Number(d.h || 0)));
            addCutterSpan(d.x0, d.x1, y0, y1);
          }

console.log(`[WINDOW_CSG] Wall=${wallId}, Panel=${panelIndex}, Processing ${wins.length} windows for cutouts`);
for (let i = 0; i < wins.length; i++) {
            const w = wins[i];
            console.log(`[WINDOW_CUTOUT] Wall=${wallId}, Panel=${panelIndex}, WindowID=${w.id}, w.x0=${w.x0}, w.x1=${w.x1}, calling addCutterSpan`);
            // Match window framing Y calculation exactly:
            // Window framing uses wallTop which varies by position for sloped walls
            const isSlopeWallClad = isPent && isAlongX && (String(wallId) === "front" || String(wallId) === "back");
            const centerX = origin.x + Math.floor((w.x0 + w.x1) / 2);
            const wallTopForWin = isSlopeWallClad ? heightAtX(centerX) : panelHeightMm;

            // Cladding is built in world coordinates (anchored to shifted plate mesh).
            // Window y values are in local wall coordinates, so we need to add the wall shift.
            const wallShiftY = wallBottomPlateBottomY_mm;

            const y0WinLocal = plateY + Math.max(0, Math.floor(Number(w.y || 0)));
            const yTopWinLocal = y0WinLocal + Math.max(100, Math.floor(Number(w.h || 0)));
            const maxFeatureYLocal = Math.max(plateY, wallTopForWin - prof.studH);
            const y0ClampedLocal = Math.min(y0WinLocal, maxFeatureYLocal);
            const y1ClampedLocal = Math.min(yTopWinLocal, maxFeatureYLocal);

            // Convert to world coordinates for the cladding cutout
            const cutY0 = wallShiftY + y0ClampedLocal;
            const cutY1 = wallShiftY + y1ClampedLocal;
            addCutterSpan(w.x0, w.x1, cutY0, cutY1);
          }

          if (cutters.length) {
            let cutterCSG = null;
            try {
              cutterCSG = BABYLON.CSG.FromMesh(cutters[0]);
              for (let i = 1; i < cutters.length; i++) {
                try {
                  const c = BABYLON.CSG.FromMesh(cutters[i]);
                  cutterCSG = cutterCSG.union(c);
                } catch (e) {}
              }
            } catch (e) {
              cutterCSG = null;
            }

            if (cutterCSG) {
              let resMesh = null;
              try {
                const baseCSG = BABYLON.CSG.FromMesh(merged);
                const resCSG = baseCSG.subtract(cutterCSG);
                resMesh = resCSG.toMesh(`${meshPrefix}clad-${wallId}-panel-${panelIndex}`, mat, scene, false);
              } catch (e) {
                resMesh = null;
              }

              if (resMesh) {
                try { if (merged && !merged.isDisposed()) merged.dispose(false, true); } catch (e) {}
                merged = resMesh;
              }
            }

            for (let i = 0; i < cutters.length; i++) {
              try { if (cutters[i] && !cutters[i].isDisposed()) cutters[i].dispose(false, true); } catch (e) {}
            }
          }
        }
      } catch (e) {}
      // ---- END openings cut-outs ----

      // ---- NEW: clip cladding to roof underside (pent) / gable line (apex) ----
      try {
        console.log('DEBUG ROOF CLIP ENTRY: merged=', !!merged);
        const hasCSG =
          typeof BABYLON !== "undefined" &&
          BABYLON &&
          BABYLON.CSG &&
          typeof BABYLON.CSG.FromMesh === "function";

        if (hasCSG && merged) {
         const roofStyle = state && state.roof ? String(state.roof.style || "") : "";
console.log('DEBUG CSG roofStyle:', roofStyle, 'state.roof=', state?.roof);

          // Only proceed if we have a roof style that needs clipping
          if (roofStyle === "pent" || roofStyle === "apex") {
            const CUT_EXTRA_ROOF = 120;
            const cutDepthRoof = Math.max(1, Math.floor(CLAD_T + 2 * CUT_EXTRA_ROOF));

            let cutterCSG = null;

            if (isAlongX && (String(wallId) === "front" || String(wallId) === "back")) {
              // Front/back walls - sloped cut for pent, gable cut for apex
              const wallOutsideFaceWorldZ = (outsidePlaneZ_mm !== null ? outsidePlaneZ_mm : (origin.z + wallThk));
              const outwardNormalZ = outwardSignZ;

              // FIX: Position the cutter to fully encompass the cladding regardless of outward direction
              const cutMinZ_mm = Math.floor(wallOutsideFaceWorldZ - CUT_EXTRA_ROOF);
              const cutMaxZ_mm = Math.floor(wallOutsideFaceWorldZ + CLAD_T + CUT_EXTRA_ROOF);

              const z0r = cutMinZ_mm;
              const z1r = cutMaxZ_mm;

              function mkWedgeAboveLineX_Fixed(name, xa0_mm, xa1_mm, yLine0_mm, yLine1_mm) {
                const x0 = Math.floor(Number(xa0_mm));
                const x1 = Math.floor(Number(xa1_mm));
                const y0 = Math.floor(Number(yLine0_mm));
                const y1 = Math.floor(Number(yLine1_mm));

                const yTop = Math.max(y0, y1) + 20000;

                console.log('[WEDGE_DEBUG]', name, { x0, x1, y0, y1, yTop, z0r, z1r });

                const positions = [
                  x0, y0, z0r,
                  x1, y1, z0r,
                  x1, y1, z1r,
                  x0, y0, z1r,

                  x0, yTop, z0r,
                  x1, yTop, z0r,
                  x1, yTop, z1r,
                  x0, yTop, z1r,
                ].map((v) => v / 1000);

                const indices = [
                  0, 2, 1, 0, 3, 2,
                  4, 5, 6, 4, 6, 7,
                  0, 5, 4, 0, 1, 5,
                  3, 6, 2, 3, 7, 6,
                  0, 7, 3, 0, 4, 7,
                  1, 6, 5, 1, 2, 6
                ];

                const normals = [];
                BABYLON.VertexData.ComputeNormals(positions, indices, normals);

                const vd = new BABYLON.VertexData();
                vd.positions = positions;
                vd.indices = indices;
                vd.normals = normals;

                const m = new BABYLON.Mesh(name, scene);
                vd.applyToMesh(m, true);
                return m;
              }

              if (roofStyle === "pent") {
                const xA0 = origin.x + Math.floor(Number(panelStart || 0));
                const xA1 = xA0 + Math.floor(Number(panelLen || 0));
                
  // Don't let the cladding clip line go below the top plate height
  let minClipY_mm = 0;
  try {
    const topPlateName =
      (variant === "basic")
        ? `wall-${wallId}-panel-${panelIndex}-plate-top`
        : `wall-${wallId}-plate-top`;

    const topPlateMesh = scene.getMeshByName && scene.getMeshByName(topPlateName);
    if (topPlateMesh && topPlateMesh.getBoundingInfo) {
      const bbTop = topPlateMesh.getBoundingInfo().boundingBox;
      const topPlateTopY_mm = bbTop.maximumWorld.y * 1000;
      minClipY_mm = Math.max(minClipY_mm, topPlateTopY_mm);
    }
  } catch (e) {}

          // PENT: clip to underside line (not wall top). Drop by top-plate thickness.
                const PENT_CLIP_DROP_MM = plateY;
               // Add WALL_RISE_MM because walls are shifted up by this amount
                const WALL_RISE_MM_CSG_SLOPE = 168;
                const yA0 = Math.max(0, heightAtX(xA0) - PENT_CLIP_DROP_MM + WALL_RISE_MM_CSG_SLOPE);
                const yA1 = Math.max(0, heightAtX(xA1) - PENT_CLIP_DROP_MM + WALL_RISE_MM_CSG_SLOPE);


                console.log("PENT_CLAD_CUT", {
                  wallId,
                  panelIndex,
                  xA0,
                  xA1,
                  PENT_CLIP_DROP_MM,
                  yA0,
                  yA1,
                });

                
                const wedge = mkWedgeAboveLineX_Fixed(
                  `cladroofcut-${String(wallId)}-panel-${String(panelIndex)}-pent`,
                  xA0,
                  xA1,
                  yA0,
                  yA1
                );

                try { cutterCSG = BABYLON.CSG.FromMesh(wedge); } catch (e) { cutterCSG = null; }
                try { if (wedge && !wedge.isDisposed()) wedge.dispose(false, true); } catch (e) {}
              } else if (roofStyle === "apex") {
                // APEX gable trim:
                // Use the same rise + underside profile as roof.js so the gable triangle is filled and matches the roof.
console.log('DEBUG apexRoofModel:', apexRoofModel);
if (apexRoofModel) {
  const xA0 = origin.x + Math.floor(Number(panelStart || 0));
  const xA1 = xA0 + Math.floor(Number(panelLen || 0));
  console.log('DEBUG apex cut: xA0=', xA0, 'xA1=', xA1, 'yAt(xA0)=', apexRoofModel.yUnderAtWorldX_mm(xA0), 'yAt(ridge)=', apexRoofModel.yUnderAtWorldX_mm(1500));

                  const wedges = [];
                  const ridgeX = Number(apexRoofModel.ridgeWorldX_mm);

                  const yAt = (x_mm) => Math.floor(apexRoofModel.yUnderAtWorldX_mm(x_mm));

                  console.log('[APEX_WEDGE_CALC] ridgeX=', ridgeX, 'yAt(xA0)=', yAt(xA0), 'yAt(ridgeX)=', yAt(ridgeX), 'yAt(xA1)=', yAt(xA1));

                  // Piecewise-linear: split at ridge if the span crosses it (slope flips).
                  if (Number.isFinite(ridgeX) && ridgeX > xA0 && ridgeX < xA1) {
                    wedges.push(
                      mkWedgeAboveLineX_Fixed(
                        `cladroofcut-${String(wallId)}-panel-${String(panelIndex)}-apexL`,
                        xA0, ridgeX,
                        yAt(xA0), yAt(ridgeX)
                      )
                    );
                    wedges.push(
                      mkWedgeAboveLineX_Fixed(
                        `cladroofcut-${String(wallId)}-panel-${String(panelIndex)}-apexR`,
                        ridgeX, xA1,
                        yAt(ridgeX), yAt(xA1)
                      )
                    );
                  } else {
                    wedges.push(
                      mkWedgeAboveLineX_Fixed(
                        `cladroofcut-${String(wallId)}-panel-${String(panelIndex)}-apex`,
                        xA0, xA1,
                        yAt(xA0), yAt(xA1)
                      )
                    );
                  }

                  if (wedges.length) {
                    try {
                      cutterCSG = BABYLON.CSG.FromMesh(wedges[0]);
                      for (let wi = 1; wi < wedges.length; wi++) {
                        try {
                          cutterCSG = cutterCSG.union(BABYLON.CSG.FromMesh(wedges[wi]));
                        } catch (e) {
                          console.error('APEX CSG union error:', e);
                        }
                      }
                    } catch (e) {
                      console.error('APEX CSG error:', e);
                      cutterCSG = null;
                    }
                  }

                  for (let wi = 0; wi < wedges.length; wi++) {
                    try { if (wedges[wi] && !wedges[wi].isDisposed()) wedges[wi].dispose(false, true); } catch (e) {}
                  }
                }
              }
            } else if (!isAlongX && (String(wallId) === "left" || String(wallId) === "right")) {
              // Left/right walls - horizontal cut at constant height for pent roofs
              if (roofStyle === "pent" && !(String(wallId) === "front" || String(wallId) === "back")) {

                const wallOutsideFaceWorldX = (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));

                // FIX: Position the cutter to fully encompass the cladding regardless of outward direction
                const cutMinX_mm = Math.floor(wallOutsideFaceWorldX - CUT_EXTRA_ROOF);
                const cutMaxX_mm = Math.floor(wallOutsideFaceWorldX + CLAD_T + CUT_EXTRA_ROOF);

                // Left wall cuts at minH, right wall cuts at maxH
                // PENT: clip to underside line (not wall top). Drop by top-plate thickness.
                const PENT_CLIP_DROP_MM = plateY;
             // Add WALL_RISE_MM because walls are shifted up by this amount
                const WALL_RISE_MM_CSG = 168;
                const cutHeightRaw = ((String(wallId) === "left") ? minH : maxH) + WALL_RISE_MM_CSG;
                const cutHeight = Math.max(0, Math.floor(cutHeightRaw - PENT_CLIP_DROP_MM));

                // FIX: Use the actual cladding Z extents
                const zA0 = (Number.isFinite(zMin_mm) ? zMin_mm : (origin.z + Math.floor(Number(panelStart || 0))));
                const zA1 = (Number.isFinite(zMax_mm) ? zMax_mm : (origin.z + Math.floor(Number(panelStart || 0)) + Math.floor(Number(panelLen || 0))));

                // Create a box cutter above the cut height
                const cutterHeight = 20000; // Tall enough to cut everything above
                const cutterBox = BABYLON.MeshBuilder.CreateBox(
                  `cladroofcut-${String(wallId)}-panel-${String(panelIndex)}-pent`,
                  {
                    width: (cutMaxX_mm - cutMinX_mm) / 1000,
                    height: cutterHeight / 1000,
                    depth: (zA1 - zA0) / 1000
                  },
                  scene
                );
                cutterBox.position = new BABYLON.Vector3(
                  (cutMinX_mm + (cutMaxX_mm - cutMinX_mm) / 2) / 1000,
                  (cutHeight + cutterHeight / 2) / 1000,
                  (zA0 + (zA1 - zA0) / 2) / 1000
                );

                try { cutterCSG = BABYLON.CSG.FromMesh(cutterBox); } catch (e) { cutterCSG = null; }
                try { if (cutterBox && !cutterBox.isDisposed()) cutterBox.dispose(false, true); } catch (e) {}
              }
              // Note: apex roofs don't need left/right wall trimming as they have constant eaves height
            }

            if (cutterCSG) {
              console.log('DEBUG CSG: cutterCSG created, attempting clip for wall', wallId, 'panel', panelIndex);
              console.log('DEBUG CSG: merged mesh exists?', !!merged, 'isDisposed?', merged?.isDisposed?.());
              console.log('DEBUG CSG: merged mesh has geometry?', !!merged?.getTotalVertices?.(), 'vertices:', merged?.getTotalVertices?.());

              // Log merged mesh bounding box BEFORE CSG
              try {
                merged.computeWorldMatrix(true);
                merged.refreshBoundingInfo();
                const bbBefore = merged.getBoundingInfo().boundingBox;
                console.log('[CLAD_BBOX_BEFORE]', wallId, {
                  minY: bbBefore.minimumWorld.y * 1000,
                  maxY: bbBefore.maximumWorld.y * 1000,
                  minX: bbBefore.minimumWorld.x * 1000,
                  maxX: bbBefore.maximumWorld.x * 1000,
                  minZ: bbBefore.minimumWorld.z * 1000,
                  maxZ: bbBefore.maximumWorld.z * 1000
                });
              } catch (e) { console.warn('Could not get bbox before:', e); }

              let resMesh = null;
              try {
                console.log('DEBUG CSG: Creating baseCSG from merged mesh...');
                const baseCSG = BABYLON.CSG.FromMesh(merged);
                console.log('DEBUG CSG: baseCSG created, performing subtract...');
                const resCSG = baseCSG.subtract(cutterCSG);
                console.log('DEBUG CSG: subtract complete, converting to mesh...');
                resMesh = resCSG.toMesh(`${meshPrefix}clad-${wallId}-panel-${panelIndex}-roofclip`, mat, scene, false);
                console.log('DEBUG CSG: resMesh created successfully:', !!resMesh);
              } catch (e) {
                console.error('DEBUG CSG: ERROR during CSG operations:', e);
                resMesh = null;
              }

              if (resMesh) {
                console.log('DEBUG CSG: Disposing old merged mesh and replacing with clipped version');
                try { if (merged && !merged.isDisposed()) merged.dispose(false, true); } catch (e) {
                  console.error('DEBUG CSG: Error disposing old mesh:', e);
                }
                merged = resMesh;
                // Mark as already trimmed so roof.js observable doesn't re-trim
                merged.metadata = Object.assign({}, merged.metadata || {}, { trimmedToRoofApex: true });
                console.log('DEBUG CSG: Merged replaced with clipped mesh, marked trimmedToRoofApex=true');

                // Log merged mesh bounding box AFTER CSG
                try {
                  merged.computeWorldMatrix(true);
                  merged.refreshBoundingInfo();
                  const bbAfter = merged.getBoundingInfo().boundingBox;
                  console.log('[CLAD_BBOX_AFTER]', wallId, {
                    minY: bbAfter.minimumWorld.y * 1000,
                    maxY: bbAfter.maximumWorld.y * 1000,
                    minX: bbAfter.minimumWorld.x * 1000,
                    maxX: bbAfter.maximumWorld.x * 1000,
                    minZ: bbAfter.minimumWorld.z * 1000,
                    maxZ: bbAfter.maximumWorld.z * 1000
                  });
                } catch (e) { console.warn('Could not get bbox after:', e); }
              } else {
                console.warn('DEBUG CSG: resMesh is null, keeping original merged mesh');
              }
            } else {
              console.log('DEBUG CSG: No cutterCSG created for wall', wallId, 'panel', panelIndex);
            }
          }
        }
      } catch (e) {}
      // ---- END roof clip ----

merged.name = `${meshPrefix}clad-${wallId}-panel-${panelIndex}`;
      // Apply wall overhang shift for front/back walls only
      // Front/back cladding is built using origin coordinates, not plate bbox world positions,
      // so it needs the -25mm X shift to match the wall frame position.
      // Left/right cladding uses plate bbox world positions which are already shifted,
      // so no additional Z shift is needed.
      const WALL_OVERHANG_MM = 25;
      if (isAlongX) {
        // Front/back walls - shift X to align with shifted wall frame
        merged.position.x -= WALL_OVERHANG_MM / 1000;
      }
      // Left/right walls - NO shift needed (bbox positions already in world coords)

  merged.material = mat;
      console.log(
  "CLAD_MAT_DETAILS",
  merged.name,
  "class=", merged.material?.getClassName?.(),
  "name=", merged.material?.name,
  "diffTex=", !!merged.material?.diffuseTexture,
  "albTex=", !!merged.material?.albedoTexture,
  "diffCol=", merged.material?.diffuseColor,
  "albCol=", merged.material?.albedoColor,
  "emiss=", merged.material?.emissiveColor
);

      console.log(
  "CLAD_MAT_APPLIED",
  merged.name,
  merged.material && merged.material.name,
  merged.material && merged.material.diffuseColor
);

      merged.metadata = Object.assign({ dynamic: true, sectionId: sectionId || null }, merged.metadata || {}, { wallId, panelIndex, type: "cladding" });

      // FINAL DEBUG: Log mesh state right before parenting
      try {
        merged.computeWorldMatrix(true);
        merged.refreshBoundingInfo();
        const bbFinal = merged.getBoundingInfo().boundingBox;
        console.log('[CLAD_FINAL]', wallId, merged.name, {
          maxY: bbFinal.maximumWorld.y * 1000,
          vertices: merged.getTotalVertices()
        });
      } catch (e) {}

      if (plateParent) {
        try {
          const absPos = merged.getAbsolutePosition ? merged.getAbsolutePosition().clone() : null;
          merged.parent = plateParent;
          if (absPos && merged.setAbsolutePosition) merged.setAbsolutePosition(absPos);
        } catch (e) {
          try { merged.parent = plateParent; } catch (e2) {}
        }
      }

      created = 1;
    } else {
      // If merge failed for any reason, keep parts as-is; still bind them to the wall's parent if present.
      if (plateParent) {
        for (let i = 0; i < parts.length; i++) {
          try {
            const absPos = parts[i].getAbsolutePosition ? parts[i].getAbsolutePosition().clone() : null;
            parts[i].parent = plateParent;
            if (absPos && parts[i].setAbsolutePosition) parts[i].setAbsolutePosition(absPos);
          } catch (e) {
            try { parts[i].parent = plateParent; } catch (e2) {}
          }
        }
      }
      created = parts.length;
    }

    return {
      created,
      anchor: {
        wallId,
        panelIndex,
        wallBottomPlateTopY_mm,
        wallBottomPlateBottomY_mm,
        claddingAnchorY_mm
      },
      reason: (merged ? null : "mergeFailed"),
      bboxMissingFallbackUsed
    };
  }
// REPLACE your entire existing scheduleDeferredCladdingPass() function
// (and any duplicate/partial versions of it) with THIS single function.
// Anchor: search for `function scheduleDeferredCladdingPass()` and replace
// from that line down to its matching closing `}`.
function addCornerBoards(scene, state, wallThk, plateY, height, minH, maxH, isPent, materials, apexRoofModel) {
  const CLAD_T = 20;
  const CORNER_BOARD_THICKNESS = 20;
  const CLAD_BOTTOM_DROP_MM = 60;
  const WALL_RISE_MM = 168;
  
  // Corner board width = frame depth + cladding thickness
  const cornerBoardWidth = wallThk + CLAD_T;
  
  // Get actual wall positions by querying wall plate bounding boxes
  // This ensures corner boards match wall positions after all shifts
  let leftWallMinZ = null, leftWallMaxZ = null;
  let leftWallX = null, rightWallX = null;
  
  try {
    for (let i = 0; i < scene.meshes.length; i++) {
      const m = scene.meshes[i];
      if (!m || !m.name) continue;
      
      if (m.name.indexOf("wall-left-plate-bottom") !== -1) {
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        leftWallMinZ = bb.minimumWorld.z * 1000;
        leftWallMaxZ = bb.maximumWorld.z * 1000;
        leftWallX = bb.minimumWorld.x * 1000;
      }
      
      if (m.name.indexOf("wall-right-plate-bottom") !== -1) {
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        rightWallX = bb.maximumWorld.x * 1000;
      }
    }
  } catch (e) {
    console.warn("addCornerBoards: failed to query wall positions", e);
  }
  
  // If we couldn't find wall plates, skip corner boards
  if (leftWallMinZ === null || leftWallMaxZ === null || leftWallX === null || rightWallX === null) {
    console.warn("addCornerBoards: could not find wall plate positions");
    return;
  }
  
  // Bottom Y: same as cladding bottom (starts below plate with drip)
  const bottomY_mm = WALL_RISE_MM - CLAD_BOTTOM_DROP_MM;
  
  // Calculate top Y based on roof style - must match cladding trim line
  function getTopY_mm(wallId) {
    let topY_mm;
    
    if (isPent) {
      if (wallId === "left") {
        topY_mm = minH + WALL_RISE_MM - plateY;
      } else {
        topY_mm = maxH + WALL_RISE_MM - plateY;
      }
    } else if (apexRoofModel) {
      topY_mm = height + WALL_RISE_MM - plateY;
    } else {
      topY_mm = height + WALL_RISE_MM - plateY;
    }
    
    return topY_mm;
  }
  
  // Create a corner board
  function createCornerBoard(name, xPos, zPos, wallId) {
    const topY_mm = getTopY_mm(wallId);
    const boardHeight_mm = Math.max(100, topY_mm - bottomY_mm);
    
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      {
        width: CORNER_BOARD_THICKNESS / 1000,
        height: boardHeight_mm / 1000,
        depth: cornerBoardWidth / 1000
      },
      scene
    );
    
    mesh.position = new BABYLON.Vector3(
      xPos / 1000,
      (bottomY_mm + boardHeight_mm / 2) / 1000,
      zPos / 1000
    );
    
    // Apply material directly from scene cache
    if (scene._claddingMatLight) {
      mesh.material = scene._claddingMatLight;
    }
    
    mesh.metadata = { dynamic: true, sectionId: sectionId || null, part: "corner-board", wall: wallId, cladding: true };
    
    return mesh;
  }
  
  // Position corner boards relative to actual wall positions
  // Left wall X position: outside of left wall cladding
  const leftX = leftWallX - CLAD_T - CORNER_BOARD_THICKNESS / 2;
  // Right wall X position: outside of right wall cladding  
  const rightX = rightWallX + CLAD_T + CORNER_BOARD_THICKNESS / 2;
  
  // Z positions: at the front and back of the left/right walls
  const frontZ = leftWallMinZ - cornerBoardWidth / 2;
  const backZ = leftWallMaxZ + cornerBoardWidth / 2;
  
  // Create the four corner boards
  createCornerBoard(meshPrefix + "corner-board-left-front", leftX, frontZ, "left");
  createCornerBoard(meshPrefix + "corner-board-left-back", leftX, backZ, "left");
  createCornerBoard(meshPrefix + "corner-board-right-front", rightX, frontZ, "right");
  createCornerBoard(meshPrefix + "corner-board-right-back", rightX, backZ, "right");
}
  
function scheduleDeferredCladdingPass() {
  try {
    scene._pendingCladding = { buildId, jobs: claddingJobs };
  } catch (e) {}

  try {
    if (!window.__dbg) window.__dbg = {};
    if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
    window.__dbg.claddingPass.deferredScheduled = true;
  } catch (e) {}

  // --- helper: ensure final cladding meshes have a material (CSG can drop it) ---
function ensureCladdingMaterialOnMeshes() {
    try {
      // Ensure the light material exists
      if (!scene._claddingMatLight) {
        const m = new BABYLON.StandardMaterial("claddingMatLight", scene);
        m.diffuseColor = new BABYLON.Color3(0.85, 0.72, 0.55);
        m.emissiveColor = new BABYLON.Color3(0.17, 0.14, 0.11);
        m.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
        m.specularPower = 16;
        scene._claddingMatLight = m;
      }

      const mat = scene._claddingMatLight;

      let cladHits = 0;
      let cornerHits = 0;
      let attachmentHits = 0;
      for (let i = 0; i < scene.meshes.length; i++) {
        const mesh = scene.meshes[i];
        if (!mesh || !mesh.name) continue;

        // Apply to main building cladding meshes
        if (mesh.name.startsWith("clad-")) {
          mesh.material = mat;
          cladHits++;
        }

        // Apply to corner board meshes
        if (mesh.name.startsWith("corner-board-")) {
          mesh.material = mat;
          cornerHits++;
        }

        // Apply to attachment cladding meshes (att-{id}-clad-...)
        if (mesh.name.indexOf("-clad-") >= 0 || (mesh.metadata && mesh.metadata.type === "cladding")) {
          mesh.material = mat;
          attachmentHits++;
        }
      }

      console.log("CLAD_MATERIAL_FINALIZED cladding=", cladHits, "cornerBoards=", cornerHits, "attachments=", attachmentHits);
    } catch (e) {
      console.warn("ensureCladdingMaterialOnMeshes failed", e);
    }
  }


  // --- helper: run the finaliser again on the next 2 frames (catches late Apex replacements) ---
function scheduleFollowUpFinalisers() {
    try {
      if (!scene || !scene.onBeforeRenderObservable || !scene.onBeforeRenderObservable.add) return;

      let frameCount = 0;
      const maxFrames = 10;
      
      const observer = scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        
        try {
          // Ensure material exists
          if (!scene._claddingMatLight) {
            const m = new BABYLON.StandardMaterial("claddingMatLight", scene);
           m.diffuseColor = new BABYLON.Color3(0.85, 0.72, 0.55);
            m.emissiveColor = new BABYLON.Color3(0.17, 0.14, 0.11);

            m.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
            m.specularPower = 16;
            scene._claddingMatLight = m;
          }
          
          const mat = scene._claddingMatLight;
          
          // Fix any meshes missing materials
          for (let i = 0; i < scene.meshes.length; i++) {
            const mesh = scene.meshes[i];
            if (!mesh || !mesh.name) continue;
            
            // Apply to main building cladding, corner boards, and attachment cladding
            var isCladding = mesh.name.startsWith("clad-") ||
                             mesh.name.startsWith("corner-board-") ||
                             mesh.name.indexOf("-clad-") >= 0 ||
                             (mesh.metadata && mesh.metadata.type === "cladding");
            if (isCladding && !mesh.material) {
              mesh.material = mat;
            }
          }
        } catch (e) {}
        
        if (frameCount >= maxFrames) {
          scene.onBeforeRenderObservable.remove(observer);
        }
      });
    } catch (e) {}
  }

  try {
    if (scene && scene.onBeforeRenderObservable && scene.onBeforeRenderObservable.addOnce) {
      scene.onBeforeRenderObservable.addOnce(() => {
        let pending = null;
        try { pending = scene._pendingCladding || null; } catch (e) {}

        let stale = false;
        try {
          stale = !(pending && String(pending.buildId || "") === String(buildId));
        } catch (e) {
          stale = true;
        }

        if (stale) {
          try {
            if (!window.__dbg) window.__dbg = {};
            if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
            window.__dbg.claddingPass.deferredRan = false;
            window.__dbg.claddingPass.staleSkip = true;
          } catch (e) {}
          return;
        }

        let createdCount = 0;

        // Keep existing debug containers if present
        const passDbg = (() => {
          try {
            return window.__dbg && window.__dbg.claddingPass ? window.__dbg.claddingPass : null;
          } catch (e) {
            return null;
          }
        })();

        // Run all queued cladding jobs
        for (let i = 0; i < claddingJobs.length; i++) {
          const j = claddingJobs[i];
          const wk = String(j.wallId || "");

          try {
            if (passDbg) {
              passDbg.jobsCount = claddingJobs.length;
              if (!passDbg.jobsProcessedByWallId) passDbg.jobsProcessedByWallId = {};
              if (!passDbg.meshesCreatedByWallId) passDbg.meshesCreatedByWallId = {};
              if (!passDbg.perWall) passDbg.perWall = {};
              if (!passDbg.perWall[wk]) passDbg.perWall[wk] = { jobs: 0, created: 0, reasons: [] };

              passDbg.perWall[wk].jobs = Number(passDbg.perWall[wk].jobs || 0) + 1;
              passDbg.jobsProcessedByWallId[wk] = Number(passDbg.jobsProcessedByWallId[wk] || 0) + 1;
            }
          } catch (e) {}

          let res = null;
          try {
            console.log('DEBUG DEFERRED CLAD:', j.wallId, 'panelHeight=', j.panelHeight);
            res = addCladdingForPanel(
              j.wallId,
              j.axis,
              j.panelIndex,
              j.panelStart,
              j.panelLen,
              j.origin,
              j.panelHeight,
              passDbg
            );
          } catch (e) {
            res = null;
          }

          if (res && Number.isFinite(res.created)) {
            createdCount += Number(res.created || 0);

            try {
              if (passDbg) {
                passDbg.meshesCreatedByWallId[wk] =
                  Number(passDbg.meshesCreatedByWallId[wk] || 0) + Number(res.created || 0);

                passDbg.perWall[wk].created =
                  Number(passDbg.perWall[wk].created || 0) + Number(res.created || 0);

                if (Number(res.created || 0) === 0) {
                  passDbg.perWall[wk].reasons.push({
                    panelIndex: j.panelIndex,
                    reason: String(res.reason || "created==0"),
                    bboxMissingFallbackUsed: !!res.bboxMissingFallbackUsed
                  });
                }
              }
            } catch (e) {}
          } else {
            try {
              if (passDbg) {
                if (!passDbg.perWall[wk]) passDbg.perWall[wk] = { jobs: 0, created: 0, reasons: [] };
                passDbg.perWall[wk].reasons.push({
                  panelIndex: j.panelIndex,
                  reason: "exceptionOrNullRes",
                  bboxMissingFallbackUsed: false
                });
              }
            } catch (e) {}
          }
        }

        try {
          if (!window.__dbg) window.__dbg = {};
          if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
          window.__dbg.claddingPass.deferredRan = true;
          window.__dbg.claddingPass.staleSkip = false;
          window.__dbg.claddingPass.claddingMeshesCreated = createdCount;
        } catch (e) {}

// Add corner boards after cladding is complete
        try {
          const s = window.__dbg && window.__dbg.store ? window.__dbg.store.getState() : null;
          if (s) {
            const variant = s.walls?.variant || "insulated";
            const prof = resolveProfile(s, variant);
            const wallThk = prof.studH;
            const plateY = prof.studW;
            
            const isPentLocal = !!(s && s.roof && String(s.roof.style || "") === "pent");
            
            // Calculate heights like build3D does
            let heightLocal = Math.max(100, Math.floor(s.walls?.height_mm || 2400));
            if (s && s.roof && String(s.roof.style || "") === "apex") {
              const baseRise_mm = resolveBaseRiseMm(s);
              const apexH = resolveApexHeightsMm(s);
              if (apexH && Number.isFinite(apexH.eaves_mm)) {
                const minWallH_mm = Math.max(100, 2 * 50 + 1);
                heightLocal = Math.max(minWallH_mm, Math.floor(apexH.eaves_mm - baseRise_mm));
              }
            }
            
            const GRID_HEIGHT_MM = 50;
            const OSB_THK_MM = 18;
            const frameDepth_mm = Math.floor(Number(CONFIG?.timber?.d ?? 100));
            const rafterDepth_mm = Math.floor(Number(CONFIG?.timber?.w ?? 50));
            const FLOOR_STACK_MM = GRID_HEIGHT_MM + frameDepth_mm + OSB_THK_MM;
            const ROOF_STACK_MM = rafterDepth_mm + OSB_THK_MM;
            const pentStackAdjust = FLOOR_STACK_MM + ROOF_STACK_MM;
            
            const minHLocal = isPentLocal
              ? Math.max(100, Math.floor(Number(s?.roof?.pent?.minHeight_mm ?? heightLocal)) - pentStackAdjust)
              : heightLocal;
            const maxHLocal = isPentLocal
              ? Math.max(100, Math.floor(Number(s?.roof?.pent?.maxHeight_mm ?? heightLocal)) - pentStackAdjust)
              : heightLocal;
            
            const apexRoofModelLocal = (s && s.roof && String(s.roof.style || "") === "apex")
              ? computeApexRoofUndersideModelMm(s)
              : null;
            
addCornerBoards(scene, s, wallThk, plateY, heightLocal, minHLocal, maxHLocal, isPentLocal, materials, apexRoofModelLocal);
          }
        } catch (e) {
          console.warn("addCornerBoards failed:", e);
        }

        // VERY LAST: ensure final cladding AND corner board meshes have a valid material
        ensureCladdingMaterialOnMeshes();

        // ALSO: run again on the next 2 frames to catch late Apex mesh replacements
        scheduleFollowUpFinalisers();

        // DEBUG: Dump all cladding meshes after everything is done
        setTimeout(() => {
          try {
            const cladMeshes = scene.meshes.filter(m => m.name && m.name.includes('clad'));
            console.log('[CLAD_DUMP] Total cladding meshes:', cladMeshes.length);
            for (const m of cladMeshes) {
              try {
                m.computeWorldMatrix(true);
                m.refreshBoundingInfo();
                const bb = m.getBoundingInfo().boundingBox;
                console.log('[CLAD_DUMP]', m.name, {
                  maxY: bb.maximumWorld.y * 1000,
                  minY: bb.minimumWorld.y * 1000,
                  vertices: m.getTotalVertices(),
                  trimmed: m.metadata?.trimmedToRoofApex
                });
              } catch (e) {}
            }
          } catch (e) {}
        }, 500);
      });
    }
  } catch (e) {}
}




  function doorIntervalsForWall(wallId) {
    const list = [];
    for (let i = 0; i < doorsAll.length; i++) {
      const d = doorsAll[i];
      if (String(d.wall || "front") !== wallId) continue;
      const wGap = Math.max(100, Math.floor(d.width_mm || 800));
      const x0_door = Math.floor(d.x_mm ?? 0);
      const x1_door = x0_door + wGap;
      const h = Math.max(100, Math.floor(d.height_mm || 2000));

      // FIX: Reduce cutout height to match actual door boards height (door - 40mm)
      const hActual = Math.max(100, h - 40);

      // FIX: Cutout must match the APERTURE (opening between uprights), not the upright positions
      // The aperture is the inside dimensions - from x0_door to x1_door
      // This way the cladding covers the uprights (frame sits behind cladding)
      const x0 = x0_door;  // Aperture left edge (inner edge of left upright)
      const x1 = x1_door;  // Aperture right edge (inner edge of right upright)

      console.log(`[DOOR_INTERVALS] Wall=${wallId}, DoorID=${d.id}, x0_door=${x0_door}, x1_door=${x1_door}, x0_cutout=${x0}, x1_cutout=${x1}, width=${wGap}, studW=${prof.studW}`);

      list.push({
        id: String(d.id || ""),
        x0,           // Expanded cutout start
        x1,           // Expanded cutout end
        doorX0: x0_door,  // Original door start (for frame positioning)
        doorX1: x1_door,  // Original door end (for frame positioning)
        w: wGap,      // Original door width
        h: hActual
      });
    }
    return list;
  }

  function windowIntervalsForWall(wallId) {
    const list = [];
    for (let i = 0; i < winsAll.length; i++) {
      const w = winsAll[i];
      if (String(w.wall || "front") !== wallId) continue;
      const wGap = Math.max(100, Math.floor(w.width_mm || 600));
      const x0_win = Math.floor(w.x_mm ?? 0);
      const x1_win = x0_win + wGap;

      const y = Math.max(0, Math.floor(w.y_mm ?? 0));
      const h = Math.max(100, Math.floor(w.height_mm || 600));

      // FIX: Window cutout must match the window frame APERTURE
      // Windows have DIFFERENT framing on different walls:
      // Front/Back (alongX): Left upright at (x0 - studW), Right at x1 → aperture is x0 to x1 (like doors)
      // Left/Right (alongZ): Left upright at (x0 - 2×studW), Right at (x1 - studW) → aperture is (x0 - studW) to (x1 - studW)
      const isLeftRight = (wallId === "left" || wallId === "right");
      const x0 = isLeftRight ? (x0_win - prof.studW) : x0_win;  // Aperture left edge
      const x1 = isLeftRight ? (x1_win - prof.studW) : x1_win;  // Aperture right edge

      list.push({
        id: String(w.id || ""),
        x0,           // Cutout start (matches aperture)
        x1,           // Cutout end (matches aperture)
        winX0: x0_win,  // Original window start (for frame positioning)
        winX1: x1_win,  // Original window end (for frame positioning)
        w: wGap,      // Original window width
        y,
        h
      });
    }
    return list;
  }

  function isInsideAnyOpening(pos, intervals) {
    for (let i = 0; i < intervals.length; i++) {
      const d = intervals[i];
      const c = pos + prof.studW / 2;
      if (c > d.x0 && c < d.x1) return true;
    }
    return false;
  }

function addDoorFramingAlongX(wallId, origin, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidDoorSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    // Use original door coordinates for frame positioning, not expanded cutout coordinates
    const doorX0 = door.doorX0 || door.x0;  // Fallback to x0 for backwards compatibility
    const doorX1 = door.doorX1 || door.x1;

    console.log(`[FRAME_X] Wall=${wallId}, DoorID=${id}, origin.x=${origin.x}, doorX0=${doorX0}, doorX1=${doorX1}, leftUpright=${origin.x + (doorX0 - prof.studW)}, rightUpright=${origin.x + doorX1}`);

    const isSlopeWall = isPent && (wallId === "front" || wallId === "back");
    const isApexGableWall = !isPent && (state && state.roof && String(state.roof.style || "") === "apex") && (wallId === "front" || wallId === "back");
    const centerX = origin.x + Math.floor((doorX0 + doorX1) / 2);

    const wallTop = isSlopeWall ? heightAtX(centerX) : (wallId === "left" ? minH : wallId === "right" ? maxH : height);
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);

    // Door uprights should only go up to the header, not the full wall height
    // Header sits at plateY + doorH (clamped to wall top - studH for non-apex)
    const desiredHeaderY = plateY + doorH;
    
    // For apex gable walls, don't clamp header to eaves height - door can extend into gable
    const maxHeaderY = isApexGableWall 
      ? desiredHeaderY  // No clamping for apex - door extends into gable
      : Math.max(plateY, wallTop - prof.studH);
    const headerY = Math.min(desiredHeaderY, maxHeaderY);
    
    // Upright height = from bottom plate top to header bottom
    const uprightH = Math.max(1, headerY - plateY);

    mkBox(
      `wall-${wallId}-door-${id}-upright-left`,
      prof.studW,
      uprightH,
      thickness,
      { x: origin.x + (doorX0 - prof.studW), y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-upright-right`,
      prof.studW,
      uprightH,
      thickness,
      { x: origin.x + doorX1, y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );

    const headerL = (door.w + 2 * prof.studW);

    mkBox(
      `wall-${wallId}-door-${id}-header`,
      headerL,
      prof.studH,
      thickness,
      { x: origin.x + (doorX0 - prof.studW), y: headerY, z: origin.z },
      mat,
      { doorId: id }
    );
    
// Add cripple studs above the header
    if (isApexGableWall && apexRoofModel) {
      // APEX with door: Single central cripple from header centre to apex point
      // The rafters meet at the apex - cripple should stop at the underside of where they meet
      // apexRoofModel gives world Y coordinates; we need to convert to wall-local Y
      // Wall is shifted up by WALL_RISE_MM (168mm), so local Y = world Y - 168
      const WALL_RISE_MM = 168;
      const apexWorldY = Math.floor(apexRoofModel.yUnderAtWorldX_mm(apexRoofModel.ridgeWorldX_mm));
      
      // The header Y is in local wall coordinates (relative to wall origin at Y=0)
      // But mkBox places at world coordinates because wall meshes are shifted
      // headerY is local (e.g. plateY + doorH), and mkBox adds to origin.y which is 0
      // The mesh then gets shifted by WALL_RISE_MM via parent transform
      
      // So cripple top in local coords should be: apexWorldY - WALL_RISE_MM
      // And we need to subtract a bit more to account for the rafter depth
      const rafterDepth = prof.studH; // Rafter sits on top of the cripple
      const apexLocalY = apexWorldY - WALL_RISE_MM - rafterDepth;
      
      const headerTopY = headerY + prof.studH;
      const crippleH = Math.max(0, apexLocalY - headerTopY);
      
      if (crippleH > prof.studW) {
        // Centre of door header
        const doorCenterX = origin.x + doorX0 + (door.w / 2) - (prof.studW / 2);
        
        mkBox(
          `wall-${wallId}-door-${id}-cripple-center`,
          prof.studW,
          crippleH,
          thickness,
          { x: doorCenterX, y: headerTopY, z: origin.z },
          mat,
          { doorId: id, part: "cripple" }
        );
      }
    } else {

      // Non-apex (pent or side walls): cripples above both uprights if space allows
      const spaceAboveHeader = Math.max(0, wallTop - plateY - headerY - prof.studH);
      if (spaceAboveHeader > prof.studW) {
        mkBox(
          `wall-${wallId}-door-${id}-cripple-left`,
          prof.studW,
          spaceAboveHeader,
          thickness,
          { x: origin.x + (doorX0 - prof.studW), y: headerY + prof.studH, z: origin.z },
          mat,
          { doorId: id, part: "cripple" }
        );
        mkBox(
          `wall-${wallId}-door-${id}-cripple-right`,
          prof.studW,
          spaceAboveHeader,
          thickness,
          { x: origin.x + doorX1, y: headerY + prof.studH, z: origin.z },
          mat,
          { doorId: id, part: "cripple" }
        );
      }
    }
  }

function addDoorFramingAlongZ(wallId, origin, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidDoorSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    // Use original door coordinates for frame positioning, not expanded cutout coordinates
    const doorZ0 = door.doorX0 || door.x0;  // Fallback to x0 for backwards compatibility
    const doorZ1 = door.doorX1 || door.x1;

    const leftUprightPos = origin.z + (doorZ0 - prof.studW);
    const rightUprightPos = origin.z + doorZ1;
    const apertureLeft = origin.z + doorZ0;  // Inner edge of left upright = outer edge of aperture
    const apertureRight = origin.z + doorZ1;  // Inner edge of right upright = outer edge of aperture
    console.log(`[FRAME_Z] Wall=${wallId}, DoorID=${id}, origin.z=${origin.z}, doorZ0=${doorZ0}, doorZ1=${doorZ1}, prof.studW=${prof.studW}`);
    console.log(`[FRAME_Z_DETAIL] leftUpright=${leftUprightPos} (origin.z + doorZ0 - prof.studW = ${origin.z} + ${doorZ0} - ${prof.studW})`);
    console.log(`[FRAME_Z_DETAIL] rightUpright=${rightUprightPos} (origin.z + doorZ1 = ${origin.z} + ${doorZ1})`);
    console.log(`[FRAME_Z_APERTURE] Aperture edges: Left=${apertureLeft}, Right=${apertureRight}`);

    const wallTop = isPent ? (wallId === "left" ? minH : maxH) : height;
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);

    // Door uprights should only go up to the header, not the full wall height
    const desiredHeaderY = plateY + doorH;
    const maxHeaderY = Math.max(plateY, wallTop - prof.studH);
    const headerY = Math.min(desiredHeaderY, maxHeaderY);
    
    // Upright height = from bottom plate top to header bottom
    const uprightH = Math.max(1, headerY - plateY);

    mkBox(
      `wall-${wallId}-door-${id}-upright-left`,
      thickness,
      uprightH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + (doorZ0 - prof.studW) },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-upright-right`,
      thickness,
      uprightH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + doorZ1 },
      mat,
      { doorId: id }
    );

    const headerL = (door.w + 2 * prof.studW);

    mkBox(
      `wall-${wallId}-door-${id}-header`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: headerY, z: origin.z + (doorZ0 - prof.studW) },
      mat,
      { doorId: id }
    );
    
    // Add cripple studs above the header if there's space
    const spaceAboveHeader = Math.max(0, wallTop - plateY - headerY - prof.studH);
    if (spaceAboveHeader > prof.studW) {
      mkBox(
        `wall-${wallId}-door-${id}-cripple-left`,
        thickness,
        spaceAboveHeader,
        prof.studW,
        { x: origin.x, y: headerY + prof.studH, z: origin.z + (doorZ0 - prof.studW) },
        mat,
        { doorId: id, part: "cripple" }
      );
      mkBox(
        `wall-${wallId}-door-${id}-cripple-right`,
        thickness,
        spaceAboveHeader,
        prof.studW,
        { x: origin.x, y: headerY + prof.studH, z: origin.z + doorZ1 },
        mat,
        { doorId: id, part: "cripple" }
      );
    }
  }

  function addWindowFramingAlongX(wallId, origin, win) {
    const thickness = wallThk;
    const id = win.id;
    const useInvalid = invalidWinSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    // Use original window coordinates for frame positioning, not expanded cutout coordinates
    const x0 = win.winX0 || win.x0;  // Fallback to x0 for backwards compatibility
    const x1 = win.winX1 || win.x1;

    const leftUprightPos = origin.x + (x0 - prof.studW);
    const rightUprightPos = origin.x + x1;
    const apertureLeft = origin.x + x0;
    const apertureRight = origin.x + x1;
    const apertureCenter = origin.x + (x0 + x1) / 2;
    console.log(`[WINDOW_FRAME_X] Wall=${wallId}, WindowID=${id}, origin.x=${origin.x}, x0=${x0}, x1=${x1}, prof.studW=${prof.studW}`);
    console.log(`[WINDOW_FRAME_X_APERTURE] Aperture: Left=${apertureLeft}, Right=${apertureRight}, Center=${apertureCenter}`);

    const isSlopeWall = isPent && (wallId === "front" || wallId === "back");
    const centerX = origin.x + Math.floor((x0 + x1) / 2);
    const wallTop = isSlopeWall ? heightAtX(centerX) : (wallId === "left" ? minH : wallId === "right" ? maxH : height);
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);

    const uprightH = studLenLocal;

    const y0Raw = plateY + Math.max(0, Math.floor(win.y));
    const yTopRaw = y0Raw + Math.max(100, Math.floor(win.h));

    const maxFeatureY = Math.max(plateY, wallTop - prof.studH);

    const y0 = Math.min(y0Raw, maxFeatureY);
    const yTop = Math.min(yTopRaw, maxFeatureY);

    mkBox(
      `wall-${wallId}-win-${id}-upright-left`,
      prof.studW,
      uprightH,
      thickness,
      { x: origin.x + (x0 - prof.studW), y: plateY, z: origin.z },
      mat,
      { windowId: id }
    );
    mkBox(
      `wall-${wallId}-win-${id}-upright-right`,
      prof.studW,
      uprightH,
      thickness,
      { x: origin.x + x1, y: plateY, z: origin.z },
      mat,
      { windowId: id }
    );

    const headerL = (win.w + 2 * prof.studW);
    mkBox(
      `wall-${wallId}-win-${id}-header`,
      headerL,
      prof.studH,
      thickness,
      { x: origin.x + (x0 - prof.studW), y: yTop, z: origin.z },
      mat,
      { windowId: id }
    );

mkBox(
      `wall-${wallId}-win-${id}-sill`,
      headerL,
      prof.studH,
      thickness,
      { x: origin.x + (x0 - prof.studW), y: y0 - prof.studH, z: origin.z },
      mat,
      { windowId: id }
    );

    // Add cripple studs below the sill (from bottom plate to sill underside)
    const crippleHeight = Math.max(0, y0 - prof.studH - plateY);
    if (crippleHeight > prof.studW) {
      // Calculate number of cripples needed based on window width and stud spacing
      const windowInnerWidth = Math.max(0, x1 - x0);
      const studSpacing = prof.spacing || 400; // Default to 400mm if null
      const numCripples = Math.max(1, Math.min(10, Math.floor(windowInnerWidth / studSpacing))); // Cap at 10
      const crippleSpacing = windowInnerWidth / (numCripples + 1);
      
      for (let ci = 1; ci <= numCripples; ci++) {
        const crippleX = origin.x + x0 + (ci * crippleSpacing) - (prof.studW / 2);
        mkBox(
          `wall-${wallId}-win-${id}-cripple-below-${ci}`,
          prof.studW,
          crippleHeight,
          thickness,
          { x: crippleX, y: plateY, z: origin.z },
          mat,
          { windowId: id, part: "cripple-below" }
        );
      }
      console.log(`[WINDOW_CRIPPLE_X] Wall=${wallId}, WindowID=${id}, Added ${numCripples} cripple studs below sill, height=${crippleHeight}mm`);
    }
  }

  function addWindowFramingAlongZ(wallId, origin, win) {
    const thickness = wallThk;
    const id = win.id;
    const useInvalid = invalidWinSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    // Use original window coordinates for frame positioning, not expanded cutout coordinates
    const z0 = win.winX0 || win.x0;  // Fallback to x0 for backwards compatibility
    const z1 = win.winX1 || win.x1;

    const leftUprightPos = origin.z + z0 - 2 * prof.studW;
    const rightUprightPos = origin.z + z1 - prof.studW;
    const apertureLeft = origin.z + z0 - prof.studW;   // Inner edge of left upright
    const apertureRight = origin.z + z1 - prof.studW;  // Inner edge of right upright
    console.log(`[WINDOW_FRAME_Z] Wall=${wallId}, WindowID=${id}, origin.z=${origin.z}, z0=${z0}, z1=${z1}, prof.studW=${prof.studW}`);
    console.log(`[WINDOW_FRAME_Z_DETAIL] leftUpright=${leftUprightPos} (origin.z + z0 - 2×studW), rightUpright=${rightUprightPos} (origin.z + z1 - studW)`);
    console.log(`[WINDOW_FRAME_Z_APERTURE] Aperture edges: Left=${apertureLeft}, Right=${apertureRight}`);

    const wallTop = isPent ? (wallId === "left" ? minH : maxH) : height;
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);
    const uprightH = studLenLocal;

    const y0Raw = plateY + Math.max(0, Math.floor(win.y));
    const yTopRaw = y0Raw + Math.max(100, Math.floor(win.h));

    const maxFeatureY = Math.max(plateY, wallTop - prof.studH);

    const y0 = Math.min(y0Raw, maxFeatureY);
    const yTop = Math.min(yTopRaw, maxFeatureY);

    mkBox(
      `wall-${wallId}-win-${id}-upright-left`,
      thickness,
      uprightH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + z0 - 2 * prof.studW },
      mat,
      { windowId: id }
    );
    mkBox(
      `wall-${wallId}-win-${id}-upright-right`,
      thickness,
      uprightH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + z1 - prof.studW },
      mat,
      { windowId: id }
    );

    const headerL = (win.w + 2 * prof.studW);
    mkBox(
      `wall-${wallId}-win-${id}-header`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: yTop, z: origin.z + (z0 - 2 * prof.studW) },
      mat,
      { windowId: id }
    );

    mkBox(
      `wall-${wallId}-win-${id}-sill`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: y0 - prof.studH, z: origin.z + (z0 - 2 * prof.studW) },
      mat,
      { windowId: id }
    );

    // Add cripple studs below the sill (from bottom plate to sill underside)
    const crippleHeight = Math.max(0, y0 - prof.studH - plateY);
    if (crippleHeight > prof.studW) {
      // Calculate number of cripples needed based on window width and stud spacing
      const windowInnerWidth = Math.max(0, z1 - z0);
      const studSpacing = prof.spacing || 400; // Default to 400mm if null
      const numCripples = Math.max(1, Math.min(10, Math.floor(windowInnerWidth / studSpacing))); // Cap at 10
      const crippleSpacing = windowInnerWidth / (numCripples + 1);
      
      for (let ci = 1; ci <= numCripples; ci++) {
        // For Z-axis walls, cripple position is along Z between the king studs
        const crippleZ = origin.z + z0 - prof.studW + (ci * crippleSpacing) - (prof.studW / 2);
        mkBox(
          `wall-${wallId}-win-${id}-cripple-below-${ci}`,
          thickness,
          crippleHeight,
          prof.studW,
          { x: origin.x, y: plateY, z: crippleZ },
          mat,
          { windowId: id, part: "cripple-below" }
        );
      }
      console.log(`[WINDOW_CRIPPLE_Z] Wall=${wallId}, WindowID=${id}, Added ${numCripples} cripple studs below sill, height=${crippleHeight}mm`);
    }
  }

  function buildBasicPanel(wallPrefix, axis, panelLen, origin, offsetAlong, openings, studLenForPosStart) {
    const isAlongX = axis === "x";

    const hForStart = (posStart) => {
      if (!studLenForPosStart) return Math.max(1, height - 2 * plateY);
      return Math.max(1, Math.floor(studLenForPosStart(posStart)));
    };

    if (isAlongX) {
      mkBox(
        wallPrefix + "plate-bottom",
        panelLen,
        plateY,
        wallThk,
        { x: origin.x + offsetAlong, y: 0, z: origin.z },
        materials.plate
      );
    } else {
      mkBox(
        wallPrefix + "plate-bottom",
        wallThk,
        plateY,
        panelLen,
        { x: origin.x, y: 0, z: origin.z + offsetAlong },
        materials.plate
      );
    }

    const placeStud = (x, z, idx, posStartRel) => {
      const h = hForStart(posStartRel);
      if (isAlongX) {
        mkBox(
          wallPrefix + "stud-" + idx,
          prof.studW,
          h,
          wallThk,
          { x, y: plateY, z },
          materials.timber
        );
      } else {
        mkBox(
          wallPrefix + "stud-" + idx,
          wallThk,
          h,
          prof.studW,
          { x, y: plateY, z },
          materials.timber
        );
      }
    };

    const offsetStart = offsetAlong;
    const offsetEnd = offsetAlong + panelLen;

    const panelOpenings = openings.filter((d) => {
      const s = d.x0;
      const e = d.x1;
      return e > offsetStart && s < offsetEnd;
    });

    const studAt = (posStart) => {
      for (let i = 0; i < panelOpenings.length; i++) {
        const d = panelOpenings[i];
        if (posStart + prof.studW > d.x0 && posStart < d.x1) return false;
      }
      return true;
    };

    if (isAlongX) {
      const x0 = origin.x + offsetAlong;
      const x1 = origin.x + offsetAlong + panelLen - prof.studW;
      const xm = Math.max(x0, Math.floor(origin.x + offsetAlong + panelLen / 2 - prof.studW / 2));

      if (studAt(offsetAlong)) placeStud(x0, origin.z, 0, offsetAlong);
      if (studAt(offsetAlong + panelLen - prof.studW)) placeStud(x1, origin.z, 1, offsetAlong + panelLen - prof.studW);

      let midAllowed = true;
      for (let i = 0; i < panelOpenings.length; i++) {
        const d = panelOpenings[i];
        const ms = xm - origin.x;
        if (ms + prof.studW > d.x0 && ms < d.x1) { midAllowed = false; break; }
      }
      if (midAllowed) placeStud(xm, origin.z, 2, (xm - origin.x));
    } else {
      const z0 = origin.z + offsetAlong;
      const z1 = origin.z + offsetAlong + panelLen - prof.studW;
      const zm = Math.max(z0, Math.floor(origin.z + offsetAlong + panelLen / 2 - prof.studW / 2));

      if (studAt(offsetAlong)) placeStud(origin.x, z0, 0, offsetAlong);
      if (studAt(offsetAlong + panelLen - prof.studW)) placeStud(origin.x, z1, 1, offsetAlong + panelLen - prof.studW);

      let midAllowed = true;
      for (let i = 0; i < panelOpenings.length; i++) {
        const d = panelOpenings[i];
        const ms = zm - origin.z;
        if (ms + prof.studW > d.x0 && ms < d.x1) { midAllowed = false; break; }
      }
      if (midAllowed) placeStud(origin.x, zm, 2, (zm - origin.z));
    }
  }

  function buildWall(wallId, axis, length, origin) {
    const isAlongX = axis === "x";
    // Use section-aware prefix from outer scope (defined at top of build3D)
    const wallMeshPrefix = meshPrefix + `wall-${wallId}-`;

    const doors = doorIntervalsForWall(wallId);
    const wins = windowIntervalsForWall(wallId);
    const openingsX = doors.concat(wins);

    const isSlopeWall = isPent && isAlongX && (wallId === "front" || wallId === "back");

    const wallHeightFlat = isPent
      ? (wallId === "left" ? minH : wallId === "right" ? maxH : height)
      : height;

    const studLenFlat = Math.max(1, wallHeightFlat - 2 * plateY);

if (isAlongX) {
      mkBox(wallMeshPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      if (!isSlopeWall) {
        // Check if this is an apex gable wall with a door extending into the gable
        const isApexGableWall = !isPent && (state && state.roof && String(state.roof.style || "") === "apex") && (wallId === "front" || wallId === "back");
        const doorsOnThisWall = doors.filter(d => d.x0 !== undefined);
        
        // Find door that extends into gable (door top > wall height)
        let gableDoor = null;
        if (isApexGableWall && doorsOnThisWall.length > 0) {
          for (let di = 0; di < doorsOnThisWall.length; di++) {
            const d = doorsOnThisWall[di];
            const doorTopY = plateY + d.h;
            // If door top is above wall height minus plate, it extends into gable
            if (doorTopY > wallHeightFlat - plateY) {
              gableDoor = d;
              break;
            }
          }
        }
        
        if (gableDoor) {
          // Cut top plate around the door opening
          const doorLeftEdge = gableDoor.x0 - prof.studW; // Left upright outer edge
          const doorRightEdge = gableDoor.x1 + prof.studW; // Right upright outer edge
          
          // Left piece of top plate
          const leftPlateLen = Math.max(0, doorLeftEdge);
          if (leftPlateLen > prof.studW) {
            mkBox(
              wallMeshPrefix + "plate-top-left",
              leftPlateLen,
              plateY,
              wallThk,
              { x: origin.x, y: wallHeightFlat - plateY, z: origin.z },
              materials.plate
            );
          }
          
          // Right piece of top plate
          const rightPlateStart = doorRightEdge;
          const rightPlateLen = Math.max(0, length - rightPlateStart);
          if (rightPlateLen > prof.studW) {
            mkBox(
              wallMeshPrefix + "plate-top-right",
              rightPlateLen,
              plateY,
              wallThk,
              { x: origin.x + rightPlateStart, y: wallHeightFlat - plateY, z: origin.z },
              materials.plate
            );
          }
        } else {
          // Normal full top plate
          mkBox(wallMeshPrefix + "plate-top", length, plateY, wallThk, { x: origin.x, y: wallHeightFlat - plateY, z: origin.z }, materials.plate);
        }
      } else {

        const yTop0 = heightAtX(origin.x);
        const yTop1 = heightAtX(origin.x + length);
        mkSlopedPlateAlongX(
          wallMeshPrefix + "plate-top",
          length,
          wallThk,
          { x: origin.x, z: origin.z },
          yTop0,
          yTop1,
          materials.plate,
          {}
        );
      }
    } else {
      mkBox(wallMeshPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallMeshPrefix + "plate-top", wallThk, plateY, length, { x: origin.x, y: wallHeightFlat - plateY, z: origin.z }, materials.plate);
    }

    const studLenForXStart = (xStartRel) => {
      if (!isSlopeWall) return studLenFlat;
      const xCenter = origin.x + Math.floor(xStartRel + prof.studW / 2);
      const wallTop = heightAtX(xCenter);
      return Math.max(1, wallTop - 2 * plateY);
    };

    if (variant === "basic") {
      const panels = computeBasicPanels(length, prof, openingsX);

      for (let p = 0; p < panels.length; p++) {
        const pan = panels[p];
        const pref = wallMeshPrefix + `panel-${p + 1}-`;
        buildBasicPanel(
          pref,
          axis,
          pan.len,
          origin,
          pan.start,
          openingsX,
          isAlongX ? studLenForXStart : (() => studLenFlat)
        );
      }

      for (let i = 0; i < doors.length; i++) {
        const d = doors[i];
        if (isAlongX) addDoorFramingAlongX(wallId, origin, d);
        else addDoorFramingAlongZ(wallId, origin, d);
      }

      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        if (isAlongX) addWindowFramingAlongX(wallId, origin, w);
        else addWindowFramingAlongZ(wallId, origin, w);
      }

      for (let p = 0; p < panels.length; p++) {
        if (__DIAG_ONE_FRONT_ONE_BOARD) {
          if (!(String(wallId) === "front" && p === 0)) continue;
        }
        const pan = panels[p];
       let panelH = wallHeightFlat;
   console.log('DEBUG BASIC panelH:', wallId, 'isPent=', isPent, 'isSlopeWall=', isSlopeWall, 'panelH=', panelH);
   if (isSlopeWall) {
          const h0 = heightAtX(origin.x + pan.start);
          const h1 = heightAtX(origin.x + pan.start + pan.len);
          // Add WALL_RISE_MM because cladding anchors to shifted wall plate
          const WALL_RISE_MM_PENT = 168;
          panelH = Math.max(h0, h1) + WALL_RISE_MM_PENT;
       } else if (isPent) {
          // Left/right walls also need WALL_RISE_MM offset
          const WALL_RISE_MM_PENT = 168;
          console.log('DEBUG PENT LEFT/RIGHT: wallId=', wallId, 'panelH before=', panelH, 'adding', WALL_RISE_MM_PENT);
          panelH = panelH + WALL_RISE_MM_PENT;
          console.log('DEBUG PENT LEFT/RIGHT: panelH after=', panelH);
        }

        if (
          state &&
          state.roof &&
          String(state.roof.style || "") === "apex" &&
          isAlongX &&
          (String(wallId) === "front" || String(wallId) === "back")
        ) {
const baseRise_mm = resolveBaseRiseMm(state);
          const apexH = resolveApexHeightsMm(state);
if (apexH && Number.isFinite(apexH.crest_mm)) {
        // Add 168mm (WALL_RISE_MM from index.js) because cladding anchors to
        // the shifted wall plate but panelH is calculated in local coords
        const WALL_RISE_MM = 168;
        const crestLocal_mm = Math.floor(apexH.crest_mm - baseRise_mm + WALL_RISE_MM);
        if (Number.isFinite(crestLocal_mm)) panelH = Math.max(panelH, crestLocal_mm);
      }
        }

        claddingJobs.push({
          wallId,
          axis,
          panelIndex: (p + 1),
          panelStart: pan.start,
          panelLen: pan.len,
          origin,
          panelHeight: panelH
        });
      }

      return;
    }

    const studs = [];
    const placeStud = (x, z, posStartRel) => {
      const h = isAlongX ? studLenForXStart(posStartRel) : studLenFlat;
      if (isAlongX) {
        studs.push(mkBox(wallMeshPrefix + "stud-" + studs.length, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber));
      } else {
        studs.push(mkBox(wallMeshPrefix + "stud-" + studs.length, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber));
      }
    };

    if (isAlongX) {
      if (!isInsideAnyOpening(0, openingsX)) placeStud(origin.x + 0, origin.z + 0, 0);
      if (!isInsideAnyOpening(length - prof.studW, openingsX)) placeStud(origin.x + (length - prof.studW), origin.z + 0, length - prof.studW);
    } else {
      if (!isInsideAnyOpening(0, openingsX)) placeStud(origin.x + 0, origin.z + 0, 0);
      if (!isInsideAnyOpening(length - prof.studW, openingsX)) placeStud(origin.x + 0, origin.z + (length - prof.studW), length - prof.studW);
    }

    if (isAlongX) {
      const spacingX = prof.spacing || 400;
      let x = spacingX;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(x, openingsX)) placeStud(origin.x + x, origin.z, x);
        x += spacingX;
      }
    } else {
      const spacingZ = prof.spacing || 400;
      let z = spacingZ;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(z, openingsX)) placeStud(origin.x, origin.z + z, z);
        z += spacingZ;
      }
    }

    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (isAlongX) addDoorFramingAlongX(wallId, origin, d);
      else addDoorFramingAlongZ(wallId, origin, d);
    }

    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (isAlongX) addWindowFramingAlongX(wallId, origin, w);
      else addWindowFramingAlongZ(wallId, origin, w);
    }

    let panelH = wallHeightFlat;
   if (isSlopeWall) {
      const h0 = heightAtX(origin.x);
      const h1 = heightAtX(origin.x + length);
      // Add WALL_RISE_MM because cladding anchors to shifted wall plate
      const WALL_RISE_MM_PENT = 168;
      panelH = Math.max(h0, h1) + WALL_RISE_MM_PENT;
    } else if (isPent) {
      // Left/right walls also need WALL_RISE_MM offset
      const WALL_RISE_MM_PENT = 168;
      console.log('DEBUG PENT BASIC LEFT/RIGHT: wallId=', wallId, 'panelH before=', panelH);
      panelH = panelH + WALL_RISE_MM_PENT;
      console.log('DEBUG PENT BASIC LEFT/RIGHT: panelH after=', panelH);
    }
    if (
      state &&
      state.roof &&
      String(state.roof.style || "") === "apex" &&
      isAlongX &&
      (String(wallId) === "front" || String(wallId) === "back")
    ) {
      const baseRise_mm = resolveBaseRiseMm(state);
      const apexH = resolveApexHeightsMm(state);
     console.log('DEBUG apex panelH:', wallId, 'apexH=', apexH, 'panelH before=', panelH, 'crestLocal would be=', apexH?.crest_mm ? (apexH.crest_mm - baseRise_mm + 168) : 'N/A');
if (apexH && Number.isFinite(apexH.crest_mm)) {
        // Add 168mm (WALL_RISE_MM from index.js) because cladding anchors to
        // the shifted wall plate but panelH is calculated in local coords
        const WALL_RISE_MM = 168;
        const crestLocal_mm = Math.floor(apexH.crest_mm - baseRise_mm + WALL_RISE_MM);
        if (Number.isFinite(crestLocal_mm)) panelH = Math.max(panelH, crestLocal_mm);
      }
    }
console.log('DEBUG apex panelH AFTER:', wallId, 'panelH=', panelH);
    if (__DIAG_ONE_FRONT_ONE_BOARD) {
      if (!(String(wallId) === "front")) return;
    }

    claddingJobs.push({
      wallId,
      axis,
      panelIndex: 1,
      panelStart: 0,
      panelLen: length,
      origin,
      panelHeight: panelH
    });
  }

  const sideLenZ = Math.max(1, dims.d - 2 * wallThk);

  if (flags.front) buildWall("front", "x", dims.w, { x: 0, z: 0 });
  if (flags.back) buildWall("back", "x", dims.w, { x: 0, z: dims.d - wallThk });

  if (flags.left) buildWall("left", "z", sideLenZ, { x: 0, z: wallThk });
  if (flags.right) buildWall("right", "z", sideLenZ, { x: dims.w - wallThk, z: wallThk });

  // Build wall insulation and internal lining for insulated variant
  // Uses vis.wallIns and vis.wallPly toggles (default to vis.ins for backwards compat)
  const showWallInsulation = variant === "insulated" && (state.vis?.wallIns !== false) && (state.vis?.ins !== false);
  const showWallPlywood = variant === "insulated" && (state.vis?.wallPly !== false);
  console.log('[WALLS] Wall insulation check - variant:', variant, 'vis.wallIns:', state.vis?.wallIns, 'vis.wallPly:', state.vis?.wallPly, 'showWallInsulation:', showWallInsulation, 'showWallPlywood:', showWallPlywood);
  if (showWallInsulation || showWallPlywood) {
    buildWallInsulationAndLining(
      state, scene, materials, dims, height, prof, wallThk, plateY,
      flags, meshPrefix, sectionId, sectionPos, doorsAll, winsAll,
      showWallInsulation, showWallPlywood
    );
  }

  // Schedule one-shot deferred cladding build (one frame later)
  scheduleDeferredCladdingPass();
}

/**
 * Build wall insulation (PIR 50mm between studs) and internal plywood lining (12mm)
 * for insulated wall variant. Similar to floor insulation between joists.
 */
function buildWallInsulationAndLining(state, scene, materials, dims, height, prof, wallThk, plateY, flags, meshPrefix, sectionId, sectionPos, doorsAll, winsAll, showInsulation = true, showPlywood = true) {
  const PIR_THICKNESS = 50; // 50mm PIR insulation
  const PLY_THICKNESS = 12; // 12mm plywood internal lining
  const STUD_SPACING = prof.spacing || 400;
  const studW = prof.studW;
  
  console.log('[WALL_INS] Building wall insulation - dims:', dims, 'height:', height, 'studW:', studW, 'spacing:', STUD_SPACING);
  
  // Insulation material (yellow/cream PIR color)
  const insMat = new BABYLON.StandardMaterial('wallInsMat-' + Date.now(), scene);
  insMat.diffuseColor = new BABYLON.Color3(0.95, 0.9, 0.4); // Brighter yellow
  
  // Plywood material (light wood color)
  const plyMat = new BABYLON.StandardMaterial('wallPlyMat-' + Date.now(), scene);
  plyMat.diffuseColor = new BABYLON.Color3(0.85, 0.75, 0.65);

  // Get root node for wall meshes - try multiple methods
  let shedRoot = scene.getTransformNodeByName("shedRoot");
  if (!shedRoot) {
    shedRoot = scene.getMeshByName("shedRoot");
  }
  if (!shedRoot) {
    // Create a transform node if not found
    shedRoot = new BABYLON.TransformNode("wallInsRoot", scene);
  }
  
  // Insulation height (between plates)
  const insHeight = Math.max(1, height - 2 * plateY);
  console.log('[WALL_INS] insHeight:', insHeight, 'plateY:', plateY);
  
  // Helper: get openings (doors + windows) for a specific wall
  function getOpeningsForWall(wallId) {
    const openings = [];
    // Add doors
    for (let i = 0; i < (doorsAll || []).length; i++) {
      const d = doorsAll[i];
      if (String(d.wall || "front") !== wallId) continue;
      const w = Math.max(100, Math.floor(d.width_mm || 800));
      const x0 = Math.floor(d.x_mm ?? 0);
      const h = Math.max(100, Math.floor(d.height_mm || 2000));
      openings.push({ x0, x1: x0 + w, y0: 0, y1: h, type: 'door' });
    }
    // Add windows
    for (let i = 0; i < (winsAll || []).length; i++) {
      const win = winsAll[i];
      if (String(win.wall || "front") !== wallId) continue;
      const w = Math.max(100, Math.floor(win.width_mm || 600));
      const h = Math.max(100, Math.floor(win.height_mm || 400));
      const x0 = Math.floor(win.x_mm ?? 0);
      const y0 = Math.floor(win.y_mm ?? 1000);
      openings.push({ x0, x1: x0 + w, y0, y1: y0 + h, type: 'window' });
    }
    return openings;
  }
  
  // Helper: check if a horizontal range overlaps with any opening
  function overlapsOpening(start, end, openings) {
    for (let i = 0; i < openings.length; i++) {
      const o = openings[i];
      // Check horizontal overlap
      if (start < o.x1 && end > o.x0) {
        return true;
      }
    }
    return false;
  }
  
  // Build insulation and lining for each wall
  function buildWallInsulation(wallId, axis, wallLen, origin) {
    const isAlongX = axis === "x";
    const prefix = meshPrefix + `wall-${wallId}-ins-`;
    const plyPrefix = meshPrefix + `wall-${wallId}-ply-`;
    
    // Get openings for this wall
    const wallOpenings = getOpeningsForWall(wallId);
    console.log('[WALL_INS] Building wall:', wallId, 'openings:', wallOpenings.length);
    
    // Calculate stud positions (same logic as main wall builder)
    const studPositions = [0]; // Start with corner stud
    let pos = STUD_SPACING;
    while (pos < wallLen - studW) {
      studPositions.push(pos);
      pos += STUD_SPACING;
    }
    if (studPositions[studPositions.length - 1] !== wallLen - studW) {
      studPositions.push(wallLen - studW); // End corner stud
    }
    
    console.log('[WALL_INS] Stud positions for', wallId, ':', studPositions);
    
    // Build insulation panels between studs (with partial fill around openings)
    let insCount = 0;
    
    // Helper to find which opening overlaps this bay and get its vertical extents
    function getOverlappingOpening(start, end) {
      for (let oi = 0; oi < wallOpenings.length; oi++) {
        const o = wallOpenings[oi];
        if (start < o.x1 && end > o.x0) {
          return o;
        }
      }
      return null;
    }
    
    // Helper to create an insulation panel
    function createInsPanel(name, bayStart, bayEnd, yBottom, yTop) {
      const bayW = bayEnd - bayStart;
      const insH = yTop - yBottom;
      if (bayW < 10 || insH < 10) return null;
      
      const insDepth = wallThk - 10;
      const insW = isAlongX ? bayW : insDepth;
      const insD = isAlongX ? insDepth : bayW;
      
      const insX = isAlongX 
        ? origin.x + bayStart + bayW / 2 
        : origin.x + wallThk / 2;
      const insZ = isAlongX 
        ? origin.z + wallThk / 2 
        : origin.z + bayStart + bayW / 2;
      
      const ins = BABYLON.MeshBuilder.CreateBox(name, {
        width: insW * 0.001,
        height: insH * 0.001,
        depth: insD * 0.001
      }, scene);
      
      ins.position = new BABYLON.Vector3(
        insX * 0.001,
        (yBottom + insH / 2) * 0.001,
        insZ * 0.001
      );
      ins.material = insMat;
      ins.parent = shedRoot;
      ins.metadata = { dynamic: true, sectionId: sectionId || null, isWallInsulation: true };
      ins.enableEdgesRendering();
      ins.edgesWidth = 1;
      ins.edgesColor = new BABYLON.Color4(0.7, 0.65, 0.3, 1);
      return ins;
    }
    
    // Only build insulation if showInsulation flag is true
    if (showInsulation) {
      for (let i = 0; i < studPositions.length - 1; i++) {
        const studStart = studPositions[i] + studW; // After this stud
        const studEnd = studPositions[i + 1]; // Before next stud
        const bayWidth = studEnd - studStart;
        
        if (bayWidth < 10) continue;
        
        const overlapping = getOverlappingOpening(studStart, studEnd);
        
        if (!overlapping) {
          // No opening - fill entire bay with insulation
          if (createInsPanel(prefix + i, studStart, studEnd, plateY, plateY + insHeight)) {
            insCount++;
          }
        } else {
          // Bay overlaps with an opening - add partial insulation below and above
          const openingBottomY = plateY + Math.max(0, overlapping.y0 || 0);
          const openingTopY = plateY + Math.max(0, overlapping.y1 || insHeight);
          
          // Insulation BELOW the opening (from plate to sill area)
          // Account for sill thickness (prof.studH)
          const sillThickness = prof.studH || 100;
          const insBelowTop = Math.max(plateY, openingBottomY - sillThickness);
          if (insBelowTop > plateY + 50) { // At least 50mm gap to be worth filling
            if (createInsPanel(prefix + i + '-below', studStart, studEnd, plateY, insBelowTop)) {
              insCount++;
              console.log(`[WALL_INS] Added insulation BELOW opening in bay ${i}, height=${insBelowTop - plateY}mm`);
            }
          }
          
          // Insulation ABOVE the opening (from header to top plate)
          // Account for header thickness
          const headerThickness = prof.studH || 100;
          const insAboveBottom = Math.min(plateY + insHeight, openingTopY + headerThickness);
          const insAboveTop = plateY + insHeight;
          if (insAboveTop > insAboveBottom + 50) { // At least 50mm gap to be worth filling
            if (createInsPanel(prefix + i + '-above', studStart, studEnd, insAboveBottom, insAboveTop)) {
              insCount++;
              console.log(`[WALL_INS] Added insulation ABOVE opening in bay ${i}, height=${insAboveTop - insAboveBottom}mm`);
            }
          }
        }
      }
      
      console.log('[WALL_INS] Created', insCount, 'insulation panels for wall', wallId);
    }
    
    // Only build plywood if showPlywood flag is true
    if (!showPlywood) return;
    
    // Build internal plywood lining
    // Lining sits on inside face of wall (inside the stud cavity)
    const plyW = isAlongX ? wallLen : PLY_THICKNESS;
    const plyD = isAlongX ? PLY_THICKNESS : wallLen;
    const plyH = height; // Full wall height
    
    // Position on inside face of wall (OUTSIDE the stud volume, on interior side)
    let plyX, plyZ;
    if (isAlongX) {
      plyX = origin.x + wallLen / 2;
      // Front wall: interior is +Z direction (behind studs)
      // Back wall: interior is -Z direction (in front of studs)
      plyZ = wallId === "front" 
        ? origin.z + wallThk + PLY_THICKNESS / 2  // Place behind studs (interior side)
        : origin.z - PLY_THICKNESS / 2;           // Place in front of studs (interior side)
    } else {
      // Left wall: interior is +X direction (behind studs)
      // Right wall: interior is -X direction (in front of studs)
      plyX = wallId === "left"
        ? origin.x + wallThk + PLY_THICKNESS / 2  // Place behind studs (interior side)
        : origin.x - PLY_THICKNESS / 2;           // Place in front of studs (interior side)
      plyZ = origin.z + wallLen / 2;
    }
    
    const ply = BABYLON.MeshBuilder.CreateBox(plyPrefix + "panel", {
      width: plyW * 0.001,
      height: plyH * 0.001,
      depth: plyD * 0.001
    }, scene);
    
    ply.position = new BABYLON.Vector3(
      plyX * 0.001,
      (plyH / 2) * 0.001,
      plyZ * 0.001
    );
    ply.material = plyMat;
    ply.parent = shedRoot;
    ply.metadata = { dynamic: true, sectionId: sectionId || null };
    ply.enableEdgesRendering();
    ply.edgesWidth = 2;
    ply.edgesColor = new BABYLON.Color4(0.5, 0.4, 0.3, 1);
    
    // If wall has openings, cut them out using CSG
    if (wallOpenings.length > 0) {
      console.log('[WALL_INS] Cutting', wallOpenings.length, 'openings from plywood for wall', wallId);
      
      const hasCSG = typeof BABYLON !== "undefined" && BABYLON && BABYLON.CSG && typeof BABYLON.CSG.FromMesh === "function";
      
      if (hasCSG) {
        const cutters = [];
        
        for (let oi = 0; oi < wallOpenings.length; oi++) {
          const op = wallOpenings[oi];
          const opW = op.x1 - op.x0;
          const opH = op.y1 - op.y0;
          const opY = plateY + op.y0 + opH / 2;
          
          // Create cutter box for this opening
          let cutterW, cutterD, cutterX, cutterZ;
          if (isAlongX) {
            cutterW = opW;
            cutterD = PLY_THICKNESS + 20; // Extra depth to ensure clean cut
            cutterX = origin.x + op.x0 + opW / 2;
            cutterZ = plyZ;
          } else {
            cutterW = PLY_THICKNESS + 20;
            cutterD = opW;
            cutterX = plyX;
            cutterZ = origin.z + op.x0 + opW / 2;
          }
          
          const cutter = BABYLON.MeshBuilder.CreateBox(plyPrefix + "cutter-" + oi, {
            width: cutterW * 0.001,
            height: opH * 0.001,
            depth: cutterD * 0.001
          }, scene);
          
          cutter.position = new BABYLON.Vector3(
            cutterX * 0.001,
            opY * 0.001,
            cutterZ * 0.001
          );
          
          cutters.push(cutter);
        }
        
        if (cutters.length > 0) {
          try {
            // Merge all cutters into one CSG
            let cutterCSG = BABYLON.CSG.FromMesh(cutters[0]);
            for (let ci = 1; ci < cutters.length; ci++) {
              const c = BABYLON.CSG.FromMesh(cutters[ci]);
              cutterCSG = cutterCSG.union(c);
            }
            
            // Subtract from plywood
            const plyCSG = BABYLON.CSG.FromMesh(ply);
            const resultCSG = plyCSG.subtract(cutterCSG);
            const resultMesh = resultCSG.toMesh(plyPrefix + "panel-cut", plyMat, scene, false);
            
            // Copy properties from original
            resultMesh.parent = shedRoot;
            resultMesh.metadata = { dynamic: true, sectionId: sectionId || null };
            resultMesh.enableEdgesRendering();
            resultMesh.edgesWidth = 2;
            resultMesh.edgesColor = new BABYLON.Color4(0.5, 0.4, 0.3, 1);
            
            // Dispose original and cutters
            ply.dispose(false, true);
            for (let ci = 0; ci < cutters.length; ci++) {
              cutters[ci].dispose(false, true);
            }
            
            console.log('[WALL_INS] Successfully cut openings from plywood for wall', wallId);
          } catch (e) {
            console.warn('[WALL_INS] CSG cutting failed for wall', wallId, e);
            // Dispose cutters but keep original ply
            for (let ci = 0; ci < cutters.length; ci++) {
              cutters[ci].dispose(false, true);
            }
          }
        }
      } else {
        console.log('[WALL_INS] CSG not available - plywood will cover openings for wall', wallId);
      }
    }
  }
  
  const sideLenZ = Math.max(1, dims.d - 2 * wallThk);
  
  if (flags.front) buildWallInsulation("front", "x", dims.w, { x: 0, z: 0 });
  if (flags.back) buildWallInsulation("back", "x", dims.w, { x: 0, z: dims.d - wallThk });
  if (flags.left) buildWallInsulation("left", "z", sideLenZ, { x: 0, z: wallThk });
  if (flags.right) buildWallInsulation("right", "z", sideLenZ, { x: dims.w - wallThk, z: wallThk });
}

function resolveProfile(state, variant) {
  const defaults =
    variant === "insulated"
      ? { studW: 50, studH: 100, spacing: 400 }
      : { studW: 50, studH: 75, spacing: null };

  const fg = state?.frameGauge;
  const fgW = Math.floor(Number(fg?.thickness_mm));
  const fgH = Math.floor(Number(fg?.depth_mm));

  const cfg = state?.walls?.[variant];
  const w = Math.floor(Number(cfg?.section?.w));
  const h = Math.floor(Number(cfg?.section?.h));

  let studW = Number.isFinite(w) && w > 0 ? w : defaults.studW;
  let studH = Number.isFinite(h) && h > 0 ? h : defaults.studH;

  if (Number.isFinite(fgW) && fgW > 0) studW = fgW;
  if (Number.isFinite(fgH) && fgH > 0) studH = fgH;

  return { studW, studH, spacing: defaults.spacing };
}

function normalizeWallFlags(state) {
  const enabled = state.vis?.wallsEnabled !== false;
  const parts = state.vis?.walls || { front: true, back: true, left: true, right: true };
  return {
    front: enabled && parts.front !== false,
    back: enabled && parts.back !== false,
    left: enabled && parts.left !== false,
    right: enabled && parts.right !== false,
  };
}

function getOpeningsAll(state) {
  const openings = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  return openings.filter((o) => o && o.enabled !== false);
}

function getDoorIntervalsForWallFromState(state, wallId) {
  const openings = getOpeningsAll(state);
  const doorsAll = openings.filter((o) => o && o.type === "door");
  const list = [];
  for (let i = 0; i < doorsAll.length; i++) {
    const d = doorsAll[i];
    if (String(d.wall || "front") !== wallId) continue;
    const wGap = Math.max(100, Math.floor(d.width_mm || 800));
    const x0 = Math.floor(d.x_mm ?? 0);
    const x1 = x0 + wGap;
    const h = Math.max(100, Math.floor(d.height_mm || 2000));
    list.push({ id: String(d.id || ""), x0, x1, w: wGap, h });
  }
  return list;
}

function getWindowIntervalsForWallFromState(state, wallId) {
  const openings = getOpeningsAll(state);
  const winsAll = openings.filter((o) => o && o.type === "window");
  const list = [];
  for (let i = 0; i < winsAll.length; i++) {
    const w = winsAll[i];
    if (String(w.wall || "front") !== wallId) continue;
    const wGap = Math.max(100, Math.floor(w.width_mm || 600));
    const x0 = Math.floor(w.x_mm ?? 0);
    const x1 = x0 + wGap;

    const y = Math.max(0, Math.floor(w.y_mm ?? 0));
    const h = Math.max(100, Math.floor(w.height_mm || 600));
    list.push({ id: String(w.id || ""), x0, x1, w: wGap, y, h });
  }
  return list;
}

/**
 * Pure BASIC panel segmentation helper.
 * IMPORTANT: This is a verbatim extraction of the existing BASIC panelization block inside buildWall().
 * It must not change behavior.
 */
function computeBasicPanels(length, prof, openingsX) {
  let panels = [{ start: 0, len: length }];

  if (length > 2400) {
    const p1 = Math.floor(length / 2);
    const p2 = length - p1;
    panels = [{ start: 0, len: p1 }, { start: p1, len: p2 }];

    const seamA = p1 - prof.studW;
    const seamB = p1 + prof.studW;

    const all = openingsX
      .map((o) => ({ x0: Math.floor(o.x0 ?? 0), x1: Math.floor(o.x1 ?? 0) }))
      .filter((o) => Number.isFinite(o.x0) && Number.isFinite(o.x1));

    all.sort((a, b) => (a.x0 - b.x0) || (a.x1 - b.x1));

    const clusters = [];
    if (all.length) {
      let cs = all[0].x0;
      let ce = all[0].x1;
      for (let i = 1; i < all.length; i++) {
        const o = all[i];
        const ne = Math.max(ce, o.x1);
        const span = ne - cs;
        if (span <= 2400) {
          ce = ne;
        } else {
          clusters.push({ x0: cs, x1: ce });
          cs = o.x0;
          ce = o.x1;
        }
      }
      clusters.push({ x0: cs, x1: ce });
    }

    const regions = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const coversSeam = !(c.x1 < seamA || c.x0 > seamB);
      if (!coversSeam) continue;

      const clusterPanelStart = clamp(c.x0 - prof.studW, 0, length);
      const clusterPanelEnd = clamp(c.x1 + prof.studW, 0, length);

      regions.push({ start: clusterPanelStart, end: clusterPanelEnd });
    }

    if (regions.length) {
      regions.sort((a, b) => a.start - b.start || a.end - b.end);

      const merged = [];
      let cur = { start: regions[0].start, end: regions[0].end };
      for (let i = 1; i < regions.length; i++) {
        const r = regions[i];
        if (r.start <= (cur.end + 1)) {
          cur.end = Math.max(cur.end, r.end);
        } else {
          merged.push(cur);
          cur = { start: r.start, end: r.end };
        }
      }
      merged.push(cur);

      const next = [];
      let cursor = 0;
      for (let i = 0; i < merged.length; i++) {
        const r = merged[i];
        const s = clamp(r.start, 0, length);
        const e = clamp(r.end, 0, length);
        if (s > cursor) {
          const leftLen = Math.max(0, s - cursor);
          if (leftLen > 0) next.push({ start: cursor, len: leftLen });
        }
        const midLen = Math.max(0, e - s);
        if (midLen > 0) next.push({ start: s, len: midLen });
        cursor = Math.max(cursor, e);
      }
      if (cursor < length) {
        const rightLen = Math.max(0, length - cursor);
        if (rightLen > 0) next.push({ start: cursor, len: rightLen });
      }

      panels = next.length ? next : panels;
    }
  }

  return panels;
}

function pickPanelIndexForCenter(panels, x0, x1) {
  const c = (Number(x0) + Number(x1)) / 2;
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const a = p.start;
    const b = p.start + p.len;
    if (c >= a && c < b) return i;
  }
  if (!panels.length) return -1;
  if (c < panels[0].start) return 0;
  return panels.length - 1;
}

/**
 * Update Wall Insulation and Plywood BOM sections
 * Called from updateBOM for both apex and pent roofs
 */
function updateWallInsulationBOM(state, variant, isPent) {
  console.log('[WALL_INS_BOM] Updating wall insulation BOM - variant:', variant);
  
  // Get elements for both pages
  const wallPirBodyEl = document.getElementById('wallPirBody');
  const wallPirSummaryEl = document.getElementById('wallPirSummary');
  const wallPirSectionEl = document.getElementById('wallPirSection');
  const wallPlyBodyEl = document.getElementById('wallPlyBody');
  const wallPlySummaryEl = document.getElementById('wallPlySummary');
  const wallPlySectionEl = document.getElementById('wallPlySection');
  const wallPirBodyEl2 = document.getElementById('wallPirBody2');
  const wallPirSummaryEl2 = document.getElementById('wallPirSummary2');
  const wallPirSectionEl2 = document.getElementById('wallPirSection2');
  const wallPlyBodyEl2 = document.getElementById('wallPlyBody2');
  const wallPlySummaryEl2 = document.getElementById('wallPlySummary2');
  const wallPlySectionEl2 = document.getElementById('wallPlySection2');
  
  console.log('[WALL_INS_BOM] Elements found:', {
    wallPirBodyEl: !!wallPirBodyEl,
    wallPirBodyEl2: !!wallPirBodyEl2,
    wallPlyBodyEl: !!wallPlyBodyEl,
    wallPlyBodyEl2: !!wallPlyBodyEl2
  });
  
  if (variant !== 'insulated') {
    console.log('[WALL_INS_BOM] Not insulated variant - hiding sections');
    if (wallPirSectionEl) wallPirSectionEl.style.display = 'none';
    if (wallPlySectionEl) wallPlySectionEl.style.display = 'none';
    if (wallPirSectionEl2) wallPirSectionEl2.style.display = 'none';
    if (wallPlySectionEl2) wallPlySectionEl2.style.display = 'none';
    return;
  }
  
  console.log('[WALL_INS_BOM] Insulated variant - calculating BOM');
  
  // Show sections
  if (wallPirSectionEl) wallPirSectionEl.style.display = '';
  if (wallPlySectionEl) wallPlySectionEl.style.display = '';
  if (wallPirSectionEl2) wallPirSectionEl2.style.display = '';
  if (wallPlySectionEl2) wallPlySectionEl2.style.display = '';
  
  const PIR_SHEET_W = 1200;
  const PIR_SHEET_L = 2400;
  const PLY_SHEET_W = 1220;
  const PLY_SHEET_L = 2440;
  
  // Get wall dimensions
  const frameW = Math.max(1, Math.floor(state.w));
  const frameD = Math.max(1, Math.floor(state.d));
  const prof = resolveProfile(state, variant);
  const wallThk = prof.studH;
  const studW = prof.studW;
  const STUD_SPACING = prof.spacing || 400;
  
  // Calculate wall height
  let height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));
  if (!isPent && state?.roof?.style === "apex") {
    const apexH = resolveApexHeightsMm(state);
    if (apexH && Number.isFinite(apexH.eaves_mm)) {
      const baseRise_mm = resolveBaseRiseMm(state);
      height = Math.max(100, Math.floor(apexH.eaves_mm - baseRise_mm));
    }
  } else if (isPent && state?.roof?.pent) {
    const minH = state.roof.pent.minHeight_mm || 2100;
    const maxH = state.roof.pent.maxHeight_mm || 2300;
    height = Math.max(minH, maxH);
  }
  
  const plateY = studW;
  const studLen = Math.max(1, height - 2 * plateY);
  
  const lengths = {
    front: frameW,
    back: frameW,
    left: Math.max(1, frameD - 2 * wallThk),
    right: Math.max(1, frameD - 2 * wallThk),
  };
  
  const flags = normalizeWallFlags(state);
  const walls = ["front", "back", "left", "right"].filter((w) => flags[w]);
  
  // Calculate PIR insulation
  let wallPirHtml = '';
  let totalPirArea = 0;
  
  for (const wname of walls) {
    const wallLen = lengths[wname];
    const doorsW = getDoorIntervalsForWallFromState(state, wname);
    const winsW = getWindowIntervalsForWallFromState(state, wname);
    const allOpenings = doorsW.concat(winsW);
    
    const studPositions = [0];
    let pos = STUD_SPACING;
    while (pos < wallLen - studW) {
      studPositions.push(pos);
      pos += STUD_SPACING;
    }
    studPositions.push(wallLen - studW);
    
    let bayCount = 0;
    for (let i = 0; i < studPositions.length - 1; i++) {
      const studStart = studPositions[i] + studW;
      const studEnd = studPositions[i + 1];
      const bayWidth = studEnd - studStart;
      
      let hasOpening = false;
      for (const o of allOpenings) {
        const ox0 = o.x0 || o.doorX0 || 0;
        const ox1 = o.x1 || o.doorX1 || (ox0 + (o.w || 800));
        if (studStart < ox1 && studEnd > ox0) {
          hasOpening = true;
          break;
        }
      }
      
      if (!hasOpening && bayWidth > 10) {
        bayCount++;
        totalPirArea += studLen * bayWidth;
      }
    }
    
    if (bayCount > 0) {
      wallPirHtml += `<tr><td>${wname.charAt(0).toUpperCase() + wname.slice(1)}</td><td>${bayCount}</td><td>${studLen}mm × ~${Math.round(STUD_SPACING - studW)}mm</td><td>Between studs</td></tr>`;
    }
  }
  
  const pirHtmlContent = wallPirHtml || `<tr><td colspan="4">None</td></tr>`;
  if (wallPirBodyEl) wallPirBodyEl.innerHTML = pirHtmlContent;
  if (wallPirBodyEl2) wallPirBodyEl2.innerHTML = pirHtmlContent;
  
  const pirSheetArea = PIR_SHEET_W * PIR_SHEET_L;
  const pirMinSheets = pirSheetArea > 0 ? Math.ceil(totalPirArea / pirSheetArea) : 0;
  const pirSummaryText = `50mm PIR (Celotex) - Minimum sheets (${PIR_SHEET_W}×${PIR_SHEET_L}mm): ${pirMinSheets}`;
  if (wallPirSummaryEl) wallPirSummaryEl.textContent = pirSummaryText;
  if (wallPirSummaryEl2) wallPirSummaryEl2.textContent = pirSummaryText;
  
  // Calculate plywood lining
  let wallPlyHtml = '';
  let totalPlyArea = 0;
  
  for (const wname of walls) {
    const wallLen = lengths[wname];
    const doorsW = getDoorIntervalsForWallFromState(state, wname);
    const winsW = getWindowIntervalsForWallFromState(state, wname);
    
    const panelH = height;
    const panelW = wallLen;
    
    const sheetsAcross = Math.ceil(panelW / PLY_SHEET_L);
    const sheetsUp = Math.ceil(panelH / PLY_SHEET_W);
    
    let openingArea = 0;
    for (const d of doorsW) {
      openingArea += (d.w || 800) * (d.h || 2000);
    }
    for (const w of winsW) {
      openingArea += (w.w || 600) * (w.h || 400);
    }
    
    const grossArea = panelH * panelW;
    const netArea = Math.max(0, grossArea - openingArea);
    totalPlyArea += netArea;
    
    wallPlyHtml += `<tr><td>${wname.charAt(0).toUpperCase() + wname.slice(1)}</td><td>${sheetsAcross * sheetsUp}</td><td>${panelH}mm × ${panelW}mm</td><td>${doorsW.length + winsW.length > 0 ? 'Cut for openings' : 'Full panel'}</td></tr>`;
  }
  
  const plyHtmlContent = wallPlyHtml || `<tr><td colspan="4">None</td></tr>`;
  if (wallPlyBodyEl) wallPlyBodyEl.innerHTML = plyHtmlContent;
  if (wallPlyBodyEl2) wallPlyBodyEl2.innerHTML = plyHtmlContent;
  
  const plySheetArea = PLY_SHEET_W * PLY_SHEET_L;
  const plyMinSheets = plySheetArea > 0 ? Math.ceil(totalPlyArea / plySheetArea) : 0;
  const plySummaryText = `12mm Plywood - Minimum 8×4ft sheets required: ${plyMinSheets}`;
  if (wallPlySummaryEl) wallPlySummaryEl.textContent = plySummaryText;
  if (wallPlySummaryEl2) wallPlySummaryEl2.textContent = plySummaryText;
  
  console.log('[WALL_INS_BOM] Done - PIR sheets:', pirMinSheets, 'Ply sheets:', plyMinSheets);
}

export function updateBOM(state) {
  console.log('[WALLS_BOM] updateBOM called');
  const isPent = !!(state && state.roof && String(state.roof.style || "") === "pent");
  const variant = state.walls?.variant || "insulated";
  console.log('[WALLS_BOM] isPent:', isPent, 'variant:', variant);
  
  // Update wall PIR and plywood BOM (runs for both apex and pent)
  updateWallInsulationBOM(state, variant, isPent);
  
  if (!isPent) {
    const sections = [];
    let totalFrameLength_mm = 0;  // Track total frame timber length
    const FRAME_STOCK_LENGTH = 6200;  // Frame timber stock length

    // Keep BOM consistent with build3D():
    // APEX ONLY: "Height to Eaves" implicitly drives the wall frame height (base-aware).
    let height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));
    if (state && state.roof && String(state.roof.style || "") === "apex") {
      const baseRise_mm = resolveBaseRiseMm(state);
      const apexH = resolveApexHeightsMm(state);
      if (apexH && Number.isFinite(apexH.eaves_mm)) {
        const minWallH_mm = Math.max(100, 2 * 50 + 1);
        height = Math.max(minWallH_mm, Math.floor(apexH.eaves_mm - baseRise_mm));
      }
    }

    const prof = resolveProfile(state, variant);

    const plateY = prof.studW;
    const wallThk = prof.studH;
    const studLen = Math.max(1, height - 2 * plateY);

    const frameW = Math.max(1, Math.floor(state.w));
    const frameD = Math.max(1, Math.floor(state.d));

    const lengths = {
      front: frameW,
      back: frameW,
      left: Math.max(1, frameD - 2 * wallThk),
      right: Math.max(1, frameD - 2 * wallThk),
    };

    const flags = normalizeWallFlags(state);
    const walls = ["front", "back", "left", "right"].filter((w) => flags[w]);

    for (const wname of walls) {
      const L = lengths[wname];

      // Wall header row
      sections.push([`WALL: ${wname} (${variant})`, "", "", "", "", `Frame L=${L}mm`]);

      // Panels for grouping (no geometry changes; basic uses same segmentation as buildWall)
      let panels = [{ start: 0, len: L }];
      if (variant === "basic") {
        const doors = getDoorIntervalsForWallFromState(state, wname);
        const wins = getWindowIntervalsForWallFromState(state, wname);
        const openingsX = doors.concat(wins);
        panels = computeBasicPanels(L, prof, openingsX);
        if (!panels.length) panels = [{ start: 0, len: L }];
      }

      // Precompute per-wall openings for attribution
      const doorsW = getDoorIntervalsForWallFromState(state, wname);
      const winsW = getWindowIntervalsForWallFromState(state, wname);

      const openingItemsByPanel = {};
      for (let i = 0; i < panels.length; i++) openingItemsByPanel[i] = [];

      // Doors -> panel that contains center point
      for (let i = 0; i < doorsW.length; i++) {
        const d = doorsW[i];
        const pi = pickPanelIndexForCenter(panels, d.x0, d.x1);
        if (pi < 0) continue;

        const id = String(d.id || "");
        const headerL = (d.w + 2 * prof.studW);

        openingItemsByPanel[pi].push(["  Door Uprights", 2, studLen, prof.studW, wallThk, `door ${id}`]);
        openingItemsByPanel[pi].push(["  Door Header", 1, headerL, prof.studH, wallThk, `door ${id}`]);
      }

      // Windows -> panel that contains center point
      for (let i = 0; i < winsW.length; i++) {
        const w = winsW[i];
        const pi = pickPanelIndexForCenter(panels, w.x0, w.x1);
        if (pi < 0) continue;

        const id = String(w.id || "");
        const headerL = (w.w + 2 * prof.studW);

        openingItemsByPanel[pi].push(["  Window Uprights", 2, studLen, prof.studW, wallThk, `window ${id}`]);
        openingItemsByPanel[pi].push(["  Window Header", 1, headerL, prof.studH, wallThk, `window ${id}`]);
        openingItemsByPanel[pi].push(["  Window Sill", 1, headerL, prof.studH, wallThk, `window ${id}`]);
      }

      for (let p = 0; p < panels.length; p++) {
        const pan = panels[p];

        // Panel header row
        sections.push([`  PANEL ${p + 1}`, "", "", "", "", `start=${pan.start}mm, len=${pan.len}mm`]);

        // Panel contents (all include L/W/D)
        sections.push([`  Bottom Plate`, 1, pan.len, plateY, wallThk, ""]);
        totalFrameLength_mm += pan.len;
        sections.push([`  Top Plate`, 1, pan.len, plateY, wallThk, ""]);
        totalFrameLength_mm += pan.len;

        if (variant === "basic") {
          // Mirrors current basic wall panel stud policy (3 studs per panel in buildBasicPanel; suppression is geometric-only)
          sections.push([`  Studs`, 3, studLen, prof.studW, wallThk, "basic"]);
          totalFrameLength_mm += 3 * studLen;
        } else {
          // Insulated stud count logic preserved (was previously per wall; now attributed under single panel)
          let count = 2;
          const spacingBOM = prof.spacing || 400;
          let run = spacingBOM;
          while (run <= pan.len - prof.studW) {
            count += 1;
            run += spacingBOM;
          }
          sections.push([`  Studs`, count, studLen, prof.studW, wallThk, "@400"]);
          totalFrameLength_mm += count * studLen;
        }

        // Opening framing items attributed to this panel
        const items = openingItemsByPanel[p] || [];
        for (let i = 0; i < items.length; i++) {
          sections.push(items[i]);
          // Accumulate frame length from opening items: [name, qty, length, ...]
          const qty = items[i][1];
          const len = items[i][2];
          if (typeof qty === 'number' && typeof len === 'number') {
            totalFrameLength_mm += qty * len;
          }
        }
      }
    }

    // ---- TOTAL FRAME SUMMARY (APEX) ----
    sections.push(["", "", "", "", "", ""]);
    const totalFrameStockPieces = Math.ceil(totalFrameLength_mm / FRAME_STOCK_LENGTH);
    sections.push([
      `TOTAL FRAME`,
      totalFrameStockPieces,
      FRAME_STOCK_LENGTH,
      "",
      "",
      `Total: ${Math.round(totalFrameLength_mm / 1000 * 10) / 10}m linear; ${totalFrameStockPieces} × ${FRAME_STOCK_LENGTH}mm lengths`
    ]);

    // ---- CLADDING CUTTING LIST (APEX) ----
    sections.push(["", "", "", "", "", ""]);
    sections.push(["CLADDING", "", "", "", "", ""]);
    
    const CLAD_BOARD_WIDTH = 140;  // Visible face height
    const CLAD_OVERLAP = 20;       // Overlap between boards
    const CLAD_THICKNESS = 20;
    const CLAD_EFFECTIVE = CLAD_BOARD_WIDTH - CLAD_OVERLAP; // 120mm effective coverage
    const CLAD_STOCK_LENGTH = 6200;
    const CLAD_BOTTOM_DROP = 60;
    
    // Corner board dimensions
    const CORNER_BOARD_THICKNESS = 20;
    const CORNER_BOARD_WIDTH = wallThk + CLAD_THICKNESS; // frame depth + cladding thickness
    
    let totalCladLength_mm = 0;
    const cladByWall = {};
    
    for (const wname of walls) {
      const L = lengths[wname];
      const wallH = height;
      
      // Calculate number of courses needed
      const claddingHeight = wallH - plateY + CLAD_BOTTOM_DROP;
      const courses = Math.ceil(claddingHeight / CLAD_BOARD_WIDTH);
      
      // Get openings for this wall
      const doorsW = getDoorIntervalsForWallFromState(state, wname);
      const winsW = getWindowIntervalsForWallFromState(state, wname);
      
      // Calculate total board length needed for this wall
      let wallTotalLength = 0;
      
      for (let c = 0; c < courses; c++) {
        const courseBottomY = plateY - CLAD_BOTTOM_DROP + (c * CLAD_BOARD_WIDTH);
        const courseTopY = courseBottomY + CLAD_BOARD_WIDTH;
        
        let courseLength = L;
        
        for (const d of doorsW) {
          const doorBottomY = plateY;
          const doorTopY = plateY + d.h;
          if (courseBottomY < doorTopY && courseTopY > doorBottomY) {
            courseLength -= d.w;
          }
        }
        
        for (const w of winsW) {
          const winBottomY = plateY + w.y;
          const winTopY = winBottomY + w.h;
          if (courseBottomY < winTopY && courseTopY > winBottomY) {
            courseLength -= w.w;
          }
        }
        
        wallTotalLength += Math.max(0, courseLength);
      }
      
      cladByWall[wname] = {
        courses,
        wallLength: L,
        wallHeight: wallH,
        totalLength: wallTotalLength,
        doors: doorsW.length,
        windows: winsW.length
      };
      
      totalCladLength_mm += wallTotalLength;
    }
    
    for (const wname of walls) {
      const c = cladByWall[wname];
      sections.push([
        `  ${wname.charAt(0).toUpperCase() + wname.slice(1)} wall cladding`,
        c.courses,
        c.wallLength,
        CLAD_BOARD_WIDTH,
        CLAD_THICKNESS,
        `${c.courses} courses × ${c.wallLength}mm; total run: ${c.totalLength}mm`
      ]);
    }
    
    const totalStockBoards = Math.ceil(totalCladLength_mm / CLAD_STOCK_LENGTH);
    sections.push([
      `  TOTAL CLADDING`,
      totalStockBoards,
      CLAD_STOCK_LENGTH,
      CLAD_BOARD_WIDTH,
      CLAD_THICKNESS,
      `Total: ${Math.round(totalCladLength_mm / 1000 * 10) / 10}m linear; ${totalStockBoards} × ${CLAD_STOCK_LENGTH}mm boards`
    ]);
    
    const cornerBoardHeight = height - plateY + CLAD_BOTTOM_DROP;
    sections.push([
      `  Corner boards`,
      4,
      cornerBoardHeight,
      CORNER_BOARD_WIDTH,
      CORNER_BOARD_THICKNESS,
      `4 corners`
    ]);

    return { sections };
  }

  const sections = [];
  let totalFrameLength_mm = 0;  // Track total frame timber length
  const FRAME_STOCK_LENGTH = 6200;  // Frame timber stock length
  // variant already declared above
  const baseHeight = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  const prof = resolveProfile(state, variant);

  const plateY = prof.studW;
  const wallThk = prof.studH;

  const frameW = Math.max(1, Math.floor(state.w));
  const frameD = Math.max(1, Math.floor(state.d));

  const minH = Math.max(100, Math.floor(Number(state?.roof?.pent?.minHeight_mm ?? baseHeight)));
  const maxH = Math.max(100, Math.floor(Number(state?.roof?.pent?.maxHeight_mm ?? baseHeight)));

  function heightAtX(x_mm) {
    const x = Math.max(0, Math.min(frameW, Math.floor(Number(x_mm))));
    const t = frameW > 0 ? (x / frameW) : 0;
    return Math.max(100, Math.floor(minH + (maxH - minH) * t));
  }

  const lengths = {
    front: frameW,
    back: frameW,
    left: Math.max(1, frameD - 2 * wallThk),
    right: Math.max(1, frameD - 2 * wallThk),
  };

  const flags = normalizeWallFlags(state);
  const walls = ["front", "back", "left", "right"].filter((w) => flags[w]);

  function isInsideAnyOpeningAt(pos, intervals) {
    for (let i = 0; i < intervals.length; i++) {
      const d = intervals[i];
      const c = pos + prof.studW / 2;
      if (c > d.x0 && c < d.x1) return true;
    }
    return false;
  }

  for (const wname of walls) {
    const L = lengths[wname];

    const isFrontBack = (wname === "front" || wname === "back");
    const isSlopeWall = isFrontBack;

    const wallHFlat = (wname === "left") ? minH : (wname === "right") ? maxH : baseHeight;
    const studLenFlat = Math.max(1, wallHFlat - 2 * plateY);

    sections.push([`WALL: ${wname} (${variant})`, "", "", "", "", `pent slope X; minH=${minH}mm, maxH=${maxH}mm; L=${L}mm`]);

    let panels = [{ start: 0, len: L }];
    if (variant === "basic" && isFrontBack) {
      const doors = getDoorIntervalsForWallFromState(state, wname);
      const wins = getWindowIntervalsForWallFromState(state, wname);
      const openingsX = doors.concat(wins);
      panels = computeBasicPanels(L, prof, openingsX);
      if (!panels.length) panels = [{ start: 0, len: L }];
    }

    const doorsW = getDoorIntervalsForWallFromState(state, wname);
    const winsW = getWindowIntervalsForWallFromState(state, wname);
    const openingsX = doorsW.concat(winsW);

    const openingItemsByPanel = {};
    for (let i = 0; i < panels.length; i++) openingItemsByPanel[i] = [];

    for (let i = 0; i < doorsW.length; i++) {
      const d = doorsW[i];
      const pi = pickPanelIndexForCenter(panels, d.x0, d.x1);
      if (pi < 0) continue;

      const id = String(d.id || "");
      const headerL = (d.w + 2 * prof.studW);

      const cx = Math.floor((d.x0 + d.x1) / 2);
      const topH = isSlopeWall ? heightAtX(cx) : wallHFlat;
      const studLenLocal = Math.max(1, topH - 2 * plateY);

      openingItemsByPanel[pi].push(["  Door Uprights", 2, studLenLocal, prof.studW, wallThk, `door ${id}; pent slope; ${wname}`]);
      openingItemsByPanel[pi].push(["  Door Header", 1, headerL, prof.studH, wallThk, `door ${id}; pent slope; ${wname}`]);
    }

    for (let i = 0; i < winsW.length; i++) {
      const w = winsW[i];
      const pi = pickPanelIndexForCenter(panels, w.x0, w.x1);
      if (pi < 0) continue;

      const id = String(w.id || "");
      const headerL = (w.w + 2 * prof.studW);

      const cx = Math.floor((w.x0 + w.x1) / 2);
      const topH = isSlopeWall ? heightAtX(cx) : wallHFlat;
      const studLenLocal = Math.max(1, topH - 2 * plateY);

      openingItemsByPanel[pi].push(["  Window Uprights", 2, studLenLocal, prof.studW, wallThk, `window ${id}; pent slope; ${wname}`]);
      openingItemsByPanel[pi].push(["  Window Header", 1, headerL, prof.studH, wallThk, `window ${id}; pent slope; ${wname}`]);
      openingItemsByPanel[pi].push(["  Window Sill", 1, headerL, prof.studH, wallThk, `window ${id}; pent slope; ${wname}`]);
    }

    for (let p = 0; p < panels.length; p++) {
      const pan = panels[p];

      sections.push([`  PANEL ${p + 1}`, "", "", "", "", `start=${pan.start}mm, len=${pan.len}mm`]);

      sections.push([`  Bottom Plate`, 1, pan.len, plateY, wallThk, isSlopeWall ? `pent slope; ${wname}` : ""]);
      totalFrameLength_mm += pan.len;

      if (isSlopeWall) {
        const x0 = pan.start;
        const x1 = pan.start + pan.len;
        const h0 = heightAtX(x0);
        const h1 = heightAtX(x1);
        sections.push([`  Top Plate (Sloped)`, 1, pan.len, plateY, wallThk, `pent slope; ${wname}; minH=${h0}mm maxH=${h1}mm`]);
        totalFrameLength_mm += pan.len;
      } else {
        sections.push([`  Top Plate`, 1, pan.len, plateY, wallThk, `pent; ${wname}; H=${wallHFlat}mm`]);
        totalFrameLength_mm += pan.len;
      }

      if (!isSlopeWall) {
        if (variant === "basic") {
          sections.push([`  Studs`, 3, studLenFlat, prof.studW, wallThk, `pent; ${wname}`]);
          totalFrameLength_mm += 3 * studLenFlat;
        } else {
          let count = 2;
          const spacingPent = prof.spacing || 400;
          let run = spacingPent;
          while (run <= pan.len - prof.studW) { count += 1; run += spacingPent; }
          sections.push([`  Studs`, count, studLenFlat, prof.studW, wallThk, `pent; ${wname}; @400`]);
          totalFrameLength_mm += count * studLenFlat;
        }
      } else {
        const studsByLen = {};

        function addStudLen(len) {
          const Lmm = Math.max(1, Math.floor(len));
          studsByLen[Lmm] = (studsByLen[Lmm] || 0) + 1;
        }

        if (variant === "basic") {
          const offsetAlong = pan.start;
          const panelLen = pan.len;

          const x0s = offsetAlong;
          const x1s = offsetAlong + panelLen - prof.studW;
          const xm = Math.max(x0s, Math.floor(offsetAlong + panelLen / 2 - prof.studW / 2));

          const panelOpenings = openingsX.filter((d) => {
            const s = d.x0;
            const e = d.x1;
            return e > offsetAlong && s < (offsetAlong + panelLen);
          });

          const studAt = (posStart) => {
            for (let i = 0; i < panelOpenings.length; i++) {
              const d = panelOpenings[i];
              if (posStart + prof.studW > d.x0 && posStart < d.x1) return false;
            }
            return true;
          };

          if (studAt(x0s)) {
            const cx = Math.floor(x0s + prof.studW / 2);
            addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
          }
          if (studAt(x1s)) {
            const cx = Math.floor(x1s + prof.studW / 2);
            addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
          }

          let midAllowed = true;
          for (let i = 0; i < panelOpenings.length; i++) {
            const d = panelOpenings[i];
            if (xm + prof.studW > d.x0 && xm < d.x1) { midAllowed = false; break; }
          }
          if (midAllowed) {
            const cx = Math.floor(xm + prof.studW / 2);
            addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
          }
        } else {
          const offset = pan.start;
          const len = pan.len;

          if (!isInsideAnyOpeningAt(offset, openingsX)) {
            const cx = Math.floor(offset + prof.studW / 2);
            addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
          }
          if (!isInsideAnyOpeningAt(offset + (len - prof.studW), openingsX)) {
            const cx = Math.floor(offset + (len - prof.studW) + prof.studW / 2);
            addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
          }

          const spacingSlope = prof.spacing || 400;
          let x = spacingSlope;
          while (x <= len - prof.studW) {
            if (Math.abs(x - (len - prof.studW)) < 1) break;
            const posStart = offset + x;
            if (!isInsideAnyOpeningAt(posStart, openingsX)) {
              const cx = Math.floor(posStart + prof.studW / 2);
              addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
            }
            x += spacingSlope;
          }
        }

        Object.keys(studsByLen).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
          sections.push([`  Studs`, studsByLen[k], Number(k), prof.studW, wallThk, `pent slope; ${wname}`]);
          totalFrameLength_mm += studsByLen[k] * Number(k);
        });
      }

      const items = openingItemsByPanel[p] || [];
      for (let i = 0; i < items.length; i++) {
        sections.push(items[i]);
        // Accumulate frame length from opening items: [name, qty, length, ...]
        const qty = items[i][1];
        const len = items[i][2];
        if (typeof qty === 'number' && typeof len === 'number') {
          totalFrameLength_mm += qty * len;
        }
      }
    }
  }

  // ---- TOTAL FRAME SUMMARY (PENT) ----
  sections.push(["", "", "", "", "", ""]);
  const totalFrameStockPieces = Math.ceil(totalFrameLength_mm / FRAME_STOCK_LENGTH);
  sections.push([
    `TOTAL FRAME`,
    totalFrameStockPieces,
    FRAME_STOCK_LENGTH,
    "",
    "",
    `Total: ${Math.round(totalFrameLength_mm / 1000 * 10) / 10}m linear; ${totalFrameStockPieces} × ${FRAME_STOCK_LENGTH}mm lengths`
  ]);

  // ---- CLADDING CUTTING LIST ----
  sections.push(["", "", "", "", "", ""]);
  sections.push(["CLADDING", "", "", "", "", ""]);
  
  const CLAD_BOARD_WIDTH = 140;  // Visible face height
  const CLAD_OVERLAP = 20;       // Overlap between boards
  const CLAD_THICKNESS = 20;
  const CLAD_EFFECTIVE = CLAD_BOARD_WIDTH - CLAD_OVERLAP; // 120mm effective coverage
  const CLAD_STOCK_LENGTH = 6200;
  const CLAD_BOTTOM_DROP = 60;
  
  // Corner board dimensions
  const CORNER_BOARD_THICKNESS = 20;
  const CORNER_BOARD_WIDTH = wallThk + CLAD_THICKNESS; // frame depth + cladding thickness
  
  let totalCladLength_mm = 0;
  const cladByWall = {};
  
  for (const wname of walls) {
    const L = lengths[wname];
    const wallH = (wname === "left") ? minH : (wname === "right") ? maxH : baseHeight;
    
    // Calculate number of courses needed
    const claddingHeight = wallH - plateY + CLAD_BOTTOM_DROP; // from drip line to top plate
    const courses = Math.ceil(claddingHeight / CLAD_BOARD_WIDTH);
    
    // Get openings for this wall
    const doorsW = getDoorIntervalsForWallFromState(state, wname);
    const winsW = getWindowIntervalsForWallFromState(state, wname);
    
    // Calculate total board length needed for this wall
    // For each course, subtract any openings that intersect that course height
    let wallTotalLength = 0;
    
    for (let c = 0; c < courses; c++) {
      const courseBottomY = plateY - CLAD_BOTTOM_DROP + (c * CLAD_BOARD_WIDTH);
      const courseTopY = courseBottomY + CLAD_BOARD_WIDTH;
      
      // Start with full wall length
      let courseLength = L;
      
      // Subtract door openings (doors go from floor to door height)
      for (const d of doorsW) {
        const doorBottomY = plateY;
        const doorTopY = plateY + d.h;
        
        // Check if this course overlaps the door opening
        if (courseBottomY < doorTopY && courseTopY > doorBottomY) {
          courseLength -= d.w;
        }
      }
      
      // Subtract window openings
      for (const w of winsW) {
        const winBottomY = plateY + w.y;
        const winTopY = winBottomY + w.h;
        
        // Check if this course overlaps the window opening
        if (courseBottomY < winTopY && courseTopY > winBottomY) {
          courseLength -= w.w;
        }
      }
      
      wallTotalLength += Math.max(0, courseLength);
    }
    
    cladByWall[wname] = {
      courses,
      wallLength: L,
      wallHeight: wallH,
      totalLength: wallTotalLength,
      doors: doorsW.length,
      windows: winsW.length
    };
    
    totalCladLength_mm += wallTotalLength;
  }
  
  // Output cladding by wall
  for (const wname of walls) {
    const c = cladByWall[wname];
    const stockBoards = Math.ceil(c.totalLength / CLAD_STOCK_LENGTH);
    
    sections.push([
      `  ${wname.charAt(0).toUpperCase() + wname.slice(1)} wall cladding`,
      c.courses,
      c.wallLength,
      CLAD_BOARD_WIDTH,
      CLAD_THICKNESS,
      `${c.courses} courses × ${c.wallLength}mm; total run: ${c.totalLength}mm`
    ]);
  }
  
  // Summary row
  const totalStockBoards = Math.ceil(totalCladLength_mm / CLAD_STOCK_LENGTH);
  sections.push([
    `  TOTAL CLADDING`,
    totalStockBoards,
    CLAD_STOCK_LENGTH,
    CLAD_BOARD_WIDTH,
    CLAD_THICKNESS,
    `Total: ${Math.round(totalCladLength_mm / 1000 * 10) / 10}m linear; ${totalStockBoards} × ${CLAD_STOCK_LENGTH}mm boards`
  ]);
  
  // Corner boards (4 pieces)
  const cornerBoardHeight = baseHeight - plateY + CLAD_BOTTOM_DROP; // Same as cladding height
  sections.push([
    `  Corner boards`,
    4,
    cornerBoardHeight,
    CORNER_BOARD_WIDTH,
    CORNER_BOARD_THICKNESS,
    `4 corners`
  ]);

  return { sections };
}

function resolveBaseRiseMm(state) {
  // Base/plinth rise above world ground (Y=0), in mm.
  // We intentionally support multiple legacy key shapes; first finite wins.
  // If no base exists, returns 0.
  const base = state && state.base ? state.base : null;

  const candidates = [
    base && base.height_mm,
    base && base.raise_mm,
    base && base.plinthHeight_mm,
    base && base.plinth_mm,
    state && state.baseHeight_mm,
    state && state.plinthHeight_mm,
    state && state.platformHeight_mm,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const n = Number(candidates[i]);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return 0;
}

function resolveApexHeightsMm(state) {
  // APEX roof height controls are ground-referenced absolute heights in mm:
  // - eaves_mm: ground -> underside of eaves at wall line
  // - crest_mm: ground -> highest roof point (ridge/crest)
  //
  // Deterministic correction:
  // - If crest < eaves, crest is clamped UP to eaves (prevents inverted roof).
  const apex = state && state.roof && state.roof.apex ? state.roof.apex : null;

  function pickMm() {
    for (let i = 0; i < arguments.length; i++) {
      const n = Number(arguments[i]);
      if (Number.isFinite(n)) return Math.floor(n);
    }
    return null;
  }

  // Support a few likely legacy key names without renaming state keys.
  const e = pickMm(
    apex && apex.eavesHeight_mm,
    apex && apex.heightToEaves_mm,
    apex && apex.eaves_mm,
    apex && apex.heightEaves_mm
  );

  const c = pickMm(
    apex && apex.crestHeight_mm,
    apex && apex.heightToCrest_mm,
    apex && apex.crest_mm,
    apex && apex.heightCrest_mm
  );

  let eaves_mm = (e == null) ? null : Math.max(0, e);
  let crest_mm = (c == null) ? null : Math.max(0, c);

  if (eaves_mm != null && crest_mm != null && crest_mm < eaves_mm) crest_mm = eaves_mm;

  return { eaves_mm, crest_mm };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* ---------------- APEX helpers (match roof.js maths for gable trim) ---------------- */

function getRoofFrameGauge_Apex(state) {
  const cfgW = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.w : 50));
  const cfgD = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.d : 100));

  let t = null;
  let d = null;

  try { t = (state && state.frame && state.frame.thickness_mm != null) ? Math.floor(Number(state.frame.thickness_mm)) : null; } catch (e0) { t = null; }
  try { d = (state && state.frame && state.frame.depth_mm != null) ? Math.floor(Number(state.frame.depth_mm)) : null; } catch (e1) { d = null; }

  const thickness_mm = (Number.isFinite(t) && t > 0) ? t : ((Number.isFinite(cfgW) && cfgW > 0) ? cfgW : 50);
  const depth_mm = (Number.isFinite(d) && d > 0) ? d : ((Number.isFinite(cfgD) && cfgD > 0) ? cfgD : 100);
  return { thickness_mm, depth_mm };
}

function computeApexRiseMm_likeRoofJs(state, spanA_mm) {
  const A_mm = Math.max(1, Math.floor(Number(spanA_mm || 1)));

  const OSB_THK_MM = 18;

  function _numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function _firstFinite() {
    for (let i = 0; i < arguments.length; i++) {
      const n = _numOrNull(arguments[i]);
      if (n != null) return n;
    }
    return null;
  }

  const apex = (state && state.roof && state.roof.apex) ? state.roof.apex : null;

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

  // Legacy default
  let rise_mm = clamp(Math.floor(A_mm * 0.20), 200, 900);

  if (eavesCtl_mm != null && crestCtl_mm != null) {
    const e0 = Math.max(0, Math.floor(eavesCtl_mm));
    let c0 = Math.max(0, Math.floor(crestCtl_mm));
    if (c0 < e0) c0 = e0;
    if (c0 < (e0 + OSB_THK_MM)) c0 = (e0 + OSB_THK_MM);

    const halfSpan_mm = Math.max(1, Math.floor(A_mm / 2));
    const delta_mm = Math.max(0, Math.floor(c0 - e0));

    const solveRiseFromDelta = (delta, halfSpan, osbThk) => {
      const target = Math.max(osbThk, Math.floor(delta));
      const f = (r) => {
        const rr = Math.max(0, Number(r));
        const den = Math.sqrt(halfSpan * halfSpan + rr * rr);
        const cosT = den > 1e-6 ? (halfSpan / den) : 1;
        return rr + (cosT * osbThk);
      };
      let lo = 0;
      let hi = Math.max(target + 2000, 1);
      for (let it = 0; it < 32; it++) {
        const mid = (lo + hi) / 2;
        if (f(mid) >= target) hi = mid;
        else lo = mid;
      }
      return Math.max(0, Math.floor(hi));
    };

    rise_mm = solveRiseFromDelta(delta_mm, halfSpan_mm, OSB_THK_MM);
  }

  return Math.max(0, Math.floor(rise_mm));
}

function computeApexRoofUndersideModelMm(state) {
  // Returns an underside-height function for the APEX roof in WORLD mm, consistent with roof.js.
  // Used to: (1) ensure cladding extends to roof line, (2) build the APEX gable CSG roof-trim cutter.
  try {
    const dims = resolveDims(state);
    const ovh = (dims && dims.overhang) ? dims.overhang : { l_mm: 0, r_mm: 0, f_mm: 0, b_mm: 0 };
    const l_mm = Math.max(0, Math.floor(Number(ovh.l_mm || 0)));

    const roofW_mm = Math.max(1, Math.floor(Number(dims?.roof?.w_mm ?? 1)));
    const A_mm = roofW_mm;
    const halfSpan_mm = Math.max(1, Math.floor(A_mm / 2));

    const rise_mm = computeApexRiseMm_likeRoofJs(state, A_mm);

    const g = getRoofFrameGauge_Apex(state);
    const baseW = Math.max(1, Math.floor(Number(g.thickness_mm)));
    const baseD = Math.max(1, Math.floor(Number(g.depth_mm)));
    const memberW_mm = baseD;
    const memberD_mm = baseW;

    const den = Math.sqrt(halfSpan_mm * halfSpan_mm + rise_mm * rise_mm);
    const cosT = den > 1e-6 ? (halfSpan_mm / den) : 1;

    const OSB_CLEAR_MM = 1;

    // roof.js placement rule (APEX):
    // - If BOTH eaves+crest controls provided => solve roofRootY so OSB underside at the roof edge hits eavesTargetAbs.
    // - Else => roofRootY sits at wallH (state.walls.height_mm).
    const apex = (state && state.roof && state.roof.apex) ? state.roof.apex : null;
    const eCtl = Number(apex && (apex.eavesHeight_mm ?? apex.heightToEaves_mm ?? apex.eaves_mm ?? apex.minHeight_mm ?? apex.heightEaves_mm));
    const cCtl = Number(apex && (apex.crestHeight_mm ?? apex.heightToCrest_mm ?? apex.crest_mm ?? apex.maxHeight_mm ?? apex.ridgeHeight_mm ?? apex.heightCrest_mm));
    const hasControls = Number.isFinite(eCtl) && Number.isFinite(cCtl);

    const wallH_mm = Math.max(100, Math.floor(Number(state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400)));

    const WALL_RISE_MM = 168;
    let roofRootY_mm;
    if (hasControls) {
      // Match roof.js exactly: roofRootY = eavesTargetAbs - WALL_RISE_MM
      // The tie beam underside is at eavesTargetAbs_mm
      // roofRoot.position.y = (eavesTargetAbs_mm - WALL_RISE_MM) / 1000 in roof.js
      // But index.js then adds WALL_RISE_MM shift to all roof meshes
      // So effective world Y of roofRoot = eavesTargetAbs_mm - WALL_RISE_MM + WALL_RISE_MM = eavesTargetAbs_mm
      // Wait no - let's trace more carefully:
      // roof.js: roofRoot.position.y = (eavesTargetAbs_mm - WALL_RISE_MM) / 1000
      // This is in mm: roofRootY_mm = eavesTargetAbs_mm - WALL_RISE_MM
      // Then index.js shifts by +WALL_RISE_MM, so final world Y = eavesTargetAbs_mm
      // The tie beam underside in local coords is at y=0
      // So tie beam underside world = roofRootY_mm + WALL_RISE_MM = eavesTargetAbs_mm ✓
      //
      // For OSB underside, we need to add the local offset which is eavesUnderLocalY_mm at eaves
      // OSB underside at eaves (world) = eavesTargetAbs_mm + eavesUnderLocalY_mm
      //
      // But wait - for the cladding CSG we want to cut at the OSB underside
      // yUnderAtLocalX gives the LOCAL offset above the tie beam (which is at y=0 locally)
      // So world Y of OSB underside = tie beam world Y + yUnderAtLocalX
      // = eavesTargetAbs_mm + yUnderAtLocalX(x)
      //
      // In yUnderAtWorldX_mm we do: roofRootY_mm + yUnderAtLocalX_mm(xLocal)
      // So we want roofRootY_mm = eavesTargetAbs_mm (the tie beam underside world Y)
      const eavesTargetAbs_mm = Math.max(0, Math.floor(eCtl));
      roofRootY_mm = eavesTargetAbs_mm;
    } else {
      // Legacy: no controls, roof sits on top of wall
      // Wall top plate is at wallH_mm + WALL_RISE_MM (with floor rise)
      // Tie beam underside = wall top plate = wallH_mm + WALL_RISE_MM
      roofRootY_mm = wallH_mm + WALL_RISE_MM;
    }

    // roofRoot X aligns local min corner to world -l (yaw=0), so: localX = worldX + l
    const roofRootX_mm = -l_mm;
    const ridgeLocalX_mm = halfSpan_mm;
    const ridgeWorldX_mm = roofRootX_mm + ridgeLocalX_mm;

    const yUnderAtLocalX_mm = (xLocal_mm) => {
      // Match roof.js formula exactly:
      // yUnderLocal_mm = memberD_mm + tanT * distFromEaves + offsetAlongY_atFixedX_mm
      // where offsetAlongY_atFixedX_mm = (memberD_mm + OSB_CLEAR_MM) / cosT
      //
      // At eaves (x=0 or x=A_mm): distFromEaves = 0, height is lowest
      // At ridge (x=halfSpan): distFromEaves = halfSpan, height is highest
      const x = Math.max(0, Math.min(A_mm, Math.floor(Number(xLocal_mm))));
      const tanT = rise_mm / Math.max(1, halfSpan_mm);
      const offsetAlongY_mm = (memberD_mm + OSB_CLEAR_MM) / Math.max(0.001, cosT);

      // Distance from nearest eave - 0 at eaves, halfSpan at ridge
      const distFromNearestEave = x <= halfSpan_mm ? x : (A_mm - x);
      return memberD_mm + tanT * distFromNearestEave + offsetAlongY_mm;
    };

    const yUnderAtWorldX_mm = (xWorld_mm) => {
      const xLocal_mm = Math.floor(Number(xWorld_mm)) - roofRootX_mm; // == xWorld + l
      return roofRootY_mm + yUnderAtLocalX_mm(xLocal_mm);
    };

    console.log('[APEX_MODEL_DEBUG]', {
      roofRootY_mm,
      roofRootX_mm,
      halfSpan_mm,
      rise_mm,
      memberD_mm,
      cosT,
      wallH_mm,
      WALL_RISE_MM,
      hasControls,
      eCtl,
      cCtl,
      l_mm,
      yAtEaves: yUnderAtLocalX_mm(0),
      yAtRidge: yUnderAtLocalX_mm(halfSpan_mm)
    });

    return {
      yUnderAtWorldX_mm,
      ridgeWorldX_mm
    };
  } catch (e) {
    return null;
  }
}
