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
 * Multi-door (insulated only):
 * - Any number of doors on any wall, via state.walls.openings[] entries with {wall, enabled, x_mm, width_mm, height_mm}.
 * - Stud skip rule preserved: skip studs whose centerline lies strictly inside (x, x+width).
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
  const openings = normalizeOpenings(state);

  function mkBox(name, Lx, Ly, Lz, pos, mat) {
    const mesh = BABYLON.MeshBuilder.CreateBox(
      name,
      { width: Lx / 1000, height: Ly / 1000, depth: Lz / 1000 },
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
        mkBox(wallPrefix + "stud-" + idx, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber);
      } else {
        mkBox(wallPrefix + "stud-" + idx, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber);
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

  function openingsForWall(wallId, wallLen) {
    if (variant !== "insulated") return [];
    const out = [];
    for (const d of openings) {
      if (!d || !d.enabled) continue;
      if (String(d.type || "door") !== "door") continue;
      if (String(d.wall || "front").toLowerCase() !== String(wallId).toLowerCase()) continue;

      const dw = Math.max(100, Math.floor(d.width_mm || 800));
      const dx0 = clamp(Math.floor(d.x_mm ?? 0), 0, Math.max(0, wallLen - dw));
      out.push({
        id: String(d.id || "door"),
        x0: dx0,
        w: dw,
        h: Math.max(100, Math.floor(d.height_mm || 2000)),
      });
    }
    return out;
  }

  function isInsideAnyOpening(center, opens) {
    for (let i = 0; i < opens.length; i++) {
      const o = opens[i];
      if (center > o.x0 && center < (o.x0 + o.w)) return true;
    }
    return false;
  }

  function addDoorFraming(wallId, axis, origin, wallLen, door) {
    const isAlongX = axis === "x";
    const thickness = wallThk;

    const doorX0 = clamp(door.x0, 0, Math.max(0, wallLen - door.w));
    const doorX1 = doorX0 + door.w;

    const kingH = Math.max(1, height - 2 * plateY);
    const trimH = door.h;

    const name = (suffix) => `wall-${wallId}-door-${door.id}-${suffix}`;

    if (isAlongX) {
      mkBox(name("king-left"),  prof.studW, kingH, thickness, { x: origin.x + (doorX0 - prof.studW), y: plateY, z: origin.z }, materials.timber);
      mkBox(name("king-right"), prof.studW, kingH, thickness, { x: origin.x + doorX1,              y: plateY, z: origin.z }, materials.timber);

      mkBox(name("trimmer-left"),  prof.studW, trimH, thickness, { x: origin.x + doorX0,               y: plateY, z: origin.z }, materials.timber);
      mkBox(name("trimmer-right"), prof.studW, trimH, thickness, { x: origin.x + (doorX1 - prof.studW), y: plateY, z: origin.z }, materials.timber);

      const headerL = door.w + 2 * prof.studW;
      mkBox(name("header"), headerL, prof.studH, thickness, { x: origin.x + (doorX0 - prof.studW), y: plateY + trimH, z: origin.z }, materials.timber);
    } else {
      mkBox(name("king-left"),  thickness, kingH, prof.studW, { x: origin.x, y: plateY, z: origin.z + (doorX0 - prof.studW) }, materials.timber);
      mkBox(name("king-right"), thickness, kingH, prof.studW, { x: origin.x, y: plateY, z: origin.z + doorX1 }, materials.timber);

      mkBox(name("trimmer-left"),  thickness, trimH, prof.studW, { x: origin.x, y: plateY, z: origin.z + doorX0 }, materials.timber);
      mkBox(name("trimmer-right"), thickness, trimH, prof.studW, { x: origin.x, y: plateY, z: origin.z + (doorX1 - prof.studW) }, materials.timber);

      const headerL = door.w + 2 * prof.studW;
      mkBox(name("header"), thickness, prof.studH, headerL, { x: origin.x, y: plateY + trimH, z: origin.z + (doorX0 - prof.studW) }, materials.timber);
    }
  }

  function buildWall(wallId, axis, length, origin) {
    const isAlongX = axis === "x";
    const wallPrefix = `wall-${wallId}-`;

    // BASIC: if length > 2400mm, split into two panels (equal-ish, sum exact)
    if (variant === "basic" && length > 2400) {
      const p1 = Math.floor(length / 2);
      const p2 = length - p1;
      buildBasicPanel(wallPrefix + "panel-1-", axis, p1, origin, 0);
      buildBasicPanel(wallPrefix + "panel-2-", axis, p2, origin, p1);
      return;
    }

    // Plates
    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top",    length, plateY, wallThk, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top",    wallThk, plateY, length, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    }

    const studs = [];
    const placeStud = (x, z, h) => {
      if (isAlongX) studs.push(mkBox(wallPrefix + "stud-" + studs.length, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber));
      else studs.push(mkBox(wallPrefix + "stud-" + studs.length, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber));
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
      if (isAlongX) placeStud(Math.max(origin.x, Math.floor(origin.x + length / 2 - prof.studW / 2)), origin.z, studLen);
      else placeStud(origin.x, Math.max(origin.z, Math.floor(origin.z + length / 2 - prof.studW / 2)), studLen);
      return;
    }

    const wallOpens = openingsForWall(wallId, length);

    // Insulated @400
    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;

        const center = x + prof.studW / 2;
        if (!isInsideAnyOpening(center, wallOpens)) placeStud(origin.x + x, origin.z, studLen);

        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;

        const center = z + prof.studW / 2;
        if (!isInsideAnyOpening(center, wallOpens)) placeStud(origin.x, origin.z + z, studLen);

        z += prof.spacing;
      }
    }

    // Door framing per opening
    for (let i = 0; i < wallOpens.length; i++) {
      addDoorFraming(wallId, axis, origin, length, wallOpens[i]);
    }
  }

  // Corner-safe lengths/origins:
  // Front/Back: full width.
  // Left/Right: between front/back => shorter by 2 * wallThk and start at z = wallThk.
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
    back: enabled && parts.back !== false,
    left: enabled && parts.left !== false,
    right: enabled && parts.right !== false,
  };
}

function normalizeOpenings(state) {
  const arr = state?.walls?.openings;
  if (Array.isArray(arr)) return arr;
  return [];
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

  const openings = normalizeOpenings(state);

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

    // insulated (count algorithm preserved)
    let count = 2;
    let run = 400;
    while (run <= L - prof.studW) {
      count += 1;
      run += prof.spacing;
    }
    sections.push([`Studs (${wname})`, count, studLen, prof.studW, "@400"]);

    // Door framing rows for EACH door on this wall (insulated only)
    for (const d of openings) {
      if (!d || !d.enabled) continue;
      if (String(d.type || "door") !== "door") continue;
      if (String(d.wall || "front").toLowerCase() !== String(wname).toLowerCase()) continue;

      const doorId = String(d.id || "door");
      const doorW = Math.max(100, Math.floor(d.width_mm || 800));

      sections.push([`King Studs (${wname}, ${doorId})`, 2, Math.max(1, height - 2 * plateY), prof.studW, "door"]);
      sections.push([`Trimmer Studs (${wname}, ${doorId})`, 2, Math.max(100, Math.floor(d.height_mm || 2000)), prof.studW, "door"]);
      sections.push([`Header (${wname}, ${doorId})`, 1, doorW + 2 * prof.studW, prof.studH, "door"]);
    }
  }

  return { sections };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
