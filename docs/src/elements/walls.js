// src/elements/walls.js

/**
 * Build four walls. Coordinates:
 * - Front/Back run along X, thickness extrudes +Z.
 * - Left/Right run along Z, thickness extrudes +X.
 * Variant rules:
 *  - insulated: 50×100 @ 400mm centers + corners; front door framing (kings, trimmers, header)
 *  - basic:     50×75; corners + single mid-span; ignore door controls
 *
 * Each wall is gated by per-wall flags in state.vis.walls.{front|back|left|right} and the master state.vis.wallsEnabled.
 *
 * Door aperture (front, insulated):
 *  - On enable (center snap): handled via UI/state; this module clamps and skips studs within opening.
 *  - Skip studs whose centerline lies strictly inside (doorX, doorX+doorW).
 *  - Add kings (full height) outside edges; trimmers inside; header above opening.
 *
 * @param {any} state Derived state for walls (w/d already resolved to frame outer dims)
 * @param {{scene:BABYLON.Scene, materials:any}} ctx
 */
export function build3D(state, ctx) {
  const { scene, materials } = ctx;
  const variant = state.walls?.variant || 'insulated';
  const height = Math.max(100, Math.floor(state.walls?.height_mm || 2400));

  // Cleanup previous dynamic meshes for walls
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

  const plateH = prof.studH; // use studH as plate thickness for simplicity
  const studLen = height - 2 * plateH; // stud cut length

  const flags = normalizeWallFlags(state);

  // Front door inputs (used for aperture)
  const door = (state.walls?.openings || [])[0];
  const doorEnabled = !!(door && door.enabled && variant === 'insulated');
  const doorW = doorEnabled ? Math.max(100, Math.floor(door.width_mm || 800)) : 0;
  const unclampedDoorX = doorEnabled ? Math.floor(door.x_mm ?? 0) : 0;
  const doorX = doorEnabled ? clamp(unclampedDoorX, 0, Math.max(0, dims.w - doorW)) : 0;

  // Helper to create a box in mm, positioned with its base at y=0
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

  // Build one wall along a principal axis
  function buildWall(wallId, axis, length) {
    const isAlongX = axis === 'x';
    const thickness = prof.studW; // approximate wall thickness by stud width
    const wallPrefix = `wall-${wallId}-`;

    // Plates
    if (isAlongX) {
      mkBox(wallPrefix + 'plate-bottom', length, plateH, thickness, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    length, plateH, thickness, { x: 0, y: height - plateH, z: 0 }, materials.plate);
    } else {
      mkBox(wallPrefix + 'plate-bottom', thickness, plateH, length, { x: 0, y: 0, z: 0 }, materials.plate);
      mkBox(wallPrefix + 'plate-top',    thickness, plateH, length, { x: 0, y: height - plateH, z: 0 }, materials.plate);
    }

    // Stud placement
    const studs = [];
    const placeStud = (x, z, h) => {
      if (isAlongX) {
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, prof.studW, h, thickness, { x, y: plateH, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + 'stud-' + studs.length, thickness, h, prof.studW, { x, y: plateH, z }, materials.timber));
      }
    };

    // Corners
    placeStud(0, 0, studLen);
    if (isAlongX) placeStud(length - prof.studW, 0, studLen);
    else placeStud(0, length - prof.studW, studLen);

    if (variant === 'basic') {
      // One mid-span stud
      if (isAlongX) placeStud(Math.max(0, Math.floor(length / 2 - prof.studW / 2)), 0, studLen);
      else placeStud(0, Math.max(0, Math.floor(length / 2 - prof.studW / 2)), studLen);
      return { studs };
    }

    // insulated: studs @ 400mm C/C
    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        // Aperture omission for FRONT wall only
        if (wallId === 'front' && doorEnabled) {
          const center = x + prof.studW / 2;
          const inside = (center > doorX) && (center < (doorX + doorW)); // strictly inside
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

  // Build per flags
  if (flags.front) {
    buildWall('front', 'x', dims.w);
    if (doorEnabled) addFrontDoorFraming(dims.w, doorX, doorW);
  }
  if (flags.back) {
    shiftGroup(scene, 'wall-back', () => buildWall('back', 'x', dims.w), { x: 0, z: dims.d - prof.studW });
  }
  if (flags.left) {
    buildWall('left', 'z', dims.d);
  }
  if (flags.right) {
    shiftGroup(scene, 'wall-right', () => buildWall('right', 'z', dims.d), { x: dims.w - prof.studW, z: 0 });
  }

  // Door framing on front wall (insulated): kings, trimmers, header
  function addFrontDoorFraming(lengthX, dx, dw) {
    const kingW = prof.studW;
    const trimW = prof.studW;
    const headerThk = prof.studH; // simple header thickness = studH
    const thickness = prof.studW;

    const doorH = Math.max(100, Math.floor(door.height_mm || 2000));
    const doorX0 = clamp(dx, 0, Math.max(0, lengthX - dw));
    const doorX1 = doorX0 + dw;

    // Kings: outside the opening edges
    mkBox('wall-front-king-left',  kingW, height - 2 * prof.studH, thickness, { x: doorX0 - kingW, y: prof.studH, z: 0 }, materials.timber);
    mkBox('wall-front-king-right', kingW, height - 2 * prof.studH, thickness, { x: doorX1,          y: prof.studH, z: 0 }, materials.timber);

    // Trimmers: inside edges
    const trimmerH = doorH;
    mkBox('wall-front-trimmer-left',  trimW, trimmerH, thickness, { x: doorX0,         y: prof.studH, z: 0 }, materials.timber);
    mkBox('wall-front-trimmer-right', trimW, trimmerH, thickness, { x: doorX1 - trimW, y: prof.studH, z: 0 }, materials.timber);

    // Header spanning opening + 2× stud thickness (unchanged)
    const headerL = dw + 2 * prof.studW;
    mkBox('wall-front-header', headerL, headerThk, thickness, { x: doorX0 - prof.studW, y: prof.studH + trimmerH, z: 0 }, materials.timber);
  }
}

// Normalize flags from state; default all true
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

// Shift all meshes created by a builder by a given offset (mm) and rename with prefix
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

/**
 * Compute BOM sections for walls.
 * Returns { sections } with rows: [item, qty, L_mm, W_mm, notes]
 * Skips walls disabled via per-wall flags.
 * (Stud count remains rule-based; aperture removal does not alter BOM math to avoid drift.)
 * @param {any} state
 */
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

  for (const wname of walls) {
    const L = lengths[wname];

    // Plates
    sections.push(['Bottom Plate (' + wname + ')', 1, L, studW, '']);
    sections.push(['Top Plate (' + wname + ')', 1, L, studW, '']);

    if (!isIns) {
      // basic: corners + mid-span
      const studs = 2 /* corners */ + 1 /* mid */;
      sections.push(['Studs (' + wname + ')', studs, studLen, studW, 'basic']);
      continue;
    }

    // insulated studs @ 400mm C/C (rule-based)
    let count = 2; // corners
    let run = 400;
    while (run <= L - studW) {
      count += 1;
      run += spacing;
    }
    sections.push(['Studs (' + wname + ')', count, studLen, studW, '@400']);

    // Door framing on front only (existing BOM behavior unchanged)
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
