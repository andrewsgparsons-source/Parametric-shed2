<script type="module">
/**
 * Walls with multi-door support (insulated variant only).
 *
 * - Door openings can be on any wall: front/back/left/right.
 * - X offset is along the wall’s run direction:
 *   - front/back: +X
 *   - left/right: +Z
 * - Corner-safe: front/back are full width; left/right length = d - 2*thickness and start at z=thickness.
 * - Plates are rotated 90° about their length axis:
 *   => plate vertical height = studW, wall thickness = studH.
 *
 * BASIC panelization rule preserved:
 * - If basic wall length > 2400mm, split into two panels.
 */
export function build3D(state, ctx) {
  const { scene, materials } = ctx;
  const variant = state.walls?.variant || "insulated";
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  scene.meshes
    .filter((m) => m.metadata && m.metadata.dynamic === true && m.name.startsWith("wall-"))
    .forEach((m) => { if (!m.isDisposed()) m.dispose(false, true); });

  const dims = {
    w: Math.max(1, Math.floor(state.w)),
    d: Math.max(1, Math.floor(state.d)),
  };

  const prof = resolveProfile(state, variant);
  const plateY = prof.studW;
  const wallThk = prof.studH;
  const studLen = Math.max(1, height - 2 * plateY);

  const flags = normalizeWallFlags(state);
  const doorsAll = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doors = (variant === "insulated")
    ? doorsAll.filter(d => d && d.type === "door" && d.enabled && (d.wall === "front" || d.wall === "back" || d.wall === "left" || d.wall === "right"))
    : [];

  function mkBox(name, Lx, Ly, Lz, pos, mat) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, {
      width: Lx / 1000,
      height: Ly / 1000,
      depth: Lz / 1000
    }, scene);
    mesh.position = new BABYLON.Vector3(
      (pos.x + Lx / 2) / 1000,
      (pos.y + Ly / 2) / 1000,
      (pos.z + Lz / 2) / 1000
    );
    mesh.material = mat;
    mesh.metadata = { dynamic: true };
    return mesh;
  }

  function wallDoors(wallId) {
    return doors.filter(d => d.wall === wallId);
  }

  function clampDoorToWall(d, wallLen) {
    const w = Math.max(100, Math.floor(d.width_mm || 800));
    const x = Math.floor(d.x_mm ?? 0);
    const cx = clamp(x, 0, Math.max(0, wallLen - w));
    return { ...d, width_mm: w, x_mm: cx, height_mm: Math.max(100, Math.floor(d.height_mm || 2000)) };
  }

  function isInsideAnyOpening(center, openings) {
    for (const o of openings) {
      const x0 = o.x_mm;
      const x1 = o.x_mm + o.width_mm;
      if (center > x0 && center < x1) return true;
    }
    return false;
  }

  function addDoorFraming(wallId, axis, origin, wallLen, d) {
    const dd = clampDoorToWall(d, wallLen);
    const dx = dd.x_mm;
    const dw = dd.width_mm;
    const doorH = dd.height_mm;

    const x0 = dx;
    const x1 = dx + dw;

    if (axis === "x") {
      mkBox(`wall-${wallId}-king-left-${dd.id}`,  prof.studW, Math.max(1, height - 2 * plateY), wallThk, { x: origin.x + (x0 - prof.studW), y: plateY, z: origin.z }, materials.timber);
      mkBox(`wall-${wallId}-king-right-${dd.id}`, prof.studW, Math.max(1, height - 2 * plateY), wallThk, { x: origin.x + x1,                y: plateY, z: origin.z }, materials.timber);

      mkBox(`wall-${wallId}-trimmer-left-${dd.id}`,  prof.studW, doorH, wallThk, { x: origin.x + x0,                y: plateY, z: origin.z }, materials.timber);
      mkBox(`wall-${wallId}-trimmer-right-${dd.id}`, prof.studW, doorH, wallThk, { x: origin.x + (x1 - prof.studW), y: plateY, z: origin.z }, materials.timber);

      const headerL = dw + 2 * prof.studW;
      mkBox(`wall-${wallId}-header-${dd.id}`, headerL, prof.studH, wallThk, { x: origin.x + (x0 - prof.studW), y: plateY + doorH, z: origin.z }, materials.timber);
      return;
    }

    // axis === "z"
    mkBox(`wall-${wallId}-king-left-${dd.id}`,  wallThk, Math.max(1, height - 2 * plateY), prof.studW, { x: origin.x, y: plateY, z: origin.z + (x0 - prof.studW) }, materials.timber);
    mkBox(`wall-${wallId}-king-right-${dd.id}`, wallThk, Math.max(1, height - 2 * plateY), prof.studW, { x: origin.x, y: plateY, z: origin.z + x1 }, materials.timber);

    mkBox(`wall-${wallId}-trimmer-left-${dd.id}`,  wallThk, doorH, prof.studW, { x: origin.x, y: plateY, z: origin.z + x0 }, materials.timber);
    mkBox(`wall-${wallId}-trimmer-right-${dd.id}`, wallThk, doorH, prof.studW, { x: origin.x, y: plateY, z: origin.z + (x1 - prof.studW) }, materials.timber);

    const headerL = dw + 2 * prof.studW;
    mkBox(`wall-${wallId}-header-${dd.id}`, wallThk, prof.studH, headerL, { x: origin.x, y: plateY + doorH, z: origin.z + (x0 - prof.studW) }, materials.timber);
  }

  function buildBasicPanel(wallPrefix, axis, panelLen, origin, offsetAlong) {
    const isAlongX = axis === "x";

    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", panelLen, plateY, wallThk, { x: origin.x + offsetAlong, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top",    panelLen, plateY, wallThk, { x: origin.x + offsetAlong, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, panelLen, { x: origin.x, y: 0, z: origin.z + offsetAlong }, materials.plate);
      mkBox(wallPrefix + "plate-top",    wallThk, plateY, panelLen, { x: origin.x, y: height - plateY, z: origin.z + offsetAlong }, materials.plate);
    }

    const placeStud = (x, z, h, idx) => {
      if (isAlongX) mkBox(wallPrefix + "stud-" + idx, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber);
      else mkBox(wallPrefix + "stud-" + idx, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber);
    };

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

  function buildWall(wallId, axis, length, origin) {
    const wallPrefix = `wall-${wallId}-`;

    if (variant === "basic" && length > 2400) {
      const p1 = Math.floor(length / 2);
      const p2 = length - p1;
      buildBasicPanel(wallPrefix + "panel-1-", axis, p1, origin, 0);
      buildBasicPanel(wallPrefix + "panel-2-", axis, p2, origin, p1);
      return;
    }

    if (axis === "x") {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top",    length, plateY, wallThk, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top",    wallThk, plateY, length, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    }

    const openings = wallDoors(wallId).map(d => clampDoorToWall(d, length));

    const placeStud = (x, z, h, idx) => {
      if (axis === "x") mkBox(wallPrefix + "stud-" + idx, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber);
      else mkBox(wallPrefix + "stud-" + idx, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber);
    };

    // End studs
    if (axis === "x") {
      placeStud(origin.x + 0, origin.z, studLen, 0);
      placeStud(origin.x + (length - prof.studW), origin.z, studLen, 1);
    } else {
      placeStud(origin.x, origin.z + 0, studLen, 0);
      placeStud(origin.x, origin.z + (length - prof.studW), studLen, 1);
    }

    if (variant === "basic") {
      if (axis === "x") placeStud(Math.max(origin.x, Math.floor(origin.x + length / 2 - prof.studW / 2)), origin.z, studLen, 2);
      else placeStud(origin.x, Math.max(origin.z, Math.floor(origin.z + length / 2 - prof.studW / 2)), studLen, 2);
      return;
    }

    // Stud field @400, skipping inside openings (insulated only)
    if (axis === "x") {
      let x = 400;
      let idx = 2;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        const center = x + prof.studW / 2;
        if (!isInsideAnyOpening(center, openings)) {
          placeStud(origin.x + x, origin.z, studLen, idx++);
        }
        x += prof.spacing;
      }
    } else {
      let z = 400;
      let idx = 2;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        const center = z + prof.studW / 2;
        if (!isInsideAnyOpening(center, openings)) {
          placeStud(origin.x, origin.z + z, studLen, idx++);
        }
        z += prof.spacing;
      }
    }

    // Door framing
    for (const d of openings) {
      addDoorFraming(wallId, axis, origin, length, d);
    }
  }

  const sideLenZ = Math.max(1, dims.d - 2 * wallThk);

  if (flags.front) buildWall("front", "x", dims.w, { x: 0, z: 0 });
  if (flags.back)  buildWall("back",  "x", dims.w, { x: 0, z: dims.d - wallThk });

  if (flags.left)  buildWall("left",  "z", sideLenZ, { x: 0, z: wallThk });
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
    back:  enabled && parts.back  !== false,
    left:  enabled && parts.left  !== false,
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

  const doorsAll = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doors = (variant === "insulated")
    ? doorsAll.filter(d => d && d.type === "door" && d.enabled && (d.wall === "front" || d.wall === "back" || d.wall === "left" || d.wall === "right"))
    : [];

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

    // studs count logic preserved (not reduced for openings; matches previous behavior style)
    let count = 2;
    let run = 400;
    while (run <= L - prof.studW) {
      count += 1;
      run += prof.spacing;
    }
    sections.push([`Studs (${wname})`, count, studLen, prof.studW, "@400"]);

    // Add door framing items for any enabled door on this wall
    const wallDoors = doors.filter(d => d.wall === wname);
    for (const d of wallDoors) {
      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const doorH = Math.max(100, Math.floor(d.height_mm || 2000));
      sections.push([`King Studs (${wname})`, 2, Math.max(1, height - 2 * plateY), prof.studW, `door:${d.id}`]);
      sections.push([`Trimmer Studs (${wname})`, 2, doorH, prof.studW, `door:${d.id}`]);
      sections.push([`Header (${wname})`, 1, doorW + 2 * prof.studW, prof.studH, `door:${d.id}`]);
    }
  }

  return { sections };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
</script>
