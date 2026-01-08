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
export function build3D(state, ctx) {
  const { scene, materials } = ctx;
  const variant = state.walls?.variant || "insulated";

  // Precompute apex roof underside model once per rebuild (used only for gable cladding trim + height).
  const apexRoofModel = (state && state.roof && String(state.roof.style || "") === "apex")
    ? computeApexRoofUndersideModelMm(state)
    : null;

  // Wall height is normally driven by state.walls.height_mm.
  // APEX ONLY: "Height to Eaves" is a ground-referenced target for the roof eaves UNDERSIDE at the wall line.
  // To make that control drive the building, we implicitly drive the wall frame height here.
  // Base-aware: if the building has a raised base/plinth, we subtract that rise so the final eaves underside
  // remains at the requested ground-referenced height.
  //
  // NOTE: deterministic correction (shared with roof logic):
  // - If crest < eaves, crest is clamped up to eaves (no inverted roof).
  let height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));
  if (state && state.roof && String(state.roof.style || "") === "apex") {
    const baseRise_mm = resolveBaseRiseMm(state);
    const apexH = resolveApexHeightsMm(state);
    if (apexH && Number.isFinite(apexH.eaves_mm)) {
      // Wall frame height is measured from the local "ground" used by walls (world Y=0).
      // We clamp to a sane minimum so plates can exist.
      const minWallH_mm = Math.max(100, 2 * 50 + 1); // 2 plates (approx) + 1mm
      height = Math.max(minWallH_mm, Math.floor(apexH.eaves_mm - baseRise_mm));
    }
  }

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith("wall-"))
    .forEach((m) => {
      if (!m.isDisposed()) m.dispose(false, true);
    });

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith("clad-"))
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

  // ---- Cladding (Phase 1): external shiplap, geometry only ----
  const CLAD_H = 140;
  const CLAD_T = 20;
  const CLAD_DRIP = 30;
  const CLAD_BOTTOM_DROP_MM = 60;

  const CLAD_Rt = 5;
  const CLAD_Ht = 45;
  const CLAD_Rb = 5;
  const CLAD_Hb = 20;

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

  const minH = isPent
    ? Math.max(100, Math.floor(Number(state?.roof?.pent?.minHeight_mm ?? height)))
    : height;
  const maxH = isPent
    ? Math.max(100, Math.floor(Number(state?.roof?.pent?.maxHeight_mm ?? height)))
    : height;

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
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    return mesh;
  }

  function mkSlopedPlateAlongX(name, Lx, Lz, origin, yTopAtX0, yTopAtX1, mat, meta) {
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
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
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

    if (__DIAG_ONE_FRONT_ONE_BOARD) {
      if (!(String(wallId) === "front" && Number(panelIndex) === 1)) {
        return { created: 0, anchor: null, reason: "diagSkipNotFrontPanel1" };
      }
    }

    // Light cladding material (do NOT mutate shared materials) — KEEP AS-IS
    let mat = materials && materials.cladding ? materials.cladding : materials.timber;
    try {
      if (!scene._claddingMatLight) {
        let base = (materials && materials.cladding) ? materials.cladding : null;
        let m = null;
        if (base && base.clone) {
          m = base.clone("claddingMatLight");
        } else {
          m = new BABYLON.StandardMaterial("claddingMatLight", scene);
        }
        if (m) {
          m.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
          try { m.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1); } catch (e) {}
          scene._claddingMatLight = m;
        }
      }
      if (scene._claddingMatLight) mat = scene._claddingMatLight;
    } catch (e) {}

    const ph = Number(panelHeight);
    const panelHeightMm = Number.isFinite(ph) ? ph : height;

    // FIX: Use Math.ceil to ensure we have enough courses to cover the full height
    let courses = Math.max(1, Math.ceil(panelHeightMm / CLAD_H));
    if (__DIAG_ONE_FRONT_ONE_BOARD) courses = 1;

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
          claddingAnchorY_mm = desiredFirstBottomY_mm - 95;

          xMin_mm = Number(bb.minimumWorld.x) * 1000;
          xMax_mm = Number(bb.maximumWorld.x) * 1000;
          zMin_mm = Number(bb.minimumWorld.z) * 1000;
          zMax_mm = Number(bb.maximumWorld.z) * 1000;
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

    for (let i = 0; i < courses; i++) {
      const isFirst = i === 0;
      const firstCourseYOffsetMm = (isFirst ? 125 : 0);
      const yBase = claddingAnchorY_mm + i * CLAD_H + firstCourseYOffsetMm;

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
          `clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
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
          `clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
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

        const b0 = mkBox(
          `clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
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
          `clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
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
            const s0 = Math.max(panelA0, Math.floor(Number(a0)));
            const s1 = Math.min(panelA1, Math.floor(Number(a1)));
            const len = Math.max(0, s1 - s0);
            const hh = Math.max(0, Math.floor(Number(y1)) - Math.floor(Number(y0)));
            if (len < 1 || hh < 1) return;

            const name = `cladcut-${String(wallId)}-panel-${String(panelIndex)}-${String(cutters.length)}`;
            let m = null;

            if (isAlongX) {
              m = BABYLON.MeshBuilder.CreateBox(
                name,
                { width: len / 1000, height: hh / 1000, depth: cutDepth / 1000 },
                scene
              );
              m.position = new BABYLON.Vector3(
                (origin.x + s0 + len / 2) / 1000,
                (Math.floor(Number(y0)) + hh / 2) / 1000,
                (cutMinOut_mm + cutDepth / 2) / 1000
              );
            } else {
              m = BABYLON.MeshBuilder.CreateBox(
                name,
                { width: cutDepth / 1000, height: hh / 1000, depth: len / 1000 },
                scene
              );
              m.position = new BABYLON.Vector3(
                (cutMinOut_mm + cutDepth / 2) / 1000,
                (Math.floor(Number(y0)) + hh / 2) / 1000,
                (origin.z + s0 + len / 2) / 1000
              );
            }

            if (m) cutters.push(m);
          }

          for (let i = 0; i < doors.length; i++) {
            const d = doors[i];
            const y0 = plateY;
            const y1 = plateY + Math.max(1, Math.floor(Number(d.h || 0)));
            addCutterSpan(d.x0, d.x1, y0, y1);
          }

          for (let i = 0; i < wins.length; i++) {
            const w = wins[i];
            const y0 = plateY + Math.max(0, Math.floor(Number(w.y || 0)));
            const y1 = y0 + Math.max(1, Math.floor(Number(w.h || 0)));
            addCutterSpan(w.x0, w.x1, y0, y1);
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
                resMesh = resCSG.toMesh(`clad-${wallId}-panel-${panelIndex}`, mat, scene, false);
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
        const hasCSG =
          typeof BABYLON !== "undefined" &&
          BABYLON &&
          BABYLON.CSG &&
          typeof BABYLON.CSG.FromMesh === "function";

        if (hasCSG && merged) {
          const roofStyle = state && state.roof ? String(state.roof.style || "") : "";

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

                // PENT: clip to underside line (not wall top). Drop by top-plate thickness.
                const PENT_CLIP_DROP_MM = plateY; // 50mm typically
                const yA0 = Math.max(0, heightAtX(xA0) - PENT_CLIP_DROP_MM);
                const yA1 = Math.max(0, heightAtX(xA1) - PENT_CLIP_DROP_MM);

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
                if (apexRoofModel) {
                  const xA0 = origin.x + Math.floor(Number(panelStart || 0));
                  const xA1 = xA0 + Math.floor(Number(panelLen || 0));

                  const wedges = [];
                  const ridgeX = Number(apexRoofModel.ridgeWorldX_mm);

                  const yAt = (x_mm) => Math.floor(apexRoofModel.yUnderAtWorldX_mm(x_mm));

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
                        try { cutterCSG = cutterCSG.union(BABYLON.CSG.FromMesh(wedges[wi])); } catch (e) {}
                      }
                    } catch (e) { cutterCSG = null; }
                  }

                  for (let wi = 0; wi < wedges.length; wi++) {
                    try { if (wedges[wi] && !wedges[wi].isDisposed()) wedges[wi].dispose(false, true); } catch (e) {}
                  }
                }
              }
            } else if (!isAlongX && (String(wallId) === "left" || String(wallId) === "right")) {
              // Left/right walls - horizontal cut at constant height for pent roofs
              if (roofStyle === "pent") {
                const wallOutsideFaceWorldX = (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));

                // FIX: Position the cutter to fully encompass the cladding regardless of outward direction
                const cutMinX_mm = Math.floor(wallOutsideFaceWorldX - CUT_EXTRA_ROOF);
                const cutMaxX_mm = Math.floor(wallOutsideFaceWorldX + CLAD_T + CUT_EXTRA_ROOF);

                // Left wall cuts at minH, right wall cuts at maxH
                // PENT: clip to underside line (not wall top). Drop by top-plate thickness.
                const PENT_CLIP_DROP_MM = plateY;
                const cutHeightRaw = (String(wallId) === "left") ? minH : maxH;
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
              let resMesh = null;
              try {
                const baseCSG = BABYLON.CSG.FromMesh(merged);
                const resCSG = baseCSG.subtract(cutterCSG);
                resMesh = resCSG.toMesh(`clad-${wallId}-panel-${panelIndex}-roofclip`, mat, scene, false);
              } catch (e) {
                resMesh = null;
              }

              if (resMesh) {
                try { if (merged && !merged.isDisposed()) merged.dispose(false, true); } catch (e) {}
                merged = resMesh;
              }
            }
          }
        }
      } catch (e) {}
      // ---- END roof clip ----

      merged.name = `clad-${wallId}-panel-${panelIndex}`;
      merged.material = mat;
      merged.metadata = Object.assign({ dynamic: true }, { wallId, panelIndex, type: "cladding" });

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

  function scheduleDeferredCladdingPass() {
    try {
      scene._pendingCladding = { buildId, jobs: claddingJobs };
    } catch (e) {}

    try {
      if (!window.__dbg) window.__dbg = {};
      if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
      window.__dbg.claddingPass.deferredScheduled = true;
    } catch (e) {}

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

          try {
            if (!window.__dbg) window.__dbg = {};
            if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
            if (!window.__dbg.claddingPass.anchorsUsed) window.__dbg.claddingPass.anchorsUsed = [];
            window.__dbg.claddingPass.jobsCount = claddingJobs.length;
            if (!window.__dbg.claddingPass.jobsProcessedByWallId) window.__dbg.claddingPass.jobsProcessedByWallId = {};
            if (!window.__dbg.claddingPass.meshesCreatedByWallId) window.__dbg.claddingPass.meshesCreatedByWallId = {};
            if (!window.__dbg.claddingPass.sampleOutsideByWallId) window.__dbg.claddingPass.sampleOutsideByWallId = {};
            if (!window.__dbg.claddingPass.perWall) window.__dbg.claddingPass.perWall = {};
          } catch (e) {}

          const passDbg = (() => {
            try {
              return window.__dbg && window.__dbg.claddingPass ? window.__dbg.claddingPass : null;
            } catch (e) {
              return null;
            }
          })();

          for (let i = 0; i < claddingJobs.length; i++) {
            const j = claddingJobs[i];
            const wk = String(j.wallId || "");

            try {
              if (passDbg && passDbg.perWall) {
                if (!passDbg.perWall[wk]) passDbg.perWall[wk] = { jobs: 0, created: 0, reasons: [] };
                passDbg.perWall[wk].jobs = Number(passDbg.perWall[wk].jobs || 0) + 1;
              }
            } catch (e) {}

            try {
              if (passDbg && passDbg.jobsProcessedByWallId) {
                passDbg.jobsProcessedByWallId[wk] = Number(passDbg.jobsProcessedByWallId[wk] || 0) + 1;
              }
            } catch (e) {}

            let res = null;
            try {
              res = addCladdingForPanel(j.wallId, j.axis, j.panelIndex, j.panelStart, j.panelLen, j.origin, j.panelHeight, passDbg);
            } catch (e) {
              res = null;
            }

            if (res && Number.isFinite(res.created)) {
              createdCount += res.created;

              try {
                if (passDbg && passDbg.meshesCreatedByWallId) {
                  passDbg.meshesCreatedByWallId[wk] = Number(passDbg.meshesCreatedByWallId[wk] || 0) + Number(res.created || 0);
                }
              } catch (e) {}

              try {
                if (passDbg && passDbg.perWall) {
                  if (!passDbg.perWall[wk]) passDbg.perWall[wk] = { jobs: 0, created: 0, reasons: [] };
                  passDbg.perWall[wk].created = Number(passDbg.perWall[wk].created || 0) + Number(res.created || 0);
                  if (Number(res.created || 0) === 0) {
                    const reason = String(res.reason || "");
                    const fb = !!res.bboxMissingFallbackUsed;
                    passDbg.perWall[wk].reasons.push({
                      panelIndex: j.panelIndex,
                      reason: reason || "created==0",
                      bboxMissingFallbackUsed: fb
                    });
                  }
                }
              } catch (e) {}
            } else {
              try {
                if (passDbg && passDbg.perWall) {
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

          if (cladFitAgg) {
            try {
              if (!window.__dbg) window.__dbg = {};
              window.__dbg.cladFit = {
                ok: !!cladFitAgg.ok,
                eps_mm: Number(cladFitAgg.eps_mm),
                worst: cladFitAgg.worst,
                samplesCount: Number(cladFitAgg.samplesCount || 0)
              };

              if (window.__dbg.cladFit.ok) {
                console.log("CLAD_FIT OK eps=" + Number(cladFitAgg.eps_mm) + " samples=" + Number(cladFitAgg.samplesCount || 0));
              } else {
                const w = cladFitAgg.worst || {};
                const mm = Number(w.mm || 0);
                const mmTxt = (mm >= 0 ? "+" : "") + mm.toFixed(1);
                console.log(
                  "CLAD_FIT FAIL side=" +
                    String(w.side || "right") +
                    " mm=" +
                    mmTxt +
                    " wall=" +
                    String(w.wallName || "") +
                    " panel=" +
                    String(w.panelIndex != null ? w.panelIndex : "null") +
                    " course=" +
                    String(w.courseIndex != null ? w.courseIndex : "null") +
                    " eps=" +
                    Number(cladFitAgg.eps_mm)
                );
              }
            } catch (e) {}
          }
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
      const x0 = Math.floor(d.x_mm ?? 0);
      const x1 = x0 + wGap;
      const h = Math.max(100, Math.floor(d.height_mm || 2000));
      list.push({ id: String(d.id || ""), x0, x1, w: wGap, h });
    }
    return list;
  }

  function windowIntervalsForWall(wallId) {
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

    const doorX0 = door.x0;
    const doorX1 = door.x1;

    const isSlopeWall = isPent && (wallId === "front" || wallId === "back");
    const centerX = origin.x + Math.floor((doorX0 + doorX1) / 2);

    const wallTop = isSlopeWall ? heightAtX(centerX) : (wallId === "left" ? minH : wallId === "right" ? maxH : height);
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);

    const uprightH = studLenLocal;

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

    const desiredHeaderY = plateY + doorH;
    const maxHeaderY = Math.max(plateY, wallTop - prof.studH);
    const headerY = Math.min(desiredHeaderY, maxHeaderY);

    mkBox(
      `wall-${wallId}-door-${id}-header`,
      headerL,
      prof.studH,
      thickness,
      { x: origin.x + (doorX0 - prof.studW), y: headerY, z: origin.z },
      mat,
      { doorId: id }
    );
  }

  function addDoorFramingAlongZ(wallId, origin, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidDoorSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    const doorZ0 = door.x0;
    const doorZ1 = door.x1;

    const wallTop = isPent ? (wallId === "left" ? minH : maxH) : height;
    const studLenLocal = Math.max(1, wallTop - 2 * plateY);
    const uprightH = studLenLocal;

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

    const desiredHeaderY = plateY + doorH;
    const maxHeaderY = Math.max(plateY, wallTop - prof.studH);
    const headerY = Math.min(desiredHeaderY, maxHeaderY);

    mkBox(
      `wall-${wallId}-door-${id}-header`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: headerY, z: origin.z + (doorZ0 - prof.studW) },
      mat,
      { doorId: id }
    );
  }

  function addWindowFramingAlongX(wallId, origin, win) {
    const thickness = wallThk;
    const id = win.id;
    const useInvalid = invalidWinSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    const x0 = win.x0;
    const x1 = win.x1;

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
      { x: origin.x + (x0 - prof.studW), y: y0, z: origin.z },
      mat,
      { windowId: id }
    );
  }

  function addWindowFramingAlongZ(wallId, origin, win) {
    const thickness = wallThk;
    const id = win.id;
    const useInvalid = invalidWinSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    const z0 = win.x0;
    const z1 = win.x1;

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
      { x: origin.x, y: plateY, z: origin.z + (z0 - prof.studW) },
      mat,
      { windowId: id }
    );
    mkBox(
      `wall-${wallId}-win-${id}-upright-right`,
      thickness,
      uprightH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + z1 },
      mat,
      { windowId: id }
    );

    const headerL = (win.w + 2 * prof.studW);
    mkBox(
      `wall-${wallId}-win-${id}-header`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: yTop, z: origin.z + (z0 - prof.studW) },
      mat,
      { windowId: id }
    );

    mkBox(
      `wall-${wallId}-win-${id}-sill`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: y0, z: origin.z + (z0 - prof.studW) },
      mat,
      { windowId: id }
    );
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
    const wallPrefix = `wall-${wallId}-`;

    const doors = doorIntervalsForWall(wallId);
    const wins = windowIntervalsForWall(wallId);
    const openingsX = doors.concat(wins);

    const isSlopeWall = isPent && isAlongX && (wallId === "front" || wallId === "back");

    const wallHeightFlat = isPent
      ? (wallId === "left" ? minH : wallId === "right" ? maxH : height)
      : height;

    const studLenFlat = Math.max(1, wallHeightFlat - 2 * plateY);

    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      if (!isSlopeWall) {
        mkBox(wallPrefix + "plate-top", length, plateY, wallThk, { x: origin.x, y: wallHeightFlat - plateY, z: origin.z }, materials.plate);
      } else {
        const yTop0 = heightAtX(origin.x);
        const yTop1 = heightAtX(origin.x + length);
        mkSlopedPlateAlongX(
          wallPrefix + "plate-top",
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
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", wallThk, plateY, length, { x: origin.x, y: wallHeightFlat - plateY, z: origin.z }, materials.plate);
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
        const pref = wallPrefix + `panel-${p + 1}-`;
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

        if (isSlopeWall) {
          const h0 = heightAtX(origin.x + pan.start);
          const h1 = heightAtX(origin.x + pan.start + pan.len);
          panelH = Math.max(h0, h1);
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
            const crestLocal_mm = Math.floor(apexH.crest_mm - baseRise_mm);
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
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber));
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
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(x, openingsX)) placeStud(origin.x + x, origin.z, x);
        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(z, openingsX)) placeStud(origin.x, origin.z + z, z);
        z += prof.spacing;
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
      panelH = Math.max(h0, h1);
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
        const crestLocal_mm = Math.floor(apexH.crest_mm - baseRise_mm);
        if (Number.isFinite(crestLocal_mm)) panelH = Math.max(panelH, crestLocal_mm);
      }
    }

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

  // Schedule one-shot deferred cladding build (one frame later)
  scheduleDeferredCladdingPass();
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

export function updateBOM(state) {
  const isPent = !!(state && state.roof && String(state.roof.style || "") === "pent");
  if (!isPent) {
    const sections = [];
    const variant = state.walls?.variant || "insulated";

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
        sections.push([`  Top Plate`, 1, pan.len, plateY, wallThk, ""]);

        if (variant === "basic") {
          // Mirrors current basic wall panel stud policy (3 studs per panel in buildBasicPanel; suppression is geometric-only)
          sections.push([`  Studs`, 3, studLen, prof.studW, wallThk, "basic"]);
        } else {
          // Insulated stud count logic preserved (was previously per wall; now attributed under single panel)
          let count = 2;
          let run = 400;
          while (run <= pan.len - prof.studW) {
            count += 1;
            run += prof.spacing;
          }
          sections.push([`  Studs`, count, studLen, prof.studW, wallThk, "@400"]);
        }

        // Opening framing items attributed to this panel
        const items = openingItemsByPanel[p] || [];
        for (let i = 0; i < items.length; i++) sections.push(items[i]);
      }
    }

    return { sections };
  }

  const sections = [];
  const variant = state.walls?.variant || "insulated";
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

      if (isSlopeWall) {
        const x0 = pan.start;
        const x1 = pan.start + pan.len;
        const h0 = heightAtX(x0);
        const h1 = heightAtX(x1);
        sections.push([`  Top Plate (Sloped)`, 1, pan.len, plateY, wallThk, `pent slope; ${wname}; minH=${h0}mm maxH=${h1}mm`]);
      } else {
        sections.push([`  Top Plate`, 1, pan.len, plateY, wallThk, `pent; ${wname}; H=${wallHFlat}mm`]);
      }

      if (!isSlopeWall) {
        if (variant === "basic") sections.push([`  Studs`, 3, studLenFlat, prof.studW, wallThk, `pent; ${wname}`]);
        else {
          let count = 2;
          let run = 400;
          while (run <= pan.len - prof.studW) { count += 1; run += prof.spacing; }
          sections.push([`  Studs`, count, studLenFlat, prof.studW, wallThk, `pent; ${wname}; @400`]);
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

          let x = 400;
          while (x <= len - prof.studW) {
            if (Math.abs(x - (len - prof.studW)) < 1) break;
            const posStart = offset + x;
            if (!isInsideAnyOpeningAt(posStart, openingsX)) {
              const cx = Math.floor(posStart + prof.studW / 2);
              addStudLen(Math.max(1, heightAtX(cx) - 2 * plateY));
            }
            x += prof.spacing;
          }
        }

        Object.keys(studsByLen).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
          sections.push([`  Studs`, studsByLen[k], Number(k), prof.studW, wallThk, `pent slope; ${wname}`]);
        });
      }

      const items = openingItemsByPanel[p] || [];
      for (let i = 0; i < items.length; i++) sections.push(items[i]);
    }
  }

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
    const eavesUnderLocalY_mm = memberD_mm + cosT * (memberD_mm + OSB_CLEAR_MM);

    // roof.js placement rule (APEX):
    // - If BOTH eaves+crest controls provided => solve roofRootY so OSB underside at the roof edge hits eavesTargetAbs.
    // - Else => roofRootY sits at wallH (state.walls.height_mm).
    const apex = (state && state.roof && state.roof.apex) ? state.roof.apex : null;
    const eCtl = Number(apex && (apex.eavesHeight_mm ?? apex.heightToEaves_mm ?? apex.eaves_mm ?? apex.minHeight_mm ?? apex.heightEaves_mm));
    const cCtl = Number(apex && (apex.crestHeight_mm ?? apex.heightToCrest_mm ?? apex.crest_mm ?? apex.maxHeight_mm ?? apex.ridgeHeight_mm ?? apex.heightCrest_mm));
    const hasControls = Number.isFinite(eCtl) && Number.isFinite(cCtl);

    const wallH_mm = Math.max(100, Math.floor(Number(state && state.walls && state.walls.height_mm != null ? state.walls.height_mm : 2400)));

    let roofRootY_mm = wallH_mm;
    if (hasControls) {
      // Use the same corrected eaves target as roof.js (crest correction handled inside rise solver).
      const eavesTargetAbs_mm = Math.max(0, Math.floor(eCtl));
      roofRootY_mm = Math.floor(eavesTargetAbs_mm - eavesUnderLocalY_mm);
    }

    // roofRoot X aligns local min corner to world -l (yaw=0), so: localX = worldX + l
    const roofRootX_mm = -l_mm;
    const ridgeLocalX_mm = halfSpan_mm;
    const ridgeWorldX_mm = roofRootX_mm + ridgeLocalX_mm;

    const yUnderAtLocalX_mm = (xLocal_mm) => {
      const x = Math.max(0, Math.min(A_mm, Math.floor(Number(xLocal_mm))));
      const dx = Math.abs(x - ridgeLocalX_mm);
      const t = Math.max(0, Math.min(1, 1 - (dx / halfSpan_mm)));
      const ySurf_mm = memberD_mm + Math.floor(rise_mm * t);
      return ySurf_mm + cosT * (memberD_mm + OSB_CLEAR_MM);
    };

    const yUnderAtWorldX_mm = (xWorld_mm) => {
      const xLocal_mm = Math.floor(Number(xWorld_mm)) - roofRootX_mm; // == xWorld + l
      return roofRootY_mm + yUnderAtLocalX_mm(xLocal_mm);
    };

    return {
      yUnderAtWorldX_mm,
      ridgeWorldX_mm
    };
  } catch (e) {
    return null;
  }
}
