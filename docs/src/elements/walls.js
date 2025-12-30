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
  const doorEnabled = (variant === "insulated");

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

  function buildBasicPanel(wallPrefix, axis, panelLen, origin, offsetAlong) {
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
      placeStud(x0, origin.z, studLen, 0);
      placeStud(x1, origin.z, studLen, 1);
      placeStud(xm, origin.z, studLen, 2);
    } else {
      const z0 = origin.z + offsetAlong;
      const z1 = origin.z + offsetAlong + panelLen - prof.studW;
      const zm = Math.max(z0, Math.floor(origin.z + offsetAlong + panelLen / 2 - prof.studW / 2));
      placeStud(origin.x, z0, studLen, 0);
      placeStud(origin.x, z1, studLen, 1);
      placeStud(origin.x, zm, studLen, 2);
    }
  }

  function normalizeDoorsForWall(wallId, length) {
    if (!doorEnabled) return [];
    const out = [];
    for (let i = 0; i < allDoors.length; i++) {
      const d = allDoors[i];
      if (!d || d.type !== "door") continue;
      const w = String(d.wall || "front");
      if (w !== wallId) continue;

      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const xRaw = Math.floor(d.x_mm ?? 0);
      const x0 = clamp(xRaw, 0, Math.max(0, length - doorW));
      const x1 = x0 + doorW;

      out.push({ door: d, x0, x1, w: doorW });
    }
    return out;
  }

  function isInsideAnyDoorCenter(center, doors) {
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (center > dd.x0 && center < dd.x1) return true;
    }
    return false;
  }

  function addDoorFraming(wallId, axis, origin, length, dd) {
    const thickness = wallThk;
    const door = dd.door;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(dd.x0, 0, Math.max(0, length - dd.w));
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

  function buildWall(wallId, axis, length, origin) {
    const isAlongX = axis === "x";
    const wallPrefix = `wall-${wallId}-`;
    const doors = normalizeDoorsForWall(wallId, length);

    // BASIC: if length > 2400mm, split into two panels (equal-ish, sum exact)
    if (variant === "basic" && length > 2400) {
      const p1 = Math.floor(length / 2);
      const p2 = length - p1; // difference ≤ 1
      buildBasicPanel(wallPrefix + "panel-1-", axis, p1, origin, 0);
      buildBasicPanel(wallPrefix + "panel-2-", axis, p2, origin, p1);
      return;
    }

    // Plates
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
      // Basic: single mid-span stud
      if (isAlongX) placeStud(Math.max(origin.x, Math.floor(origin.x + length / 2 - prof.studW / 2)), origin.z, studLen);
      else placeStud(origin.x, Math.max(origin.z, Math.floor(origin.z + length / 2 - prof.studW / 2)), studLen);
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

    for (let i = 0; i < doors.length; i++) addDoorFraming(wallId, axis, origin, length, doors[i]);
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
  const doorEnabled = (variant === "insulated");

  function doorsForWall(wallId, length) {
    if (!doorEnabled) return [];
    const out = [];
    for (let i = 0; i < allDoors.length; i++) {
      const d = allDoors[i];
      if (!d || d.type !== "door") continue;
      const w = String(d.wall || "front");
      if (w !== wallId) continue;

      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const xRaw = Math.floor(d.x_mm ?? 0);
      const x0 = clamp(xRaw, 0, Math.max(0, length - doorW));
      const x1 = x0 + doorW;

      out.push({ door: d, x0, x1, w: doorW });
    }
    return out;
  }

  function isInsideAnyDoorCenter(center, doors) {
    for (let i = 0; i < doors.length; i++) {
      const dd = doors[i];
      if (center > dd.x0 && center < dd.x1) return true;
    }
    return false;
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

    if (variant === "basic" && L > 2400) {
      const p1 = Math.floor(L / 2);
      const p2 = L - p1;

      sections.push([`Bottom Plate (${wname}) — Panel 1`, 1, p1, prof.studW, "basic"]);
      sections.push([`Bottom Plate (${wname}) — Panel 2`, 1, p2, prof.studW, "basic"]);
      sections.push([`Top Plate (${wname}) — Panel 1`, 1, p1, prof.studW, "basic"]);
      sections.push([`Top Plate (${wname}) — Panel 2`, 1, p2, prof.studW, "basic"]);

      sections.push([`Studs (${wname})`, 6, studLen, prof.studW, "basic (2 panels)"]);
      continue;
    }

    sections.push([`Bottom Plate (${wname})`, 1, L, prof.studW, ""]);
    sections.push([`Top Plate (${wname})`, 1, L, prof.studW, ""]);

    if (variant === "basic") {
      sections.push([`Studs (${wname})`, 3, studLen, prof.studW, "basic"]);
      continue;
    }

    const doors = doorsForWall(wname, L);
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
