// FILE: docs/src/index.js
// NO-DRIFT: Orchestration only. Extends door UI to support multiple doors without changing base/BOM algorithms.

window.__dbg = window.__dbg || {};
window.__dbg.initStarted = true;
window.__dbg.initFinished = false;

// Avoid newer syntax that can break on some Android WebViews (no ??=).
function dbgInitDefaults() {
  if (window.__dbg.engine === undefined) window.__dbg.engine = null;
  if (window.__dbg.scene === undefined) window.__dbg.scene = null;
  if (window.__dbg.camera === undefined) window.__dbg.camera = null;
  if (window.__dbg.frames === undefined) window.__dbg.frames = 0;
  if (window.__dbg.buildCalls === undefined) window.__dbg.buildCalls = 0;
  if (window.__dbg.lastError === undefined) window.__dbg.lastError = null;
}
dbgInitDefaults();

window.addEventListener("error", (e) => {
  window.__dbg.lastError = (e && e.message) ? e.message : String(e);
});
window.addEventListener("unhandledrejection", (e) => {
  window.__dbg.lastError = (e && e.reason) ? String(e.reason) : "unhandledrejection";
});

import { createStateStore } from "./state.js";
import { DEFAULTS, resolveDims } from "./params.js";
import { boot, disposeAll } from "./renderer/babylon.js";
import * as Base from "./elements/base.js";
import * as Walls from "./elements/walls.js";
import { renderBOM } from "./bom/index.js";

(function init() {
  try {
    const canvas = document.getElementById("renderCanvas");
    const statusOverlayEl = document.getElementById("statusOverlay");

    if (!canvas) {
      window.__dbg.lastError = "renderCanvas not found";
      return;
    }

    // Boot renderer
    let ctx = null;
    try {
      ctx = boot(canvas);
    } catch (e) {
      window.__dbg.lastError = "boot(canvas) failed: " + String(e && e.message ? e.message : e);
      return;
    }

    window.__dbg.engine = (ctx && ctx.engine) ? ctx.engine : null;
    window.__dbg.scene = (ctx && ctx.scene) ? ctx.scene : null;
    window.__dbg.camera = (ctx && ctx.camera) ? ctx.camera : null;

    // Frames counter
    try {
      const eng = window.__dbg.engine;
      if (eng && eng.onEndFrameObservable && typeof eng.onEndFrameObservable.add === "function") {
        eng.onEndFrameObservable.add(() => { window.__dbg.frames += 1; });
      }
    } catch (e) {}

    const store = createStateStore(DEFAULTS);

    const vWallsEl = document.getElementById("vWalls");
    const vBaseEl = document.getElementById("vBase");
    const vFrameEl = document.getElementById("vFrame");
    const vInsEl = document.getElementById("vIns");
    const vDeckEl = document.getElementById("vDeck");

    const vWallFrontEl = document.getElementById("vWallFront");
    const vWallBackEl = document.getElementById("vWallBack");
    const vWallLeftEl = document.getElementById("vWallLeft");
    const vWallRightEl = document.getElementById("vWallRight");

    const dimModeEl = document.getElementById("dimMode");
    const wInputEl = document.getElementById("wInput");
    const dInputEl = document.getElementById("dInput");

    const overUniformEl = document.getElementById("roofOverUniform");
    const overFrontEl = document.getElementById("roofOverFront");
    const overBackEl = document.getElementById("roofOverBack");
    const overLeftEl = document.getElementById("roofOverLeft");
    const overRightEl = document.getElementById("roofOverRight");

    const wallsVariantEl = document.getElementById("wallsVariant");
    const wallHeightEl = document.getElementById("wallHeight");

    // Existing door control IDs (still used)
    const doorEnabledEl = document.getElementById("doorEnabled");
    const doorXEl = document.getElementById("doorX");
    const doorWEl = document.getElementById("doorW");
    const doorHEl = document.getElementById("doorH");

    // New multi-door UI
    const doorListEl = document.getElementById("doorList");
    const doorAddBtn = document.getElementById("doorAddBtn");
    const doorRemoveBtn = document.getElementById("doorRemoveBtn");
    const doorWallEl = document.getElementById("doorWall");

    let selectedDoorId = null;

    const asPosInt = (v, def) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? n : def;
    };
    const asNonNegInt = (v, def = 0) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    const asNullableInt = (v) => {
      if (v == null || v === "") return null;
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };

    function getWallsEnabled(state) {
      const vis = state && state.vis ? state.vis : null;
      if (vis && typeof vis.walls === "boolean") return vis.walls;
      if (vis && typeof vis.wallsEnabled === "boolean") return vis.wallsEnabled;
      return true;
    }

    function getWallParts(state) {
      const vis = state && state.vis ? state.vis : null;

      if (vis && vis.walls && typeof vis.walls === "object") {
        return {
          front: vis.walls.front !== false,
          back: vis.walls.back !== false,
          left: vis.walls.left !== false,
          right: vis.walls.right !== false,
        };
      }

      if (vis && vis.wallsParts && typeof vis.wallsParts === "object") {
        return {
          front: vis.wallsParts.front !== false,
          back: vis.wallsParts.back !== false,
          left: vis.wallsParts.left !== false,
          right: vis.wallsParts.right !== false,
        };
      }

      return { front: true, back: true, left: true, right: true };
    }

    function resume3D() {
      const engine = window.__dbg.engine;
      const camera = window.__dbg.camera;

      canvas.style.display = "block";

      const bomPage = document.getElementById("bomPage");
      const wallsPage = document.getElementById("wallsBomPage");
      if (bomPage) bomPage.style.display = "none";
      if (wallsPage) wallsPage.style.display = "none";

      try { if (engine && typeof engine.resize === "function") engine.resize(); } catch (e) {}
      try { if (camera && typeof camera.attachControl === "function") camera.attachControl(canvas, true); } catch (e) {}
    }

    function safeDispose() {
      try {
        try { disposeAll(ctx); return; } catch (e) {}
        try { disposeAll(ctx && ctx.scene ? ctx.scene : null); return; } catch (e) {}
        try { disposeAll(); } catch (e) {}
      } catch (e) {}
    }

    function render(state) {
      try {
        window.__dbg.buildCalls += 1;

        const R = resolveDims(state);
        const baseState = { ...state, w: R.base.w_mm, d: R.base.d_mm };
        const wallState = { ...state, w: R.frame.w_mm, d: R.frame.d_mm };

        safeDispose();

        if (Base && typeof Base.build3D === "function") Base.build3D(baseState, ctx);

        if (getWallsEnabled(state)) {
          if (Walls && typeof Walls.build3D === "function") Walls.build3D(wallState, ctx);
        }

        if (Walls && typeof Walls.updateBOM === "function") {
          const wallsBom = Walls.updateBOM(wallState);
          if (wallsBom && wallsBom.sections) renderBOM(wallsBom.sections);
        }

        if (Base && typeof Base.updateBOM === "function") Base.updateBOM(baseState);
      } catch (e) {
        window.__dbg.lastError = "render() failed: " + String(e && e.message ? e.message : e);
      }
    }

    // ---- Multi-door helpers (no drift elsewhere) ----
    function getDoors(state) {
      const arr = state && state.walls && Array.isArray(state.walls.openings) ? state.walls.openings : [];
      return arr;
    }

    function findDoor(state, id) {
      const doors = getDoors(state);
      for (const d of doors) if (d && d.id === id) return d;
      return null;
    }

    function ensureSelectedDoor(state) {
      const doors = getDoors(state);
      if (doors.length === 0) return null;
      if (selectedDoorId && findDoor(state, selectedDoorId)) return selectedDoorId;
      selectedDoorId = doors[0].id;
      return selectedDoorId;
    }

    function setDoors(nextDoors) {
      store.setState({ walls: { openings: nextDoors } });
    }

    function upsertDoor(nextDoor) {
      const s = store.getState();
      const doors = getDoors(s);
      const out = [];
      let found = false;
      for (const d of doors) {
        if (d && d.id === nextDoor.id) {
          out.push(nextDoor);
          found = true;
        } else {
          out.push(d);
        }
      }
      if (!found) out.push(nextDoor);
      setDoors(out);
    }

    function removeDoorById(id) {
      const s = store.getState();
      const doors = getDoors(s);
      const out = doors.filter(d => d && d.id !== id);
      setDoors(out);
      selectedDoorId = out.length ? out[0].id : null;
    }

    function patchSelectedDoor(patch) {
      const s = store.getState();
      const id = ensureSelectedDoor(s);
      if (!id) return;
      const cur = findDoor(s, id);
      if (!cur) return;
      upsertDoor({ ...cur, ...patch });
    }

    function currentWallLength(state, wallName) {
      const R = resolveDims(state);
      const fw = Math.max(1, Math.floor(R.frame.w_mm));
      const fd = Math.max(1, Math.floor(R.frame.d_mm));
      if (wallName === "left" || wallName === "right") return fd;
      return fw;
    }

    function clampDoorX(x, doorW, wallLen) {
      const maxX = Math.max(0, wallLen - doorW);
      return Math.max(0, Math.min(maxX, x));
    }

    function rebuildDoorList(state) {
      if (!doorListEl) return;
      const doors = getDoors(state);
      const curId = ensureSelectedDoor(state);

      if (doors.length === 0) {
        doorListEl.innerHTML = `<option value="" selected>(no doors)</option>`;
        doorListEl.disabled = true;
        if (doorRemoveBtn) doorRemoveBtn.disabled = true;
        return;
      }

      doorListEl.disabled = false;
      if (doorRemoveBtn) doorRemoveBtn.disabled = false;

      doorListEl.innerHTML = doors.map(d => {
        const wall = (d && d.wall) ? d.wall : "front";
        const label = `${d.id} (${wall})`;
        const sel = d.id === curId ? " selected" : "";
        return `<option value="${escapeAttr(d.id)}"${sel}>${escapeHtml(label)}</option>`;
      }).join("");
    }

    function syncDoorUi(state) {
      const id = ensureSelectedDoor(state);
      const d = id ? findDoor(state, id) : null;

      if (doorWallEl) doorWallEl.value = d && d.wall ? d.wall : "front";
      if (doorEnabledEl) doorEnabledEl.checked = !!(d && d.enabled);

      if (doorXEl) doorXEl.value = String((d && d.x_mm != null) ? d.x_mm : 0);
      if (doorWEl) doorWEl.value = String((d && d.width_mm != null) ? d.width_mm : 900);
      if (doorHEl) doorHEl.value = String((d && d.height_mm != null) ? d.height_mm : 2000);
    }

    // ---- UI sync ----
    function syncUiFromState(state) {
      try {
        if (dimModeEl) dimModeEl.value = (state && state.dimMode) ? state.dimMode : "base";

        if (wInputEl && dInputEl && state && state.dimInputs && state.dimMode) {
          if (state.dimMode === "base") {
            wInputEl.value = String(state.dimInputs.baseW_mm);
            dInputEl.value = String(state.dimInputs.baseD_mm);
          } else if (state.dimMode === "frame") {
            wInputEl.value = String(state.dimInputs.frameW_mm);
            dInputEl.value = String(state.dimInputs.frameD_mm);
          } else {
            wInputEl.value = String(state.dimInputs.roofW_mm);
            dInputEl.value = String(state.dimInputs.roofD_mm);
          }
        } else {
          if (wInputEl && state && state.w != null) wInputEl.value = String(state.w);
          if (dInputEl && state && state.d != null) dInputEl.value = String(state.d);
        }

        if (state && state.overhang) {
          if (overUniformEl) overUniformEl.value = String(state.overhang.uniform_mm ?? 0);
          if (overLeftEl) overLeftEl.value = state.overhang.left_mm == null ? "" : String(state.overhang.left_mm);
          if (overRightEl) overRightEl.value = state.overhang.right_mm == null ? "" : String(state.overhang.right_mm);
          if (overFrontEl) overFrontEl.value = state.overhang.front_mm == null ? "" : String(state.overhang.front_mm);
          if (overBackEl) overBackEl.value = state.overhang.back_mm == null ? "" : String(state.overhang.back_mm);
        }

        if (vBaseEl) vBaseEl.checked = !!(state && state.vis && state.vis.base);
        if (vFrameEl) vFrameEl.checked = !!(state && state.vis && state.vis.frame);
        if (vInsEl) vInsEl.checked = !!(state && state.vis && state.vis.ins);
        if (vDeckEl) vDeckEl.checked = !!(state && state.vis && state.vis.deck);

        if (vWallsEl) vWallsEl.checked = getWallsEnabled(state);

        const parts = getWallParts(state);
        if (vWallFrontEl) vWallFrontEl.checked = !!parts.front;
        if (vWallBackEl) vWallBackEl.checked = !!parts.back;
        if (vWallLeftEl) vWallLeftEl.checked = !!parts.left;
        if (vWallRightEl) vWallRightEl.checked = !!parts.right;

        if (wallsVariantEl && state && state.walls && state.walls.variant) wallsVariantEl.value = state.walls.variant;
        if (wallHeightEl && state && state.walls && state.walls.height_mm != null) wallHeightEl.value = String(state.walls.height_mm);

        rebuildDoorList(state);
        syncDoorUi(state);
      } catch (e) {
        window.__dbg.lastError = "syncUiFromState failed: " + String(e && e.message ? e.message : e);
      }
    }

    function updateOverlay() {
      if (!statusOverlayEl) return;

      const hasBabylon = typeof window.BABYLON !== "undefined";
      const cw = canvas ? (canvas.clientWidth || 0) : 0;
      const ch = canvas ? (canvas.clientHeight || 0) : 0;

      const engine = window.__dbg.engine;
      const scene = window.__dbg.scene;
      const camera = window.__dbg.camera;

      const meshes = (scene && scene.meshes) ? scene.meshes.length : 0;
      const err = (window.__dbg.lastError || "").slice(0, 200);

      statusOverlayEl.textContent =
        "BABYLON loaded: " + hasBabylon + "\n" +
        "Canvas: " + cw + " x " + ch + "\n" +
        "Engine: " + (!!engine) + "\n" +
        "Scene: " + (!!scene) + "\n" +
        "Camera: " + (!!camera) + "\n" +
        "Frames: " + window.__dbg.frames + "\n" +
        "BuildCalls: " + window.__dbg.buildCalls + "\n" +
        "Meshes: " + meshes + "\n" +
        "LastError: " + err;
    }

    // ---- Existing listeners (unchanged) ----
    if (vWallsEl) {
      vWallsEl.addEventListener("change", (e) => {
        const s = store.getState();
        const on = !!e.target.checked;

        if (s && s.vis && typeof s.vis.walls === "boolean") store.setState({ vis: { walls: on } });
        else if (s && s.vis && typeof s.vis.wallsEnabled === "boolean") store.setState({ vis: { wallsEnabled: on } });
        else store.setState({ vis: { walls: on } });
      });
    }

    if (vBaseEl) vBaseEl.addEventListener("change", (e) => store.setState({ vis: { base: !!e.target.checked } }));
    if (vFrameEl) vFrameEl.addEventListener("change", (e) => store.setState({ vis: { frame: !!e.target.checked } }));
    if (vInsEl) vInsEl.addEventListener("change", (e) => store.setState({ vis: { ins: !!e.target.checked } }));
    if (vDeckEl) vDeckEl.addEventListener("change", (e) => store.setState({ vis: { deck: !!e.target.checked } }));

    function patchWallPart(key, value) {
      const s = store.getState();
      if (s && s.vis && s.vis.walls && typeof s.vis.walls === "object") {
        store.setState({ vis: { walls: { [key]: value } } });
        return;
      }
      if (s && s.vis && s.vis.wallsParts && typeof s.vis.wallsParts === "object") {
        store.setState({ vis: { wallsParts: { [key]: value } } });
        return;
      }
      store.setState({ _noop: Date.now() });
    }

    if (vWallFrontEl) vWallFrontEl.addEventListener("change", (e) => patchWallPart("front", !!e.target.checked));
    if (vWallBackEl) vWallBackEl.addEventListener("change", (e) => patchWallPart("back", !!e.target.checked));
    if (vWallLeftEl) vWallLeftEl.addEventListener("change", (e) => patchWallPart("left", !!e.target.checked));
    if (vWallRightEl) vWallRightEl.addEventListener("change", (e) => patchWallPart("right", !!e.target.checked));

    if (dimModeEl) {
      dimModeEl.addEventListener("change", () => {
        store.setState({ dimMode: dimModeEl.value });
        syncUiFromState(store.getState());
      });
    }

    function writeActiveDims() {
      const s = store.getState();
      const w = asPosInt(wInputEl ? wInputEl.value : null, 1000);
      const d = asPosInt(dInputEl ? dInputEl.value : null, 1000);

      if (s && s.dimInputs && s.dimMode) {
        if (s.dimMode === "base") store.setState({ dimInputs: { baseW_mm: w, baseD_mm: d } });
        else if (s.dimMode === "frame") store.setState({ dimInputs: { frameW_mm: w, frameD_mm: d } });
        else store.setState({ dimInputs: { roofW_mm: w, roofD_mm: d } });
      } else {
        store.setState({ w, d });
      }
    }
    if (wInputEl) wInputEl.addEventListener("input", writeActiveDims);
    if (dInputEl) dInputEl.addEventListener("input", writeActiveDims);

    if (overUniformEl) {
      overUniformEl.addEventListener("input", () => {
        const n = Math.max(0, Math.floor(Number(overUniformEl.value || 0)));
        store.setState({ overhang: { uniform_mm: Number.isFinite(n) ? n : 0 } });
      });
    }
    if (overLeftEl) overLeftEl.addEventListener("input", () => store.setState({ overhang: { left_mm: asNullableInt(overLeftEl.value) } }));
    if (overRightEl) overRightEl.addEventListener("input", () => store.setState({ overhang: { right_mm: asNullableInt(overRightEl.value) } }));
    if (overFrontEl) overFrontEl.addEventListener("input", () => store.setState({ overhang: { front_mm: asNullableInt(overFrontEl.value) } }));
    if (overBackEl) overBackEl.addEventListener("input", () => store.setState({ overhang: { back_mm: asNullableInt(overBackEl.value) } }));

    if (wallsVariantEl) wallsVariantEl.addEventListener("change", () => store.setState({ walls: { variant: wallsVariantEl.value } }));
    if (wallHeightEl) wallHeightEl.addEventListener("input", () => store.setState({ walls: { height_mm: asPosInt(wallHeightEl.value, 2400) } }));

    // ---- Multi-door UI events ----
    if (doorListEl) {
      doorListEl.addEventListener("change", () => {
        selectedDoorId = doorListEl.value || null;
        syncUiFromState(store.getState());
      });
    }

    if (doorAddBtn) {
      doorAddBtn.addEventListener("click", () => {
        const s = store.getState();
        const doors = getDoors(s);
        const used = new Set(doors.map(d => d && d.id).filter(Boolean));
        let i = 1;
        while (used.has("door" + i)) i++;
        const id = "door" + i;

        const wall = "front";
        const wallLen = currentWallLength(s, wall);
        const width_mm = 900;
        const x_mm = clampDoorX(Math.floor((wallLen - width_mm) / 2), width_mm, wallLen);

        upsertDoor({
          id,
          wall,
          type: "door",
          enabled: true,
          x_mm,
          width_mm,
          height_mm: 2000
        });
        selectedDoorId = id;
      });
    }

    if (doorRemoveBtn) {
      doorRemoveBtn.addEventListener("click", () => {
        const s = store.getState();
        const id = ensureSelectedDoor(s);
        if (!id) return;
        removeDoorById(id);
      });
    }

    if (doorWallEl) {
      doorWallEl.addEventListener("change", () => {
        const s = store.getState();
        const id = ensureSelectedDoor(s);
        if (!id) return;
        const cur = findDoor(s, id);
        if (!cur) return;

        const wall = doorWallEl.value || "front";
        const wallLen = currentWallLength(s, wall);
        const w = asPosInt(cur.width_mm, 900);
        const centered = Math.floor((wallLen - w) / 2);
        upsertDoor({ ...cur, wall, x_mm: clampDoorX(centered, w, wallLen) });
      });
    }

    if (doorEnabledEl) {
      doorEnabledEl.addEventListener("change", () => {
        const s = store.getState();
        const id = ensureSelectedDoor(s);
        if (!id) return;
        const cur = findDoor(s, id);
        if (!cur) return;

        const enabled = !!doorEnabledEl.checked;
        if (!enabled) {
          upsertDoor({ ...cur, enabled: false });
          return;
        }

        const wall = cur.wall || "front";
        const wallLen = currentWallLength(s, wall);
        const doorW = asPosInt(cur.width_mm, 900);
        const centered = Math.floor((wallLen - doorW) / 2);
        upsertDoor({ ...cur, enabled: true, x_mm: clampDoorX(centered, doorW, wallLen) });
      });
    }

    if (doorXEl) {
      doorXEl.addEventListener("input", () => {
        const s = store.getState();
        const id = ensureSelectedDoor(s);
        if (!id) return;
        const cur = findDoor(s, id);
        if (!cur) return;

        const wall = cur.wall || "front";
        const wallLen = currentWallLength(s, wall);
        const doorW = asPosInt(cur.width_mm, 900);
        const x = asNonNegInt(doorXEl.value, cur.x_mm || 0);
        upsertDoor({ ...cur, x_mm: clampDoorX(x, doorW, wallLen) });
      });
    }

    if (doorWEl) {
      doorWEl.addEventListener("input", () => {
        const s = store.getState();
        const id = ensureSelectedDoor(s);
        if (!id) return;
        const cur = findDoor(s, id);
        if (!cur) return;

        const wall = cur.wall || "front";
        const wallLen = currentWallLength(s, wall);
        const w = asPosInt(doorWEl.value, cur.width_mm || 900);
        const x = clampDoorX(cur.x_mm || 0, w, wallLen);
        upsertDoor({ ...cur, width_mm: w, x_mm: x });
      });
    }

    if (doorHEl) {
      doorHEl.addEventListener("input", () => {
        patchSelectedDoor({ height_mm: asPosInt(doorHEl.value, 2000) });
      });
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    function escapeAttr(s) {
      return escapeHtml(s).replace(/`/g, "");
    }

    // Start
    store.onChange((s) => {
      syncUiFromState(s);
      render(s);
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

    // Kick once
    syncUiFromState(store.getState());
    render(store.getState());
    resume3D();

    window.__dbg.initFinished = true;
  } catch (e) {
    window.__dbg.lastError = "init() failed: " + String(e && e.message ? e.message : e);
    window.__dbg.initFinished = false;
  }
})();
