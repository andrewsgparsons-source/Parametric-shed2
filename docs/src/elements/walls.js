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
 * CORNER JOIN (requested change):
 * - Panels must NOT overlap/intersect at corners.
 * - Front/Back are full building frame width (dims.w).
 * - Left/Right run BETWEEN front/back, so their length is (dims.d - 2 * wallThickness)
 *   and they start at z = wallThickness.
 *
 * Door logic remains insulated-only (basic ignores door controls).
 *
 * @param {any} state Derived state for walls (w/d already resolved to frame outer dims)
 * @param {{scene:BABYLON.Scene, materials:any}} ctx
 */
export function build3D(state, ctx) {
  const { scene } = ctx;
  const materials = ctx && ctx.materials ? ctx.materials : {};
  const variant = state.walls?.variant || "insulated";
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith("wall-"))
    .forEach((m) => {
      if (!m.isDisposed()) m.dispose(false, true);
    });

  const dims = {
    w: Math.max(1, Math.floor(state.w)),
    d: Math.max(1, Math.floor(state.d)),
  };

  const prof = resolveProfile(state, variant);

  // Rotated plates: vertical plate height is the thin dimension; wall thickness is the wide dimension.
  const plateY = prof.studW; // usually 50mm
  const wallThk = prof.studH; // 75 or 100mm
  const studLen = Math.max(1, height - 2 * plateY);

  const flags = normalizeWallFlags(state);

  const allDoors = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doorEnabled = true;

  function mkBox(name, Lx, Ly, Lz, pos, mat) {
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
    mesh.metadata = { dynamic: true };
    return mesh;
  }

  function normalizeDoorsForWall(wallId, length) {
    if (!doorEnabled) return [];
    const raw = [];
    for (let i = 0; i < allDoors.length; i++) {
      const d = allDoors[i];
      if (!d || d.type !== "door") continue;
      const w = String(d.wall || "front");
      if (w !== wallId) continue;

      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const xRaw = Math.floor(d.x_mm ?? 0);
      raw.push({ door: d, x0: xRaw, x1: xRaw + doorW, w: doorW });
    }
    return snapDoorsForWall(raw, length, prof.studW);
  }

  function isInsideAnyDoorCenter(center, doors) {
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (center >= dd.x0 && center <= dd.x1) return true;
    }
    return false;
  }

  function findDoorsCoveringSeamStud(doors, seam) {
    const cEnd = seam - (prof.studW / 2);
    const cStart = seam + (prof.studW / 2);
    const out = [];
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (cEnd >= dd.x0 && cEnd <= dd.x1) out.push(dd);
      else if (cStart >= dd.x0 && cStart <= dd.x1) out.push(dd);
    }
    out.sort((a, b) => (a.x0 - b.x0) || (a.x1 - b.x1));
    return out;
  }

  function addInsulatedDoorFraming(wallId, axis, origin, length, dd) {
    const thickness = wallThk;
    const door = dd.door;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(Math.floor(dd.x0), 0, Math.max(0, length - dd.w));
    const doorX1 = doorX0 + dd.w;
    const id = String(door.id != null ? door.id : "door");

    if (axis === "x") {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-king-left",
        prof.studW,
        Math.max(1, height - 2 * plateY),
        thickness,
        { x: origin.x + (doorX0 - prof.studW), y: plateY, z: origin.z },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-king-right",
        prof.studW,
        Math.max(1, height - 2 * plateY),
        thickness,
        { x: origin.x + doorX1, y: plateY, z: origin.z },
        materials.timber
      );

      mkBox(
        "wall-" + wallId + "-door-" + id + "-trimmer-left",
        prof.studW,
        doorH,
        thickness,
        { x: origin.x + doorX0, y: plateY, z: origin.z },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-trimmer-right",
        prof.studW,
        doorH,
        thickness,
        { x: origin.x + (doorX1 - prof.studW), y: plateY, z: origin.z },
        materials.timber
      );

      const headerL = dd.w + 2 * prof.studW;
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        headerL,
        prof.studH,
        thickness,
        { x: origin.x + (doorX0 - prof.studW), y: plateY + doorH, z: origin.z },
        materials.timber
      );
    } else {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-king-left",
        thickness,
        Math.max(1, height - 2 * plateY),
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + (doorX0 - prof.studW) },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-king-right",
        thickness,
        Math.max(1, height - 2 * plateY),
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + doorX1 },
        materials.timber
      );

      mkBox(
        "wall-" + wallId + "-door-" + id + "-trimmer-left",
        thickness,
        doorH,
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + doorX0 },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-trimmer-right",
        thickness,
        doorH,
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + (doorX1 - prof.studW) },
        materials.timber
      );

      const headerL = dd.w + 2 * prof.studW;
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        thickness,
        prof.studH,
        headerL,
        { x: origin.x, y: plateY + doorH, z: origin.z + (doorX0 - prof.studW) },
        materials.timber
      );
    }
  }

  function addBasicDoorFrame(wallId, axis, origin, length, dd) {
    const door = dd.door;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(Math.floor(dd.x0), 0, Math.max(0, length - dd.w));
    const doorX1 = doorX0 + dd.w;
    const id = String(door.id != null ? door.id : "door");

    if (axis === "x") {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-upright-left",
        prof.studW,
        studLen,
        wallThk,
        { x: origin.x + doorX0, y: plateY, z: origin.z },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-upright-right",
        prof.studW,
        studLen,
        wallThk,
        { x: origin.x + (doorX1 - prof.studW), y: plateY, z: origin.z },
        materials.timber
      );

      const headerL = dd.w + 2 * prof.studW;
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        headerL,
        prof.studH,
        wallThk,
        { x: origin.x + (doorX0 - prof.studW), y: plateY + doorH, z: origin.z },
        materials.timber
      );
    } else {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-upright-left",
        wallThk,
        studLen,
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + doorX0 },
        materials.timber
      );
      mkBox(
        "wall-" + wallId + "-door-" + id + "-upright-right",
        wallThk,
        studLen,
        prof.studW,
        { x: origin.x, y: plateY, z: origin.z + (doorX1 - prof.studW) },
        materials.timber
      );

      const headerL = dd.w + 2 * prof.studW;
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        wallThk,
        prof.studH,
        headerL,
        { x: origin.x, y: plateY + doorH, z: origin.z + (doorX0 - prof.studW) },
        materials.timber
      );
    }
  }

  function addBasicDoorHeaderOnly(wallId, axis, origin, length, dd) {
    const door = dd.door;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(Math.floor(dd.x0), 0, Math.max(0, length - dd.w));
    const id = String(door.id != null ? door.id : "door");
    const headerL = dd.w + 2 * prof.studW;

    if (axis === "x") {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        headerL,
        prof.studH,
        wallThk,
        { x: origin.x + (doorX0 - prof.studW), y: plateY + doorH, z: origin.z },
        materials.timber
      );
    } else {
      mkBox(
        "wall-" + wallId + "-door-" + id + "-header",
        wallThk,
        prof.studH,
        headerL,
        { x: origin.x, y: plateY + doorH, z: origin.z + (doorX0 - prof.studW) },
        materials.timber
      );
    }
  }

  function buildBasicPanel(wallPrefix, axis, panelLen, origin, offsetAlong, doors) {
    const isAlongX = axis === "x";

    if (isAlongX) {
      mkBox(
        wallPrefix + "plate-bottom",
        panelLen,
        plateY,
        wallThk,
        { x: origin.x + offsetAlong, y: 0, z: origin.z },
        materials.plate
      );
      mkBox(
        wallPrefix + "plate-top",
        panelLen,
        plateY,
        wallThk,
        { x: origin.x + offsetAlong, y: height - plateY, z: origin.z },
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
      mkBox(
        wallPrefix + "plate-top",
        wallThk,
        plateY,
        panelLen,
        { x: origin.x, y: height - plateY, z: origin.z + offsetAlong },
        materials.plate
      );
    }

    const placeStud = (x, z, h, idx) => {
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

    // Corner studs + single mid stud per panel (basic rule preserved per panel)
    if (isAlongX) {
      const x0 = origin.x + offsetAlong;
      const x1 = origin.x + offsetAlong + panelLen - prof.studW;
      const xm = Math.max(x0, Math.floor(origin.x + offsetAlong + panelLen / 2 - prof.studW / 2));
      const centerLocal = offsetAlong + panelLen / 2;
      placeStud(x0, origin.z, studLen, 0);
      placeStud(x1, origin.z, studLen, 1);
      if (!isInsideAnyDoorCenter(centerLocal, doors || [])) placeStud(xm, origin.z, studLen, 2);
    } else {
      const z0 = origin.z + offsetAlong;
      const z1 = origin.z + offsetAlong + panelLen - prof.studW;
      const zm = Math.max(z0, Math.floor(origin.z + offsetAlong + panelLen / 2 - prof.studW / 2));
      const centerLocal = offsetAlong + panelLen / 2;
      placeStud(origin.x, z0, studLen, 0);
      placeStud(origin.x, z1, studLen, 1);
      if (!isInsideAnyDoorCenter(centerLocal, doors || [])) placeStud(origin.x, zm, studLen, 2);
    }
  }

  function buildWall(wallId, axis, length, origin) {
    const wallPrefix = `wall-${wallId}-`;
    const doors = normalizeDoorsForWall(wallId, length);

    // BASIC: if length > 2400mm, split into panels
    if (variant === "basic" && length > 2400) {
      const seam = Math.floor(length / 2);
      const seamDoors = findDoorsCoveringSeamStud(doors, seam);

      if (seamDoors.length) {
        let panelIdx = 1;
        let offset = 0;

        for (let i = 0; i < seamDoors.length; i++) {
          const dd = seamDoors[i];

          const betweenLen = Math.max(0, Math.floor(dd.x0 - offset));
          if (betweenLen > 0) {
            buildBasicPanel(wallPrefix + "panel-" + panelIdx + "-", axis, betweenLen, origin, offset, doors);
            panelIdx += 1;
          }

          const doorLen = Math.max(0, Math.floor(dd.w));
          if (doorLen > 0) {
            buildBasicPanel(wallPrefix + "panel-door-" + (i + 1) + "-", axis, doorLen, origin, Math.floor(dd.x0), doors);
          }

          offset = Math.max(offset, Math.floor(dd.x1));
        }

        const rightLen = Math.max(0, Math.floor(length - offset));
        if (rightLen > 0) {
          buildBasicPanel(wallPrefix + "panel-" + panelIdx + "-", axis, rightLen, origin, offset, doors);
        }

        for (let i = 0; i < doors.length; i++) {
          const dd = doors[i];
          let isSeamDoor = false;
          for (let j = 0; j < seamDoors.length; j++) {
            if (seamDoors[j] === dd) { isSeamDoor = true; break; }
          }
          if (isSeamDoor) addBasicDoorHeaderOnly(wallId, axis, origin, length, dd);
          else addBasicDoorFrame(wallId, axis, origin, length, dd);
        }
        return;
      }

      const p1 = seam;
      const p2 = length - p1;
      buildBasicPanel(wallPrefix + "panel-1-", axis, p1, origin, 0, doors);
      buildBasicPanel(wallPrefix + "panel-2-", axis, p2, origin, p1, doors);

      for (let i = 0; i < doors.length; i++) addBasicDoorFrame(wallId, axis, origin, length, doors[i]);
      return;
    }

    // Plates
    const isAlongX = axis === "x";
    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", length, plateY, wallThk, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", wallThk, plateY, length, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    }

    const studs = [];
    const placeStud = (x, z, h) => {
      if (isAlongX) {
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber));
      }
    };

    // Corner studs
    if (isAlongX) {
      placeStud(origin.x + 0, origin.z + 0, studLen);
      placeStud(origin.x + (length - prof.studW), origin.z + 0, studLen);
    } else {
      placeStud(origin.x + 0, origin.z + 0, studLen);
      placeStud(origin.x + 0, origin.z + (length - prof.studW), studLen);
    }

    if (variant === "basic") {
      // Basic: single mid-span stud (omit if it lands inside any door opening)
      const centerLocal = length / 2;
      if (!isInsideAnyDoorCenter(centerLocal, doors)) {
        if (isAlongX) placeStud(Math.max(origin.x, Math.floor(origin.x + length / 2 - prof.studW / 2)), origin.z, studLen);
        else placeStud(origin.x, Math.max(origin.z, Math.floor(origin.z + length / 2 - prof.studW / 2)), studLen);
      }

      for (let i = 0; i < doors.length; i++) addBasicDoorFrame(wallId, axis, origin, length, doors[i]);
      return;
    }

    // Insulated @400 (door exclusions per-wall)
    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;

        const center = x + prof.studW / 2;
        if (!isInsideAnyDoorCenter(center, doors)) placeStud(origin.x + x, origin.z, studLen);

        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;

        const center = z + prof.studW / 2;
        if (!isInsideAnyDoorCenter(center, doors)) placeStud(origin.x, origin.z + z, studLen);

        z += prof.spacing;
      }
    }

    for (let i = 0; i < doors.length; i++) addInsulatedDoorFraming(wallId, axis, origin, length, doors[i]);
  }

  // Corner-safe lengths/origins:
  // Front/Back: full width.
  // Left/Right: between front/back => shorter by 2 * wallThk and start at z = wallThk.
  const sideLenZ = Math.max(1, dims.d - 2 * wallThk);

  if (flags.front) buildWall("front", "x", dims.w, { x: 0, z: 0 });
  if (flags.back) buildWall("back", "x", dims.w, { x: 0, z: dims.d - wallThk });

  if (flags.left) buildWall("left", "z", sideLenZ, { x: 0, z: wallThk });
  if (flags.right) buildWall("right", "z", sideLenZ, { x: dims.w - wallThk, z: wallThk });
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

export function snapOpeningsForState(state) {
  const openings = Array.isArray(state?.walls?.openings) ? state.walls.openings : [];
  const variant = state?.walls?.variant || "insulated";
  const prof = resolveProfile(state, variant);

  const wallThk = prof.studH;
  const frameW = Math.max(1, Math.floor(state?.w ?? 1));
  const frameD = Math.max(1, Math.floor(state?.d ?? 1));

  const lengths = {
    front: frameW,
    back: frameW,
    left: Math.max(1, frameD - 2 * wallThk),
    right: Math.max(1, frameD - 2 * wallThk),
  };

  const events = [];
  const out = [];
  const doorsByWall = { front: [], back: [], left: [], right: [] };

  for (let i = 0; i < openings.length; i++) {
    const o = openings[i];
    if (!o || o.type !== "door") {
      out.push(o);
      continue;
    }
    const wall = String(o.wall || "front");
    if (!doorsByWall[wall]) {
      out.push(o);
      continue;
    }
    doorsByWall[wall].push({ idx: i, door: o });
  }

  const wallKeys = ["front", "back", "left", "right"];
  const snappedByIdx = new Map();

  for (let wi = 0; wi < wallKeys.length; wi++) {
    const wall = wallKeys[wi];
    const list = doorsByWall[wall];
    if (!list.length) continue;

    const L = lengths[wall];
    const raw = list.map((r) => {
      const d = r.door;
      const w = Math.max(100, Math.floor(d.width_mm || 800));
      const x = Math.floor(d.x_mm ?? 0);
      return { door: d, x0: x, x1: x + w, w: w, _idx: r.idx };
    });

    const res = snapDoorsForWallWithEvents(raw, L, prof.studW, wall);
    for (let ei = 0; ei < res.events.length; ei++) events.push(res.events[ei]);

    for (let i = 0; i < res.doors.length; i++) {
      const dd = res.doors[i];
      snappedByIdx.set(dd._idx, Object.assign({}, dd.door, { x_mm: Math.floor(dd.x0) }));
    }

    for (let i = 0; i < res.removed.length; i++) {
      snappedByIdx.set(res.removed[i], null);
    }
  }

  for (let i = 0; i < openings.length; i++) {
    const o = openings[i];
    if (o && o.type === "door") {
      if (!snappedByIdx.has(i)) out.push(o);
      else {
        const v = snappedByIdx.get(i);
        if (v) out.push(v);
      }
    }
  }

  return { openings: out, events };
}

export function updateBOM(state) {
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

  const allDoors = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doorEnabled = true;

  function doorsForWall(wallId, length) {
    if (!doorEnabled) return [];
    const raw = [];
    for (let i = 0; i < allDoors.length; i++) {
      const d = allDoors[i];
      if (!d || d.type !== "door") continue;
      const w = String(d.wall || "front");
      if (w !== wallId) continue;

      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const xRaw = Math.floor(d.x_mm ?? 0);
      raw.push({ door: d, x0: xRaw, x1: xRaw + doorW, w: doorW });
    }
    return snapDoorsForWall(raw, length, prof.studW);
  }

  function isInsideAnyDoorCenter(center, doors) {
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (center >= dd.x0 && center <= dd.x1) return true;
    }
    return false;
  }

  function findDoorsCoveringSeamStud(doors, seam) {
    const cEnd = seam - (prof.studW / 2);
    const cStart = seam + (prof.studW / 2);
    const out = [];
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (cEnd >= dd.x0 && cEnd <= dd.x1) out.push(dd);
      else if (cStart >= dd.x0 && cStart <= dd.x1) out.push(dd);
    }
    out.sort((a, b) => (a.x0 - b.x0) || (a.x1 - b.x1));
    return out;
  }

  function countInsulatedStuds(L, doors) {
    let count = 2; // corners
    let run = 400;
    while (run <= L - prof.studW) {
      if (Math.abs(run - (L - prof.studW)) < 1) break;
      const center = run + prof.studW / 2;
      if (!isInsideAnyDoorCenter(center, doors)) count += 1;
      run += prof.spacing;
    }
    return count;
  }

  for (const wname of walls) {
    const L = lengths[wname];
    const doors = doorsForWall(wname, L);

    if (variant === "basic" && L > 2400) {
      const seam = Math.floor(L / 2);
      const seamDoors = findDoorsCoveringSeamStud(doors, seam);

      if (seamDoors.length) {
        const segs = [];
        let panelIdx = 1;
        let offset = 0;

        for (let i = 0; i < seamDoors.length; i++) {
          const dd = seamDoors[i];

          const betweenLen = Math.max(0, Math.floor(dd.x0 - offset));
          if (betweenLen > 0) {
            segs.push({ kind: "panel", label: `Panel ${panelIdx}`, offset, len: betweenLen });
            panelIdx += 1;
          }

          const doorLen = Math.max(0, Math.floor(dd.w));
          if (doorLen > 0) {
            segs.push({ kind: "door", label: `Door Panel ${i + 1}`, offset: Math.floor(dd.x0), len: doorLen, doorRef: dd });
          }

          offset = Math.max(offset, Math.floor(dd.x1));
        }

        const rightLen = Math.max(0, Math.floor(L - offset));
        if (rightLen > 0) {
          segs.push({ kind: "panel", label: `Panel ${panelIdx}`, offset, len: rightLen });
        }

        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          sections.push([`Bottom Plate (${wname}) — ${seg.label}`, 1, seg.len, prof.studW, "basic"]);
          sections.push([`Top Plate (${wname}) — ${seg.label}`, 1, seg.len, prof.studW, "basic"]);
        }

        let studCount = 0;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          if (seg.len <= 0) continue;
          studCount += 2;
          const center = seg.offset + (seg.len / 2);
          if (!isInsideAnyDoorCenter(center, doors)) studCount += 1;
        }
        sections.push([`Studs (${wname})`, studCount, studLen, prof.studW, "basic (door panels)"]);

        for (let i = 0; i < doors.length; i++) {
          const dd = doors[i];
          const d = dd.door;
          const id = String(d.id != null ? d.id : "door");

          let isSeamDoor = false;
          for (let j = 0; j < seamDoors.length; j++) {
            if (seamDoors[j] === dd) { isSeamDoor = true; break; }
          }

          if (!isSeamDoor) sections.push([`Door Uprights (${wname}) — ${id}`, 2, studLen, prof.studW, "basic door"]);
          sections.push([`Header (${wname}) — ${id}`, 1, dd.w + 2 * prof.studW, prof.studH, "basic door"]);
        }

        continue;
      }

      const p1 = seam;
      const p2 = L - p1;

      sections.push([`Bottom Plate (${wname}) — Panel 1`, 1, p1, prof.studW, "basic"]);
      sections.push([`Bottom Plate (${wname}) — Panel 2`, 1, p2, prof.studW, "basic"]);
      sections.push([`Top Plate (${wname}) — Panel 1`, 1, p1, prof.studW, "basic"]);
      sections.push([`Top Plate (${wname}) — Panel 2`, 1, p2, prof.studW, "basic"]);

      let studCount = 4; // panel corners
      if (!isInsideAnyDoorCenter(p1 / 2, doors)) studCount += 1;
      if (!isInsideAnyDoorCenter(p1 + p2 / 2, doors)) studCount += 1;
      sections.push([`Studs (${wname})`, studCount, studLen, prof.studW, "basic (2 panels)"]);

      for (let i = 0; i < doors.length; i++) {
        const id = String(doors[i].door.id != null ? doors[i].door.id : "door");
        sections.push([`Door Uprights (${wname}) — ${id}`, 2, studLen, prof.studW, "basic door"]);
        sections.push([`Header (${wname}) — ${id}`, 1, doors[i].w + 2 * prof.studW, prof.studH, "basic door"]);
      }
      continue;
    }

    sections.push([`Bottom Plate (${wname})`, 1, L, prof.studW, ""]);
    sections.push([`Top Plate (${wname})`, 1, L, prof.studW, ""]);

    if (variant === "basic") {
      let studCount = 2;
      if (!isInsideAnyDoorCenter(L / 2, doors)) studCount += 1;
      sections.push([`Studs (${wname})`, studCount, studLen, prof.studW, "basic"]);

      for (let i = 0; i < doors.length; i++) {
        const id = String(doors[i].door.id != null ? doors[i].door.id : "door");
        sections.push([`Door Uprights (${wname}) — ${id}`, 2, studLen, prof.studW, "basic door"]);
        sections.push([`Header (${wname}) — ${id}`, 1, doors[i].w + 2 * prof.studW, prof.studH, "basic door"]);
      }
      continue;
    }

    sections.push([`Studs (${wname})`, countInsulatedStuds(L, doors), studLen, prof.studW, "@400"]);

    for (let i = 0; i < doors.length; i++) {
      const d = doors[i].door;
      const id = String(d.id != null ? d.id : "door");
      sections.push([`King Studs (${wname}) — ${id}`, 2, Math.max(1, height - 2 * plateY), prof.studW, "door"]);
      sections.push([`Trimmer Studs (${wname}) — ${id}`, 2, Math.max(100, Math.floor(d.height_mm || 2000)), prof.studW, "door"]);
      sections.push([`Header (${wname}) — ${id}`, 1, doors[i].w + 2 * prof.studW, prof.studH, "door"]);
    }
  }

  return { sections };
}

function snapDoorsForWall(rawDoors, length, studW) {
  return snapDoorsForWallWithEvents(rawDoors.map((d) => Object.assign({}, d, { _idx: -1 })), length, studW, "").doors.map((d) => {
    const out = Object.assign({}, d);
    delete out._idx;
    return out;
  });
}

function snapDoorsForWallWithEvents(rawDoors, length, studW, wall) {
  const CORNER_CLEAR = 50;
  const MIN_GAP = 50;

  const events = [];
  const removed = [];

  const items = [];
  for (let i = 0; i < rawDoors.length; i++) {
    const dd = rawDoors[i];
    const d = dd.door;
    const id = String(d && d.id != null ? d.id : "door");
    const w = Math.max(1, Math.floor(dd.w || 1));
    items.push({
      door: d,
      id,
      wall,
      w,
      desired: Math.floor(dd.x0 ?? 0),
      _idx: dd._idx,
    });
  }

  // Remove doors that can never satisfy corner clearance.
  const maxDoorW = Math.max(0, length - 2 * CORNER_CLEAR);
  const survivors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.w > maxDoorW) {
      events.push(`Door ${it.id} (${wall}) removed: too wide (${it.w}mm) for wall length ${length}mm with 50mm corner clearance.`);
      removed.push(it._idx);
    } else {
      survivors.push(it);
    }
  }

  // If still impossible to fit all with fixed constraints, remove widest doors until feasible.
  function requiredLen(list) {
    if (!list.length) return 0;
    let sum = 0;
    for (let i = 0; i < list.length; i++) sum += list[i].w;
    return sum + (list.length - 1) * MIN_GAP + 2 * CORNER_CLEAR;
  }

  let cur = survivors.slice();
  while (cur.length > 0 && requiredLen(cur) > length) {
    let dropIdx = 0;
    for (let i = 1; i < cur.length; i++) {
      if (cur[i].w > cur[dropIdx].w) dropIdx = i;
      else if (cur[i].w === cur[dropIdx].w && cur[i].desired > cur[dropIdx].desired) dropIdx = i;
    }
    const drop = cur.splice(dropIdx, 1)[0];
    events.push(`Door ${drop.id} (${wall}) removed: cannot fit with 50mm spacing and 50mm corner clearance.`);
    removed.push(drop._idx);
  }

  if (!cur.length) return { doors: [], removed, events };

  // Clamp to corner-clear range.
  for (let i = 0; i < cur.length; i++) {
    const it = cur[i];
    it.minEdge = CORNER_CLEAR;
    it.maxEdge = Math.max(CORNER_CLEAR, length - CORNER_CLEAR - it.w);
    it.desiredClamped = clamp(it.desired, it.minEdge, it.maxEdge);
  }

  // Stable order by desired.
  const order = cur.slice().sort((a, b) => (a.desiredClamped - b.desiredClamped) || (a._idx - b._idx));

  // Projection with fixed gaps (forward/backward).
  for (let i = 0; i < order.length; i++) {
    const it = order[i];
    if (i === 0) it.pos = clamp(it.desiredClamped, it.minEdge, it.maxEdge);
    else {
      const prev = order[i - 1];
      const minPos = prev.pos + prev.w + MIN_GAP;
      it.pos = clamp(Math.max(it.desiredClamped, minPos), it.minEdge, it.maxEdge);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const it = order[i];
    it.pos = clamp(it.pos, it.minEdge, it.maxEdge);
    if (i < order.length - 1) {
      const next = order[i + 1];
      const maxPos = next.pos - MIN_GAP - it.w;
      it.pos = clamp(Math.min(it.pos, maxPos), it.minEdge, it.maxEdge);
    }
  }

  for (let i = 0; i < order.length; i++) {
    const it = order[i];
    if (i === 0) it.pos = clamp(it.pos, it.minEdge, it.maxEdge);
    else {
      const prev = order[i - 1];
      const minPos = prev.pos + prev.w + MIN_GAP;
      it.pos = clamp(Math.max(it.pos, minPos), it.minEdge, it.maxEdge);
    }
  }

  const out = [];
  for (let i = 0; i < order.length; i++) {
    const it = order[i];
    const prevX = Math.floor(Number(it.door && it.door.x_mm != null ? it.door.x_mm : it.desired));
    const nextX = Math.floor(Number(it.pos));

    const reasons = [];
    if (it.desiredClamped !== it.desired) reasons.push("corner clearance");
    if (nextX !== Math.floor(it.desiredClamped)) reasons.push("50mm spacing");

    if (prevX !== nextX) {
      const rs = reasons.length ? (" (" + reasons.join("; ") + ")") : "";
      events.push(`Door ${it.id} (${wall}) snapped: ${prevX}mm → ${nextX}mm${rs}.`);
    }

    out.push({
      door: it.door,
      x0: Math.floor(it.pos),
      x1: Math.floor(it.pos + it.w),
      w: it.w,
      _idx: it._idx,
    });
  }

  return { doors: out, removed, events };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}