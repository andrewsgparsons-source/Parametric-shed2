// FILE: docs/src/elements/walls.js
/**
 * Build four walls. Coordinates:
 * - Front/Back run along X, thickness extrudes +Z.
 * - Left/Right run along Z, thickness extrudes +X.
 * Variant rules:
 *  - insulated: 50×100 @ 400mm centers + corners; door framing per enabled opening
 *  - basic:     50×75; corners + single mid-span; ignore doors
 *
 * Multiple doors:
 * - Any number of door openings on any wall: front/back/left/right (insulated only)
 * - Skips studs whose centerline lies strictly inside any opening interval.
 * - Adds kings, trimmers, header per opening.
 */
export function build3D(state, ctx) {
  const { scene, materials } = ctx;
  const variant = state.walls?.variant || 'insulated';
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  scene.meshes
    .filter(m => m.metadata && m.metadata.dynamic === true && m.name.startsWith('wall-'))
    .forEach(m => { if (!m.isDisposed()) m.dispose(false, true); });

  const dims = {
    w: Math.max(1, Math.floor(state.w)),
    d: Math.max(1, Math.floor(state.d)),
  };

  const prof = (variant === 'insulated')
    ? { studW: 50, studH: 100, spacing: 400 }
    : { studW: 50, studH: 75,  spacing: null };

  const plateH = prof.studH;
  const studLen = height - 2 * plateH;

  const flags = normalizeWallFlags(state);

  const allOpenings = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const activeDoors = (variant === 'insulated')
    ? allOpenings.filter(o =>
        o && o.type === 'door' && o.enabled === true &&
        (o.wall === 'front' || o.wall === 'back' || o.wall === 'left' || o.wall === 'right')
      )
    : [];

  function doorsFor(wallId, wallLen) {
    const out = [];
    for (const d of activeDoors) {
      if (d.wall !== wallId) continue;
      const w = Math.max(100, Math.floor(d.width_mm || 800));
      const x0 = clamp(Math.floor(d.x_mm ?? 0), 0, Math.max(0, wallLen - w));
      out.push({
        id: d.id || ('door-' + Math.random().toString(36).slice(2)),
        x_mm: x0,
        width_mm: w,
        height_mm: Math.max(100, Math.floor(d.height_mm || 2000)),
      });
    }
    return out;
  }

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

  function insideAnyOpening(center, openings) {
    for (const o of openings) {
      const x0 = o.x_mm;
      const x1 = o.x_mm + o.width_mm;
      if (center > x0 && center < x1) return true;
    }
    return false;
  }

  function addDoorFraming(wallPrefix, axis, dx, dw, doorH) {
    const thickness = prof.studW;
    const kingW = prof.studW;
    const trimW = prof.studW;
    const headerThk = prof.studH;

    const doorX0 = clamp(dx, 0, Math.max(0, (axis === 'x' ? dims.w : dims.d) - dw));
    const doorX1 = doorX0 + dw;

    if (axis === 'x') {
      mkBox(wallPrefix + 'king-left',  kingW, height - 2 * prof.studH, thickness, { x: doorX0 - kingW, y: prof.studH, z: 0 }, materials.timber);
      mkBox(wallPrefix + 'king-right', kingW, height - 2 * prof.studH, thickness, { x: doorX1,         y: prof.studH, z: 0 }, materials.timber);

      mkBox(wallPrefix + 'trimmer-left',  trimW, doorH, thickness, { x: doorX0,         y: prof.studH, z: 0 }, materials.timber);
      mkBox(wallPrefix + 'trimmer-right', trimW, doorH, thickness, { x: doorX1 - trimW, y: prof.studH, z: 0 }, materials.timber);

      const headerL = dw + 2 * prof.studW;
      mkBox(wallPrefix + 'header', headerL, headerThk, thickness, { x: doorX0 - prof.studW, y: prof.studH + doorH, z: 0 }, materials.timber);
      return;
    }

    // axis === 'z' (run along Z)
    mkBox(wallPrefix + 'king-left',  thickness, height - 2 * prof.studH, kingW, { x: 0, y: prof.studH, z: doorX0 - kingW }, materials.timber);
    mkBox(wallPrefix + 'king-right', thickness, height - 2 * prof.studH, kingW, { x: 0, y: prof.studH, z: doorX1 },        materials.timber);

    mkBox(wallPrefix + 'trimmer-left',  thickness, doorH, trimW, { x: 0, y: prof.studH, z: doorX0 },         materials.timber);
    mkBox(wallPrefix + 'trimmer-right', thickness, doorH, trimW, { x: 0, y: prof.studH, z: doorX1 - trimW }, materials.timber);

    const headerL = dw + 2 * prof.studW;
    mkBox(wallPrefix + 'header', thickness, headerThk, headerL, { x: 0, y: prof.studH + doorH, z: doorX0 - prof.studW }, materials.timber);
  }

  function buildWall(wallId, axis, length) {
    const isAlongX = axis === 'x';
    const thickness = prof.studW;
    const wallPrefix = `wall-${wallId}-`;

    const openings = (variant === 'insulated') ? doorsFor(wallId, length) : [];

    if (isAlongX) {
      mkBox(wallPrefix + 'plate-bottom', length, plateH, thickness, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    length, plateH, thickness, { x: 0, y: height - plateH, z: 0 }, materials.plate);
    } else {
      mkBox(wallPrefix + 'plate-bottom', thickness, plateH, length, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    thickness, plateH, length, { x: 0, y: height - plateH, z: 0 }, materials.plate);
    }

    const studs = [];
    const placeStud = (x, z, h) => {
      if (isAlongX) {
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, prof.studW, h, thickness, { x, y: plateH, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, thickness, h, prof.studW, { x, y: plateH, z }, materials.timber));
      }
    };

    // End studs
    placeStud(0, 0, studLen);
    if (isAlongX) placeStud(length - prof.studW, 0, studLen);
    else placeStud(0, length - prof.studW, studLen);

    if (variant === 'basic') {
      if (isAlongX) placeStud(Math.max(0, Math.floor(length / 2 - prof.studW / 2)), 0, studLen);
      else placeStud(0, Math.max(0, Math.floor(length / 2 - prof.studW / 2)), studLen);
      return { studs };
    }

    // Stud field @400, skip inside any opening
    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        const center = x + prof.studW / 2;
        if (!insideAnyOpening(center, openings)) placeStud(x, 0, studLen);
        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        const center = z + prof.studW / 2;
        if (!insideAnyOpening(center, openings)) placeStud(0, z, studLen);
        z += prof.spacing;
      }
    }

    // Door framing meshes (built in same local coords so shiftGroup moves them too)
    for (const o of openings) {
      const prefix = `${wallPrefix}door-${o.id}-`;
      addDoorFraming(prefix, axis, o.x_mm, o.width_mm, o.height_mm);
    }

    return { studs };
  }

  if (flags.front) buildWall('front', 'x', dims.w);

  if (flags.back) {
    shiftGroup(scene, 'wall-back', () => buildWall('back', 'x', dims.w), { x: 0, z: dims.d - prof.studW });
  }

  if (flags.left) buildWall('left', 'z', dims.d);

  if (flags.right) {
    shiftGroup(scene, 'wall-right', () => buildWall('right', 'z', dims.d), { x: dims.w - prof.studW, z: 0 });
  }
}

function normalizeWallFlags(state) {
  const enabled = state.vis?.wallsEnabled !== false;
  const parts = state.vis?.walls || { front:true, back:true, left:true, right:true };
  return {
    front: enabled && parts.front !== false,
    back:  enabled && parts.back  !== false,
    left:  enabled && parts.left  !== false,
    right: enabled && parts.right !== false,
  };
}

function shiftGroup(scene, prefix, builderFn, offset) {
  const before = new Set(scene.meshes.map(m => m.uniqueId));
  builderFn();
  const after = scene.meshes.filter(m => !before.has(m.uniqueId));
  after.forEach(m => {
    m.name = m.name.replace(/^wall-/, `${prefix}-`);
    m.position.x += (offset.x || 0) / 1000;
    m.position.z += (offset.z || 0) / 1000;
  });
}

export function updateBOM(state) {
  const sections = [];
  const variant = state.walls?.variant || 'insulated';
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  const isIns = variant === 'insulated';
  const studW = isIns ? 50 : 50;
  const studH = isIns ? 100 : 75;
  const spacing = isIns ? 400 : null;
  const plateH = studH;
  const studLen = height - 2 * plateH;

  const lengths = {
    front: Math.max(1, Math.floor(state.w)),
    back:  Math.max(1, Math.floor(state.w)),
    left:  Math.max(1, Math.floor(state.d)),
    right: Math.max(1, Math.floor(state.d)),
  };
  const flags = normalizeWallFlags(state);
  const walls = ['front', 'back', 'left', 'right'].filter(w => flags[w]);

  const allOpenings = Array.isArray(state.walls?.openings) ? state.walls.openings : [];
  const doors = isIns
    ? allOpenings.filter(o =>
        o && o.type === 'door' && o.enabled === true &&
        (o.wall === 'front' || o.wall === 'back' || o.wall === 'left' || o.wall === 'right')
      )
    : [];

  for (const wname of walls) {
    const L = lengths[wname];

    sections.push(['Bottom Plate (' + wname + ')', 1, L, studW, '']);
    sections.push(['Top Plate (' + wname + ')', 1, L, studW, '']);

    if (!isIns) {
      const studs = 2 + 1;
      sections.push(['Studs (' + wname + ')', studs, studLen, studW, 'basic']);
      continue;
    }

    let count = 2;
    let run = 400;
    while (run <= L - studW) {
      count += 1;
      run += spacing;
    }
    sections.push(['Studs (' + wname + ')', count, studLen, studW, '@400']);

    // Door framing per door on this wall
    for (const d of doors) {
      if (d.wall !== wname) continue;
      const doorW = Math.max(100, Math.floor(d.width_mm || 800));
      const doorH = Math.max(100, Math.floor(d.height_mm || 2000));
      const id = d.id || 'door';

      sections.push([`King Studs (${wname})`, 2, height - 2 * studH, studW, `door:${id}`]);
      sections.push([`Trimmer Studs (${wname})`, 2, doorH, studW, `door:${id}`]);
      sections.push([`Header (${wname})`, 1, doorW + 2 * studW, studH, `door:${id}`]);
    }
  }

  return { sections };
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
