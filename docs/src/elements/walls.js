// FILE: docs/src/elements/walls.js
/**
 * Build four walls. Coordinates:
 * - Front/Back run along X, thickness extrudes +Z.
 * - Left/Right run along Z, thickness extrudes +X.
 *
 * CHANGE (requested): Top + bottom plates are rotated 90° about their length axis so studs land on the plate's wider face.
 * Practically this means plate "vertical height" becomes the stud thickness (50), and wall thickness becomes the stud depth (75/100).
 * All other behavior (spacing rules, door logic, wall gating, BOM structure) remains the same.
 *
 * @param {any} state Derived state for walls (w/d already resolved to frame outer dims)
 * @param {{scene:BABYLON.Scene, materials:any}} ctx
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

  // Preserve existing variant semantics:
  // insulated: 50×100 @ 400mm centers, basic: 50×75, no spacing.
  // But if a section exists in state (from UI), use it.
  const prof = resolveProfile(state, variant);

  // Plate rotated: vertical plate height is the "thin" dimension, wall thickness is the "wide" dimension.
  const plateY = prof.studW;        // 50mm vertical
  const wallThk = prof.studH;       // 75/100mm wall thickness (extrude axis)
  const studLen = Math.max(1, height - 2 * plateY);

  const flags = normalizeWallFlags(state);

  const door = (state.walls?.openings || [])[0];
  const doorEnabled = !!(door && door.enabled && variant === 'insulated');
  const doorW = doorEnabled ? Math.max(100, Math.floor(door.width_mm || 800)) : 0;
  const unclampedDoorX = doorEnabled ? Math.floor(door.x_mm ?? 0) : 0;
  const doorX = doorEnabled ? clamp(unclampedDoorX, 0, Math.max(0, dims.w - doorW)) : 0;

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

  function buildWall(wallId, axis, length) {
    const isAlongX = axis === 'x';
    const wallPrefix = `wall-${wallId}-`;

    // Plates rotated 90° about their length axis:
    // Along X: length in X, thickness in Z, vertical height in Y
    // Along Z: length in Z, thickness in X, vertical height in Y
    if (isAlongX) {
      mkBox(wallPrefix + 'plate-bottom', length, plateY, wallThk, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    length, plateY, wallThk, { x: 0, y: height - plateY, z: 0 }, materials.plate);
    } else {
      mkBox(wallPrefix + 'plate-bottom', wallThk, plateY, length, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    wallThk, plateY, length, { x: 0, y: height - plateY, z: 0 }, materials.plate);
    }

    const studs = [];
    const placeStud = (x, z, h) => {
      // Studs: 50 wide across the run, 75/100 in thickness, vertical length h
      if (isAlongX) {
        studs.push(mkBox(
          wallPrefix + 'stud-' + studs.length,
          prof.studW, h, wallThk,
          { x, y: plateY, z },
          materials.timber
        ));
      } else {
        studs.push(mkBox(
          wallPrefix + 'stud-' + studs.length,
          wallThk, h, prof.studW,
          { x, y: plateY, z },
          materials.timber
        ));
      }
    };

    // Corner studs (unchanged placement intent)
    placeStud(0, 0, studLen);
    if (isAlongX) placeStud(length - prof.studW, 0, studLen);
    else placeStud(0, length - prof.studW, studLen);

    if (variant === 'basic') {
      // Basic keeps single mid stud (unchanged rule)
      if (isAlongX) placeStud(Math.max(0, Math.floor(length / 2 - prof.studW / 2)), 0, studLen);
      else placeStud(0, Math.max(0, Math.floor(length / 2 - prof.studW / 2)), studLen);
      return { studs };
    }

    // Insulated @400 (unchanged rule)
    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        if (wallId === 'front' && doorEnabled) {
          const center = x + prof.studW / 2;
          const inside = (center > doorX) && (center < (doorX + doorW));
          if (!inside) placeStud(x, 0, studLen);
        } else {
          placeStud(x, 0, studLen);
        }
        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        placeStud(0, z, studLen);
        z += prof.spacing;
      }
    }

    return { studs };
  }

  // Front
  if (flags.front) {
    buildWall('front', 'x', dims.w);
    if (doorEnabled) addFrontDoorFraming(dims.w, doorX, doorW);
  }

  // Back: shift by wall thickness (was 50, now 75/100)
  if (flags.back) {
    shiftGroup(scene, 'wall-back', () => buildWall('back', 'x', dims.w), { x: 0, z: dims.d - wallThk });
  }

  // Left
  if (flags.left) {
    buildWall('left', 'z', dims.d);
  }

  // Right: shift by wall thickness (was 50, now 75/100)
  if (flags.right) {
    shiftGroup(scene, 'wall-right', () => buildWall('right', 'z', dims.d), { x: dims.w - wallThk, z: 0 });
  }

  function addFrontDoorFraming(lengthX, dx, dw) {
    // Keep door logic identical; only plate/stud base changes to match rotated plates.
    const thickness = wallThk;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(dx, 0, Math.max(0, lengthX - dw));
    const doorX1 = doorX0 + dw;

    // Kings: full height between plates (use plateY, not studH)
    mkBox(
      'wall-front-king-left',
      prof.studW, Math.max(1, height - 2 * plateY), thickness,
      { x: doorX0 - prof.studW, y: plateY, z: 0 },
      materials.timber
    );
    mkBox(
      'wall-front-king-right',
      prof.studW, Math.max(1, height - 2 * plateY), thickness,
      { x: doorX1, y: plateY, z: 0 },
      materials.timber
    );

    // Trimmers: from bottom plate up to header
    mkBox(
      'wall-front-trimmer-left',
      prof.studW, doorH, thickness,
      { x: doorX0, y: plateY, z: 0 },
      materials.timber
    );
    mkBox(
      'wall-front-trimmer-right',
      prof.studW, doorH, thickness,
      { x: doorX1 - prof.studW, y: plateY, z: 0 },
      materials.timber
    );

    // Header: keep same thickness logic as before (vertical thickness = studH), but positioned from new plate base.
    const headerL = dw + 2 * prof.studW;
    mkBox(
      'wall-front-header',
      headerL, prof.studH, thickness,
      { x: doorX0 - prof.studW, y: plateY + doorH, z: 0 },
      materials.timber
    );
  }
}

function resolveProfile(state, variant) {
  // Default behavior preserved: insulated => 50×100 @400, basic => 50×75 no spacing.
  const defaults = (variant === 'insulated')
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

  const prof = resolveProfile(state, variant);

  // Plate rotated: vertical plate height is studW (50)
  const plateY = prof.studW;
  const studLen = Math.max(1, height - 2 * plateY);

  const lengths = {
    front: Math.max(1, Math.floor(state.w)),
    back:  Math.max(1, Math.floor(state.w)),
    left:  Math.max(1, Math.floor(state.d)),
    right: Math.max(1, Math.floor(state.d)),
  };
  const flags = normalizeWallFlags(state);
  const walls = ['front', 'back', 'left', 'right'].filter(w => flags[w]);

  for (const wname of walls) {
    const L = lengths[wname];

    // Preserve BOM structure: [item, qty, L_mm, W_mm, notes]
    sections.push(['Bottom Plate (' + wname + ')', 1, L, prof.studW, '']);
    sections.push(['Top Plate (' + wname + ')', 1, L, prof.studW, '']);

    if (variant !== 'insulated') {
      const studs = 2 + 1;
      sections.push(['Studs (' + wname + ')', studs, studLen, prof.studW, 'basic']);
      continue;
    }

    let count = 2;
    let run = 400;
    while (run <= L - prof.studW) {
      count += 1;
      run += prof.spacing;
    }
    sections.push(['Studs (' + wname + ')', count, studLen, prof.studW, '@400']);

    if (wname === 'front') {
      const door = (state.walls?.openings || [])[0];
      if (door && door.enabled) {
        const doorW = Math.max(100, Math.floor(door.width_mm || 800));
        sections.push(['King Studs (front)', 2, Math.max(1, height - 2 * plateY), prof.studW, 'door']);
        sections.push(['Trimmer Studs (front)', 2, Math.max(100, Math.floor(door.height_mm || 2000)), prof.studW, 'door']);
        sections.push(['Header (front)', 1, doorW + 2 * prof.studW, prof.studH, 'door']);
      }
    }
  }

  return { sections };
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
