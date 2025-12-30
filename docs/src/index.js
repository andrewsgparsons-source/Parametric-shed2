// FILE: docs/src/index.js
// Orchestration only.
// Adds stud/plate size selector (#wallSection) that updates state.walls.{insulated,basic}.section to 50×75 or 50×100.
// Keeps all other behavior unchanged.

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
  if (window.__dbg.doorSeq === undefined) window.__dbg.doorSeq = 1;
  if (window.__dbg.windowSeq === undefined) window.__dbg.windowSeq = 1;
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
import * as Roof from "./elements/roof.js";
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

function shiftRoofMeshes(scene, dx_mm, dy_mm, dz_mm) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("roof-") !== 0) continue;
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

    var roofStyleEl = $("roofStyle");

    var overUniformEl = $("roofOverUniform");
    var overFrontEl = $("roofOverFront");
    var overBackEl = $("roofOverBack");
    var overLeftEl = $("roofOverLeft");
    var overRightEl = $("roofOverRight");

    var wallSectionEl = $("wallSection"); // NEW
    var wallsVariantEl = $("wallsVariant");
    var wallHeightEl = $("wallHeight");

    var addDoorBtnEl = $("addDoorBtn");
    var removeAllDoorsBtnEl = $("removeAllDoorsBtn");
    var doorsListEl = $("doorsList");

    var addWindowBtnEl = $("addWindowBtn");
    var removeAllWindowsBtnEl = $("removeAllWindowsBtn");
    var windowsListEl = $("windowsList");

    var instanceSelectEl = $("instanceSelect");
    var saveInstanceBtnEl = $("saveInstanceBtn");
    var loadInstanceBtnEl = $("loadInstanceBtn");
    var instanceNameInputEl = $("instanceNameInput");
    var saveAsInstanceBtnEl = $("saveAsInstanceBtn");
    var deleteInstanceBtnEl = $("deleteInstanceBtn");
    var instancesHintEl = $("instancesHint");

    // ---- Instances (Save/Load Presets) ----
    var LS_INSTANCES_KEY = "shedInstances_v1";
    var LS_ACTIVE_KEY = "shedInstancesActive_v1";

    var _instProvider = null;
    var _instUsingFallback = false;
    var _instProbe = { canRead: false, canWrite: false, persistentOk: false, errName: "", errMsg: "" };

    /* Instances manual test:
       1) Save As "A"
       2) Change width/depth (and/or add a door/window)
       3) Save As "B"
       4) Switch dropdown between A and B and click Load
       5) Confirm controls + model update immediately (via existing store.onChange)
       6) Refresh page -> active remains selected when persistent storage is OK
    */

    function safeJsonParse(s) {
      try { return JSON.parse(s); } catch (e) { return null; }
    }
    function safeJsonStringify(v) {
      try { return JSON.stringify(v); } catch (e) { return ""; }
    }

    function setInstancesHint(msg) {
      if (!instancesHintEl) return;
      instancesHintEl.textContent = msg;
    }

    function cloneJson(obj) {
      try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
    }

    function isPlainObject(x) {
      return !!x && typeof x === "object" && !Array.isArray(x);
    }

    function deepMerge(dst, src) {
      if (!isPlainObject(dst)) dst = {};
      if (!isPlainObject(src)) return dst;
      var keys = Object.keys(src);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var sv = src[k];
        if (Array.isArray(sv)) {
          dst[k] = sv.slice();
        } else if (isPlainObject(sv)) {
          dst[k] = deepMerge(isPlainObject(dst[k]) ? dst[k] : {}, sv);
        } else {
          dst[k] = sv;
        }
      }
      return dst;
    }

    function storageProbe() {
      var res = { canRead: false, canWrite: false, persistentOk: false, errName: "", errMsg: "" };
      var ls = null;

      try { ls = window.localStorage; } catch (e0) { ls = null; }
      if (!ls) {
        res.errName = "NoLocalStorage";
        res.errMsg = "window.localStorage unavailable";
        return res;
      }

      try {
        var tmp = ls.getItem(LS_INSTANCES_KEY);
        res.canRead = true;
        void tmp;
      } catch (e1) {
        res.canRead = false;
        res.errName = e1 && e1.name ? String(e1.name) : "ReadError";
        res.errMsg = e1 && e1.message ? String(e1.message) : String(e1);
        return res;
      }

      try {
        ls.setItem("__shed_probe__", "1");
        var v = ls.getItem("__shed_probe__");
        ls.removeItem("__shed_probe__");
        res.canWrite = (v === "1");
      } catch (e2) {
        // QuotaExceededError: treat read OK, write failed
        res.canWrite = false;
        res.errName = e2 && e2.name ? String(e2.name) : "WriteError";
        res.errMsg = e2 && e2.message ? String(e2.message) : String(e2);
      }

      res.persistentOk = !!(res.canRead && res.canWrite);
      return res;
    }

    function createPersistentProvider() {
      return {
        getItem: function (k) { return window.localStorage.getItem(k); },
        setItem: function (k, v) { window.localStorage.setItem(k, v); },
        removeItem: function (k) { window.localStorage.removeItem(k); }
      };
    }

    function createFallbackProvider() {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? String(mem[k]) : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { try { delete mem[k]; } catch (e) {} }
      };
    }

    function providerGet(key) {
      try { return _instProvider ? _instProvider.getItem(key) : null; } catch (e) { return null; }
    }

    function providerSet(key, val) {
      try { if (_instProvider) _instProvider.setItem(key, val); } catch (e) { throw e; }
    }

    function providerRemove(key) {
      try { if (_instProvider) _instProvider.removeItem(key); } catch (e) { throw e; }
    }

    function hintStorageStatusIfNeeded(prefix) {
      if (_instProbe.persistentOk) return;
      var msg = "";
      if (_instProbe.canRead && !_instProbe.canWrite) {
        msg = "Storage read OK, write blocked: " + String(_instProbe.errName || "") + " " + String(_instProbe.errMsg || "");
      } else {
        msg = "Storage blocked: " + String(_instProbe.errName || "") + " " + String(_instProbe.errMsg || "");
      }
      if (_instUsingFallback) msg += " (session only)";
      if (prefix) msg = prefix + " — " + msg;
      setInstancesHint(msg);
    }

    function readInstances() {
      var raw = providerGet(LS_INSTANCES_KEY);
      if (!raw) return {};
      var parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    }

    function writeInstances(map) {
      var s = safeJsonStringify(map || {});
      if (!s) return;
      providerSet(LS_INSTANCES_KEY, s);
    }

    function readActiveName() {
      var v = providerGet(LS_ACTIVE_KEY);
      return v != null ? String(v) : null;
    }

    function writeActiveName(name) {
      if (name == null) { providerRemove(LS_ACTIVE_KEY); return; }
      providerSet(LS_ACTIVE_KEY, String(name));
    }

    function listInstanceNames(map) {
      var names = Object.keys(map || {});
      names.sort(function (a, b) { return String(a).localeCompare(String(b)); });
      return names;
    }

    function rebuildInstanceSelect(selectedNameMaybe) {
      if (!instanceSelectEl) return { map: {}, names: [], selected: null };

      var map = {};
      try {
        map = readInstances();
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
        return { map: {}, names: [], selected: null };
      }

      var names = listInstanceNames(map);

      if (!names.length) {
        try {
          map["Default"] = cloneJson(store.getState());
          writeInstances(map);
          writeActiveName("Default");
          map = readInstances();
          names = listInstanceNames(map);
        } catch (e2) {
          if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
          else hintStorageStatusIfNeeded("Storage unavailable");
          return { map: {}, names: [], selected: null };
        }
      }

      var active = readActiveName();
      var want = selectedNameMaybe != null ? String(selectedNameMaybe) : null;
      if (!want && active && map[active] != null) want = active;
      if (!want || names.indexOf(want) === -1) want = names[0];

      instanceSelectEl.innerHTML = "";
      for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        var opt = document.createElement("option");
        opt.value = nm;
        opt.textContent = nm;
        instanceSelectEl.appendChild(opt);
      }

      instanceSelectEl.value = want;
      try { writeActiveName(want); } catch (e3) {}

      if (_instProbe.persistentOk) setInstancesHint("Selected: " + want);
      else setInstancesHint("Selected: " + want + " (session only)");

      return { map: map, names: names, selected: want };
    }

    function getSelectedNameSafe(map) {
      if (!instanceSelectEl) return null;
      var nm = String(instanceSelectEl.value || "");
      if (!nm) return null;
      if (map && typeof map === "object" && map[nm] == null) return null;
      return nm;
    }

    function saveCurrentTo(name, overwriteAllowed) {
      var nm = String(name || "").trim();
      if (!nm) return false;

      try {
        var map = readInstances();
        if (map[nm] != null && !overwriteAllowed) return false;

        map[nm] = cloneJson(store.getState());
        writeInstances(map);
        writeActiveName(nm);
        rebuildInstanceSelect(nm);

        if (_instProbe.persistentOk) setInstancesHint("Saved: " + nm);
        else setInstancesHint("Saved: " + nm + " (session only)");
        return true;
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
        return false;
      }
    }

    function loadFrom(name) {
      var nm = String(name || "").trim();
      if (!nm) return;

      try {
        var map = readInstances();
        var saved = map[nm];
        if (!saved || typeof saved !== "object") {
          if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
          else setInstancesHint("No saved instances. (session only)");
          rebuildInstanceSelect(null);
          return;
        }

        var baseline = cloneJson(DEFAULTS);
        var merged = deepMerge(baseline, cloneJson(saved));
        store.setState(merged);

        writeActiveName(nm);
        rebuildInstanceSelect(nm);

        if (_instProbe.persistentOk) setInstancesHint("Loaded: " + nm);
        else setInstancesHint("Loaded: " + nm + " (session only)");
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    }

    function deleteSelected() {
      try {
        var map = readInstances();
        var names = listInstanceNames(map);
        if (names.length <= 1) {
          if (_instProbe.persistentOk) setInstancesHint("Cannot delete last instance.");
          else setInstancesHint("Cannot delete last instance. (session only)");
          return;
        }

        var name = getSelectedNameSafe(map);
        if (!name) return;

        delete map[name];
        writeInstances(map);

        var remaining = listInstanceNames(map);
        var nextName = remaining.length ? remaining[0] : null;

        if (nextName) {
          writeActiveName(nextName);
          rebuildInstanceSelect(nextName);
          // Optional: auto-load newly selected instance
          loadFrom(nextName);

          if (_instProbe.persistentOk) setInstancesHint("Deleted: " + name + ", Selected: " + nextName);
          else setInstancesHint("Deleted: " + name + ", Selected: " + nextName + " (session only)");
        } else {
          rebuildInstanceSelect(null);
          if (_instProbe.persistentOk) setInstancesHint("Deleted: " + name);
          else setInstancesHint("Deleted: " + name + " (session only)");
        }
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    }

    function wireInstancesUiOnce() {
      if (!instanceSelectEl || !saveInstanceBtnEl || !loadInstanceBtnEl || !saveAsInstanceBtnEl || !deleteInstanceBtnEl) return;
      if (saveInstanceBtnEl._wired) return;

      saveInstanceBtnEl._wired = true;
      loadInstanceBtnEl._wired = true;
      saveAsInstanceBtnEl._wired = true;
      deleteInstanceBtnEl._wired = true;
      instanceSelectEl._wired = true;

      saveInstanceBtnEl.addEventListener("click", function () {
        try {
          var map = readInstances();
          var name = getSelectedNameSafe(map);
          if (!name) {
            if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
            else setInstancesHint("No saved instances. (session only)");
            rebuildInstanceSelect(null);
            return;
          }
          saveCurrentTo(name, true);
        } catch (e) {
          if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
          else hintStorageStatusIfNeeded("Storage unavailable");
        }
      });

      loadInstanceBtnEl.addEventListener("click", function () {
        try {
          var map = readInstances();
          var name = getSelectedNameSafe(map);
          if (!name) {
            if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
            else setInstancesHint("No saved instances. (session only)");
            rebuildInstanceSelect(null);
            return;
          }
          loadFrom(name);
        } catch (e) {
          if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
          else hintStorageStatusIfNeeded("Storage unavailable");
        }
      });

      saveAsInstanceBtnEl.addEventListener("click", function () {
        var name = instanceNameInputEl ? String(instanceNameInputEl.value || "").trim() : "";
        if (!name) return;

        try {
          var map = readInstances();
          if (map[name] != null) {
            var ok = false;
            try { ok = window.confirm('Overwrite existing instance "' + name + '"?'); } catch (e0) { ok = false; }
            if (!ok) return;
          }
          saveCurrentTo(name, true);
          if (instanceNameInputEl) instanceNameInputEl.value = "";
        } catch (e) {
          if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
          else hintStorageStatusIfNeeded("Storage unavailable");
        }
      });

      deleteInstanceBtnEl.addEventListener("click", function () {
        deleteSelected();
      });

      instanceSelectEl.addEventListener("change", function () {
        try {
          var map = readInstances();
          var name = getSelectedNameSafe(map);
          if (!name) {
            if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
            else setInstancesHint("No saved instances. (session only)");
            rebuildInstanceSelect(null);
            return;
          }

          try { writeActiveName(name); } catch (e2) {}

          rebuildInstanceSelect(name);
          if (_instProbe.persistentOk) setInstancesHint("Selected: " + name);
          else setInstancesHint("Selected: " + name + " (session only)");
        } catch (e) {
          if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
          else hintStorageStatusIfNeeded("Storage unavailable");
        }
      });
    }

    function initInstances() {
      // Probe storage and select provider once.
      _instProbe = storageProbe();
      if (_instProbe.persistentOk) {
        _instProvider = createPersistentProvider();
        _instUsingFallback = false;
      } else {
        _instProvider = createFallbackProvider();
        _instUsingFallback = true;
      }

      wireInstancesUiOnce();

      if (!_instProbe.persistentOk) {
        hintStorageStatusIfNeeded(null);
      }

      rebuildInstanceSelect(null);
    }

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

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

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

    function currentWallThicknessFromState(state) {
      var v = (state && state.walls && state.walls.variant) ? String(state.walls.variant) : "insulated";
      var sec = (state && state.walls && state.walls[v] && state.walls[v].section) ? state.walls[v].section : null;
      var h = sec && sec.h != null ? Math.floor(Number(sec.h)) : (v === "basic" ? 75 : 100);
      return (Number.isFinite(h) && h > 0) ? h : (v === "basic" ? 75 : 100);
    }

    function currentStudWFromState(state) {
      var v = (state && state.walls && state.walls.variant) ? String(state.walls.variant) : "insulated";
      var sec = (state && state.walls && state.walls[v] && state.walls[v].section) ? state.walls[v].section : null;
      var w = sec && sec.w != null ? Math.floor(Number(sec.w)) : 50;
      return (Number.isFinite(w) && w > 0) ? w : 50;
    }

    function currentPlateYFromState(state) {
      return currentStudWFromState(state);
    }

    function currentStudLenFromState(state) {
      var plateY = currentPlateYFromState(state);
      var H = state && state.walls && state.walls.height_mm != null ? Math.max(100, Math.floor(Number(state.walls.height_mm))) : 2400;
      return Math.max(1, H - 2 * plateY);
    }

    function getWallLengthsForOpenings(state) {
      var dims = getWallOuterDimsFromState(state);
      var thk = currentWallThicknessFromState(state);
      return {
        front: Math.max(1, Math.floor(dims.w_mm)),
        back: Math.max(1, Math.floor(dims.w_mm)),
        left: Math.max(1, Math.floor(dims.d_mm - 2 * thk)),
        right: Math.max(1, Math.floor(dims.d_mm - 2 * thk)),
        _thk: thk
      };
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

        // Roof (PENT only): 3D + additive cutting list rendering
        var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
        if (roofStyle === "pent") {
          var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(R.roof.w_mm)) : Math.max(1, Math.floor(R.base.w_mm));
          var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(R.roof.d_mm)) : Math.max(1, Math.floor(R.base.d_mm));
          var roofState = Object.assign({}, state, { w: roofW, d: roofD });

          if (Roof && typeof Roof.build3D === "function") Roof.build3D(roofState, ctx);

          // Align roof to the same world shift as walls (roof only; does not touch existing wall/base behavior)
          shiftRoofMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);

          if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(roofState);
        } else {
          // Clear roof tables when not pent (roof module handles DOM presence checks)
          try {
            if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(Object.assign({}, state, { roof: Object.assign({}, state.roof || {}, { style: "apex" }) }));
          } catch (e0) {}
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

    function getOpeningsFromState(state) {
      return (state && state.walls && Array.isArray(state.walls.openings)) ? state.walls.openings : [];
    }

    function setOpenings(nextOpenings) {
      store.setState({ walls: { openings: nextOpenings } });
    }

    function getDoorsFromState(state) {
      var openings = getOpeningsFromState(state);
      var doors = [];
      for (var i = 0; i < openings.length; i++) {
        var d = openings[i];
        if (d && d.type === "door") doors.push(d);
      }
      return doors;
    }

    function getWindowsFromState(state) {
      var openings = getOpeningsFromState(state);
      var wins = [];
      for (var i = 0; i < openings.length; i++) {
        var w = openings[i];
        if (w && w.type === "window") wins.push(w);
      }
      return wins;
    }

    function getOpeningById(state, id) {
      var openings = getOpeningsFromState(state);
      for (var i = 0; i < openings.length; i++) {
        var o = openings[i];
        if (o && String(o.id || "") === String(id)) return o;
      }
      return null;
    }

    function validateDoors(state) {
      var res = { invalidById: {}, invalidIds: [] };
      var doors = getDoorsFromState(state);
      var lens = getWallLengthsForOpenings(state);
      var minGap = 50;

      function wallLen(wall) {
        return lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;
      }

      for (var i = 0; i < doors.length; i++) {
        var d = doors[i];
        var wall = String(d.wall || "front");
        var L = wallLen(wall);
        var w = Math.max(1, Math.floor(Number(d.width_mm || 900)));
        var x = Math.floor(Number(d.x_mm || 0));

        var minX = minGap;
        var maxX = Math.max(minX, L - w - minGap);

        if (x < minX || x > maxX) {
          res.invalidById[String(d.id)] =
            "Invalid: too close to corner/end.\n" +
            "Allowed X range: " + minX + " .. " + maxX + " (mm)";
        }
      }

      var byWall = { front: [], back: [], left: [], right: [] };
      for (var j = 0; j < doors.length; j++) {
        var dd = doors[j];
        var ww = String(dd.wall || "front");
        if (!byWall[ww]) byWall[ww] = [];
        byWall[ww].push(dd);
      }

      function intervalsOverlapOrTooClose(a0, a1, b0, b1, gap) {
        if (a1 + gap <= b0) return false;
        if (b1 + gap <= a0) return false;
        return true;
      }

      Object.keys(byWall).forEach(function (wall) {
        var list = byWall[wall] || [];
        for (var a = 0; a < list.length; a++) {
          for (var b = a + 1; b < list.length; b++) {
            var da = list[a], db = list[b];
            var ax = Math.floor(Number(da.x_mm || 0));
            var aw = Math.max(1, Math.floor(Number(da.width_mm || 900)));
            var bx = Math.floor(Number(db.x_mm || 0));
            var bw = Math.max(1, Math.floor(Number(db.width_mm || 900)));

            var a0 = ax, a1 = ax + aw;
            var b0 = bx, b1 = bx + bw;

            if (intervalsOverlapOrTooClose(a0, a1, b0, b1, minGap)) {
              if (!res.invalidById[String(da.id)]) res.invalidById[String(da.id)] = "Invalid: overlaps or is too close (<50mm) to another door on " + wall + ".";
              if (!res.invalidById[String(db.id)]) res.invalidById[String(db.id)] = "Invalid: overlaps or is too close (<50mm) to another door on " + wall + ".";
            }
          }
        }
      });

      Object.keys(res.invalidById).forEach(function (k) { res.invalidIds.push(k); });
      return res;
    }

    function validateWindows(state) {
      var res = { invalidById: {}, invalidIds: [] };
      var wins = getWindowsFromState(state);
      var lens = getWallLengthsForOpenings(state);
      var minGap = 50;

      var studLen = currentStudLenFromState(state);
      var thkY = currentWallThicknessFromState(state);

      function wallLen(wall) {
        return lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;
      }

      for (var i = 0; i < wins.length; i++) {
        var w0 = wins[i];
        var wall = String(w0.wall || "front");
        var L = wallLen(wall);

        var w = Math.max(1, Math.floor(Number(w0.width_mm || 900)));
        var x = Math.floor(Number(w0.x_mm || 0));

        var y = Math.floor(Number(w0.y_mm || 0));
        var h = Math.max(1, Math.floor(Number(w0.height_mm || 600)));

        var minX = minGap;
        var maxX = Math.max(minX, L - w - minGap);

        if (x < minX || x > maxX) {
          res.invalidById[String(w0.id)] =
            "Invalid: too close to corner/end.\n" +
            "Allowed X range: " + minX + " .. " + maxX + " (mm)";
        }

        if (y < 0) {
          res.invalidById[String(w0.id)] = "Invalid: Window Y must be ≥ 0 (mm).";
        } else if ((y + h + thkY) > studLen) {
          res.invalidById[String(w0.id)] =
            "Invalid: window exceeds the wall frame height.\n" +
            "Max (Y + H) allowed: " + Math.max(0, (studLen - thkY)) + " (mm)";
        }
      }

      var byWall = { front: [], back: [], left: [], right: [] };
      for (var j = 0; j < wins.length; j++) {
        var ww2 = wins[j];
        var wl = String(ww2.wall || "front");
        if (!byWall[wl]) byWall[wl] = [];
        byWall[wl].push(ww2);
      }

      function intervalsOverlapOrTooClose(a0, a1, b0, b1, gap) {
        if (a1 + gap <= b0) return false;
        if (b1 + gap <= a0) return false;
        return true;
      }

      Object.keys(byWall).forEach(function (wall) {
        var list = byWall[wall] || [];
        for (var a = 0; a < list.length; a++) {
          for (var b = a + 1; b < list.length; b++) {
            var da = list[a], db = list[b];
            var ax = Math.floor(Number(da.x_mm || 0));
            var aw = Math.max(1, Math.floor(Number(da.width_mm || 900)));
            var bx = Math.floor(Number(db.x_mm || 0));
            var bw = Math.max(1, Math.floor(Number(db.width_mm || 900)));

            var a0 = ax, a1 = ax + aw;
            var b0 = bx, b1 = bx + bw;

            if (intervalsOverlapOrTooClose(a0, a1, b0, b1, minGap)) {
              if (!res.invalidById[String(da.id)]) res.invalidById[String(da.id)] = "Invalid: overlaps or is too close (<50mm) to another window on " + wall + ".";
              if (!res.invalidById[String(db.id)]) res.invalidById[String(db.id)] = "Invalid: overlaps or is too close (<50mm) to another window on " + wall + ".";
            }
          }
        }
      });

      Object.keys(res.invalidById).forEach(function (k) { res.invalidIds.push(k); });
      return res;
    }

    function subtractIntervals(base, forb) {
      var out = base.slice();
      forb.forEach(function (f) {
        var next = [];
        for (var i = 0; i < out.length; i++) {
          var seg = out[i];
          var a = seg[0], b = seg[1];
          var fa = f[0], fb = f[1];
          if (fb < a || fa > b) { next.push(seg); continue; }
          if (fa <= a && fb >= b) { continue; }
          if (fa > a) next.push([a, fa - 1]);
          if (fb < b) next.push([fb + 1, b]);
        }
        out = next;
      });
      return out;
    }

    function computeSnapX_ForType(state, openingId, type) {
      var d = getOpeningById(state, openingId);
      if (!d || String(d.type || "") !== type) return null;

      var minGap = 50;
      var wall = String(d.wall || "front");
      var lens = getWallLengthsForOpenings(state);
      var L = lens[wall] != null ? Math.max(1, Math.floor(lens[wall])) : 1;

      var w = Math.max(1, Math.floor(Number(d.width_mm || 900)));
      var desired = Math.floor(Number(d.x_mm || 0));

      var minX = minGap;
      var maxX = Math.max(minX, L - w - minGap);

      var base = [[minX, maxX]];
      var openings = (type === "door" ? getDoorsFromState(state) : getWindowsFromState(state))
        .filter(function (x) { return String(x.id || "") !== String(openingId) && String(x.wall || "front") === wall; });

      var forb = [];
      for (var i = 0; i < openings.length; i++) {
        var o = openings[i];
        var ox = Math.floor(Number(o.x_mm || 0));
        var ow = Math.max(1, Math.floor(Number(o.width_mm || 900)));
        var fa = (ox - minGap - w);
        var fb = (ox + ow + minGap);
        forb.push([fa, fb]);
      }

      var allowed = subtractIntervals(base, forb);
      if (!allowed.length) return clamp(desired, minX, maxX);

      var best = null;
      var bestDist = Infinity;

      for (var k = 0; k < allowed.length; k++) {
        var seg = allowed[k];
        var a = seg[0], b = seg[1];
        var x = clamp(desired, a, b);
        var dist = Math.abs(x - desired);
        if (dist < bestDist) { bestDist = dist; best = x; }
      }

      return best == null ? clamp(desired, minX, maxX) : best;
    }

    var _invalidSyncGuard = false;

    function syncInvalidOpeningsIntoState() {
      if (_invalidSyncGuard) return;

      var s = store.getState();
      var dv = validateDoors(s);
      var wv = validateWindows(s);

      var curDoors = (s && s.walls && Array.isArray(s.walls.invalidDoorIds)) ? s.walls.invalidDoorIds.map(String) : [];
      var curWins = (s && s.walls && Array.isArray(s.walls.invalidWindowIds)) ? s.walls.invalidWindowIds.map(String) : [];

      var nextDoors = dv.invalidIds.slice().sort();
      var nextWins = wv.invalidIds.slice().sort();

      function sameArr(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      }

      var curDoorsS = curDoors.slice().sort();
      var curWinsS = curWins.slice().sort();

      var need = (!sameArr(curDoorsS, nextDoors)) || (!sameArr(curWinsS, nextWins));
      if (need) {
        _invalidSyncGuard = true;
        store.setState({ walls: { invalidDoorIds: nextDoors, invalidWindowIds: nextWins } });
        _invalidSyncGuard = false;
      }

      return { doors: dv, windows: wv };
    }

    var snapNoticeDoorById = {};
    var snapNoticeWinById = {};

    function patchOpeningById(openingId, patch) {
      var s = store.getState();
      var cur = getOpeningsFromState(s);
      var next = [];
      for (var i = 0; i < cur.length; i++) {
        var o = cur[i];
        if (o && String(o.id || "") === String(openingId)) next.push(Object.assign({}, o, patch));
        else next.push(o);
      }
      setOpenings(next);
    }

    function wireCommitOnly(inputEl, onCommit) {
      inputEl.addEventListener("blur", function () { onCommit(); });
      inputEl.addEventListener("keydown", function (e) {
        if (!e) return;
        if (e.key === "Enter") {
          e.preventDefault();
          try { e.target.blur(); } catch (ex) {}
        }
      });
    }

    function renderDoorsUi(state, validation) {
      if (!doorsListEl) return;
      doorsListEl.innerHTML = "";

      var doors = getDoorsFromState(state);

      for (var i = 0; i < doors.length; i++) {
        (function (door) {
          var id = String(door.id || "");

          var item = document.createElement("div");
          item.className = "doorItem";

          var top = document.createElement("div");
          top.className = "doorTop";

          var wallLabel = document.createElement("label");
          wallLabel.textContent = "Wall";
          var wallSel = document.createElement("select");
          wallSel.innerHTML =
            '<option value="front">front</option>' +
            '<option value="back">back</option>' +
            '<option value="left">left</option>' +
            '<option value="right">right</option>';
          wallSel.value = String(door.wall || "front");
          wallLabel.appendChild(wallSel);

          var actions = document.createElement("div");
          actions.className = "doorActions";

          var snapBtn = document.createElement("button");
          snapBtn.type = "button";
          snapBtn.className = "snapBtn";
          snapBtn.textContent = "Snap to nearest viable position";

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.textContent = "Remove";

          actions.appendChild(snapBtn);
          actions.appendChild(rmBtn);

          top.appendChild(wallLabel);
          top.appendChild(actions);

          var row = document.createElement("div");
          row.className = "row3";

          function makeNum(labelTxt, v, min, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(min);
            inp.step = String(step);
            inp.value = String(v == null ? "" : v);
            lab.appendChild(inp);
            return { lab: lab, inp: inp };
          }

          var xField = makeNum("Door X (mm)", Math.floor(Number(door.x_mm ?? 0)), 0, 10);
          var wField = makeNum("Door W (mm)", Math.floor(Number(door.width_mm ?? 900)), 100, 10);
          var hField = makeNum("Door H (mm)", Math.floor(Number(door.height_mm ?? 2000)), 100, 10);

          row.appendChild(xField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          var msg = document.createElement("div");
          msg.className = "doorMsg";

          var invalidMsg = validation && validation.invalidById ? validation.invalidById[id] : null;
          var notice = snapNoticeDoorById[id] ? snapNoticeDoorById[id] : null;

          if (invalidMsg) {
            msg.textContent = String(invalidMsg);
            msg.classList.add("show");
            snapBtn.classList.add("show");
          } else if (notice) {
            msg.textContent = String(notice);
            msg.classList.add("show");
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: asNonNegInt(xField.inp.value, Math.floor(Number(door.x_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: asPosInt(wField.inp.value, Math.floor(Number(door.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: asPosInt(hField.inp.value, Math.floor(Number(door.height_mm ?? 2000))) } );
          });

          wallSel.addEventListener("change", function () {
            patchOpeningById(id, { wall: String(wallSel.value || "front") });
          });

          snapBtn.addEventListener("click", function () {
            var s = store.getState();
            var snapped = computeSnapX_ForType(s, id, "door");
            if (snapped == null) return;
            patchOpeningById(id, { x_mm: snapped });

            snapNoticeDoorById[id] = "Snapped to " + snapped + "mm.";
            setTimeout(function () {
              if (snapNoticeDoorById[id] === ("Snapped to " + snapped + "mm.")) delete snapNoticeDoorById[id];
              syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
            }, 1500);
          });

          rmBtn.addEventListener("click", function () {
            var s = store.getState();
            var cur = getOpeningsFromState(s);
            var next = [];
            for (var k = 0; k < cur.length; k++) {
              var o = cur[k];
              if (o && o.type === "door" && String(o.id || "") === id) continue;
              next.push(o);
            }
            delete snapNoticeDoorById[id];
            setOpenings(next);
          });

          item.appendChild(top);
          item.appendChild(row);
          item.appendChild(msg);

          doorsListEl.appendChild(item);
        })(doors[i]);
      }

      if (!doors.length) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No doors.";
        doorsListEl.appendChild(empty);
      }
    }

    function renderWindowsUi(state, validation) {
      if (!windowsListEl) return;
      windowsListEl.innerHTML = "";

      var wins = getWindowsFromState(state);

      for (var i = 0; i < wins.length; i++) {
        (function (win) {
          var id = String(win.id || "");

          var item = document.createElement("div");
          item.className = "windowItem";

          var top = document.createElement("div");
          top.className = "windowTop";

          var wallLabel = document.createElement("label");
          wallLabel.textContent = "Wall";
          var wallSel = document.createElement("select");
          wallSel.innerHTML =
            '<option value="front">front</option>' +
            '<option value="back">back</option>' +
            '<option value="left">left</option>' +
            '<option value="right">right</option>';
          wallSel.value = String(win.wall || "front");
          wallLabel.appendChild(wallSel);

          var actions = document.createElement("div");
          actions.className = "windowActions";

          var snapBtn = document.createElement("button");
          snapBtn.type = "button";
          snapBtn.className = "snapBtn";
          snapBtn.textContent = "Snap to nearest viable position";

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.textContent = "Remove";

          actions.appendChild(snapBtn);
          actions.appendChild(rmBtn);

          top.appendChild(wallLabel);
          top.appendChild(actions);

          var row = document.createElement("div");
          row.className = "row4";

          function makeNum(labelTxt, v, min, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(min);
            inp.step = String(step);
            inp.value = String(v == null ? "" : v);
            lab.appendChild(inp);
            return { lab: lab, inp: inp };
          }

          var xField = makeNum("Win X (mm)", Math.floor(Number(win.x_mm ?? 0)), 0, 10);
          var yField = makeNum("Win Y (mm)", Math.floor(Number(win.y_mm ?? 0)), 0, 10);
          var wField = makeNum("Win W (mm)", Math.floor(Number(win.width_mm ?? 900)), 100, 10);
          var hField = makeNum("Win H (mm)", Math.floor(Number(win.height_mm ?? 600)), 100, 10);

          row.appendChild(xField.lab);
          row.appendChild(yField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          var msg = document.createElement("div");
          msg.className = "windowMsg";

          var invalidMsg = validation && validation.invalidById ? validation.invalidById[id] : null;
          var notice = snapNoticeWinById[id] ? snapNoticeWinById[id] : null;

          if (invalidMsg) {
            msg.textContent = String(invalidMsg);
            msg.classList.add("show");
            snapBtn.classList.add("show");
          } else if (notice) {
            msg.textContent = String(notice);
            msg.classList.add("show");
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: asNonNegInt(xField.inp.value, Math.floor(Number(win.x_mm ?? 0))) });
          });
          wireCommitOnly(yField.inp, function () {
            patchOpeningById(id, { y_mm: asNonNegInt(yField.inp.value, Math.floor(Number(win.y_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: asPosInt(wField.inp.value, Math.floor(Number(win.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: asPosInt(hField.inp.value, Math.floor(Number(win.height_mm ?? 600))) });
          });

          wallSel.addEventListener("change", function () {
            patchOpeningById(id, { wall: String(wallSel.value || "front") });
          });

          snapBtn.addEventListener("click", function () {
            var s = store.getState();
            var snapped = computeSnapX_ForType(s, id, "window");
            if (snapped == null) return;
            patchOpeningById(id, { x_mm: snapped });

            snapNoticeWinById[id] = "Snapped to " + snapped + "mm.";
            setTimeout(function () {
              if (snapNoticeWinById[id] === ("Snapped to " + snapped + "mm.")) delete snapNoticeWinById[id];
              syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
            }, 1500);
          });

          rmBtn.addEventListener("click", function () {
            var s = store.getState();
            var cur = getOpeningsFromState(s);
            var next = [];
            for (var k = 0; k < cur.length; k++) {
              var o = cur[k];
              if (o && o.type === "window" && String(o.id || "") === id) continue;
              next.push(o);
            }
            delete snapNoticeWinById[id];
            setOpenings(next);
          });

          item.appendChild(top);
          item.appendChild(row);
          item.appendChild(msg);

          windowsListEl.appendChild(item);
        })(wins[i]);
      }

      if (!wins.length) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No windows.";
        windowsListEl.appendChild(empty);
      }
    }

    function syncUiFromState(state, validations) {
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

        if (roofStyleEl) {
          roofStyleEl.value = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
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

        if (wallSectionEl && state && state.walls) {
          var h = null;
          try {
            if (state.walls.insulated && state.walls.insulated.section && state.walls.insulated.section.h != null) h = state.walls.insulated.section.h;
            else if (state.walls.basic && state.walls.basic.section && state.walls.basic.section.h != null) h = state.walls.basic.section.h;
          } catch (e) {}
          wallSectionEl.value = (Math.floor(Number(h)) === 75) ? "50x75" : "50x100";
        }

        var dv = validations && validations.doors ? validations.doors : null;
        var wv = validations && validations.windows ? validations.windows : null;

        renderDoorsUi(state, dv);
        renderWindowsUi(state, wv);
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

    if (roofStyleEl) {
      roofStyleEl.addEventListener("change", function () {
        var v = String(roofStyleEl.value || "apex");
        if (v !== "apex" && v !== "pent" && v !== "hipped") v = "apex";
        store.setState({ roof: { style: v } });
      });
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
        syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
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

    if (addDoorBtnEl) {
      addDoorBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var lens = getWallLengthsForOpenings(s);
        var openings = getOpeningsFromState(s);

        var id = "door" + String(window.__dbg.doorSeq++);
        var wall = "front";
        var w = 900;
        var h = 2000;
        var L = lens[wall] || 1000;
        var x = Math.floor((L - w) / 2);

        openings.push({ id: id, wall: wall, type: "door", enabled: true, x_mm: x, width_mm: w, height_mm: h });
        setOpenings(openings);
      });
    }

    if (removeAllDoorsBtnEl) {
      removeAllDoorsBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var cur = getOpeningsFromState(s);
        var next = [];
        for (var i = 0; i < cur.length; i++) {
          var o = cur[i];
          if (o && o.type === "door") continue;
          next.push(o);
        }
        snapNoticeDoorById = {};
        setOpenings(next);
      });
    }

    if (addWindowBtnEl) {
      addWindowBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var lens = getWallLengthsForOpenings(s);
        var openings = getOpeningsFromState(s);

        var id = "win" + String(window.__dbg.windowSeq++);
        var wall = "front";
        var w = 900;
        var h = 600;
        var y = 900;
        var L = lens[wall] || 1000;
        var x = Math.floor((L - w) / 2);

        openings.push({ id: id, wall: wall, type: "window", enabled: true, x_mm: x, y_mm: y, width_mm: w, height_mm: h });
        setOpenings(openings);
      });
    }

    if (removeAllWindowsBtnEl) {
      removeAllWindowsBtnEl.addEventListener("click", function () {
        var s = store.getState();
        var cur = getOpeningsFromState(s);
        var next = [];
        for (var i = 0; i < cur.length; i++) {
          var o = cur[i];
          if (o && o.type === "window") continue;
          next.push(o);
        }
        snapNoticeWinById = {};
        setOpenings(next);
      });
    }

    store.onChange(function (s) {
      var v = syncInvalidOpeningsIntoState();
      syncUiFromState(s, v);
      render(s);
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

    initInstances();

    syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
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
