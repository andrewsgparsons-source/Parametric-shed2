// FILE: docs/src/elements/walls.js
/**
 * Build four walls.
 * Change: stud/plate section (50×75 or 50×100) is read from state.walls[variant].section (w/h).
 * Everything else (spacing, door rules, per-wall flags, BOM structure) remains unchanged.
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

  const variantCfg = (state.walls && state.walls[variant]) ? state.walls[variant] : null;
  const section = (variantCfg && variantCfg.section) ? variantCfg.section : (variant === 'insulated' ? { w: 50, h: 100 } : { w: 50, h: 75 });

  const studW = Math.max(1, Math.floor(Number(section.w != null ? section.w : 50)));
  const studH = Math.max(1, Math.floor(Number(section.h != null ? section.h : (variant === 'insulated' ? 100 : 75))));

  // spacing logic unchanged
  const spacing = (variant === 'insulated') ? 400 : null;

  const plateH = studH;
  const studLen = height - 2 * plateH;

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
    const thickness = studW;
    const wallPrefix = `wall-${wallId}-`;

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
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, studW, h, thickness, { x, y: plateH, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, thickness, h, studW, { x, y: plateH, z }, materials.timber));
      }
    };

    placeStud(0, 0, studLen);
    if (isAlongX) placeStud(length - studW, 0, studLen);
    else placeStud(0, length - studW, studLen);

    if (variant === 'basic') {
      if (isAlongX) placeStud(Math.max(0, Math.floor(length / 2 - studW / 2)), 0, studLen);
      else placeStud(0, Math.max(0, Math.floor(length / 2 - studW / 2)), studLen);
      return { studs };
    }

    if (isAlongX) {
      let x = 400;
      while (x <= length - studW) {
        if (Math.abs(x - (length - studW)) < 1) break;
        if (wallId === 'front' && doorEnabled) {
          const center = x + studW / 2;
          const inside = (center > doorX) && (center < (doorX + doorW));
          if (!inside) placeStud(x, 0, studLen);
        } else {
          placeStud(x, 0, studLen);
        }
        x += spacing;
      }
    } else {
      let z = 400;
      while (z <= length - studW) {
        if (Math.abs(z - (length - studW)) < 1) break;
        placeStud(0, z, studLen);
        z += spacing;
      }
    }

    return { studs };
  }

  if (flags.front) {
    buildWall('front', 'x', dims.w);
    if (doorEnabled) addFrontDoorFraming(dims.w, doorX, doorW);
  }
  if (flags.back) {
    shiftGroup(scene, 'wall-back', () => buildWall('back', 'x', dims.w), { x: 0, z: dims.d - studW });
  }
  if (flags.left) {
    buildWall('left', 'z', dims.d);
  }
  if (flags.right) {
    shiftGroup(scene, 'wall-right', () => buildWall('right', 'z', dims.d), { x: dims.w - studW, z: 0 });
  }

  function addFrontDoorFraming(lengthX, dx, dw) {
    const thickness = studW;
    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(dx, 0, Math.max(0, lengthX - dw));
    const doorX1 = doorX0 + dw;

    mkBox('wall-front-king-left',  studW, height - 2 * studH, thickness, { x: doorX0 - studW, y: studH, z: 0 }, materials.timber);
    mkBox('wall-front-king-right', studW, height - 2 * studH, thickness, { x: doorX1,         y: studH, z: 0 }, materials.timber);

    mkBox('wall-front-trimmer-left',  studW, doorH, thickness, { x: doorX0,         y: studH, z: 0 }, materials.timber);
    mkBox('wall-front-trimmer-right', studW, doorH, thickness, { x: doorX1 - studW, y: studH, z: 0 }, materials.timber);

    const headerL = dw + 2 * studW;
    mkBox('wall-front-header', headerL, studH, thickness, { x: doorX0 - studW, y: studH + doorH, z: 0 }, materials.timber);
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

  const variantCfg = (state.walls && state.walls[variant]) ? state.walls[variant] : null;
  const section = (variantCfg && variantCfg.section) ? variantCfg.section : (isIns ? { w: 50, h: 100 } : { w: 50, h: 75 });

  const studW = Math.max(1, Math.floor(Number(section.w != null ? section.w : 50)));
  const studH = Math.max(1, Math.floor(Number(section.h != null ? section.h : (isIns ? 100 : 75))));

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

    if (wname === 'front') {
      const door = (state.walls?.openings || [])[0];
      if (door && door.enabled) {
        const doorW = Math.max(100, Math.floor(door.width_mm || 800));
        sections.push(['King Studs (front)', 2, height - 2 * studH, studW, 'door']);
        sections.push(['Trimmer Studs (front)', 2, Math.max(100, Math.floor(door.height_mm || 2000)), studW, 'door']);
        sections.push(['Header (front)', 1, doorW + 2 * studW, studH, 'door']);
      }
    }
  }

  return { sections };
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
