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
    var toastContainerEl = $("toastContainer");

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

    var wallSectionEl = $("wallSection"); // NEW
    var wallsVariantEl = $("wallsVariant");
    var wallHeightEl = $("wallHeight");

    var addDoorBtnEl = $("addDoorBtn");
    var removeAllDoorsBtnEl = $("removeAllDoorsBtn");
    var doorsListEl = $("doorsList");

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

    function showToast(msg) {
      if (!toastContainerEl) return;
      var el = document.createElement("div");
      el.className = "toastBubble";
      el.textContent = String(msg || "");
      toastContainerEl.appendChild(el);
      try { requestAnimationFrame(function () { el.classList.add("show"); }); } catch (e) { try { el.classList.add("show"); } catch (e2) {} }

      var removed = false;
      function removeNow() {
        if (removed) return;
        removed = true;
        try { el.classList.remove("show"); } catch (e) {}
        setTimeout(function () { try { el.remove(); } catch (e2) {} }, 260);
      }

      setTimeout(removeNow, 4000);
    }

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

    function getWallLengthsForDoors(state) {
      var dims = getWallOuterDimsFromState(state);
      var thk = currentWallThicknessFromState(state);
      return {
        front: Math.max(1, Math.floor(dims.w_mm)),
        back: Math.max(1, Math.floor(dims.w_mm)),
        left: Math.max(1, Math.floor(dims.d_mm - 2 * thk)),
        right: Math.max(1, Math.floor(dims.d_mm - 2 * thk))
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

        if (Walls && typeof Walls.updateBOM === "function") {
          var wallsBom = Walls.updateBOM(wallState);
          if (wallsBom && wallsBom.sections) renderBOM(wallsBom.sections);
        }

        if (Base && typeof Base.updateBOM === "function") Base.updateBOM(baseState);
      } catch (e) {
        window.__dbg.lastError = "render() failed: " + String(e && e.message ? e.message : e);
      }
    }

    function setOpenings(nextDoors) {
      var cur = store.getState();
      var curOpenings = (cur && cur.walls && Array.isArray(cur.walls.openings)) ? cur.walls.openings : [];
      var nonDoors = [];
      for (var i = 0; i < curOpenings.length; i++) {
        var o = curOpenings[i];
        if (o && o.type === "door") continue;
        nonDoors.push(o);
      }
      store.setState({ walls: { openings: nonDoors.concat(nextDoors) } });
    }

    function getDoorsFromState(state) {
      var openings = state && state.walls && Array.isArray(state.walls.openings) ? state.walls.openings : [];
      var doors = [];
      for (var i = 0; i < openings.length; i++) {
        var d = openings[i];
        if (d && d.type === "door") doors.push(d);
      }
      return doors;
    }

    function renderDoorsUi(state) {
      if (!doorsListEl) return;
      doorsListEl.innerHTML = "";

      var doors = getDoorsFromState(state);
      for (var i = 0; i < doors.length; i++) {
        (function (door) {
          var id = String(door.id || "");
          var wrap = document.createElement("div");

          var rowA = document.createElement("div");
          rowA.className = "row";
          rowA.style.marginTop = "8px";

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

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.textContent = "Remove";
          rmBtn.setAttribute("data-door-id", id);

          rowA.appendChild(wallLabel);
          rowA.appendChild(rmBtn);

          var rowB = document.createElement("div");
          rowB.className = "row3";

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

          rowB.appendChild(xField.lab);
          rowB.appendChild(wField.lab);
          rowB.appendChild(hField.lab);

          wrap.appendChild(rowA);
          wrap.appendChild(rowB);

          function patchDoorById(doorId, patch) {
            var s = store.getState();
            var curDoors = getDoorsFromState(s);
            var next = [];
            for (var k = 0; k < curDoors.length; k++) {
              var d = curDoors[k];
              if (String(d.id || "") === String(doorId)) next.push(Object.assign({}, d, patch));
              else next.push(d);
            }
            setOpenings(next);
          }

          wallSel.addEventListener("change", function () {
            patchDoorById(id, { wall: String(wallSel.value || "front") });
          });
          xField.inp.addEventListener("input", function () {
            patchDoorById(id, { x_mm: asNonNegInt(xField.inp.value, Math.floor(Number(door.x_mm ?? 0))) });
          });
          wField.inp.addEventListener("input", function () {
            patchDoorById(id, { width_mm: asPosInt(wField.inp.value, Math.floor(Number(door.width_mm ?? 900))) });
          });
          hField.inp.addEventListener("input", function () {
            patchDoorById(id, { height_mm: asPosInt(hField.inp.value, Math.floor(Number(door.height_mm ?? 2000))) });
          });

          rmBtn.addEventListener("click", function () {
            var s = store.getState();
            var curDoors = getDoorsFromState(s);
            var next = [];
            for (var k = 0; k < curDoors.length; k++) {
              var d = curDoors[k];
              if (String(d.id || "") === id) continue;
              next.push(d);
            }
            setOpenings(next);
          });

          doorsListEl.appendChild(wrap);
        })(doors[i]);
      }

      if (!doors.length) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No doors.";
        doorsListEl.appendChild(empty);
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

        renderDoorsUi(state);
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

    // NEW: Stud/Plate size -> updates BOTH variants' section.h (50×75 or 50×100)
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
        var lens = getWallLengthsForDoors(s);
        var doors = getDoorsFromState(s);

        var id = "door" + String(window.__dbg.doorSeq++);
        var wall = "front";
        var w = 900;
        var h = 2000;
        var L = lens[wall] || 1000;
        var x = Math.floor((L - w) / 2);

        doors.push({ id: id, wall: wall, type: "door", enabled: true, x_mm: x, width_mm: w, height_mm: h });
        setOpenings(doors);
      });
    }

    if (removeAllDoorsBtnEl) {
      removeAllDoorsBtnEl.addEventListener("click", function () {
        setOpenings([]);
      });
    }

    var _snappingGuard = false;

    function openingsEqual(a, b) {
      if (a === b) return true;
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        var da = a[i], db = b[i];
        if (!da || !db) return false;
        if (String(da.id || "") !== String(db.id || "")) return false;
        if (String(da.wall || "") !== String(db.wall || "")) return false;
        if (Math.floor(Number(da.x_mm)) !== Math.floor(Number(db.x_mm))) return false;
        if (Math.floor(Number(da.width_mm)) !== Math.floor(Number(db.width_mm))) return false;
        if (Math.floor(Number(da.height_mm)) !== Math.floor(Number(db.height_mm))) return false;
        if (String(da.type || "") !== String(db.type || "")) return false;
        if (!!da.enabled !== !!db.enabled) return false;
      }
      return true;
    }

    function applyDoorSnappingIfNeeded(s) {
      if (_snappingGuard) return false;
      if (!Walls || typeof Walls.snapOpeningsForState !== "function") return false;
      if (!s || !s.walls || !Array.isArray(s.walls.openings)) return false;

      var res = null;
      try { res = Walls.snapOpeningsForState(s); } catch (e) { return false; }
      if (!res || !Array.isArray(res.openings)) return false;

      if (res.events && res.events.length) {
        for (var i = 0; i < res.events.length; i++) showToast(res.events[i]);
      }

      if (!openingsEqual(s.walls.openings, res.openings)) {
        _snappingGuard = true;
        store.setState({ walls: { openings: res.openings } });
        _snappingGuard = false;
        return true;
      }
      return false;
    }

    store.onChange(function (s) {
      if (applyDoorSnappingIfNeeded(s)) return;
      syncUiFromState(s);
      render(s);
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

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