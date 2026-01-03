// FILE: docs/src/elements/walls.js
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
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

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

  const CLAD_Rt = 5;
  const CLAD_Ht = 45;
  const CLAD_Rb = 5;
  const CLAD_Hb = 20;

  // DEBUG containers
  try {
    if (!window.__dbg) window.__dbg = {};
    if (!window.__dbg.cladding) window.__dbg.cladding = {};
    if (!window.__dbg.cladding.walls) window.__dbg.cladding.walls = {};
    window.__dbg.cladding.walls = {};
  } catch (e) {}

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
    const t = frameW > 0 ? (x / frameW) : 0;
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
      anchorsUsed: []
    };
  } catch (e) {}

  function addCladdingForPanel(wallId, axis, panelIndex, panelStart, panelLen, origin, panelHeight, buildPass) {
    const isAlongX = axis === "x";

    let mat = (materials && materials.cladding) ? materials.cladding : null;

    // Ensure cladding is noticeably lighter without mutating shared timber/plate materials.
    // Prefer basing the light material on materials.cladding when available.
    try {
      if (!scene._claddingMatLight) {
        let base = mat ? mat : (materials ? materials.timber : null);
        let m = null;

        if (base && base.clone) {
          m = base.clone("claddingMatLight");
        } else {
          m = new BABYLON.StandardMaterial("claddingMatLight", scene);
        }

        if (m) {
          // Light grey / bleached wood look
          try { m.diffuseColor = new BABYLON.Color3(0.85, 0.85, 0.82); } catch (e) {}
          try { m.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06); } catch (e) {}
          try { m.emissiveColor = new BABYLON.Color3(0.02, 0.02, 0.02); } catch (e) {}
          scene._claddingMatLight = m;
        } else {
          scene._claddingMatLight = null;
        }
      }
    } catch (e) {}

    if (scene._claddingMatLight) mat = scene._claddingMatLight;
    if (!mat) mat = materials.timber;

    const courses = Math.max(0, Math.floor(Number(panelHeight) / CLAD_H));
    if (courses < 1) return { created: 0, anchor: null };

    const parts = [];

    // Anchor cladding to TOP of the wall panel's own bottom plate (world-space), not assumed y=0.
    let wallBottomPlateBottomY_mm = 0;
    let wallBottomPlateTopY_mm = plateY;
    let claddingAnchorY_mm = plateY;
    let plateParent = null;

    let bbMinX_mm = null;
    let bbMaxX_mm = null;
    let bbMinZ_mm = null;
    let bbMaxZ_mm = null;

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
        const bi = plateMesh.getBoundingInfo();
        const bb = bi && bi.boundingBox ? bi.boundingBox : null;
        if (bb && bb.minimumWorld && bb.maximumWorld) {
          wallBottomPlateBottomY_mm = Number(bb.minimumWorld.y) * 1000;
          wallBottomPlateTopY_mm = Number(bb.maximumWorld.y) * 1000;
          claddingAnchorY_mm = wallBottomPlateTopY_mm;

          bbMinX_mm = Number(bb.minimumWorld.x) * 1000;
          bbMaxX_mm = Number(bb.maximumWorld.x) * 1000;
          bbMinZ_mm = Number(bb.minimumWorld.z) * 1000;
          bbMaxZ_mm = Number(bb.maximumWorld.z) * 1000;
        }
      }
    } catch (e) {}

    // Robust outside-plane selection (geometry-derived; no wallId sign logic)
    let outsidePlaneZ_mm = null;
    let outwardZ = 1;
    let outsidePlaneX_mm = null;
    let outwardX = 1;

    try {
      if (isAlongX) {
        const originZ = Number(origin && Number.isFinite(origin.z) ? origin.z : 0);
        if (Number.isFinite(bbMinZ_mm) && Number.isFinite(bbMaxZ_mm)) {
          const dMin = Math.abs(bbMinZ_mm - originZ);
          const dMax = Math.abs(bbMaxZ_mm - originZ);
          if (dMin < dMax) outsidePlaneZ_mm = bbMaxZ_mm;
          else outsidePlaneZ_mm = bbMinZ_mm;

          outwardZ = (outsidePlaneZ_mm === bbMaxZ_mm) ? 1 : -1;
        } else {
          outsidePlaneZ_mm = originZ + wallThk;
          outwardZ = 1;
        }
      } else {
        const originX = Number(origin && Number.isFinite(origin.x) ? origin.x : 0);
        if (Number.isFinite(bbMinX_mm) && Number.isFinite(bbMaxX_mm)) {
          const dMin = Math.abs(bbMinX_mm - originX);
          const dMax = Math.abs(bbMaxX_mm - originX);
          if (dMin < dMax) outsidePlaneX_mm = bbMaxX_mm;
          else outsidePlaneX_mm = bbMinX_mm;

          outwardX = (outsidePlaneX_mm === bbMaxX_mm) ? 1 : -1;
        } else {
          outsidePlaneX_mm = originX + wallThk;
          outwardX = 1;
        }
      }
    } catch (e) {}

    // DEBUG per wall/panel anchor (and per wall requested earlier)
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

      if (isAlongX) {
        // Front/Back run along X; thickness extrudes along Z.
        // Place cladding so its INNER face lies exactly on the selected outside plane,
        // and thickness extends entirely in the outward direction.
        const zInner = (outsidePlaneZ_mm !== null ? outsidePlaneZ_mm : (origin.z + wallThk));

        const zBottomMin = (outwardZ > 0) ? zInner : (zInner - CLAD_T);
        parts.push(
          mkBox(
            `clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
            panelLen,
            hBottomStrip,
            CLAD_T,
            { x: origin.x + panelStart, y: yBottomStrip, z: zBottomMin },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "bottom", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
          )
        );

        const tUpper = Math.max(1, CLAD_T - CLAD_Rb);
        const zUpperMin = (outwardZ > 0) ? zInner : (zInner - tUpper);

        parts.push(
          mkBox(
            `clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
            panelLen,
            hUpperStrip,
            tUpper,
            { x: origin.x + panelStart, y: yUpperStrip, z: zUpperMin },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "upper", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
          )
        );
      } else {
        // Left/Right run along Z; thickness extrudes along X.
        // Place cladding so its INNER face lies exactly on the selected outside plane,
        // and thickness extends entirely in the outward direction.
        const xInner = (outsidePlaneX_mm !== null ? outsidePlaneX_mm : (origin.x + wallThk));

        const xBottomMin = (outwardX > 0) ? xInner : (xInner - CLAD_T);
        parts.push(
          mkBox(
            `clad-${wallId}-panel-${panelIndex}-c${i}-bottom`,
            CLAD_T,
            hBottomStrip,
            panelLen,
            { x: xBottomMin, y: yBottomStrip, z: origin.z + panelStart },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "bottom", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
          )
        );

        const tUpper = Math.max(1, CLAD_T - CLAD_Rb);
        const xUpperMin = (outwardX > 0) ? xInner : (xInner - tUpper);

        parts.push(
          mkBox(
            `clad-${wallId}-panel-${panelIndex}-c${i}-upper`,
            tUpper,
            hUpperStrip,
            panelLen,
            { x: xUpperMin, y: yUpperStrip, z: origin.z + panelStart },
            mat,
            { wallId, panelIndex, course: i, type: "cladding", part: "upper", profile: { H: CLAD_H, T: CLAD_T, Rt: CLAD_Rt, Ht: CLAD_Ht, Rb: CLAD_Rb, Hb: CLAD_Hb } }
          )
        );
      }
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
      merged.name = `clad-${wallId}-panel-${panelIndex}`;
      merged.material = mat;
      merged.metadata = Object.assign({ dynamic: true }, { wallId, panelIndex, type: "cladding" });
      if (plateParent) merged.parent = plateParent;
      created = 1;
    } else {
      // If merge failed for any reason, keep parts as-is; still bind them to the wall's parent if present.
      if (plateParent) {
        for (let i = 0; i < parts.length; i++) {
          try { parts[i].parent = plateParent; } catch (e) {}
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
      }
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
            const res = addCladdingForPanel(j.wallId, j.axis, j.panelIndex, j.panelStart, j.panelLen, j.origin, j.panelHeight, passDbg);
            if (res && Number.isFinite(res.created)) createdCount += res.created;
          }

          try {
            if (!window.__dbg) window.__dbg = {};
            if (!window.__dbg.claddingPass) window.__dbg.claddingPass = {};
            window.__dbg.claddingPass.deferredRan = true;
            window.__dbg.claddingPass.staleSkip = false;
            window.__dbg.claddingPass.claddingMeshesCreated = createdCount;
          } catch (e) {}
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
        const ms = (xm - origin.x);
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
        const ms = (zm - origin.z);
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
        const pan = panels[p];
        let panelH = wallHeightFlat;
        if (isSlopeWall) {
          const h0 = heightAtX(origin.x + pan.start);
          const h1 = heightAtX(origin.x + pan.start + pan.len);
          panelH = Math.min(h0, h1);
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
      panelH = Math.min(h0, h1);
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

  const cfg = state?.walls?.[variant];
  const w = Math.floor(Number(cfg?.section?.w));
  const h = Math.floor(Number(cfg?.section?.h));

  const studW = Number.isFinite(w) && w > 0 ? w : defaults.studW;
  const studH = Number.isFinite(h) && h > 0 ? h : defaults.studH;

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
    const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
