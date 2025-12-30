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

  const plateY = prof.studW;
  const wallThk = prof.studH;
  const studLen = Math.max(1, height - 2 * plateY);

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

  function addDoorFramingAlongZ(wallId, origin, door) {
    const thickness = wallThk;
    const doorH = door.h;
    const id = door.id;
    const useInvalid = invalidDoorSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

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

  function addWindowFramingAlongX(wallId, origin, win) {
    const thickness = wallThk;
    const id = win.id;
    const useInvalid = invalidWinSet.has(String(id));
    const mat = useInvalid && invalidMat ? invalidMat : materials.timber;

    const x0 = win.x0;
    const x1 = win.x1;

    const y0 = plateY + Math.max(0, Math.floor(win.y));
    const yTop = y0 + Math.max(100, Math.floor(win.h));

    mkBox(
      `wall-${wallId}-win-${id}-upright-left`,
      prof.studW,
      Math.max(1, height - 2 * plateY),
      thickness,
      { x: origin.x + (x0 - prof.studW), y: plateY, z: origin.z },
      mat,
      { windowId: id }
    );
    mkBox(
      `wall-${wallId}-win-${id}-upright-right`,
      prof.studW,
      Math.max(1, height - 2 * plateY),
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

    const y0 = plateY + Math.max(0, Math.floor(win.y));
    const yTop = y0 + Math.max(100, Math.floor(win.h));

    mkBox(
      `wall-${wallId}-win-${id}-upright-left`,
      thickness,
      Math.max(1, height - 2 * plateY),
      prof.studW,
      { x: origin.x, y: plateY, z: origin.z + (z0 - prof.studW) },
      mat,
      { windowId: id }
    );
    mkBox(
      `wall-${wallId}-win-${id}-upright-right`,
      thickness,
      Math.max(1, height - 2 * plateY),
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

  function buildBasicPanel(wallPrefix, axis, panelLen, origin, offsetAlong, openings) {
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

      if (studAt(offsetAlong)) placeStud(x0, origin.z, studLen, 0);
      if (studAt(offsetAlong + panelLen - prof.studW)) placeStud(x1, origin.z, studLen, 1);

      let midAllowed = true;
      for (let i = 0; i < panelOpenings.length; i++) {
        const d = panelOpenings[i];
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
      for (let i = 0; i < panelOpenings.length; i++) {
        const d = panelOpenings[i];
        const ms = (zm - origin.z);
        if (ms + prof.studW > d.x0 && ms < d.x1) { midAllowed = false; break; }
      }
      if (midAllowed) placeStud(origin.x, zm, studLen, 2);
    }
  }

  function buildWall(wallId, axis, length, origin) {
    const isAlongX = axis === "x";
    const wallPrefix = `wall-${wallId}-`;

    const doors = doorIntervalsForWall(wallId);
    const wins = windowIntervalsForWall(wallId);
    const openingsX = doors.concat(wins);

    if (isAlongX) {
      mkBox(wallPrefix + "plate-bottom", length, plateY, wallThk, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", length, plateY, wallThk, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    } else {
      mkBox(wallPrefix + "plate-bottom", wallThk, plateY, length, { x: origin.x, y: 0, z: origin.z }, materials.plate);
      mkBox(wallPrefix + "plate-top", wallThk, plateY, length, { x: origin.x, y: height - plateY, z: origin.z }, materials.plate);
    }

    if (variant === "basic") {
      const panels = computeBasicPanels(length, prof, openingsX);

      for (let p = 0; p < panels.length; p++) {
        const pan = panels[p];
        const pref = wallPrefix + `panel-${p + 1}-`;
        buildBasicPanel(pref, axis, pan.len, origin, pan.start, openingsX);
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

      return;
    }

    const studs = [];
    const placeStud = (x, z, h) => {
      if (isAlongX) {
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, prof.studW, h, wallThk, { x, y: plateY, z }, materials.timber));
      } else {
        studs.push(mkBox(wallPrefix + "stud-" + studs.length, wallThk, h, prof.studW, { x, y: plateY, z }, materials.timber));
      }
    };

    if (isAlongX) {
      if (!isInsideAnyOpening(0, openingsX)) placeStud(origin.x + 0, origin.z + 0, studLen);
      if (!isInsideAnyOpening(length - prof.studW, openingsX)) placeStud(origin.x + (length - prof.studW), origin.z + 0, studLen);
    } else {
      if (!isInsideAnyOpening(0, openingsX)) placeStud(origin.x + 0, origin.z + 0, studLen);
      if (!isInsideAnyOpening(length - prof.studW, openingsX)) placeStud(origin.x + 0, origin.z + (length - prof.studW), studLen);
    }

    if (isAlongX) {
      let x = 400;
      while (x <= length - prof.studW) {
        if (Math.abs(x - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(x, openingsX)) placeStud(origin.x + x, origin.z, studLen);
        x += prof.spacing;
      }
    } else {
      let z = 400;
      while (z <= length - prof.studW) {
        if (Math.abs(z - (length - prof.studW)) < 1) break;
        if (!isInsideAnyOpening(z, openingsX)) placeStud(origin.x, origin.z + z, studLen);
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
  }

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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
