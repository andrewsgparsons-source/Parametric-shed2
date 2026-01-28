# Architecture Guide

This document explains how the Parametric Shed Configurator works under the hood.

## Overview

The configurator is a client-side JavaScript application that generates 3D geometry for timber-framed garden buildings. It uses [Babylon.js](https://www.babylonjs.com/) for rendering and a custom state management system to drive reactive updates.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │   UI Panel  │───▶│    State    │───▶│   3D Renderer       │  │
│  │  (controls) │    │   (store)   │    │   (Babylon.js)      │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│         │                  │                      │              │
│         │                  ▼                      │              │
│         │          ┌─────────────┐               │              │
│         │          │  URL Sync   │               │              │
│         │          │  (sharing)  │               │              │
│         │          └─────────────┘               │              │
│         │                                        │              │
│         ▼                                        ▼              │
│  ┌─────────────┐                      ┌─────────────────────┐  │
│  │   Profile   │                      │   BOM Generator     │  │
│  │   System    │                      │   (cutting list)    │  │
│  └─────────────┘                      └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### 1. State-Driven Rendering

Everything flows from state. When you change a dimension, add a window, or switch roof style:

1. UI control updates the state store
2. State change triggers a full rebuild
3. All 3D geometry is disposed and recreated
4. BOM is recalculated

This "destroy and rebuild" approach is simpler than incremental updates and guarantees consistency.

```javascript
// Example: changing building width
store.patch({ dimensions: { width_mm: 3000 } });
// → triggers rebuild() → new 3D model appears
```

### 2. Millimetre Precision

All internal calculations use millimetres. No magic scaling, no visual approximations. The model represents what would actually be built.

```javascript
// Timber sections are real sizes
const STUD_W_MM = 50;   // 50mm stud width
const STUD_H_MM = 75;   // 75mm stud depth
const STUD_SPACING_MM = 400;  // 400mm centres (standard)
```

Babylon.js uses metres, so we convert at the rendering boundary:

```javascript
mesh.position.x = position_mm / 1000;
```

### 3. Coordinate System

```
        Y (up)
        │
        │
        │
        └───────── X (width)
       /
      /
     Z (depth)
```

- **X** = Width (left to right when facing front)
- **Y** = Height (ground to roof)
- **Z** = Depth (front to back)

The building sits with its front-left corner at the origin (0, 0, 0).

### 4. Construction Order

Elements are built in a specific order to handle dependencies:

1. **Base** — Ground-level grid supports
2. **Floor** — Joists, rim joists, OSB decking
3. **Walls** — Framing, then cladding, then insulation/lining
4. **Openings** — Doors and windows cut into walls
5. **Dividers** — Internal partition walls
6. **Roof** — Trusses/rafters, purlins, OSB, covering
7. **Attachments** — Secondary buildings (each follows same order)

## File Structure

### Entry Point

**`index.js`** — The main orchestrator. Handles:
- Babylon.js scene setup
- State initialisation and subscription
- Rebuild coordination
- UI panel generation
- Profile loading

### State Management

**`state.js`** — Simple reactive store:
- `get()` — Current state object
- `set(state)` — Replace entire state
- `patch(partial)` — Merge partial updates
- `subscribe(callback)` — React to changes

**`params.js`** — Defaults and configuration:
- Default dimensions, materials, roof settings
- Timber section sizes
- Constraint validation helpers

### 3D Elements (`elements/`)

Each file handles one aspect of the building:

| File | Responsibility |
|------|----------------|
| `base.js` | Ground supports (concrete blocks in grid pattern) |
| `walls.js` | Wall framing, studs, plates, cladding, insulation |
| `roof.js` | Apex and pent roofs — trusses, purlins, OSB, covering |
| `doors.js` | Door openings, frames, door panels |
| `windows.js` | Window openings and glazing |
| `dividers.js` | Internal partition walls |
| `attachments.js` | Secondary buildings attached to main structure |

Each element module typically exports:
- `build3D(state, ctx)` — Create Babylon.js meshes
- `dispose(scene)` — Clean up meshes
- `getBOM(state)` — Return materials list

### Profiles

**`profiles.js`** — Defines which UI controls are visible for each profile:
- `admin` — Full access to everything
- `customer` — Simplified controls for end users
- `viewer` — Read-only, for sharing designs

**`profile-editor.js`** — UI for creating/editing profiles

### Bill of Materials

**`bom/index.js`** — Aggregates cutting lists from all elements:
- Collects timber lengths
- Groups by section size
- Calculates sheet materials
- Formats for display

## Key Patterns

### Mesh Metadata

Every mesh carries metadata for identification and cleanup:

```javascript
mesh.metadata = {
  dynamic: true,           // Will be disposed on rebuild
  wall: "front",           // Which wall this belongs to
  part: "stud",            // What type of element
  index: 3                 // Which instance
};
```

This allows selective disposal and debugging.

### CSG Boolean Operations

Doors and windows use CSG (Constructive Solid Geometry) to cut accurate holes:

```javascript
// Simplified example
const wall = createWallMesh();
const opening = createOpeningCutter();
const wallWithHole = BABYLON.CSG.FromMesh(wall)
  .subtract(BABYLON.CSG.FromMesh(opening))
  .toMesh("wall-with-opening", material, scene);
```

### Transform Nodes

Complex assemblies use transform nodes as parents:

```javascript
const roofRoot = new BABYLON.TransformNode("roof-root", scene);
roofRoot.position.y = wallHeight / 1000;

// All roof parts parent to roofRoot
rafter.parent = roofRoot;
purlin.parent = roofRoot;
```

This makes positioning and rotation easier.

### Box Helpers

Most geometry is created with helper functions:

```javascript
// Create a box with bottom at specified Y
function mkBoxBottomLocal(name, w, h, d, x, yBottom, z, parent, material, metadata) {
  const mesh = BABYLON.MeshBuilder.CreateBox(name, {
    width: w / 1000,
    height: h / 1000,
    depth: d / 1000
  }, scene);
  mesh.position = new BABYLON.Vector3(
    (x + w/2) / 1000,
    yBottom / 1000 + h / 2000,
    (z + d/2) / 1000
  );
  mesh.parent = parent;
  mesh.material = material;
  mesh.metadata = metadata;
  return mesh;
}
```

## Roof Geometry

### Pent (Lean-to)

Single slope from high edge to low edge:

```
    ╱───────────── High edge (at main building)
   ╱
  ╱
 ╱
╱─────────────── Low edge (outer wall)
```

### Apex (Gabled)

Two slopes meeting at a ridge:

```
        /\
       /  \
      /    \
     /      \
    /────────\
   Ridge at peak, eaves at walls
```

For apex roofs:
- **Trusses** — Triangular frames at regular intervals
- **Purlins** — Horizontal members running along the roof
- **OSB** — Sheet material on purlins
- **Covering** — Felt or other waterproof layer

## Attachments

Attachments are secondary buildings that connect to the main structure:

```
┌─────────────────┐
│                 │
│  Main Building  │───┬─────┐
│                 │   │ Att │  ← Attachment on right wall
│                 │───┴─────┘
└─────────────────┘
```

Each attachment:
- Has its own dimensions (width along wall, depth outward)
- Shares one wall with the main building
- Can have pent or apex roof
- Respects main building's fascia height (attachment roof must be lower)

## URL State Encoding

Designs can be shared via URL:

```
?profile=viewer&c=eyJkaW1lbnNpb25zIjp7...
```

- `profile` — Which UI profile to use
- `c` — Base64-encoded JSON state

The state is compressed and encoded on every change, making the URL a live snapshot.

## Performance Considerations

- **Full rebuild on change** — Simple but not optimal for large buildings
- **Mesh disposal** — Critical to prevent memory leaks
- **CSG operations** — Expensive; used sparingly
- **No LOD** — All detail rendered regardless of zoom

For typical garden buildings (< 8m × 8m), performance is acceptable on modern devices.

## Debugging Tips

### Console Inspection

Most build functions log their inputs:

```javascript
console.log("[walls] Building wall:", wallId, "height:", height_mm);
```

Filter by `[element]` prefix to focus on specific systems.

### Mesh Explorer

Babylon.js Inspector can be enabled:

```javascript
scene.debugLayer.show();
```

This lets you inspect individual meshes, their positions, and metadata.

### State Dump

```javascript
console.log(JSON.stringify(store.get(), null, 2));
```

Prints the complete current state for debugging.

---

*This document covers the core architecture. For specific implementation details, see the JSDoc comments in each source file.*
