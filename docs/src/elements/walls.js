import { CONFIG, resolveDims } from "../params.js";

/**
 * Walls module.
 * - Handles 4 walls: front, back, left, right.
 * - Standard stud spacing (600mm).
 * - Metadata.dynamic === true for all meshes.
 */

export function build3D(state, ctx) {
  const { scene, materials } = ctx || {};
  if (!scene) return;

  // 1. Dispose old wall meshes and nodes
  const wallMeshes = scene.meshes.filter(m => String(m.name).startsWith("wall-") && m.metadata?.dynamic);
  wallMeshes.forEach(m => m.dispose(false, true));

  const wallNodes = scene.transformNodes.filter(n => n.name.startsWith("wall-root") || n.name.startsWith("wall-"));
  wallNodes.forEach(n => n.dispose(false));

  const dims = resolveDims(state);
  const wallMat = materials?.timber || null;

  // 2. Helper for creating timber components
  function mkTimber(name, Lx_mm, Ly_mm, Lz_mm, x_mm, y_mm, z_mm, parentNode, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, {
      width: Lx_mm / 1000,
      height: Ly_mm / 1000,
      depth: Lz_mm / 1000
    }, scene);

    mesh.position = new BABYLON.Vector3(
      (x_mm + Lx_mm / 2) / 1000,
      (y_mm + Ly_mm / 2) / 1000,
      (z_mm + Lz_mm / 2) / 1000
    );

    mesh.material = wallMat;
    mesh.metadata = Object.assign({ dynamic: true }, meta || {});
    if (parentNode) mesh.parent = parentNode;
    return mesh;
  }

  const wallHeight = state.walls?.height_mm || 2400;
  const pMin = state.roof?.pent?.minHeight_mm || wallHeight;
  const pMax = state.roof?.pent?.maxHeight_mm || wallHeight;
  const tW = CONFIG.timber.w; // 50
  const tD = CONFIG.timber.d; // 100
  const yBase = 150; // Sitting on floor frame top

  // --- FRONT WALL (Lower) ---
  const frontRoot = new BABYLON.TransformNode("wall-front-root", scene);
  mkTimber("wall-front-plate-bottom", dims.frame.w_mm, tW, tD, 0, yBase, 0, frontRoot);
  // Specific name suffix for Roof.js seat finding
  mkTimber("wall-front-plate-top", dims.frame.w_mm, tW, tD, 0, yBase + pMin - tW, 0, frontRoot, { part: "plate-top" });
  
  // Studs for front
  for (let x = 0; x <= dims.frame.w_mm - tW; x += 600) {
    mkTimber(`wall-front-stud-${x}`, tW, pMin - (2 * tW), tD, x, yBase + tW, 0, frontRoot);
  }
  mkTimber(`wall-front-stud-end`, tW, pMin - (2 * tW), tD, dims.frame.w_mm - tW, yBase + tW, 0, frontRoot);

  // --- BACK WALL (Higher) ---
  const backRoot = new BABYLON.TransformNode("wall-back-root", scene);
  const zBack = dims.frame.d_mm - tD;
  mkTimber("wall-back-plate-bottom", dims.frame.w_mm, tW, tD, 0, yBase, zBack, backRoot);
  mkTimber("wall-back-plate-top", dims.frame.w_mm, tW, tD, 0, yBase + pMax - tW, zBack, backRoot, { part: "plate-top" });
  
  for (let x = 0; x <= dims.frame.w_mm - tW; x += 600) {
    mkTimber(`wall-back-stud-${x}`, tW, pMax - (2 * tW), tD, x, yBase + tW, zBack, backRoot);
  }
  mkTimber(`wall-back-stud-end`, tW, pMax - (2 * tW), tD, dims.frame.w_mm - tW, yBase + tW, zBack, backRoot);

  // --- LEFT & RIGHT WALLS (Sloped Side Walls) ---
  const sideWalls = [
    { name: "left", x: 0 },
    { name: "right", x: dims.frame.w_mm - tW }
  ];

  sideWalls.forEach(side => {
    const root = new BABYLON.TransformNode(`wall-${side.name}-root`, scene);
    // Bottom plate
    mkTimber(`wall-${side.name}-plate-bottom`, tW, tW, dims.frame.d_mm - (2 * tD), side.x, yBase, tD, root);
    
    // Raking/Sloped studs
    for (let z = tD + 600; z < dims.frame.d_mm - tD; z += 600) {
      const progress = (z - 0) / dims.frame.d_mm;
      const currentH = pMin + (pMax - pMin) * progress;
      mkTimber(`wall-${side.name}-stud-${z}`, tW, currentH - (2 * tW), tD, side.x, yBase + tW, z - (tD/2), root);
    }
  });
}

export function updateBOM(state) {
  const tbody = document.getElementById("wallBomTable");
  if (!tbody) return;
  tbody.innerHTML = "";

  const dims = resolveDims(state);
  const wallHeight = state.walls?.height_mm || 2400;
  const pMin = state.roof?.pent?.minHeight_mm || wallHeight;
  const pMax = state.roof?.pent?.maxHeight_mm || wallHeight;
  const tW = CONFIG.timber.w;
  const tD = CONFIG.timber.d;

  const rows = [];

  // Front/Back Plates
  rows.push({ item: "Wall Plate (Horizontal)", qty: 4, L: dims.frame.w_mm, W: tD, notes: "Front/Back Top & Bottom" });
  
  // Side Plates
  rows.push({ item: "Wall Plate (Horizontal)", qty: 4, L: dims.frame.d_mm - (2 * tD), W: tD, notes: "Side Top & Bottom" });

  // Front Studs
  const frontStudQty = Math.ceil(dims.frame.w_mm / 600) + 1;
  rows.push({ item: "Wall Stud (Vertical)", qty: frontStudQty, L: pMin - (2 * tW), W: tD, notes: "Front Wall" });

  // Back Studs
  const backStudQty = Math.ceil(dims.frame.w_mm / 600) + 1;
  rows.push({ item: "Wall Stud (Vertical)", qty: backStudQty, L: pMax - (2 * tW), W: tD, notes: "Back Wall" });

  // Render to Table
  rows.forEach(r => {
    const tr = document.createElement("tr");
    [r.item, r.qty, r.L, r.W, r.notes].forEach(txt => {
      const td = document.createElement("td");
      td.textContent = txt;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}
