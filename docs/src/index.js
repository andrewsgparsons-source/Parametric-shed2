// FILE: docs/src/index.js
// Orchestration only.
// Adds stud/plate size selector (#wallSection) that updates state.walls.{insulated,basic}.section to 50×75 or 50×100.
// Adds multi-door UI wiring (any number of doors, any wall) without changing geometry/BOM algorithms outside walls.js.

window.__dbg = window.__dbg || {};
window.__dbg.initStarted = true;
window.__dbg.initFinished = false;

function dbgInitDefaults() {
  if (window.__dbg.engine === undefined) window.__dbg.engine = null;
  if (window.__dbg.scene === undefined) window.__dbg.scene = null;
  if (window.__dbg.camera === undefined) window.__dbg.camera = null;
  if (window.__dbg.frames === undefined) window.__dbg.frames = 0;
  if (window.__dbg.buildCalls === undefined) window.__dbg.buildCalls = 0;
  if (window.__dbg.lastError === undefined) window.__dbg.lastError = null;
}
dbgInitDefaults();

window.addEventListener("error", function (e) {
  window.__dbg.lastError = (e && e.message) ? e.message : String(e);
});
window.addEventListener("unhandledrejection", function (e) {
  window.__dbg.lastError = (e && e.reason) ? String(e.reason) : "unhandledrejection";
});

import { createStateStore } from "./state.js";
import { DEFAULTS, resolveDims } from "./params.js";
import { boot, disposeAll } from "./renderer/babylon.js";
import * as Base from "./elements/base.js";
import * as Walls from "./elements/walls.js";
import { renderBOM } from "./bom/index.js";

function $(id) { return document.getElementById(id); }
function setDisplay(el, val) { if (el && el.style) el.style.display = val; }
function setAriaHidden(el, hidden) { if (el) el.setAttribute("aria-hidden", String(!!hidden)); }

var WALL_OVERHANG_MM = 25;
var WALL_RISE_MM = 168;

function shiftWallMeshes(scene, dx_mm, dy_mm, dz_mm) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("wall-") !== 0) continue;
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  }
}

function initApp() {
  try {
    var canvas = $("renderCanvas");
    var statusOverlayEl = $("statusOverlay");

    if (!canvas) {
      window.__dbg.lastError = "renderCanvas not found";
      return;
    }

    var ctx = null;
    try {
      ctx = boot(canvas);
    } catch (e) {
      window.__dbg.lastError = "boot(canvas) failed: " + String(e && e.message ? e.message : e);
      return;
    }

    window.__dbg.engine = (ctx && ctx.engine) ? ctx.engine : null;
    window.__dbg.scene = (ctx && ctx.scene) ? ctx.scene : null;
    window.__dbg.camera = (ctx && ctx.camera) ? ctx.camera : null;

    try {
      var eng = window.__dbg.engine;
      if (eng && eng.onEndFrameObservable && typeof eng.onEndFrameObservable.add === "function") {
        eng.onEndFrameObservable.add(function () { window.__dbg.frames += 1; });
      }
    } catch (e) {}

    var store = createStateStore(DEFAULTS);

    var vWallsEl = $("vWalls");
    var vBaseEl = $("vBase");
    var vFrameEl = $("vFrame");
    var vInsEl = $("vIns");
    var vDeckEl = $("vDeck");

    var vWallFrontEl = $("vWallFront");
    var vWallBackEl = $("vWallBack");
    var vWallLeftEl = $("vWallLeft");
    var vWallRightEl = $("vWallRight");

    var dimModeEl = $("dimMode");
    var wInputEl = $("wInput");
    var dInputEl = $("dInput");

    var overUniformEl = $("roofOverUniform");
    var overFrontEl = $("roofOverFront");
    var overBackEl = $("roofOverBack");
    var overLeftEl = $("roofOverLeft");
    var overRightEl = $("roofOverRight");

    var wallSectionEl = $("wallSection");
    var wallsVariantEl = $("wallsVariant");
    var wallHeightEl = $("wallHeight");

    // Door editor (required IDs + new selector/wall/add/remove)
    var doorSelectEl = $("doorSelect");
    var doorWallEl = $("doorWall");
    var doorAddBtnEl = $("doorAddBtn");
    var doorRemoveBtnEl = $("doorRemoveBtn");

    var doorEnabledEl = $("doorEnabled");
    var doorXEl = $("doorX");
    var doorWEl = $("doorW");
    var doorHEl = $("doorH");

    var selectedDoorId = null;

    var asPosInt = function (v, def) {
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? n : def;
    };
    var asNonNegInt = function (v, def) {
      if (def === undefined) def = 0;
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    var asNullableInt = function (v) {
      if (v == null || v === "") return null;
      var n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };

    function getWallsEnabled(state) {
      var vis = state && state.vis ? state.vis : null;
      if (vis && typeof vis.walls === "boolean") return vis.walls;
      if (vis && typeof vis.wallsEnabled === "boolean") return vis.wallsEnabled;
      return true;
    }

    function getWallParts(state) {
      var vis = state && state.vis ? state.vis : null;

      if (vis && vis.walls && typeof vis.walls === "object") {
        return {
          front: vis.walls.front !== false,
          back: vis.walls.back !== false,
          left: vis.walls.left !== false,
          right: vis.walls.right !== false
        };
      }

      if (vis && vis.wallsParts && typeof vis.wallsParts === "object") {
        return {
          front: vis.wallsParts.front !== false,
          back: vis.wallsParts.back !== false,
          left: vis.wallsParts.left !== false,
          right: vis.wallsParts.right !== false
        };
      }

      return { front: true, back: true, left: true, right: true };
    }

    function resume3D() {
      var engine = window.__dbg.engine;
      var camera = window.__dbg.camera;

      setDisplay(canvas, "block");
      setAriaHidden(canvas, false);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "none");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, true);

      try { if (engine && typeof engine.resize === "function") engine.resize(); } catch (e) {}
      try { if (camera && typeof camera.attachControl === "function") camera.attachControl(canvas, true); } catch (e) {}
    }

    function getWallOuterDimsFromState(state) {
      var R = resolveDims(state);
      var w = Math.max(1, Math.floor(R.base.w_mm + (2 * WALL_OVERHANG_MM)));
      var d = Math.max(1, Math.floor(R.base.d_mm + (2 * WALL_OVERHANG_MM)));
      return { w_mm: w, d_mm: d };
    }

    function getWallThicknessFromState(state) {
      try {
        var v = (state && state.walls && state.walls.variant) ? state.walls.variant : "insulated";
        var cfg = state && state.walls ? state.walls[v] : null;
        var h = cfg && cfg.section && cfg.section.h != null ? Math.floor(Number(cfg.section.h)) : null;
        return (Number.isFinite(h) && h > 0) ? h : (v === "basic" ? 75 : 100);
      } catch (e) {
        return 100;
      }
    }

    function wallLengthForDoor(state, door) {
      var dims = getWallOuterDimsFromState(state);
      var wallThk = getWallThicknessFromState(state);
      var wall = String(door && door.wall ? door.wall : "front").toLowerCase();
      if (wall === "left" || wall === "right") return Math.max(1, Math.floor(dims.d_mm - 2 * wallThk));
      return Math.max(1, Math.floor(dims.w_mm));
    }

    function clampDoorX(x, doorW, wallLen) {
      var maxX = Math.max(0, wallLen - doorW);
      return Math.max(0, Math.min(maxX, x));
    }

    function normalizeOpenings(state) {
      var s = state || {};
      var walls = s.walls || {};
      var arr = walls.openings;
      if (!Array.isArray(arr)) arr = [];
      if (!arr.length) {
        arr = [{ id: "door1", wall: "front", type: "door", enabled: false, x_mm: 800, width_mm: 900, height_mm: 2000 }];
      }
      return arr;
    }

    function nextDoorId(openings) {
      var maxN = 0;
      for (var i = 0; i < openings.length; i++) {
        var id = String(openings[i] && openings[i].id ? openings[i].id : "");
        var m = id.match(/(\d+)$/);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10) || 0);
      }
      return "door" + String(maxN + 1);
    }

    function getSelectedDoor(state) {
      var openings = normalizeOpenings(state);
      if (selectedDoorId) {
        for (var i = 0; i < openings.length; i++) {
          if (String(openings[i].id) === String(selectedDoorId)) return openings[i];
        }
      }
      return openings.length ? openings[0] : null;
    }

    function setOpenings(openings) {
      store.setState({ walls: { openings: openings } });
    }

    function patchSelectedDoor(patch) {
      var s = store.getState();
      var openings = normalizeOpenings(s);
      var cur = getSelectedDoor(s);
      if (!cur) return;

      var out = [];
      for (var i = 0; i < openings.length; i++) {
        var d = openings[i];
        if (String(d.id) === String(cur.id)) out.push(Object.assign({}, d, patch));
        else out.push(d);
      }
      setOpenings(out);
    }

    function syncDoorSelectOptions(state) {
      if (!doorSelectEl) return;

      var openings = normalizeOpenings(state);
      var cur = getSelectedDoor(state);
      if (!selectedDoorId && cur) selectedDoorId = cur.id;

      var html = "";
      for (var i = 0; i < openings.length; i++) {
        var d = openings[i];
        var wall = String(d.wall || "front");
        var en = d.enabled ? "on" : "off";
        html += '<option value="' + String(d.id) + '">' + String(d.id) + " (" + wall + ", " + en + ")</option>";
      }
      doorSelectEl.innerHTML = html;

      if (cur) doorSelectEl.value = String(cur.id);
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

        var R = resolveDims(state);
        var baseState = Object.assign({}, state, { w: R.base.w_mm, d: R.base.d_mm });

        var wallDims = getWallOuterDimsFromState(state);
        var wallState = Object.assign({}, state, { w: wallDims.w_mm, d: wallDims.d_mm });

        safeDispose();

        if (Base && typeof Base.build3D === "function") Base.build3D(baseState, ctx);

        if (getWallsEnabled(state)) {
          if (Walls && typeof Walls.build3D === "function") Walls.build3D(wallState, ctx);
          shiftWallMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
        }

        if (Walls && typeof Walls.updateBOM === "function") {
          var wallsBom = Walls.updateBOM(wallState);
          if (wallsBom && wallsBom.sections) renderBOM(wallsBom.sections);
        }

        if (Base && typeof Base.updateBOM === "function") Base.updateBOM(baseState);
      } catch (e) {
        window.__dbg.lastError = "render() failed: " + String(e && e.message ? e.message : e);
      }
    }

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
          if (overUniformEl) overUniformEl.value = String(state.overhang.uniform_mm != null ? state.overhang.uniform_mm : 0);
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

        var parts = getWallParts(state);
        if (vWallFrontEl) vWallFrontEl.checked = !!parts.front;
        if (vWallBackEl) vWallBackEl.checked = !!parts.back;
        if (vWallLeftEl) vWallLeftEl.checked = !!parts.left;
        if (vWallRightEl) vWallRightEl.checked = !!parts.right;

        if (wallsVariantEl && state && state.walls && state.walls.variant) wallsVariantEl.value = state.walls.variant;
        if (wallHeightEl && state && state.walls && state.walls.height_mm != null) wallHeightEl.value = String(state.walls.height_mm);

        // Reflect currently-selected section height into the dropdown.
        if (wallSectionEl && state && state.walls) {
          var h = null;
          try {
            if (state.walls.insulated && state.walls.insulated.section && state.walls.insulated.section.h != null) h = state.walls.insulated.section.h;
            else if (state.walls.basic && state.walls.basic.section && state.walls.basic.section.h != null) h = state.walls.basic.section.h;
          } catch (e) {}
          wallSectionEl.value = (Math.floor(Number(h)) === 75) ? "50x75" : "50x100";
        }

        // Doors
        syncDoorSelectOptions(state);

        var door = getSelectedDoor(state);
        if (door) {
          if (doorWallEl) doorWallEl.value = String(door.wall || "front");
          if (doorEnabledEl) doorEnabledEl.checked = !!door.enabled;
          if (doorXEl && door.x_mm != null) doorXEl.value = String(door.x_mm);
          if (doorWEl && door.width_mm != null) doorWEl.value = String(door.width_mm);
          if (doorHEl && door.height_mm != null) doorHEl.value = String(door.height_mm);
        }
      } catch (e) {
        window.__dbg.lastError = "syncUiFromState failed: " + String(e && e.message ? e.message : e);
      }
    }

    function updateOverlay() {
      if (!statusOverlayEl) return;

      var hasBabylon = typeof window.BABYLON !== "undefined";
      var cw = canvas ? (canvas.clientWidth || 0) : 0;
      var ch = canvas ? (canvas.clientHeight || 0) : 0;

      var engine = window.__dbg.engine;
      var scene = window.__dbg.scene;
      var camera = window.__dbg.camera;

      var meshes = (scene && scene.meshes) ? scene.meshes.length : 0;
      var err = String(window.__dbg.lastError || "").slice(0, 200);

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

    if (vWallsEl) {
      vWallsEl.addEventListener("change", function (e) {
        var s = store.getState();
        var on = !!(e && e.target && e.target.checked);

        if (s && s.vis && typeof s.vis.walls === "boolean") store.setState({ vis: { walls: on } });
        else if (s && s.vis && typeof s.vis.wallsEnabled === "boolean") store.setState({ vis: { wallsEnabled: on } });
        else store.setState({ vis: { walls: on } });
      });
    }

    if (vBaseEl) vBaseEl.addEventListener("change", function (e) { store.setState({ vis: { base: !!e.target.checked } }); });
    if (vFrameEl) vFrameEl.addEventListener("change", function (e) { store.setState({ vis: { frame: !!e.target.checked } }); });
    if (vInsEl) vInsEl.addEventListener("change", function (e) { store.setState({ vis: { ins: !!e.target.checked } }); });
    if (vDeckEl) vDeckEl.addEventListener("change", function (e) { store.setState({ vis: { deck: !!e.target.checked } }); });

    function patchWallPart(key, value) {
      var s = store.getState();
      if (s && s.vis && s.vis.walls && typeof s.vis.walls === "object") {
        store.setState({ vis: { walls: (function(){ var o={}; o[key]=value; return o; })() } });
        return;
      }
      if (s && s.vis && s.vis.wallsParts && typeof s.vis.wallsParts === "object") {
        store.setState({ vis: { wallsParts: (function(){ var o={}; o[key]=value; return o; })() } });
        return;
      }
      store.setState({ _noop: Date.now() });
    }

    if (vWallFrontEl) vWallFrontEl.addEventListener("change", function (e) { patchWallPart("front", !!e.target.checked); });
    if (vWallBackEl)  vWallBackEl.addEventListener("change",  function (e) { patchWallPart("back",  !!e.target.checked); });
    if (vWallLeftEl)  vWallLeftEl.addEventListener("change",  function (e) { patchWallPart("left",  !!e.target.checked); });
    if (vWallRightEl) vWallRightEl.addEventListener("change", function (e) { patchWallPart("right", !!e.target.checked); });

    if (dimModeEl) {
      dimModeEl.addEventListener("change", function () {
        store.setState({ dimMode: dimModeEl.value });
        syncUiFromState(store.getState());
      });
    }

    function writeActiveDims() {
      var s = store.getState();
      var w = asPosInt(wInputEl ? wInputEl.value : null, 1000);
      var d = asPosInt(dInputEl ? dInputEl.value : null, 1000);

      if (s && s.dimInputs && s.dimMode) {
        if (s.dimMode === "base") store.setState({ dimInputs: { baseW_mm: w, baseD_mm: d } });
        else if (s.dimMode === "frame") store.setState({ dimInputs: { frameW_mm: w, frameD_mm: d } });
        else store.setState({ dimInputs: { roofW_mm: w, roofD_mm: d } });
      } else {
        store.setState({ w: w, d: d });
      }
    }
    if (wInputEl) wInputEl.addEventListener("input", writeActiveDims);
    if (dInputEl) dInputEl.addEventListener("input", writeActiveDims);

    if (overUniformEl) {
      overUniformEl.addEventListener("input", function () {
        var n = Math.max(0, Math.floor(Number(overUniformEl.value || 0)));
        store.setState({ overhang: { uniform_mm: Number.isFinite(n) ? n : 0 } });
      });
    }
    if (overLeftEl)  overLeftEl.addEventListener("input",  function () { store.setState({ overhang: { left_mm:  asNullableInt(overLeftEl.value) } }); });
    if (overRightEl) overRightEl.addEventListener("input", function () { store.setState({ overhang: { right_mm: asNullableInt(overRightEl.value) } }); });
    if (overFrontEl) overFrontEl.addEventListener("input", function () { store.setState({ overhang: { front_mm: asNullableInt(overFrontEl.value) } }); });
    if (overBackEl)  overBackEl.addEventListener("input",  function () { store.setState({ overhang: { back_mm:  asNullableInt(overBackEl.value) } }); });

    // Stud/Plate size -> updates BOTH variants' section.h (50×75 or 50×100)
    function sectionHFromSelectValue(v) {
      return (String(v || "").toLowerCase() === "50x75") ? 75 : 100;
    }
    if (wallSectionEl) {
      wallSectionEl.addEventListener("change", function () {
        var h = sectionHFromSelectValue(wallSectionEl.value);
        store.setState({
          walls: {
            insulated: { section: { w: 50, h: h } },
            basic: { section: { w: 50, h: h } }
          }
        });
      });
    }

    if (wallsVariantEl) wallsVariantEl.addEventListener("change", function () { store.setState({ walls: { variant: wallsVariantEl.value } }); });
    if (wallHeightEl) wallHeightEl.addEventListener("input", function () { store.setState({ walls: { height_mm: asPosInt(wallHeightEl.value, 2400) } }); });

    // Door selection
    if (doorSelectEl) {
      doorSelectEl.addEventListener("change", function () {
        selectedDoorId = String(doorSelectEl.value || "");
        syncUiFromState(store.getState());
      });
    }

    if (doorAddBtnEl) {
      doorAddBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var openings = normalizeOpenings(s);
        var id = nextDoorId(openings);
        var wall = doorWallEl ? String(doorWallEl.value || "front") : "front";

        var newDoor = {
          id: id,
          wall: wall,
          type: "door",
          enabled: true,
          x_mm: 0,
          width_mm: 900,
          height_mm: 2000
        };

        var len = wallLengthForDoor(s, newDoor);
        newDoor.x_mm = clampDoorX(Math.floor((len - newDoor.width_mm) / 2), newDoor.width_mm, len);

        openings = openings.concat([newDoor]);
        selectedDoorId = id;
        setOpenings(openings);
      });
    }

    if (doorRemoveBtnEl) {
      doorRemoveBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var openings = normalizeOpenings(s);
        var cur = getSelectedDoor(s);
        if (!cur) return;

        var out = [];
        for (var i = 0; i < openings.length; i++) {
          if (String(openings[i].id) !== String(cur.id)) out.push(openings[i]);
        }

        selectedDoorId = out.length ? out[0].id : null;
        setOpenings(out);
      });
    }

    if (doorWallEl) {
      doorWallEl.addEventListener("change", function () {
        var s = store.getState();
        var cur = getSelectedDoor(s);
        if (!cur) return;

        var wall = String(doorWallEl.value || "front");
        var len = wallLengthForDoor(s, Object.assign({}, cur, { wall: wall }));
        var w = asPosInt(cur.width_mm, 900);
        var centered = Math.floor((len - w) / 2);
        patchSelectedDoor({ wall: wall, x_mm: clampDoorX(centered, w, len) });
      });
    }

    if (doorEnabledEl) {
      doorEnabledEl.addEventListener("change", function () {
        var s = store.getState();
        var cur = getSelectedDoor(s);
        if (!cur) return;

        var enabled = !!doorEnabledEl.checked;
        if (!enabled) {
          patchSelectedDoor({ enabled: false });
          return;
        }

        var len = wallLengthForDoor(s, cur);
        var w = asPosInt(cur.width_mm, 900);
        var centered = Math.floor((len - w) / 2);
        patchSelectedDoor({ enabled: true, x_mm: clampDoorX(centered, w, len) });
      });
    }

    if (doorXEl) {
      doorXEl.addEventListener("input", function () {
        var s = store.getState();
        var cur = getSelectedDoor(s);
        if (!cur) return;

        var len = wallLengthForDoor(s, cur);
        var w = asPosInt(cur.width_mm, 900);
        var x = asNonNegInt(doorXEl.value, cur.x_mm || 0);
        patchSelectedDoor({ x_mm: clampDoorX(x, w, len) });
      });
    }

    if (doorWEl) {
      doorWEl.addEventListener("input", function () {
        var s = store.getState();
        var cur = getSelectedDoor(s);
        if (!cur) return;

        var len = wallLengthForDoor(s, cur);
        var w = asPosInt(doorWEl.value, cur.width_mm || 900);
        var x = clampDoorX(cur.x_mm || 0, w, len);
        patchSelectedDoor({ width_mm: w, x_mm: x });
      });
    }

    if (doorHEl) doorHEl.addEventListener("input", function () { patchSelectedDoor({ height_mm: asPosInt(doorHEl.value, 2000) }); });

    store.onChange(function (s) {
      syncUiFromState(s);
      render(s);
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

    // Ensure door select has something meaningful on first load
    try {
      var initial = store.getState();
      var o = normalizeOpenings(initial);
      selectedDoorId = (o && o[0] && o[0].id) ? o[0].id : null;
      setOpenings(o);
    } catch (e) {}

    syncUiFromState(store.getState());
    render(store.getState());
    resume3D();

    window.__dbg.initFinished = true;
  } catch (e) {
    window.__dbg.lastError = "initApp() failed: " + String(e && e.message ? e.message : e);
    window.__dbg.initFinished = false;
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
