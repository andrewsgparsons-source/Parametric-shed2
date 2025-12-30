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
  const { scene, materials } = ctx;
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

  const openings = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doorsAll = openings.filter((o) => o && o.type === "door" && o.enabled !== false);

  const invalidIds = Array.isArray(state.walls?.invalidDoorIds) ? state.walls.invalidDoorIds.map(String) : [];
  const invalidSet = new Set(invalidIds);

  const invalidDoorMat = (() => {
    try {
      if (scene._invalidDoorMat) return scene._invalidDoorMat;
      const m = new BABYLON.StandardMaterial("invalidDoorMat", scene);
      m.diffuseColor = new BABYLON.Color3(0.85, 0.1, 0.1);
      m.emissiveColor = new BABYLON.Color3(0.35, 0.0, 0.0);
      scene._invalidDoorMat = m;
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

  function doorIntervalsForWall(wallId, length) {
    const list = [];
    for (let i = 0; i < doorsAll.length; i++) {
      const d = doorsAll[i];
      if (String(d.wall || "front") !== wallId) continue;
      const w = Math.max(100, Math.floor(d.width_mm || 800));
      const x0 = Math.floor(d.x_mm ?? 0);
      const x1 = x0 + w;
      const h = Math.max(100, Math.floor(d.height_mm || 2000));
      list.push({ id: String(d.id || ""), x0, x1, w, h });
    }
    return list;
  }

  function isInsideAnyDoor(pos, doors) {
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      const c = pos + prof.studW / 2;
      if (c > d.x0 && c < d.x1) return true;
    }
    return false;
  }

  function addDoorFramingAlongX(wallId, origin, lengthX, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidSet.has(String(id));
    const mat = useInvalid && invalidDoorMat ? invalidDoorMat : materials.timber;

    const doorX0 = door.x0;
    const doorX1 = door.x1;

    // Uprights (full height between plates)
    mkBox(
      `wall-${wallId}-door-${id}-upright-left`,
      prof.studW,
      Math.max(1, height - 2 * plateY),
      thickness,
      { x: origin.x + (doorX0 - prof.studW), y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-upright-right`,
      prof.studW,
      Math.max(1, height - 2 * plateY),
      thickness,
      { x: origin.x + doorX1, y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );

    // Trimmers (to door height) + Header (like insulated)
    mkBox(
      `wall-${wallId}-door-${id}-trimmer-left`,
      prof.studW,
      doorH,
      thickness,
      { x: origin.x + doorX0, y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-trimmer-right`,
      prof.studW,
      doorH,
      thickness,
      { x: origin.x + (doorX1 - prof.studW), y: plateY, z: origin.z },
      mat,
      { doorId: id }
    );

    const headerL = (door.w + 2 * prof.studW);
    mkBox(
      `wall-${wallId}-door-${id}-header`,
      headerL,
      prof.studH,
      thickness,
      { x: origin.x + (doorX0 - prof.studW), y: plateY + doorH, z: origin.z },
      mat,
      { doorId: id }
    );
  }

  function addDoorFramingAlongZ(wallId, origin, lengthZ, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidSet.has(String(id));
    const mat = useInvalid && invalidDoorMat ? invalidDoorMat : materials.timber;

    const doorZ0 = door.x0;
    const doorZ1 = door.x1;

    mkBox(
      `wall-${wallId}-door-${id}-upright-left`,
      thickness,
      Math.max(1, height - 2 * plateY),
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + (doorZ0 - prof.studW) },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-upright-right`,
      thickness,
      Math.max(1, height - 2 * plateY),
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + doorZ1 },
      mat,
      { doorId: id }
    );

    mkBox(
      `wall-${wallId}-door-${id}-trimmer-left`,
      thickness,
      doorH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + doorZ0 },
      mat,
      { doorId: id }
    );
    mkBox(
      `wall-${wallId}-door-${id}-trimmer-right`,
      thickness,
      doorH,
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + (doorZ1 - prof.studW) },
      mat,
      { doorId: id }
    );

    const headerL = (door.w + 2 * prof.studW);
    mkBox(
      `wall-${wallId}-door-${id}-header`,
      thickness,
      prof.studH,
      headerL,
      { x: origin.x, y: plateY + doorH, z: origin.z + (doorZ0 - prof.studW) },
      mat,
      { doorId: id }
    );
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

    const offsetStart = offsetAlong;
    const offsetEnd = offsetAlong + panelLen;

    const panelDoors = doors.filter((d) => {
      const s = d.x0;
      const e = d.x1;
      return e > offsetStart && s < offsetEnd;
    });

    const studAt = (posStart) => {
      for (let i = 0; i < panelDoors.length; i++) {
        const d = panelDoors[i];
        if (posStart + prof.studW > d.x0 && posStart < d.x1) return false;
      }
      return true;
    };

    if (isAlongX) {
      const x0 = origin.x + offsetAlong;
      const x1 = origin.x + offsetAlong + panelLen - prof.studW;
      const xm = Math.max(x0, Math.floor(origin.x + offsetAlong + panelLen / 2 - prof.studW / 2));

      if (studAt(offsetAlong)) placeStud(x0, origin.z, studLen, 0);
      if (studAt(offsetAlong + panelLen - prof.studW)) placeStud(x1, origin.z, studLen, 1);

      let midAllowed = true;
      for (let i = 0; i < panelDoors.length; i++) {
        const d = panelDoors[i];
        const ms = (xm - origin.x);
        if (ms + prof.studW > d.x0 && ms < d.x1) { midAllowed = false; break; }
      }
      if (midAllowed) placeStud(xm, origin.z, studLen, 2);
    } else {
      const z0 = origin.z + offsetAlong;
      const z1 = origin.z + offsetAlong + panelLen - prof.studW;
      const zm = Math.max(z0, Math.floor(origin.z + offsetAlong + panelLen / 2 - prof.studW / 2));

      if (studAt(offsetAlong)) placeStud(origin.x, z0, studLen, 0);
      if (studAt(offsetAlong + panelLen - prof.studW)) placeStud(origin.x, z1, studLen, 1);

      let midAllowed = true;
      for (let i = 0; i < panelDoors.length; i++) {
        const d = panelDoors[i];
        const ms = (zm - origin.z);
        if (ms + prof.studW > d.x0 && ms < d.x1) { midAllowed = false; break; }
      }
      if (midAllowed) placeStud(origin.x, zm, studLen, 2);
    }
  }

  function buildWall(wallId, axis, length, origin) {
    const isAlongX = axis === "x";
    const wallPrefix = `wall-${wallId}-`;

    const doors = doorIntervalsForWall(wallId, length);

    // Plates (full wall)
    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", length, plateY, wallThk, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", wallThk, plateY, length, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    }

    if (variant === "basic") {
      // BASIC: if length > 2400mm, split panels; seam door => insert door panel
      let panels = [{ start: 0, len: length }];

      if (length > 2400) {
        const p1 = Math.floor(length / 2);
        const p2 = length - p1;
        panels = [{ start: 0, len: p1 }, { start: p1, len: p2 }];

        const seamA = p1 - prof.studW;
        const seamB = p1 + prof.studW;

        for (let i = 0; i < doors.length; i++) {
          const d = doors[i];
          const coversSeam = !(d.x1 < seamA || d.x0 > seamB);
          if (!coversSeam) continue;

          const doorPanelStart = clamp(d.x0 - prof.studW, 0, length);
          const doorPanelEnd = clamp(d.x1 + prof.studW, 0, length);

          const next = [];
          const leftLen = Math.max(0, doorPanelStart);
          const midLen = Math.max(0, doorPanelEnd - doorPanelStart);
          const rightLen = Math.max(0, length - doorPanelEnd);

          if (leftLen > 0) next.push({ start: 0, len: leftLen });
          if (midLen > 0) next.push({ start: doorPanelStart, len: midLen });
          if (rightLen > 0) next.push({ start: doorPanelEnd, len: rightLen });

          panels = next.length ? next : panels;
          break;
        }
      }

      for (let p = 0; p < panels.length; p++) {
        const pan = panels[p];
        const pref = wallPrefix + `panel-${p + 1}-`;
        buildBasicPanel(pref, axis, pan.len, origin, pan.start, doors);
      }

      // Door framing (basic now shows frame + header)
      for (let i = 0; i < doors.length; i++) {
        const d = doors[i];
        if (isAlongX) addDoorFramingAlongX(wallId, origin, length, d);
        else addDoorFramingAlongZ(wallId, origin, length, d);
      }

      return;
    }

    // INSULATED studs @400, skipping door regions
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
      if (!isInsideAnyDoor(0, doors)) placeStud(origin.x + 0, origin.z + 0, studLen);
      if (!isInsideAnyDoor(length - prof.studW, doors)) placeStud(origin.x + (length - prof.studW), origin.z + 0, studLen);
    } else {
      if (!isInsideAnyDoor(0, doors)) placeStud(origin.x + 0, origin.z + 0, studLen);
      if (!isInsideAnyDoor(length - prof.studW, doors)) placeStud(origin.x + 0, origin.z + (length - prof.studW), studLen);
    }

    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        if (!isInsideAnyDoor(x, doors)) placeStud(origin.x + x, origin.z, studLen);
        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        if (!isInsideAnyDoor(z, doors)) placeStud(origin.x, origin.z + z, studLen);
        z += prof.spacing;
      }
    }

    // Door framing for any wall (insulated)
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (isAlongX) addDoorFramingAlongX(wallId, origin, length, d);
      else addDoorFramingAlongZ(wallId, origin, length, d);
    }
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

    // insulated (unchanged logic)
    let count = 2;
    let run = 400;
    while (run <= L - prof.studW) {
      count += 1;
      run += prof.spacing;
    }
    sections.push([`Studs (${wname})`, count, studLen, prof.studW, "@400"]);

    if (wname === "front") {
      const door = (state.walls?.openings || [])[0];
      if (door && door.enabled) {
        const doorW = Math.max(100, Math.floor(door.width_mm || 800));
        sections.push(["King Studs (front)", 2, Math.max(1, height - 2 * plateY), prof.studW, "door"]);
        sections.push(["Trimmer Studs (front)", 2, Math.max(100, Math.floor(door.height_mm || 2000)), prof.studW, "door"]);
        sections.push(["Header (front)", 1, doorW + 2 * prof.studW, prof.studH, "door"]);
      }
    }
  }

  return { sections };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}