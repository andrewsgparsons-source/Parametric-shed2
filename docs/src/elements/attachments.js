/**
 * @fileoverview Attachment Builder - Creates sub-buildings attached to the main structure
 * 
 * Attachments are secondary buildings that share one wall with the main building.
 * Each attachment has its own:
 * - Base (ground supports)
 * - Floor (joists and OSB)
 * - Walls (3 of 4, with the 4th being the main building's wall)
 * - Roof (pent or apex style)
 * 
 * ## Coordinate System
 * Attachments use the same coordinate system as the main building:
 * - X = width (left to right)
 * - Y = height (up)
 * - Z = depth (front to back)
 * 
 * ## Attachment Walls
 * The `attachTo.wall` parameter determines which wall of the main building
 * the attachment connects to:
 * - "left"  → attachment extends in +X direction
 * - "right" → attachment extends in -X direction  
 * - "front" → attachment extends in -Z direction
 * - "back"  → attachment extends in +Z direction
 * 
 * ## Dimension Mapping
 * For left/right attachments:
 * - `width_mm` = dimension along the attached wall (Z direction)
 * - `depth_mm` = dimension outward from main building (X direction)
 * 
 * For front/back attachments:
 * - `width_mm` = dimension along the attached wall (X direction)
 * - `depth_mm` = dimension outward from main building (Z direction)
 * 
 * ## Roof Types
 * - **Pent**: Single slope, high edge at main building, low edge outward
 * - **Apex**: Gabled roof with ridge running perpendicular to attached wall
 * 
 * @module elements/attachments
 */

import { CONFIG } from '../params.js';

// Constants matching main building
const GRID_HEIGHT_MM = 50;
const FLOOR_FRAME_DEPTH_MM = 100;
const FLOOR_OSB_MM = 18;
const RAFTER_W_MM = 100;  // Rafter width (along slope)
const RAFTER_D_MM = 50;   // Rafter depth (vertical when flat)
const ROOF_OSB_MM = 18;
const COVERING_MM = 2;
const FASCIA_THK_MM = 20;
const FASCIA_DEPTH_MM = 135;
const OVERHANG_MM = 75;
const RAFTER_SPACING_MM = 600;

// Wall framing constants (matching main building walls.js)
const STUD_W_MM = 50;       // Stud width (plate height)
const STUD_H_MM = 75;       // Stud depth = wall thickness (basic variant)
const STUD_SPACING_MM = 400; // Center-to-center stud spacing
const PLATE_HEIGHT_MM = STUD_W_MM;  // Bottom/top plate height = stud width

// Cladding constants (matching main building walls.js)
const CLAD_H_MM = 140;      // Height per course (horizontal board row)
const CLAD_T_MM = 20;       // Thickness (board depth when mounted)
const CLAD_DRIP_MM = 30;    // Drip edge extension on first course only
const CLAD_BOTTOM_DROP_MM = 60;  // How far first course extends below plate
const CLAD_Hb_MM = 20;      // Bottom strip height
const CLAD_Rb_MM = 5;       // Rebate depth - upper strip is recessed by this amount

/**
 * Calculate the main building's lowest fascia bottom height
 * This is used to cap attachment roof heights
 * @param {object} mainState - The main building state
 * @returns {number} The lowest fascia bottom height in mm from ground
 */
function getMainBuildingFasciaBottom(mainState) {
  const roofStyle = mainState.roof?.style || "apex";

  // Floor surface height (same as attachment)
  const floorSurfaceY = GRID_HEIGHT_MM + FLOOR_FRAME_DEPTH_MM + FLOOR_OSB_MM; // 168mm

  if (roofStyle === "apex") {
    // For apex roof, the fascia is at the eaves
    const eavesHeight = Number(
      mainState.roof?.apex?.heightToEaves_mm ||
      mainState.roof?.apex?.eavesHeight_mm ||
      1850
    );
    // Fascia bottom = eaves height - fascia depth
    // The eavesHeight is measured from floor surface, so add floor stack
    return eavesHeight - FASCIA_DEPTH_MM;
  } else if (roofStyle === "pent") {
    // For pent roof, the lowest point is at the min height end
    const minHeight = Number(mainState.roof?.pent?.minHeight_mm || 2100);
    // Fascia bottom = min height - fascia depth
    return minHeight - FASCIA_DEPTH_MM;
  } else {
    // Default/fallback - use a reasonable value
    return 1850 - FASCIA_DEPTH_MM; // 1715mm
  }
}

/**
 * Build 3D geometry for an attachment
 * @param {object} mainState - The main building state
 * @param {object} attachment - The attachment configuration
 * @param {object} ctx - The Babylon.js context { scene, materials }
 */
export function build3D(mainState, attachment, ctx) {
  const { scene, materials } = ctx;

  if (!attachment || !attachment.enabled) {
    console.log("[attachments] Skipping disabled or null attachment:", attachment?.id);
    return;
  }

  const attId = attachment.id;
  const attachWall = attachment.attachTo?.wall || "left";

  console.log("[attachments] Building attachment:", attId, "wall:", attachWall);

  // Check visibility flags from main state (attachments follow main building visibility)
  const vis = mainState?.vis || {};
  const baseEnabled = vis.baseAll !== false;
  const wallsEnabled = vis.walls !== false && vis.wallsEnabled !== false;
  const roofEnabled = vis.roof !== false;
  const claddingEnabled = vis.cladding !== false;

  console.log("[attachments] Visibility - base:", baseEnabled, "walls:", wallsEnabled,
              "roof:", roofEnabled, "cladding:", claddingEnabled);

  // Calculate attachment world position
  const position = calculateAttachmentPosition(mainState, attachment);
  console.log("[attachments] Position:", position);

  // Get attachment dimensions
  const width = attachment.dimensions?.width_mm || 1800;  // Along the attached wall
  const depth = attachment.dimensions?.depth_mm || 1200;  // Outward from main building

  // Create root node for this attachment
  const rootName = `attachment-${attId}-root`;
  const root = new BABYLON.TransformNode(rootName, scene);
  root.position = new BABYLON.Vector3(
    position.x * 0.001,
    position.y * 0.001,
    position.z * 0.001
  );
  root.metadata = { dynamic: true, attachmentId: attId };

  // Get roof configuration
  const roofType = attachment.roof?.type || "pent";

  // Calculate the maximum allowed height for the attachment roof
  // The highest point of the attachment roof cannot exceed the main building's lowest fascia bottom
  const mainFasciaBottom = getMainBuildingFasciaBottom(mainState);

  // For pent roof, the highest point is at the inner edge (highHeight_mm)
  // This height includes the roof structure (rafters + OSB + covering)
  // So we need to account for the roof stack: RAFTER_D_MM (50) + ROOF_OSB_MM (18) + COVERING_MM (2) = 70mm
  const roofStackHeight = RAFTER_D_MM + ROOF_OSB_MM + COVERING_MM;

  // Maximum wall height at inner edge = fascia bottom - floor stack - roof stack
  const floorStackHeight = GRID_HEIGHT_MM + FLOOR_FRAME_DEPTH_MM + FLOOR_OSB_MM;
  const maxInnerHeight = mainFasciaBottom - roofStackHeight;

  console.log("[attachments] Height constraint - mainFasciaBottom:", mainFasciaBottom,
              "roofStackHeight:", roofStackHeight, "maxInnerHeight:", maxInnerHeight);

  // For pent roof, calculate wall heights
  // Inner wall (at main building) is higher, outer wall is lower
  // The UI values are total heights from ground to roof underside
  // If null, use dynamic defaults based on main building fascia
  let highHeight_mm = attachment.roof?.pent?.highHeight_mm;
  if (highHeight_mm == null) {
    highHeight_mm = maxInnerHeight; // Default to max allowed height
  }

  let lowHeight_mm = attachment.roof?.pent?.lowHeight_mm;
  if (lowHeight_mm == null) {
    lowHeight_mm = Math.max(500, highHeight_mm - 300); // Default 300mm slope
  }

  // Cap the high height so the roof peak doesn't exceed the main building's fascia bottom
  if (highHeight_mm > maxInnerHeight) {
    console.log("[attachments] Capping highHeight_mm from", highHeight_mm, "to", maxInnerHeight);
    highHeight_mm = maxInnerHeight;
  }

  // Ensure low height doesn't exceed high height (keep at least 100mm slope)
  const effectiveLowHeight = Math.min(lowHeight_mm, highHeight_mm - 100);

  // Wall heights are from floor surface to roof underside
  const wallHeightInner = Math.max(500, highHeight_mm - floorStackHeight);
  const wallHeightOuter = Math.max(500, effectiveLowHeight - floorStackHeight);

  console.log("[attachments] Heights - high:", highHeight_mm, "low:", effectiveLowHeight,
              "wallInner:", wallHeightInner, "wallOuter:", wallHeightOuter);

  // Determine extents based on orientation
  // For left/right attachments: extentX = depth (outward), extentZ = width (along wall)
  // For front/back attachments: extentX = width (along wall), extentZ = depth (outward)
  let extentX, extentZ;
  if (attachWall === "left" || attachWall === "right") {
    extentX = depth;
    extentZ = width;
  } else {
    extentX = width;
    extentZ = depth;
  }

  // Build attachment components based on visibility settings
  // Base and floor
  if (baseEnabled && attachment.base?.enabled !== false) {
    buildAttachmentBase(scene, root, attId, extentX, extentZ, materials);
    buildAttachmentFloor(scene, root, attId, extentX, extentZ, materials);
  }

  console.log("[attachments] Extents - X:", extentX, "Z:", extentZ);

  // Build walls with sloped tops for pent roof
  if (wallsEnabled) {
    console.log("[attachments] Building walls...");
    try {
      buildAttachmentWalls(scene, root, attId, extentX, extentZ, wallHeightInner, wallHeightOuter,
                           attachWall, roofType, materials, claddingEnabled);
      console.log("[attachments] Walls built successfully");
    } catch (wallErr) {
      console.error("[attachments] ERROR building walls:", wallErr);
    }
  }

  // Build roof structure (rafters, OSB, covering, fascia)
  if (roofEnabled && roofType !== "overhang") {
    console.log("[attachments] Building roof...");
    try {
      buildAttachmentRoof(scene, root, attId, extentX, extentZ, wallHeightInner, wallHeightOuter,
                          attachWall, roofType, attachment, materials);
      console.log("[attachments] Roof built successfully");
    } catch (roofErr) {
      console.error("[attachments] ERROR building roof:", roofErr);
    }
  }

  // Count meshes created for this attachment
  const attMeshes = scene.meshes.filter(m => m.metadata?.attachmentId === attId);
  console.log("[attachments] Build complete for:", attId, "- created", attMeshes.length, "meshes");
}

/**
 * Calculate the world position for an attachment
 * Attachment snaps to center of the specified wall with optional offset
 * Note: Main building meshes are shifted by -WALL_OVERHANG_MM (-25mm) in X and Z
 */
function calculateAttachmentPosition(mainState, attachment) {
  const attachWall = attachment.attachTo?.wall || "left";
  const offsetFromCenter = attachment.attachTo?.offsetFromCenter_mm || 0;
  const attWidth = attachment.dimensions?.width_mm || 1800;
  const attDepth = attachment.dimensions?.depth_mm || 1200;
  const levelOffset = attachment.base?.levelOffset_mm || 0;

  // Main building dimensions (frame dimensions)
  const mainW = mainState.dim?.frameW_mm || 1800;
  const mainD = mainState.dim?.frameD_mm || 2400;

  // Main building wall offset (walls are shifted to this offset)
  const WALL_OVERHANG_MM = 25;

  let x = 0, y = levelOffset, z = 0;

  switch (attachWall) {
    case "left":
      // Left wall of main is at x = -WALL_OVERHANG_MM
      // Attachment outer edge should meet main wall, so attachment starts at x = -(attDepth + WALL_OVERHANG_MM)
      x = -attDepth - WALL_OVERHANG_MM;
      z = (mainD / 2) - (attWidth / 2) + offsetFromCenter - WALL_OVERHANG_MM;
      break;
    case "right":
      // Right wall of main is at x = mainW - WALL_OVERHANG_MM
      x = mainW - WALL_OVERHANG_MM;
      z = (mainD / 2) - (attWidth / 2) + offsetFromCenter - WALL_OVERHANG_MM;
      break;
    case "front":
      // Front wall of main is at z = -WALL_OVERHANG_MM
      x = (mainW / 2) - (attWidth / 2) + offsetFromCenter - WALL_OVERHANG_MM;
      z = -attDepth - WALL_OVERHANG_MM;
      break;
    case "back":
      // Back wall of main is at z = mainD - WALL_OVERHANG_MM
      x = (mainW / 2) - (attWidth / 2) + offsetFromCenter - WALL_OVERHANG_MM;
      z = mainD - WALL_OVERHANG_MM;
      break;
  }

  return { x, y, z };
}

/**
 * Build the base (foundation grid) for the attachment
 */
function buildAttachmentBase(scene, root, attId, extentX, extentZ, materials) {
  const gridSize = CONFIG.grid.size; // 500mm
  const gridH = CONFIG.grid.h;       // 50mm height

  const mat = new BABYLON.StandardMaterial(`att-${attId}-base-mat`, scene);
  mat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.1);

  const yB = 25; // Center of base grid (50mm high, center at 25)

  for (let x = 0; x < extentX; x += gridSize) {
    for (let z = 0; z < extentZ; z += gridSize) {
      const bw = Math.min(gridSize, extentX - x);
      const bd = Math.min(gridSize, extentZ - z);

      const b = BABYLON.MeshBuilder.CreateBox(`att-${attId}-base-${x}-${z}`, {
        width: bw * 0.001,
        height: gridH * 0.001,
        depth: bd * 0.001
      }, scene);

      b.position = new BABYLON.Vector3(
        (x + bw / 2) * 0.001,
        yB * 0.001,
        (z + bd / 2) * 0.001
      );
      b.material = mat;
      b.parent = root;
      b.metadata = { dynamic: true, attachmentId: attId, type: 'base' };

      if (b.enableEdgesRendering) {
        b.enableEdgesRendering();
        b.edgesWidth = 1;
        b.edgesColor = new BABYLON.Color4(0.2, 0.2, 0.2, 1);
      }
    }
  }
}

/**
 * Build the floor frame and decking for the attachment
 */
function buildAttachmentFloor(scene, root, attId, extentX, extentZ, materials) {
  const frameT = 50;  // Frame thickness
  const frameH = 100; // Frame depth (height)

  const yF = 50 + (frameH / 2); // Y position for frame (above base)
  const yD = 50 + frameH + 9;   // Y position for decking (above frame)

  // Frame material
  const frameMat = materials?.timber || new BABYLON.StandardMaterial(`att-${attId}-frame-mat`, scene);
  if (!materials?.timber) {
    frameMat.diffuseColor = new BABYLON.Color3(0.5, 0.4, 0.3);
  }

  // Build perimeter frame (rim joists)
  const isXLonger = extentX >= extentZ;
  const rimLen = isXLonger ? extentX : extentZ;
  const joistSpan = isXLonger ? extentZ : extentX;

  // Rim joists
  [0, joistSpan - frameT].forEach(offset => {
    const r = BABYLON.MeshBuilder.CreateBox(`att-${attId}-rim-${offset}`, {
      width: (isXLonger ? rimLen : frameT) * 0.001,
      height: frameH * 0.001,
      depth: (isXLonger ? frameT : rimLen) * 0.001
    }, scene);

    if (isXLonger) {
      r.position = new BABYLON.Vector3(
        (rimLen / 2) * 0.001,
        yF * 0.001,
        (offset + frameT / 2) * 0.001
      );
    } else {
      r.position = new BABYLON.Vector3(
        (offset + frameT / 2) * 0.001,
        yF * 0.001,
        (rimLen / 2) * 0.001
      );
    }

    r.material = frameMat;
    r.parent = root;
    r.metadata = { dynamic: true, attachmentId: attId, type: 'frame' };
  });

  // Inner joists
  const innerJoistLen = joistSpan - (frameT * 2);
  const spacing = CONFIG.spacing; // 400mm
  let cursor = spacing;

  while (cursor < rimLen - frameT) {
    const j = BABYLON.MeshBuilder.CreateBox(`att-${attId}-joist-${cursor}`, {
      width: (isXLonger ? frameT : innerJoistLen) * 0.001,
      height: frameH * 0.001,
      depth: (isXLonger ? innerJoistLen : frameT) * 0.001
    }, scene);

    const mid = (innerJoistLen / 2 + frameT) * 0.001;
    if (isXLonger) {
      j.position = new BABYLON.Vector3(cursor * 0.001, yF * 0.001, mid);
    } else {
      j.position = new BABYLON.Vector3(mid, yF * 0.001, cursor * 0.001);
    }

    j.material = frameMat;
    j.parent = root;
    j.metadata = { dynamic: true, attachmentId: attId, type: 'frame' };

    cursor += spacing;
  }

  // Decking
  const deckMat = new BABYLON.StandardMaterial(`att-${attId}-deck-mat`, scene);
  deckMat.diffuseColor = new BABYLON.Color3(0.8, 0.7, 0.6);

  const deckH = 18; // 18mm OSB
  const d = BABYLON.MeshBuilder.CreateBox(`att-${attId}-deck`, {
    width: extentX * 0.001,
    height: deckH * 0.001,
    depth: extentZ * 0.001
  }, scene);

  d.position = new BABYLON.Vector3(
    (extentX / 2) * 0.001,
    yD * 0.001,
    (extentZ / 2) * 0.001
  );
  d.material = deckMat;
  d.parent = root;
  d.metadata = { dynamic: true, attachmentId: attId, type: 'deck' };

  d.enableEdgesRendering();
  d.edgesWidth = 4;
  d.edgesColor = new BABYLON.Color4(0, 0, 0, 1);
}

/**
 * Build the walls for the attachment (3 walls - inner wall is missing)
 * Uses proper framing (plates + studs) and cladding matching the main building
 *
 * CORNER JOIN RULES (matching main building):
 * - Outer wall and the wall perpendicular to slope are full width
 * - Side walls (along slope) run BETWEEN outer and inner edges
 * - For left/right attachments: front/back are full width, outer runs between
 * - For front/back attachments: left/right are full width, outer runs between
 *
 * For pent roof, the walls along the slope direction have sloped top plates (prisms)
 */
function buildAttachmentWalls(scene, root, attId, extentX, extentZ, wallHeightInner, wallHeightOuter,
                               attachWall, roofType, materials, claddingEnabled = true) {
  console.log("[attachments] buildAttachmentWalls called for:", attId,
              "extentX:", extentX, "extentZ:", extentZ,
              "wallHeightInner:", wallHeightInner, "wallHeightOuter:", wallHeightOuter,
              "attachWall:", attachWall, "roofType:", roofType, "claddingEnabled:", claddingEnabled);

  // Wall base Y = floor surface = grid + floor frame + floor OSB
  const wallBaseY = GRID_HEIGHT_MM + FLOOR_FRAME_DEPTH_MM + FLOOR_OSB_MM; // 50 + 100 + 18 = 168

  // Wall framing dimensions
  const plateH = PLATE_HEIGHT_MM;   // 50mm - plate height
  const wallThk = STUD_H_MM;        // 75mm - wall thickness (stud depth)
  const studW = STUD_W_MM;          // 50mm - stud width
  const studSpacing = STUD_SPACING_MM; // 400mm center-to-center

  console.log("[attachments] Wall params - baseY:", wallBaseY, "wallThk:", wallThk, "plateH:", plateH);

  // Get materials - use main building materials for consistency
  const plateMat = materials?.plate || createMaterial(scene, `att-${attId}-plate-mat`, 0.65, 0.45, 0.25);
  const studMat = materials?.timber || createMaterial(scene, `att-${attId}-stud-mat`, 0.72, 0.50, 0.28);

  // Use scene's cladding material if available (matches main building)
  let cladMat = materials?.cladding || scene._claddingMatLight;
  if (!cladMat) {
    cladMat = createCladdingMaterial(scene, `claddingMatLight`);
    scene._claddingMatLight = cladMat;
    console.log("[attachments] Created and cached cladding material on scene");
  }

  console.log("[attachments] Materials - plate:", plateMat?.name, "stud:", studMat?.name, "clad:", cladMat?.name);

  const isPent = roofType === "pent";

  // Helper to create a box mesh at position (bottom-left-front corner)
  function mkBox(name, lenX, lenY, lenZ, pos, mat) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, {
      width: lenX / 1000,
      height: lenY / 1000,
      depth: lenZ / 1000
    }, scene);
    mesh.position = new BABYLON.Vector3(
      (pos.x + lenX / 2) / 1000,
      (pos.y + lenY / 2) / 1000,
      (pos.z + lenZ / 2) / 1000
    );
    mesh.material = mat;
    mesh.parent = root;
    mesh.metadata = { dynamic: true, attachmentId: attId, type: 'wall-frame' };
    return mesh;
  }

  // Helper to create a sloped top plate (prism) for walls along the slope direction
  // Matches main building's mkSlopedPlateAlongX functionality
  function mkSlopedPlateAlongX(name, lenX, lenZ, originX, originZ, yTopAtX0, yTopAtX1, mat) {
    const x0 = originX;
    const x1 = originX + lenX;
    const z0 = originZ;
    const z1 = originZ + lenZ;

    const yTop0 = Math.max(0, Math.floor(Number(yTopAtX0)));
    const yTop1 = Math.max(0, Math.floor(Number(yTopAtX1)));
    const yBot0 = Math.max(0, yTop0 - plateH);
    const yBot1 = Math.max(0, yTop1 - plateH);

    const positions = [
      x0, yBot0, z0,
      x1, yBot1, z0,
      x1, yBot1, z1,
      x0, yBot0, z1,
      x0, yTop0, z0,
      x1, yTop1, z0,
      x1, yTop1, z1,
      x0, yTop0, z1,
    ].map((v) => v / 1000);

    const indices = [
      0, 1, 2, 0, 2, 3, // bottom
      4, 6, 5, 4, 7, 6, // top
      0, 5, 1, 0, 4, 5, // z0 face
      3, 2, 6, 3, 6, 7, // z1 face
      0, 3, 7, 0, 7, 4, // x0 face
      1, 5, 6, 1, 6, 2  // x1 face
    ];

    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const mesh = new BABYLON.Mesh(name, scene);
    vd.applyToMesh(mesh, true);

    // Clone material with backFaceCulling disabled for proper rendering
    let useMat = mat;
    if (mat && mat.clone) {
      useMat = mat.clone(name + "-mat");
      useMat.backFaceCulling = false;
    }
    mesh.material = useMat;
    mesh.parent = root;
    mesh.metadata = { dynamic: true, attachmentId: attId, type: 'wall-frame', part: 'sloped-plate' };
    return mesh;
  }

  // Helper to create a sloped top plate along Z axis
  function mkSlopedPlateAlongZ(name, lenX, lenZ, originX, originZ, yTopAtZ0, yTopAtZ1, mat) {
    const x0 = originX;
    const x1 = originX + lenX;
    const z0 = originZ;
    const z1 = originZ + lenZ;

    const yTop0 = Math.max(0, Math.floor(Number(yTopAtZ0)));
    const yTop1 = Math.max(0, Math.floor(Number(yTopAtZ1)));
    const yBot0 = Math.max(0, yTop0 - plateH);
    const yBot1 = Math.max(0, yTop1 - plateH);

    const positions = [
      x0, yBot0, z0,
      x1, yBot0, z0,
      x1, yBot1, z1,
      x0, yBot1, z1,
      x0, yTop0, z0,
      x1, yTop0, z0,
      x1, yTop1, z1,
      x0, yTop1, z1,
    ].map((v) => v / 1000);

    const indices = [
      0, 1, 2, 0, 2, 3, // bottom
      4, 6, 5, 4, 7, 6, // top
      0, 5, 1, 0, 4, 5, // z0 face
      3, 2, 6, 3, 6, 7, // z1 face
      0, 3, 7, 0, 7, 4, // x0 face
      1, 5, 6, 1, 6, 2  // x1 face
    ];

    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const mesh = new BABYLON.Mesh(name, scene);
    vd.applyToMesh(mesh, true);

    let useMat = mat;
    if (mat && mat.clone) {
      useMat = mat.clone(name + "-mat");
      useMat.backFaceCulling = false;
    }
    mesh.material = useMat;
    mesh.parent = root;
    mesh.metadata = { dynamic: true, attachmentId: attId, type: 'wall-frame', part: 'sloped-plate' };
    return mesh;
  }

  // Build walls based on attachment orientation
  // Following main building corner join rules

  if (attachWall === "left") {
    // Attachment to the left - inner wall (right side X=extentX) is missing
    // Slope runs along X: high at X=extentX (inner), low at X=0 (outer)
    // CORNER JOIN: Front/Back are full extentX width, Outer runs BETWEEN them

    const heightAtX = isPent
      ? (x) => wallHeightOuter + (wallHeightInner - wallHeightOuter) * (x / extentX)
      : () => wallHeightInner;

    // Side walls length (outer runs between front and back)
    const outerLen = extentZ - 2 * wallThk;

    // FRONT WALL (at Z=0, runs along X, full width) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'front', 'x', extentX,
                   { x: 0, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtX, mkBox, mkSlopedPlateAlongX);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'front', extentX, wallBaseY, -CLAD_T_MM, isPent, heightAtX, cladMat);
    }

    // BACK WALL (at Z=extentZ-wallThk, runs along X, full width) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'back', 'x', extentX,
                   { x: 0, z: extentZ - wallThk }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtX, mkBox, mkSlopedPlateAlongX);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'back', extentX, wallBaseY, extentZ, isPent, heightAtX, cladMat);
    }

    // OUTER WALL (at X=0, runs along Z, between front/back) - flat height
    buildWallPanel(scene, root, attId, 'outer', 'z', outerLen,
                   { x: 0, z: wallThk }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, false, () => wallHeightOuter, mkBox, null);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'outer', outerLen, wallHeightOuter, -CLAD_T_MM, wallBaseY, wallThk, cladMat, false, null);
    }

  } else if (attachWall === "right") {
    // Attachment to the right - inner wall (left side X=0) is missing
    // Slope runs along X: high at X=0 (inner), low at X=extentX (outer)
    // CORNER JOIN: Front/Back are full extentX width, Outer runs BETWEEN them

    const heightAtX = isPent
      ? (x) => wallHeightInner + (wallHeightOuter - wallHeightInner) * (x / extentX)
      : () => wallHeightInner;

    const outerLen = extentZ - 2 * wallThk;

    // FRONT WALL (at Z=0, runs along X, full width) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'front', 'x', extentX,
                   { x: 0, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtX, mkBox, mkSlopedPlateAlongX);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'front', extentX, wallBaseY, -CLAD_T_MM, isPent, heightAtX, cladMat);
    }

    // BACK WALL (at Z=extentZ-wallThk, runs along X, full width) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'back', 'x', extentX,
                   { x: 0, z: extentZ - wallThk }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtX, mkBox, mkSlopedPlateAlongX);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'back', extentX, wallBaseY, extentZ, isPent, heightAtX, cladMat);
    }

    // OUTER WALL (at X=extentX-wallThk, runs along Z, between front/back) - flat height
    buildWallPanel(scene, root, attId, 'outer', 'z', outerLen,
                   { x: extentX - wallThk, z: wallThk }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, false, () => wallHeightOuter, mkBox, null);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'outer', outerLen, wallHeightOuter, extentX, wallBaseY, wallThk, cladMat, false, null);
    }

  } else if (attachWall === "front") {
    // Attachment to the front - inner wall (back side Z=extentZ) is missing
    // Slope runs along Z: high at Z=extentZ (inner), low at Z=0 (outer)
    // CORNER JOIN: Left/Right are full extentZ depth, Outer runs BETWEEN them

    const heightAtZ = isPent
      ? (z) => wallHeightOuter + (wallHeightInner - wallHeightOuter) * (z / extentZ)
      : () => wallHeightInner;

    const outerLen = extentX - 2 * wallThk;

    // LEFT WALL (at X=0, runs along Z, full depth) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'left', 'z', extentZ,
                   { x: 0, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtZ, mkBox, mkSlopedPlateAlongZ);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'left', extentZ, wallHeightOuter, -CLAD_T_MM, wallBaseY, 0, cladMat, isPent, heightAtZ);
    }

    // RIGHT WALL (at X=extentX-wallThk, runs along Z, full depth) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'right', 'z', extentZ,
                   { x: extentX - wallThk, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtZ, mkBox, mkSlopedPlateAlongZ);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'right', extentZ, wallHeightOuter, extentX, wallBaseY, 0, cladMat, isPent, heightAtZ);
    }

    // OUTER WALL (at Z=0, runs along X, between left/right) - flat height
    buildWallPanel(scene, root, attId, 'outer', 'x', outerLen,
                   { x: wallThk, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, false, () => wallHeightOuter, mkBox, null);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'outer', outerLen, wallBaseY, -CLAD_T_MM, false, () => wallHeightOuter, cladMat, wallThk);
    }

  } else if (attachWall === "back") {
    // Attachment to the back - inner wall (front side Z=0) is missing
    // Slope runs along Z: high at Z=0 (inner), low at Z=extentZ (outer)
    // CORNER JOIN: Left/Right are full extentZ depth, Outer runs BETWEEN them

    const heightAtZ = isPent
      ? (z) => wallHeightInner + (wallHeightOuter - wallHeightInner) * (z / extentZ)
      : () => wallHeightInner;

    const outerLen = extentX - 2 * wallThk;

    // LEFT WALL (at X=0, runs along Z, full depth) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'left', 'z', extentZ,
                   { x: 0, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtZ, mkBox, mkSlopedPlateAlongZ);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'left', extentZ, wallHeightInner, -CLAD_T_MM, wallBaseY, 0, cladMat, isPent, heightAtZ);
    }

    // RIGHT WALL (at X=extentX-wallThk, runs along Z, full depth) - potentially sloped for pent
    buildWallPanel(scene, root, attId, 'right', 'z', extentZ,
                   { x: extentX - wallThk, z: 0 }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, isPent, heightAtZ, mkBox, mkSlopedPlateAlongZ);
    if (claddingEnabled) {
      buildCladdingAlongZ(scene, root, attId, 'right', extentZ, wallHeightInner, extentX, wallBaseY, 0, cladMat, isPent, heightAtZ);
    }

    // OUTER WALL (at Z=extentZ-wallThk, runs along X, between left/right) - flat height
    buildWallPanel(scene, root, attId, 'outer', 'x', outerLen,
                   { x: wallThk, z: extentZ - wallThk }, wallBaseY, wallThk, plateH, studW, studSpacing,
                   plateMat, studMat, false, () => wallHeightOuter, mkBox, null);
    if (claddingEnabled) {
      buildCladdingAlongX(scene, root, attId, 'outer', outerLen, wallBaseY, extentZ, false, () => wallHeightOuter, cladMat, wallThk);
    }
  }
}

/**
 * Build a single wall panel with plates and studs
 * Handles both flat and sloped (pent) walls
 * @param {string} axis - 'x' or 'z' - direction the wall runs
 * @param {number} length - wall length in mm
 * @param {object} origin - {x, z} position of wall start
 * @param {boolean} isSloped - whether this wall has a sloped top
 * @param {function} heightAt - function(position) returning wall height at that position
 */
function buildWallPanel(scene, root, attId, wallId, axis, length, origin, baseY, wallThk, plateH, studW, studSpacing, plateMat, studMat, isSloped, heightAt, mkBox, mkSlopedPlate) {
  const isAlongX = axis === 'x';
  const prefix = `att-${attId}-${wallId}`;

  // Calculate wall heights at start and end
  const heightAtStart = heightAt(0);
  const heightAtEnd = heightAt(length);
  const wallHeight = isSloped ? Math.max(heightAtStart, heightAtEnd) : heightAtStart;

  // Build bottom plate (always flat)
  if (isAlongX) {
    mkBox(`${prefix}-plate-bottom`, length, plateH, wallThk, { x: origin.x, y: baseY, z: origin.z }, plateMat);
  } else {
    mkBox(`${prefix}-plate-bottom`, wallThk, plateH, length, { x: origin.x, y: baseY, z: origin.z }, plateMat);
  }

  // Build top plate
  if (!isSloped) {
    // Flat top plate
    const topPlateY = baseY + wallHeight - plateH;
    if (isAlongX) {
      mkBox(`${prefix}-plate-top`, length, plateH, wallThk, { x: origin.x, y: topPlateY, z: origin.z }, plateMat);
    } else {
      mkBox(`${prefix}-plate-top`, wallThk, plateH, length, { x: origin.x, y: topPlateY, z: origin.z }, plateMat);
    }
  } else if (mkSlopedPlate) {
    // Sloped top plate (prism)
    const yTop0 = baseY + heightAtStart;
    const yTop1 = baseY + heightAtEnd;
    if (isAlongX) {
      mkSlopedPlate(`${prefix}-plate-top`, length, wallThk, origin.x, origin.z, yTop0, yTop1, plateMat);
    } else {
      mkSlopedPlate(`${prefix}-plate-top`, wallThk, length, origin.x, origin.z, yTop0, yTop1, plateMat);
    }
  }

  // Build studs
  const placeStud = (posAlongWall) => {
    // Calculate stud height at this position
    const studHeight = isSloped
      ? Math.max(1, heightAt(posAlongWall + studW / 2) - 2 * plateH)
      : Math.max(1, wallHeight - 2 * plateH);

    if (studHeight <= 0) return;

    if (isAlongX) {
      mkBox(`${prefix}-stud-${posAlongWall}`, studW, studHeight, wallThk,
            { x: origin.x + posAlongWall, y: baseY + plateH, z: origin.z }, studMat);
    } else {
      mkBox(`${prefix}-stud-${posAlongWall}`, wallThk, studHeight, studW,
            { x: origin.x, y: baseY + plateH, z: origin.z + posAlongWall }, studMat);
    }
  };

  // Place end studs
  placeStud(0);
  if (length > studW) {
    placeStud(length - studW);
  }

  // Place intermediate studs at regular spacing
  let pos = studSpacing;
  while (pos < length - studW) {
    // Don't place if too close to end stud
    if (Math.abs(pos - (length - studW)) >= studW) {
      placeStud(pos);
    }
    pos += studSpacing;
  }
}

/**
 * Create cladding material matching the main building
 */
function createCladdingMaterial(scene, name) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = new BABYLON.Color3(0.85, 0.72, 0.55);
  mat.emissiveColor = new BABYLON.Color3(0.17, 0.14, 0.11);
  mat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
  mat.specularPower = 16;
  mat.backFaceCulling = false;
  return mat;
}

/**
 * Build cladding courses along X axis (for front/back walls)
 * For sloped walls, uses CSG to cleanly clip cladding at the roof line (matching main building)
 * @param {number} xOffset - optional X offset for walls that start after x=0 (e.g., outer wall between side walls)
 */
function buildCladdingAlongX(scene, root, attId, wallId, length, baseY, zPos, isSloped, heightAtX, cladMat, xOffset = 0) {
  const maxWallHeight = isSloped ? Math.max(heightAtX(0), heightAtX(length)) : heightAtX(0);
  // Build extra courses above roof line for ALL walls:
  // - Sloped walls: CSG will trim them to the slope
  // - Non-sloped walls: extra courses extend behind fascia (hidden)
  const extraHeight = isSloped ? 500 : 200;
  const cladHeight = maxWallHeight + CLAD_BOTTOM_DROP_MM + extraHeight;
  const numCourses = Math.ceil(cladHeight / CLAD_H_MM);

  console.log("[attachments] buildCladdingAlongX:", wallId, "length:", length, "baseY:", baseY, "zPos:", zPos,
              "xOffset:", xOffset, "maxWallHeight:", maxWallHeight, "numCourses:", numCourses, "isSloped:", isSloped);

  // Calculate roof line Y values (absolute Y, not relative to baseY)
  const roofYAtStart = heightAtX(0) + baseY;  // Wall top Y at X=0
  const roofYAtEnd = heightAtX(length) + baseY;  // Wall top Y at X=length

  // Collect all cladding course meshes to merge
  const parts = [];

  for (let c = 0; c < numCourses; c++) {
    const isFirst = c === 0;
    const yBase = baseY - CLAD_BOTTOM_DROP_MM + c * CLAD_H_MM;

    // Bottom strip: full thickness, at base of board (+ drip on first course)
    const yBottomStrip = yBase - (isFirst ? CLAD_DRIP_MM : 0);
    const hBottomStrip = CLAD_Hb_MM + (isFirst ? CLAD_DRIP_MM : 0);

    // Upper strip: recessed (thinner), above bottom strip
    const yUpperStrip = yBase + CLAD_Hb_MM;
    const hUpperStrip = Math.max(1, CLAD_H_MM - CLAD_Hb_MM);
    const tUpper = Math.max(1, CLAD_T_MM - CLAD_Rb_MM); // 15mm instead of 20mm

    const courseTopY = yUpperStrip + hUpperStrip;

    // For sloped walls, we build all courses and CSG trims them
    // For non-sloped walls, we build extra courses that extend behind the fascia (no skip)
    // The extra height added above ensures we don't build too many courses

    // Calculate Z positions for the two strips
    // Both strips have their INNER face at the wall surface
    // Upper strip is thinner, creating a recess on the OUTER face (shiplap profile)
    // zPos is the outer face position, so inner face is at zPos + CLAD_T_MM (for front) or zPos - CLAD_T_MM (for back)
    // Determine which way the wall faces based on zPos sign
    const wallFacingBack = zPos >= 0; // Back wall cladding has zPos > 0

    // Bottom strip: full thickness, inner face at wall surface
    const zBottomCenter = wallFacingBack
      ? zPos + CLAD_T_MM / 2    // Back wall: inner face at zPos, outer at zPos + CLAD_T
      : zPos + CLAD_T_MM / 2;   // Front wall: inner face at zPos + CLAD_T, outer at zPos

    // Upper strip: thinner, inner face at same position, recess on outer face
    const zUpperCenter = wallFacingBack
      ? zPos + tUpper / 2       // Back wall: recessed from outer face
      : zPos + CLAD_T_MM - tUpper / 2;  // Front wall: recessed from outer face

    // BOTTOM STRIP - full thickness (creates the protruding lip)
    const bottomMesh = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-c${c}-bottom-temp`, {
      width: length / 1000,
      height: hBottomStrip / 1000,
      depth: CLAD_T_MM / 1000
    }, scene);
    bottomMesh.position = new BABYLON.Vector3(
      (xOffset + length / 2) / 1000,
      (yBottomStrip + hBottomStrip / 2) / 1000,
      zBottomCenter / 1000
    );
    parts.push(bottomMesh);

    // UPPER STRIP - recessed (thinner, creates the shadow line)
    const upperMesh = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-c${c}-upper-temp`, {
      width: length / 1000,
      height: hUpperStrip / 1000,
      depth: tUpper / 1000
    }, scene);
    upperMesh.position = new BABYLON.Vector3(
      (xOffset + length / 2) / 1000,
      (yUpperStrip + hUpperStrip / 2) / 1000,
      zUpperCenter / 1000
    );
    parts.push(upperMesh);
  }

  if (parts.length === 0) return;

  // Merge all course meshes
  let merged = null;
  try {
    merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  } catch (e) {
    console.error("[attachments] Failed to merge cladding courses:", e);
    merged = null;
  }

  if (!merged) return;

  // CSG clip cladding at roof line - matching main building walls.js approach
  let cutterCSG = null;

  if (isSloped) {
    // SLOPED walls: use wedge cutter following the slope
    const CUT_EXTRA = 120; // Match main building
    const z0r = zPos - CUT_EXTRA;
    const z1r = zPos + CLAD_T_MM + CUT_EXTRA;

    const x0 = xOffset;
    const x1 = xOffset + length;

    // Match main building: clip line is at wall top MINUS plate thickness
    // roofYAtStart/End already include baseY (168mm floor rise)
    const PENT_CLIP_DROP_MM = PLATE_HEIGHT_MM; // 50mm - drop by plate thickness
    const y0 = roofYAtStart - PENT_CLIP_DROP_MM;
    const y1 = roofYAtEnd - PENT_CLIP_DROP_MM;
    const yTop = Math.max(y0, y1) + 20000; // Very high - same as main building

    console.log('[ATT_WEDGE_DEBUG]', { x0, x1, y0, y1, yTop, z0r, z1r, roofYAtStart, roofYAtEnd });

    // Create wedge ABOVE the roof line - EXACTLY like main building
    // Vertices 0-3 = sloped bottom at roof line, vertices 4-7 = flat top very high
    const positions = [
      x0, y0, z0r,
      x1, y1, z0r,
      x1, y1, z1r,
      x0, y0, z1r,
      x0, yTop, z0r,
      x1, yTop, z0r,
      x1, yTop, z1r,
      x0, yTop, z1r,
    ].map((v) => v / 1000);

    // EXACT same indices as main building walls.js mkWedgeAboveLineX_Fixed
    const indices = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 5, 4, 0, 1, 5,
      3, 6, 2, 3, 7, 6,
      0, 7, 3, 0, 4, 7,
      1, 6, 5, 1, 2, 6
    ];

    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const wedge = new BABYLON.Mesh(`att-${attId}-clad-${wallId}-cutter`, scene);
    vd.applyToMesh(wedge, true);

    try { cutterCSG = BABYLON.CSG.FromMesh(wedge); } catch (e) { cutterCSG = null; }
    try { if (wedge && !wedge.isDisposed()) wedge.dispose(false, true); } catch (e) {}
  } else {
    // NON-SLOPED walls: use flat box cutter at constant height
    // Matching main building walls.js approach for flat-topped walls
    const CUT_EXTRA = 120;
    const cutMinZ = zPos - CUT_EXTRA;
    const cutMaxZ = zPos + CLAD_T_MM + CUT_EXTRA;

    // Cut height: wall height + baseY - plate thickness (same as main building)
    const PENT_CLIP_DROP_MM = PLATE_HEIGHT_MM; // 50mm
    const cutHeight = roofYAtStart - PENT_CLIP_DROP_MM;

    // X extents of the cladding
    const x0 = xOffset;
    const x1 = xOffset + length;

    // Create a box cutter above the cut height - same as main building
    const cutterHeight = 20000; // Tall enough to cut everything above

    console.log('[ATT_BOX_X_DEBUG]', { cutHeight, cutMinZ, cutMaxZ, x0, x1, roofYAtStart, baseY });

    const cutterBox = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-cutter`, {
      width: (x1 - x0) / 1000,
      height: cutterHeight / 1000,
      depth: (cutMaxZ - cutMinZ) / 1000
    }, scene);
    cutterBox.position = new BABYLON.Vector3(
      (x0 + (x1 - x0) / 2) / 1000,
      (cutHeight + cutterHeight / 2) / 1000,
      (cutMinZ + (cutMaxZ - cutMinZ) / 2) / 1000
    );

    try { cutterCSG = BABYLON.CSG.FromMesh(cutterBox); } catch (e) { cutterCSG = null; }
    try { if (cutterBox && !cutterBox.isDisposed()) cutterBox.dispose(false, true); } catch (e) {}
  }

  // Apply CSG subtract if cutter was created
  if (cutterCSG) {
    let resMesh = null;
    try {
      const baseCSG = BABYLON.CSG.FromMesh(merged);
      const resCSG = baseCSG.subtract(cutterCSG);
      resMesh = resCSG.toMesh(`att-${attId}-clad-${wallId}`, cladMat, scene, false);
    } catch (e) {
      console.error("[attachments] CSG clip failed:", e);
      resMesh = null;
    }

    if (resMesh) {
      try { merged.dispose(false, true); } catch (e) {}
      merged = resMesh;
    }
  }

  // Set final properties on the merged/clipped mesh
  merged.name = `att-${attId}-clad-${wallId}`;
  merged.material = cladMat;
  merged.parent = root;
  merged.metadata = { dynamic: true, attachmentId: attId, type: 'cladding', wallId: wallId };

  // Board definition comes from merged geometry (same as main building)
  // No explicit edge rendering needed - internal board faces provide definition
}

/**
 * Build cladding courses along Z axis (for left/right walls)
 * For sloped walls, uses CSG to cleanly clip cladding at the roof line (matching main building)
 * @param {number} zOffset - Z offset for the cladding start position
 */
function buildCladdingAlongZ(scene, root, attId, wallId, length, wallHeight, xPos, baseY, zOffset, cladMat, isSloped, heightAtZ) {
  const effectiveHeight = isSloped && heightAtZ ? Math.max(heightAtZ(0), heightAtZ(length)) : wallHeight;
  // Build extra courses above roof line for ALL walls:
  // - Sloped walls: CSG will trim them to the slope
  // - Non-sloped walls: extra courses extend behind fascia (hidden)
  const extraHeight = (isSloped && heightAtZ) ? 500 : 200;
  const cladHeight = effectiveHeight + CLAD_BOTTOM_DROP_MM + extraHeight;
  const numCourses = Math.ceil(cladHeight / CLAD_H_MM);

  console.log("[attachments] buildCladdingAlongZ:", wallId, "length:", length, "wallHeight:", wallHeight,
              "xPos:", xPos, "baseY:", baseY, "zOffset:", zOffset, "effectiveHeight:", effectiveHeight,
              "numCourses:", numCourses, "isSloped:", isSloped);

  // Calculate roof line Y values (absolute Y)
  const roofYAtStart = (isSloped && heightAtZ) ? (heightAtZ(0) + baseY) : (wallHeight + baseY);
  const roofYAtEnd = (isSloped && heightAtZ) ? (heightAtZ(length) + baseY) : (wallHeight + baseY);

  // Collect all cladding course meshes to merge
  const parts = [];

  for (let c = 0; c < numCourses; c++) {
    const isFirst = c === 0;
    const yBase = baseY - CLAD_BOTTOM_DROP_MM + c * CLAD_H_MM;

    // Bottom strip: full thickness, at base of board (+ drip on first course)
    const yBottomStrip = yBase - (isFirst ? CLAD_DRIP_MM : 0);
    const hBottomStrip = CLAD_Hb_MM + (isFirst ? CLAD_DRIP_MM : 0);

    // Upper strip: recessed (thinner), above bottom strip
    const yUpperStrip = yBase + CLAD_Hb_MM;
    const hUpperStrip = Math.max(1, CLAD_H_MM - CLAD_Hb_MM);
    const tUpper = Math.max(1, CLAD_T_MM - CLAD_Rb_MM); // 15mm instead of 20mm

    const courseTopY = yUpperStrip + hUpperStrip;

    // For sloped walls, we build all courses and CSG trims them
    // For non-sloped walls, we build extra courses that extend behind the fascia (no skip)
    // The extra height added above ensures we don't build too many courses

    // For Z-axis walls, thickness is along X
    // Determine wall facing direction based on xPos
    // xPos < 0 means wall is on the LEFT side (outer wall), facing outward (-X direction)
    // xPos > 0 means wall is on the RIGHT side, facing outward (+X direction)
    const wallFacingLeft = xPos < 0;

    // Bottom strip: full thickness, center is always at xPos + CLAD_T_MM / 2
    const xBottomCenter = xPos + CLAD_T_MM / 2;

    // Upper strip: thinner, with recess on OUTER face (visible side)
    // Both strips must have their INNER face aligned at the wall surface
    const xUpperCenter = wallFacingLeft
      ? xPos + CLAD_T_MM - tUpper / 2  // Left-facing: inner face at xPos + CLAD_T_MM, recess on left (outer)
      : xPos + tUpper / 2;              // Right-facing: inner face at xPos, recess on right (outer)

    // BOTTOM STRIP - full thickness (creates the protruding lip)
    const bottomMesh = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-c${c}-bottom-temp`, {
      width: CLAD_T_MM / 1000,
      height: hBottomStrip / 1000,
      depth: length / 1000
    }, scene);
    bottomMesh.position = new BABYLON.Vector3(
      xBottomCenter / 1000,
      (yBottomStrip + hBottomStrip / 2) / 1000,
      (zOffset + length / 2) / 1000
    );
    parts.push(bottomMesh);

    // UPPER STRIP - recessed (thinner, creates the shadow line)
    const upperMesh = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-c${c}-upper-temp`, {
      width: tUpper / 1000,
      height: hUpperStrip / 1000,
      depth: length / 1000
    }, scene);
    upperMesh.position = new BABYLON.Vector3(
      xUpperCenter / 1000,
      (yUpperStrip + hUpperStrip / 2) / 1000,
      (zOffset + length / 2) / 1000
    );
    parts.push(upperMesh);
  }

  if (parts.length === 0) return;

  // Merge all course meshes
  let merged = null;
  try {
    merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  } catch (e) {
    console.error("[attachments] Failed to merge cladding courses:", e);
    merged = null;
  }

  if (!merged) return;

  // CSG clip cladding at roof line - matching main building walls.js approach
  let cutterCSG = null;

  if (isSloped && heightAtZ) {
    // SLOPED walls: use wedge cutter following the slope
    const CUT_EXTRA = 120; // Match main building
    const x0r = xPos - CUT_EXTRA;
    const x1r = xPos + CLAD_T_MM + CUT_EXTRA;

    const z0 = zOffset;
    const z1 = zOffset + length;

    // Match main building: clip line is at wall top MINUS plate thickness
    const PENT_CLIP_DROP_MM = PLATE_HEIGHT_MM; // 50mm
    const y0 = roofYAtStart - PENT_CLIP_DROP_MM;
    const y1 = roofYAtEnd - PENT_CLIP_DROP_MM;
    const yTop = Math.max(y0, y1) + 20000;

    console.log('[ATT_WEDGE_Z_DEBUG]', { z0, z1, y0, y1, yTop, x0r, x1r });

    // Create wedge ABOVE the roof line - for Z-axis walls
    // Vertices follow the same pattern as X-axis but with Z as the slope direction
    const positions = [
      x0r, y0, z0,
      x1r, y0, z0,
      x1r, y1, z1,
      x0r, y1, z1,
      x0r, yTop, z0,
      x1r, yTop, z0,
      x1r, yTop, z1,
      x0r, yTop, z1,
    ].map((v) => v / 1000);

    // EXACT same indices as main building
    const indices = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 5, 4, 0, 1, 5,
      3, 6, 2, 3, 7, 6,
      0, 7, 3, 0, 4, 7,
      1, 6, 5, 1, 2, 6
    ];

    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const wedge = new BABYLON.Mesh(`att-${attId}-clad-${wallId}-cutter`, scene);
    vd.applyToMesh(wedge, true);

    try { cutterCSG = BABYLON.CSG.FromMesh(wedge); } catch (e) { cutterCSG = null; }
    try { if (wedge && !wedge.isDisposed()) wedge.dispose(false, true); } catch (e) {}
  } else {
    // NON-SLOPED walls: use flat box cutter at constant height
    // Matching main building walls.js lines 1264-1305
    const CUT_EXTRA = 120;
    const cutMinX = xPos - CUT_EXTRA;
    const cutMaxX = xPos + CLAD_T_MM + CUT_EXTRA;

    // Cut height: wall height + baseY - plate thickness (same as main building)
    const PENT_CLIP_DROP_MM = PLATE_HEIGHT_MM; // 50mm
    const cutHeight = roofYAtStart - PENT_CLIP_DROP_MM;

    // Z extents of the cladding
    const z0 = zOffset;
    const z1 = zOffset + length;

    // Create a box cutter above the cut height - same as main building
    const cutterHeight = 20000; // Tall enough to cut everything above

    console.log('[ATT_BOX_Z_DEBUG]', { cutHeight, cutMinX, cutMaxX, z0, z1, wallHeight, baseY });

    const cutterBox = BABYLON.MeshBuilder.CreateBox(`att-${attId}-clad-${wallId}-cutter`, {
      width: (cutMaxX - cutMinX) / 1000,
      height: cutterHeight / 1000,
      depth: (z1 - z0) / 1000
    }, scene);
    cutterBox.position = new BABYLON.Vector3(
      (cutMinX + (cutMaxX - cutMinX) / 2) / 1000,
      (cutHeight + cutterHeight / 2) / 1000,
      (z0 + (z1 - z0) / 2) / 1000
    );

    try { cutterCSG = BABYLON.CSG.FromMesh(cutterBox); } catch (e) { cutterCSG = null; }
    try { if (cutterBox && !cutterBox.isDisposed()) cutterBox.dispose(false, true); } catch (e) {}
  }

  // Apply CSG subtract if cutter was created
  if (cutterCSG) {
    let resMesh = null;
    try {
      const baseCSG = BABYLON.CSG.FromMesh(merged);
      const resCSG = baseCSG.subtract(cutterCSG);
      resMesh = resCSG.toMesh(`att-${attId}-clad-${wallId}`, cladMat, scene, false);
    } catch (e) {
      console.error("[attachments] CSG clip failed:", e);
      resMesh = null;
    }

    if (resMesh) {
      try { merged.dispose(false, true); } catch (e) {}
      merged = resMesh;
    }
  }

  // Set final properties on the merged/clipped mesh
  merged.name = `att-${attId}-clad-${wallId}`;
  merged.material = cladMat;
  merged.parent = root;
  merged.metadata = { dynamic: true, attachmentId: attId, type: 'cladding', wallId: wallId };

  // Board definition comes from merged geometry (same as main building)
  // No explicit edge rendering needed - internal board faces provide definition
}

/**
 * Build the roof structure for the attachment
 * Following the same approach as main building: build flat in local space, then rotate and position
 * Includes rafters, OSB sheathing, covering (felt), and fascia boards
 */
function buildAttachmentRoof(scene, root, attId, extentX, extentZ, wallHeightInner, wallHeightOuter,
                              attachWall, roofType, attachment, materials) {
  // Floor surface Y position
  const floorSurfaceY = GRID_HEIGHT_MM + FLOOR_FRAME_DEPTH_MM + FLOOR_OSB_MM;

  // Roof bearing heights (Y at top of wall plates)
  const roofInnerY = floorSurfaceY + wallHeightInner;
  const roofOuterY = floorSurfaceY + wallHeightOuter;

  // Materials
  const joistMat = materials?.timber || createMaterial(scene, `att-${attId}-joist-mat`, 0.5, 0.4, 0.3);
  const osbMat = createMaterial(scene, `att-${attId}-osb-mat`, 0.75, 0.62, 0.45);
  const coveringMat = createMaterial(scene, `att-${attId}-covering-mat`, 0.1, 0.1, 0.1);

  if (roofType === "pent") {
    buildPentRoof(scene, root, attId, extentX, extentZ, roofInnerY, roofOuterY,
                  attachWall, joistMat, osbMat, coveringMat, attachment);
  } else if (roofType === "apex") {
    buildApexRoof(scene, root, attId, extentX, extentZ, roofInnerY,
                  attachment, joistMat, osbMat, coveringMat);
  }
}

/**
 * Helper to create a simple diffuse material
 */
function createMaterial(scene, name, r, g, b) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = new BABYLON.Color3(r, g, b);
  mat.backFaceCulling = false;  // Show both sides
  return mat;
}

/**
 * Build pent roof with proper structure
 * Follows the main building approach: build flat in a local root node, then rotate to pitch angle
 * Supports configurable overhangs (eaves, vergeLeft, vergeRight) matching main building protocol
 */
function buildPentRoof(scene, root, attId, extentX, extentZ, roofInnerY, roofOuterY,
                        attachWall, joistMat, osbMat, coveringMat, attachment) {

  // Get overhang values from attachment config (with defaults)
  const pentOvh = attachment?.roof?.pent?.overhang || {};
  const ovhEaves = Math.max(0, Math.floor(Number(pentOvh.eaves_mm ?? 75)));
  const ovhVergeL = Math.max(0, Math.floor(Number(pentOvh.vergeLeft_mm ?? 75)));
  const ovhVergeR = Math.max(0, Math.floor(Number(pentOvh.vergeRight_mm ?? 75)));

  console.log("[attachments] buildPentRoof:", attId,
              "extentX:", extentX, "extentZ:", extentZ,
              "roofInnerY:", roofInnerY, "roofOuterY:", roofOuterY,
              "attachWall:", attachWall,
              "overhangs:", { eaves: ovhEaves, vergeL: ovhVergeL, vergeR: ovhVergeR });

  // Calculate rise (height difference) and run (horizontal distance)
  const rise_mm = roofInnerY - roofOuterY;

  // Determine slope direction based on attachWall
  // For left/right attachments: slope runs along X (extentX is depth/run)
  // For front/back attachments: slope runs along Z (extentZ is depth/run)
  const slopeAlongX = (attachWall === "left" || attachWall === "right");

  const run_mm = slopeAlongX ? extentX : extentZ;       // Distance along slope direction
  const span_mm = slopeAlongX ? extentZ : extentX;     // Distance perpendicular to slope

  // Calculate slope length (hypotenuse) and scale factor
  const slopeLen_mm = Math.sqrt(run_mm * run_mm + rise_mm * rise_mm);
  const slopeScale = slopeLen_mm / run_mm;

  // Pitch angle
  const pitchAngle = Math.atan2(rise_mm, run_mm);

  // Slope direction is now handled by yaw rotation (see below)
  // - Left/Right: slope runs along X axis
  // - Front/Back: slope runs along Z axis
  // The yaw rotation ensures the high end (inner edge) always points toward the main building

  // Create a roof root node at the low point of the roof
  // We'll build everything flat (y=0 at underside of rafters) then rotate and position
  const roofRoot = new BABYLON.TransformNode(`att-${attId}-roof-root`, scene);
  roofRoot.metadata = { dynamic: true, attachmentId: attId };
  roofRoot.parent = root;

  // Local coordinate system for roof:
  // - slopeAxis runs along the slope (0 to slopeLen)
  // - spanAxis runs perpendicular (0 to span)
  // - Y is up (0 at rafter bottom)

  // Physical dimensions for roof (along slope, we use the scaled length)
  // Add overhang at eaves (outer edge) - note: no overhang at ridge (connects to main building)
  // The slope length with eaves overhang = sqrt((run + eaves_ovh)^2 + rise^2)
  const runWithEaves_mm = run_mm + ovhEaves;
  const slopeLenWithEaves_mm = Math.sqrt(runWithEaves_mm * runWithEaves_mm + rise_mm * rise_mm);

  // Span with verge overhangs on both sides
  const spanWithVerges_mm = span_mm + ovhVergeL + ovhVergeR;

  const roofSlope_mm = slopeLenWithEaves_mm;
  const roofSpan_mm = spanWithVerges_mm;

  // Helper to create box at local position (bottom-aligned in Y)
  function mkBox(name, lenX, lenY, lenZ, x, yBottom, z, mat, meta) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, {
      width: lenX / 1000,
      height: lenY / 1000,
      depth: lenZ / 1000
    }, scene);

    mesh.position = new BABYLON.Vector3(
      (x + lenX / 2) / 1000,
      yBottom / 1000 + lenY / 2000,
      (z + lenZ / 2) / 1000
    );

    mesh.material = mat;
    mesh.parent = roofRoot;
    mesh.metadata = Object.assign({ dynamic: true, attachmentId: attId, type: 'roof' }, meta || {});
    return mesh;
  }

  // Build in local coordinates (A = slope axis, B = span axis)
  // If slopeAlongX: A->X, B->Z in local
  // If slopeAlongZ: A->Z, B->X in local

  const A_mm = roofSlope_mm;  // Along slope direction
  const B_mm = roofSpan_mm;   // Perpendicular to slope

  // Build rim joists (at front and back of span, running along slope)
  mkBox(`att-${attId}-rim-front`, A_mm, RAFTER_D_MM, RAFTER_W_MM, 0, 0, 0, joistMat, { part: 'rim', edge: 'front' });
  mkBox(`att-${attId}-rim-back`, A_mm, RAFTER_D_MM, RAFTER_W_MM, 0, 0, B_mm - RAFTER_W_MM, joistMat, { part: 'rim', edge: 'back' });

  // Build rafters (run along slope, spaced along span)
  const rafterPositions = [];
  let p = 0;
  const maxP = B_mm - RAFTER_W_MM;
  while (p <= maxP) {
    rafterPositions.push(p);
    p += RAFTER_SPACING_MM;
  }
  // Ensure last rafter at end
  if (rafterPositions.length && rafterPositions[rafterPositions.length - 1] < maxP) {
    rafterPositions.push(maxP);
  }

  rafterPositions.forEach((pos, i) => {
    mkBox(`att-${attId}-rafter-${i}`, A_mm, RAFTER_D_MM, RAFTER_W_MM, 0, 0, pos, joistMat, { part: 'rafter' });
  });

  // Build OSB (on top of rafters)
  const osbY = RAFTER_D_MM;
  const osbMesh = mkBox(`att-${attId}-osb`, A_mm, ROOF_OSB_MM, B_mm, 0, osbY, 0, osbMat, { part: 'osb' });
  if (osbMesh.enableEdgesRendering) {
    osbMesh.enableEdgesRendering();
    osbMesh.edgesWidth = 3;
    osbMesh.edgesColor = new BABYLON.Color4(0, 0, 0, 1);
  }

  // Build covering (felt) on top of OSB - extends past OSB for overhang fold-down
  const coverY = RAFTER_D_MM + ROOF_OSB_MM;
  mkBox(`att-${attId}-covering`, A_mm, COVERING_MM, B_mm, 0, coverY, 0, coveringMat, { part: 'covering' });

  // Covering fold-downs (100mm drop at edges)
  const FOLD_DOWN_MM = 100;

  // Eaves fold (at A=0, low edge)
  mkBox(`att-${attId}-covering-eaves`, COVERING_MM, FOLD_DOWN_MM, B_mm, -COVERING_MM, coverY - FOLD_DOWN_MM, 0, coveringMat, { part: 'covering-eaves' });

  // Ridge fold (at A=A_mm, high edge)
  mkBox(`att-${attId}-covering-ridge`, COVERING_MM, FOLD_DOWN_MM, B_mm, A_mm, coverY - FOLD_DOWN_MM, 0, coveringMat, { part: 'covering-ridge' });

  // Verge folds (at B=0 and B=B_mm)
  mkBox(`att-${attId}-covering-verge-left`, A_mm, FOLD_DOWN_MM, COVERING_MM, 0, coverY - FOLD_DOWN_MM, -COVERING_MM, coveringMat, { part: 'covering-verge', edge: 'left' });
  mkBox(`att-${attId}-covering-verge-right`, A_mm, FOLD_DOWN_MM, COVERING_MM, 0, coverY - FOLD_DOWN_MM, B_mm, coveringMat, { part: 'covering-verge', edge: 'right' });

  // Fascia boards (hang down from roof edges)
  const fasciaTopY = RAFTER_D_MM + ROOF_OSB_MM;
  const fasciaBottomY = fasciaTopY - FASCIA_DEPTH_MM;

  // Eaves fascia (at A=0)
  mkBox(`att-${attId}-fascia-eaves`, FASCIA_THK_MM, FASCIA_DEPTH_MM, B_mm + 2 * FASCIA_THK_MM, -FASCIA_THK_MM, fasciaBottomY, -FASCIA_THK_MM, joistMat, { part: 'fascia', edge: 'eaves' });

  // Ridge fascia (at A=A_mm) - Note: This connects to main building, may not be needed
  // mkBox(`att-${attId}-fascia-ridge`, FASCIA_THK_MM, FASCIA_DEPTH_MM, B_mm + 2 * FASCIA_THK_MM, A_mm, fasciaBottomY, -FASCIA_THK_MM, joistMat, { part: 'fascia', edge: 'ridge' });

  // Verge fascia (at B=0 and B=B_mm, runs along slope)
  mkBox(`att-${attId}-fascia-verge-left`, A_mm, FASCIA_DEPTH_MM, FASCIA_THK_MM, 0, fasciaBottomY, -FASCIA_THK_MM, joistMat, { part: 'fascia', edge: 'verge-left' });
  mkBox(`att-${attId}-fascia-verge-right`, A_mm, FASCIA_DEPTH_MM, FASCIA_THK_MM, 0, fasciaBottomY, B_mm, joistMat, { part: 'fascia', edge: 'verge-right' });

  // Now rotate and position the roof root node
  // The roof is built with A along local X, B along local Z
  // We need to rotate so A aligns with the world slope direction

  // Determine pitch axis (perpendicular to slope direction)
  const pitchAxisWorld = slopeAlongX ? new BABYLON.Vector3(0, 0, 1) : new BABYLON.Vector3(1, 0, 0);

  // Yaw rotation to align local +X (high end of slope) toward the main building
  // Pitch sign determines which way to tilt to raise the inner edge
  // 
  // After yaw, local +X points toward main building (inner edge = ridge)
  // Then pitch rotation around the perpendicular axis tilts that edge UP
  //
  // Attachment | Yaw    | Ridge direction | Pitch axis | Pitch sign
  // -----------|--------|-----------------|------------|------------
  // Left       | 0      | +X              | Z          | +1
  // Right      | π      | -X              | Z          | -1
  // Front      | -π/2   | +Z              | X          | -1
  // Back       | +π/2   | -Z              | X          | +1

  let yaw = 0;
  let pitchSign = 1;

  if (attachWall === "left") {
    yaw = 0;
    pitchSign = 1;   // +pitch around Z tilts +X toward +Y (up)
  } else if (attachWall === "right") {
    yaw = Math.PI;   // 180° flip: local +X → world -X
    pitchSign = -1;  // -pitch around Z tilts -X toward +Y (up)
  } else if (attachWall === "front") {
    yaw = -Math.PI / 2;  // local +X → world +Z (toward main building)
    pitchSign = -1;      // -pitch around X tilts +Z toward +Y (up)
  } else { // back
    yaw = Math.PI / 2;   // local +X → world -Z (toward main building)
    pitchSign = 1;       // +pitch around X tilts -Z toward +Y (up)
  }

  const qYaw = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), yaw);
  const qPitch = BABYLON.Quaternion.RotationAxis(pitchAxisWorld, pitchSign * pitchAngle);

  roofRoot.rotationQuaternion = qPitch.multiply(qYaw);

  console.log("[attachments] Roof rotation - pitchAngle:", pitchAngle * 180 / Math.PI, "deg",
              "slopeAlongX:", slopeAlongX,
              "appliedPitch:", (slopeAlongX ? -pitchAngle : pitchAngle) * 180 / Math.PI, "deg");

  // Position the roof root
  // After rotation, we need to position it so:
  // - The low edge of the roof is at the outer wall position
  // - The roof height at low edge = roofOuterY

  // First, compute where the roof corners end up after rotation
  // Local corners at y=0: (0,0,0), (A,0,0), (0,0,B), (A,0,B)
  function localToWorld(lx, ly, lz) {
    const local = new BABYLON.Vector3(lx / 1000, ly / 1000, lz / 1000);
    const rotated = local.rotateByQuaternionToRef(roofRoot.rotationQuaternion, new BABYLON.Vector3());
    return rotated;
  }

  // Find the min/max X, Z at corners after rotation
  const corners = [
    localToWorld(0, 0, 0),
    localToWorld(A_mm, 0, 0),
    localToWorld(0, 0, B_mm),
    localToWorld(A_mm, 0, B_mm)
  ];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  corners.forEach(c => {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  });

  // The low corner (A=0) should be at the outer edge MINUS the eaves overhang
  // The roof extends past walls by: eaves at outer edge, vergeL/vergeR on sides
  // For left/right attachments: eaves extends in X direction, verges extend in Z
  // For front/back attachments: eaves extends in Z direction, verges extend in X

  // Calculate the overhang offset for eaves (extends outward from outer wall)
  const eavesOffset_m = ovhEaves / 1000;

  // Calculate the verge offset (roof starts at -vergeL relative to wall span start)
  const vergeLOffset_m = ovhVergeL / 1000;

  // Position the roof based on where the geometry extends after rotation
  // The roof is built with eaves at local origin (0,0,0), extending toward +X (ridge) and +Z (span)
  // After yaw rotation, these directions change:
  //   Left (yaw=0):     local +X → world +X, local +Z → world +Z
  //   Right (yaw=π):    local +X → world -X, local +Z → world -Z
  //   Front (yaw=-π/2): local +X → world +Z, local +Z → world +X
  //   Back (yaw=+π/2):  local +X → world -Z, local +Z → world -X

  const vergeROffset_m = (ovhVergeR || ovhVergeL) / 1000;

  let targetRoofX_m, targetRoofZ_m;
  if (attachWall === "left") {
    // Roof extends +X (toward main), +Z (span)
    // Eaves (origin) at outer edge: X = -ovhEaves
    // Span starts at Z = -vergeL
    targetRoofX_m = -eavesOffset_m;
    targetRoofZ_m = -vergeLOffset_m;
  } else if (attachWall === "right") {
    // Roof extends -X (toward main), -Z (span) due to 180° yaw
    // Eaves (origin) at outer edge: X = extentX + ovhEaves
    // Span far edge (origin after Z flip) at: Z = extentZ + vergeR
    targetRoofX_m = extentX / 1000 + eavesOffset_m;
    targetRoofZ_m = extentZ / 1000 + vergeROffset_m;
  } else if (attachWall === "front") {
    // With yaw=-π/2: local +X → world +Z, local +Z → world -X (flipped!)
    // Roof extends +Z (toward main), span extends toward -X
    // Eaves (origin) at outer edge: Z = -ovhEaves
    // Span: near edge at X=roofRoot.x, far edge at X=roofRoot.x - B
    // Want coverage from X = -vergeL to X = extentX + vergeR
    // So roofRoot.x = extentX + vergeR (far edge at -vergeL)
    targetRoofX_m = extentX / 1000 + vergeROffset_m;
    targetRoofZ_m = -eavesOffset_m;
  } else { // back
    // With yaw=+π/2: local +X → world -Z, local +Z → world +X
    // Roof extends -Z (toward main), span extends toward +X
    // Eaves (origin) at outer edge: Z = extentZ + ovhEaves
    // Span: near edge at X=roofRoot.x, far edge at X=roofRoot.x + B
    // Want coverage from X = -vergeL to X = extentX + vergeR
    // So roofRoot.x = -vergeL (far edge at extentX + vergeR)
    targetRoofX_m = -vergeLOffset_m;
    targetRoofZ_m = extentZ / 1000 + eavesOffset_m;
  }

  // The eaves corner (0,0,0) stays at origin after rotation
  const eavesCorner = localToWorld(0, 0, 0);

  // Y position: The BEARING POINT (where roof meets outer wall) should be at roofOuterY
  // The eaves extends ovhEaves beyond the outer wall, so it's LOWER than roofOuterY
  // Calculate the slope distance from eaves to bearing point: ovhEaves / cos(pitchAngle)
  const bearingPointA_mm = ovhEaves / Math.cos(pitchAngle);
  const bearingPointY = localToWorld(bearingPointA_mm, 0, B_mm / 2).y;
  const targetY_m = roofOuterY / 1000 - bearingPointY;

  // Position the roof root so that the eaves corner lands at the target position
  roofRoot.position = new BABYLON.Vector3(
    targetRoofX_m - eavesCorner.x,
    targetY_m,
    targetRoofZ_m - eavesCorner.z
  );

  console.log("[attachments] Roof positioning - yaw:", (yaw * 180 / Math.PI).toFixed(1) + "°",
              "pitchSign:", pitchSign, "pitch:", (pitchAngle * 180 / Math.PI).toFixed(1) + "°");
  console.log("[attachments] Eaves corner after rotation:", eavesCorner);
  console.log("[attachments] Target roof position: X=" + targetRoofX_m.toFixed(4) + " Z=" + targetRoofZ_m.toFixed(4));
  console.log("[attachments] Roof root position:",
              "x:", (targetRoofX_m - eavesCorner.x).toFixed(4),
              "y:", targetY_m.toFixed(4),
              "z:", (targetRoofZ_m - eavesCorner.z).toFixed(4));
}

/**
 * Build apex roof (simplified - similar to main building)
 */
function buildApexRoof(scene, root, attId, extentX, extentZ, roofBaseY, attachment, joistMat, osbMat, coveringMat) {
  // Simplified apex roof - just create two sloped planes meeting at a ridge
  const eaveHeight = attachment.roof?.apex?.eaveHeight_mm || 100;
  const crestHeight = attachment.roof?.apex?.crestHeight_mm || 400;

  const ridgeX = extentX / 2;
  const ridgeY = roofBaseY + crestHeight;
  const eaveY = roofBaseY + eaveHeight;

  // Create two roof planes using ribbon mesh
  const leftPath1 = [
    new BABYLON.Vector3(0, eaveY * 0.001, 0),
    new BABYLON.Vector3(ridgeX * 0.001, ridgeY * 0.001, 0)
  ];
  const leftPath2 = [
    new BABYLON.Vector3(0, eaveY * 0.001, extentZ * 0.001),
    new BABYLON.Vector3(ridgeX * 0.001, ridgeY * 0.001, extentZ * 0.001)
  ];

  const rightPath1 = [
    new BABYLON.Vector3(ridgeX * 0.001, ridgeY * 0.001, 0),
    new BABYLON.Vector3(extentX * 0.001, eaveY * 0.001, 0)
  ];
  const rightPath2 = [
    new BABYLON.Vector3(ridgeX * 0.001, ridgeY * 0.001, extentZ * 0.001),
    new BABYLON.Vector3(extentX * 0.001, eaveY * 0.001, extentZ * 0.001)
  ];

  const leftRoof = BABYLON.MeshBuilder.CreateRibbon(`att-${attId}-roof-left`, {
    pathArray: [leftPath1, leftPath2],
    sideOrientation: BABYLON.Mesh.DOUBLESIDE
  }, scene);
  leftRoof.material = coveringMat;
  leftRoof.parent = root;
  leftRoof.metadata = { dynamic: true, attachmentId: attId, type: 'roof', part: 'covering' };

  const rightRoof = BABYLON.MeshBuilder.CreateRibbon(`att-${attId}-roof-right`, {
    pathArray: [rightPath1, rightPath2],
    sideOrientation: BABYLON.Mesh.DOUBLESIDE
  }, scene);
  rightRoof.material = coveringMat;
  rightRoof.parent = root;
  rightRoof.metadata = { dynamic: true, attachmentId: attId, type: 'roof', part: 'covering' };
}

/**
 * Dispose all meshes for a specific attachment
 */
export function disposeAttachment(scene, attachmentId) {
  const meshes = scene.meshes.filter(m =>
    m.metadata?.attachmentId === attachmentId
  );
  meshes.forEach(m => m.dispose());

  // Also dispose the root node
  const rootName = `attachment-${attachmentId}-root`;
  const root = scene.getTransformNodeByName(rootName);
  if (root) root.dispose();
}

/**
 * Dispose all attachment meshes
 */
export function disposeAllAttachments(scene) {
  const meshes = scene.meshes.filter(m =>
    m.metadata?.attachmentId != null
  );
  meshes.forEach(m => m.dispose());

  // Dispose all attachment root nodes
  const roots = scene.transformNodes.filter(n =>
    n.name.startsWith('attachment-') && n.name.endsWith('-root')
  );
  roots.forEach(r => r.dispose());
}
