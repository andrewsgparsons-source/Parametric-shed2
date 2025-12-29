// src/index.js

import { createStateStore } from './state.js';
import { DEFAULTS, resolveDims } from './params.js';
import { boot, disposeAll } from './renderer/babylon.js';
import * as Base from './elements/base.js';
import * as Walls from './elements/walls.js';
import { renderBOM } from './bom/index.js';

// Bootstrap
const canvas = document.getElementById('renderCanvas');
const ctx = boot(canvas);
const store = createStateStore(DEFAULTS);

// UI elements
const viewSelect = document.getElementById('viewSelect');

const vWallsEl = document.getElementById('vWalls');
const vBaseEl = document.getElementById('vBase');
const vFrameEl = document.getElementById('vFrame');
const vInsEl = document.getElementById('vIns');
const vDeckEl = document.getElementById('vDeck');

// Per-wall toggles
const vWallFrontEl = document.getElementById('vWallFront');
const vWallBackEl  = document.getElementById('vWallBack');
const vWallLeftEl  = document.getElementById('vWallLeft');
const vWallRightEl = document.getElementById('vWallRight');

const dimModeEl = document.getElementById('dimMode');
const wInputEl = document.getElementById('wInput');
const dInputEl = document.getElementById('dInput');

const overUniformEl = document.getElementById('roofOverUniform');
const overFrontEl = document.getElementById('roofOverFront');
const overBackEl = document.getElementById('roofOverBack');
const overLeftEl = document.getElementById('roofOverLeft');
const overRightEl = document.getElementById('roofOverRight');

const wallsVariantEl = document.getElementById('wallsVariant');
const wallHeightEl = document.getElementById('wallHeight');

const doorEnabledEl = document.getElementById('doorEnabled');
const doorXEl = document.getElementById('doorX');
const doorWEl = document.getElementById('doorW');
const doorHEl = document.getElementById('doorH');

const stageEl = document.getElementById('stage');
const bomWrapEl = document.getElementById('bomWrap');
const bomPageEl = document.getElementById('bomPage');

// Render function
function render(state) {
  // Resolve dimensions for both engines
  const R = resolveDims(state);
  const baseState = { ...state, w: R.base.w_mm,  d: R.base.d_mm };
  const wallState = { ...state, w: R.frame.w_mm, d: R.frame.d_mm };

  // View toggling (3 states)
  const v = viewSelect.value;
  const is3D = v === '3d';
  const isWalls = v === 'walls-bom';
  const isBase = v === 'base-bom';

  stageEl.style.display = is3D ? '' : '';
  canvas.style.display = is3D ? 'block' : 'none';
  bomWrapEl.style.display = isWalls ? '' : 'none';
  bomPageEl.style.display = isBase ? 'block' : 'none';

  // Hide visibility rows when not 3D (base + walls)
  document.querySelectorAll('.visRow').forEach(row => { row.style.display = is3D ? '' : 'none'; });
  document.querySelectorAll('.vis-row').forEach(row => { row.style.display = is3D ? '' : 'none'; });

  // Dispose dynamic meshes from previous frame
  disposeAll(ctx.scene);

  // Base 3D
  Base.build3D(baseState, ctx);

  // Determine if any wall is visible
  const parts = state.vis?.walls || { front:true, back:true, left:true, right:true };
  const anyWallOn = !!state.vis?.wallsEnabled && (parts.front || parts.back || parts.left || parts.right);

  // Walls 3D
  if (anyWallOn) {
    Walls.build3D(wallState, ctx);
  }

  // Walls BOM
  const bom = Walls.updateBOM(wallState);
  renderBOM(bom.sections);

  // Base BOM (writes directly to DOM IDs in #bomPage)
  Base.updateBOM(baseState);
}

// Store subscription
store.onChange(render);

// Helpers
const asPosInt = (v, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : def;
};
const asNonNegInt = (v, def = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const asNullableInt = (v) => {
  if (v == null || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Resolve current front wall length (frame outer width)
function currentFrontWallLength() {
  const R = resolveDims(store.getState());
  return Math.max(1, Math.floor(R.frame.w_mm));
}

// Clamp a door X within [0, wallLen - doorW]
function clampDoorX(x, doorW) {
  const L = currentFrontWallLength();
  const maxX = Math.max(0, L - doorW);
  return Math.max(0, Math.min(maxX, x));
}

// Sync inputs from state on mode switch
function syncUiFromState(state) {
  dimModeEl.value = state.dimMode;
  if (state.dimMode === 'base') {
    wInputEl.value = String(state.dimInputs.baseW_mm);
    dInputEl.value = String(state.dimInputs.baseD_mm);
  } else if (state.dimMode === 'frame') {
    wInputEl.value = String(state.dimInputs.frameW_mm);
    dInputEl.value = String(state.dimInputs.frameD_mm);
  } else {
    wInputEl.value = String(state.dimInputs.roofW_mm);
    dInputEl.value = String(state.dimInputs.roofD_mm);
  }

  overUniformEl.value = String(state.overhang.uniform_mm ?? 0);
  overLeftEl.value = state.overhang.left_mm == null ? '' : String(state.overhang.left_mm);
  overRightEl.value = state.overhang.right_mm == null ? '' : String(state.overhang.right_mm);
  overFrontEl.value = state.overhang.front_mm == null ? '' : String(state.overhang.front_mm);
  overBackEl.value = state.overhang.back_mm == null ? '' : String(state.overhang.back_mm);

  vBaseEl.checked = !!state.vis.base;
  vFrameEl.checked = !!state.vis.frame;
  vInsEl.checked = !!state.vis.ins;
  vDeckEl.checked = !!state.vis.deck;

  vWallsEl.checked = !!state.vis.wallsEnabled;

  const parts = state.vis?.walls || { front:true, back:true, left:true, right:true };
  vWallFrontEl.checked = !!parts.front;
  vWallBackEl.checked  = !!parts.back;
  vWallLeftEl.checked  = !!parts.left;
  vWallRightEl.checked = !!parts.right;

  wallsVariantEl.value = state.walls.variant;
  wallHeightEl.value = String(state.walls.height_mm);

  const door = state.walls.openings[0];
  doorEnabledEl.checked = !!door.enabled;
  doorXEl.value = String(door.x_mm);
  doorWEl.value = String(door.width_mm);
  doorHEl.value = String(door.height_mm);
}

// Event wiring

viewSelect.addEventListener('change', () => {
  render(store.getState());
});

// Walls master visibility toggles all parts
vWallsEl.addEventListener('change', (e) => {
  const on = !!e.target.checked;
  store.setState({
    vis: {
      wallsEnabled: on,
      walls: { front: on, back: on, left: on, right: on }
    }
  });
});

// Base visibility toggles map exactly: base/frame/ins/deck
vBaseEl.addEventListener('change', (e) => {
  store.setState({ vis: { base: e.target.checked } });
});
vFrameEl.addEventListener('change', (e) => {
  store.setState({ vis: { frame: e.target.checked } });
});
vInsEl.addEventListener('change', (e) => {
  store.setState({ vis: { ins: e.target.checked } });
});
vDeckEl.addEventListener('change', (e) => {
  store.setState({ vis: { deck: e.target.checked } });
});

// New per-wall visibility listeners (do not clobber siblings)
vWallFrontEl.addEventListener('change', (e) => {
  store.setState({ vis: { walls: { front: !!e.target.checked } } });
});
vWallBackEl.addEventListener('change', (e) => {
  store.setState({ vis: { walls: { back: !!e.target.checked } } });
});
vWallLeftEl.addEventListener('change', (e) => {
  store.setState({ vis: { walls: { left: !!e.target.checked } } });
});
vWallRightEl.addEventListener('change', (e) => {
  store.setState({ vis: { walls: { right: !!e.target.checked } } });
});

// Dimension Mode
dimModeEl.addEventListener('change', () => {
  store.setState({ dimMode: dimModeEl.value });
  syncUiFromState(store.getState());
});

// Active W/D write into active mode slots
function writeActiveDims() {
  const s = store.getState();
  const w = asPosInt(wInputEl.value, (s.dimInputs.baseW_mm));
  const d = asPosInt(dInputEl.value, (s.dimInputs.baseD_mm));
  if (s.dimMode === 'base') {
    store.setState({ dimInputs: { baseW_mm: w, baseD_mm: d } });
  } else if (s.dimMode === 'frame') {
    store.setState({ dimInputs: { frameW_mm: w, frameD_mm: d } });
  } else {
    store.setState({ dimInputs: { roofW_mm: w, roofD_mm: d } });
  }
}
wInputEl.addEventListener('input', writeActiveDims);
dInputEl.addEventListener('input', writeActiveDims);

// Overhangs
overUniformEl.addEventListener('input', () => {
  const n = Math.max(0, Math.floor(Number(overUniformEl.value || 0)));
  store.setState({ overhang: { uniform_mm: Number.isFinite(n) ? n : 0 } });
});
overLeftEl.addEventListener('input', () => store.setState({ overhang: { left_mm: asNullableInt(overLeftEl.value) } }));
overRightEl.addEventListener('input', () => store.setState({ overhang: { right_mm: asNullableInt(overRightEl.value) } }));
overFrontEl.addEventListener('input', () => store.setState({ overhang: { front_mm: asNullableInt(overFrontEl.value) } }));
overBackEl.addEventListener('input', () => store.setState({ overhang: { back_mm: asNullableInt(overBackEl.value) } }));

// Walls variant/height
wallsVariantEl.addEventListener('change', () => {
  store.setState({ walls: { variant: wallsVariantEl.value } });
});
wallHeightEl.addEventListener('input', () => {
  store.setState({ walls: { height_mm: asPosInt(wallHeightEl.value, 2400) } });
});

// --- Door controls & center snap ---

// Enable/disable: on enable, snap to wall center by default (one-time)
doorEnabledEl.addEventListener('change', () => {
  const s = store.getState();
  const enabled = !!doorEnabledEl.checked;
  const cur = s.walls.openings[0];
  if (enabled) {
    const L = currentFrontWallLength();
    const doorW = asPosInt(cur.width_mm, 900);
    const centered = Math.floor((L - doorW) / 2);
    const clamped = clampDoorX(centered, doorW);
    const o = { ...cur, enabled: true, x_mm: clamped };
    store.setState({ walls: { openings: [o] } });
  } else {
    const o = { ...cur, enabled: false };
    store.setState({ walls: { openings: [o] } });
  }
});

doorXEl.addEventListener('input', () => {
  const s = store.getState();
  const cur = s.walls.openings[0];
  const doorW = asPosInt(cur.width_mm, 900);
  const x = asNonNegInt(doorXEl.value, cur.x_mm);
  const clamped = clampDoorX(x, doorW);
  const o = { ...cur, x_mm: clamped };
  store.setState({ walls: { openings: [o] } });
});

doorWEl.addEventListener('input', () => {
  const s = store.getState();
  const cur = s.walls.openings[0];
  const w = asPosInt(doorWEl.value, cur.width_mm);
  const clampedX = clampDoorX(cur.x_mm ?? 0, w);
  const o = { ...cur, width_mm: w, x_mm: clampedX };
  store.setState({ walls: { openings: [o] } });
});

doorHEl.addEventListener('input', () => {
  const s = store.getState();
  const cur = s.walls.openings[0];
  const h = asPosInt(doorHEl.value, cur.height_mm);
  // Re-clamp X when height changes per spec (idempotent)
  const clampedX = clampDoorX(cur.x_mm ?? 0, asPosInt(cur.width_mm, 900));
  const o = { ...cur, height_mm: h, x_mm: clampedX };
  store.setState({ walls: { openings: [o] } });
});

// Initial seed + first render
if (!wInputEl.value) wInputEl.value = String(store.getState().dimInputs.baseW_mm);
if (!dInputEl.value) dInputEl.value = String(store.getState().dimInputs.baseD_mm);
syncUiFromState(store.getState());
render(store.getState());
