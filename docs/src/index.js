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
  if (window.__dbg.viewSnap === undefined) window.__dbg.viewSnap = {};
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
import { initInstancesUI } from "./instances.js";

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

function ensureRequiredDomScaffolding() {
  function ensureEl(tag, id, parent) {
    var el = $(id);
    if (el) return el;
    el = document.createElement(tag);
    el.id = id;
    (parent || document.body).appendChild(el);
    return el;
  }

  // Ensure core view containers exist so view switching + BOM rendering does not crash.
  var bomPage = $("bomPage") || ensureEl("div", "bomPage", document.body);
  var wallsPage = $("wallsBomPage") || ensureEl("div", "wallsBomPage", document.body);
  var roofPage = $("roofBomPage") || ensureEl("div", "roofBomPage", document.body);

  // Make sure they start hidden (view system will show/hide).
  if (bomPage && bomPage.style && bomPage.style.display === "") bomPage.style.display = "none";
  if (wallsPage && wallsPage.style && wallsPage.style.display === "") wallsPage.style.display = "none";
  if (roofPage && roofPage.style && roofPage.style.display === "") roofPage.style.display = "none";

  // Walls cutting list table (renderBOM targets #bomTable)
  if (!$("bomTable")) {
    var t = document.createElement("table");
    t.id = "bomTable";
    var tb = document.createElement("tbody");
    t.appendChild(tb);
    wallsPage.appendChild(t);
  }

  // Base cutting list common targets (Base module writes into these IDs)
  if (!$("timberTableBody")) {
    var timberTable = document.createElement("table");
    timberTable.id = "timberTable";
    var thead1 = document.createElement("thead");
    var trh1 = document.createElement("tr");
    trh1.innerHTML = "<th>Item</th><th>Qty</th><th>L</th><th>W</th><th>D</th><th>Notes</th>";
    thead1.appendChild(trh1);
    timberTable.appendChild(thead1);
    var tbody1 = document.createElement("tbody");
    tbody1.id = "timberTableBody";
    timberTable.appendChild(tbody1);
    bomPage.appendChild(timberTable);
  }
  if (!$("timberTotals")) {
    var tt = document.createElement("div");
    tt.id = "timberTotals";
    bomPage.appendChild(tt);
  }
  if (!$("osbStdBody")) {
    var osbStd = document.createElement("table");
    osbStd.id = "osbStdTable";
    var tbody2 = document.createElement("tbody");
    tbody2.id = "osbStdBody";
    osbStd.appendChild(tbody2);
    bomPage.appendChild(osbStd);
  }
  if (!$("osbRipBody")) {
    var osbRip = document.createElement("table");
    osbRip.id = "osbRipTable";
    var tbody3 = document.createElement("tbody");
    tbody3.id = "osbRipBody";
    osbRip.appendChild(tbody3);
    bomPage.appendChild(osbRip);
  }
  if (!$("pirBody")) {
    var pir = document.createElement("table");
    pir.id = "pirTable";
    var tbody4 = document.createElement("tbody");
    tbody4.id = "pirBody";
    pir.appendChild(tbody4);
    bomPage.appendChild(pir);
  }
  if (!$("gridBody")) {
    var grid = document.createElement("table");
    grid.id = "gridTable";
    var tbody5 = document.createElement("tbody");
    tbody5.id = "gridBody";
    grid.appendChild(tbody5);
    bomPage.appendChild(grid);
  }

  // Roof cutting list target (roof module renders into #roofBomTable if present)
  if (!$("roofBomTable")) {
    var roofTable = document.createElement("table");
    roofTable.id = "roofBomTable";
    var roofTbody = document.createElement("tbody");
    roofTable.appendChild(roofTbody);
    roofPage.appendChild(roofTable);
  }
}

function initApp() {
  try {
    ensureRequiredDomScaffolding();

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

    var roofMinHeightEl = $("roofMinHeight");
    var roofMaxHeightEl = $("roofMaxHeight");

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

    function applyWallHeightUiLock(state) {
      if (!wallHeightEl) return;

      var style = "";
      try {
        style = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "";
      } catch (e0) { style = ""; }
      if (!style && roofStyleEl) style = String(roofStyleEl.value || "");

      if (style === "pent") {
        wallHeightEl.disabled = true;
        wallHeightEl.setAttribute("aria-disabled", "true");
        wallHeightEl.title = "Disabled for pent roof (use Roof Min/Max Height).";
      } else {
        wallHeightEl.disabled = false;
        try { wallHeightEl.removeAttribute("aria-disabled"); } catch (e1) {}
        try { wallHeightEl.removeAttribute("title"); } catch (e2) {}
      }
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
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, true);

      try { if (engine && typeof engine.resize === "function") engine.resize(); } catch (e) {}
      try { if (camera && typeof camera.attachControl === "function") camera.attachControl(canvas, true); } catch (e) {}
    }

    function showWallsBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "block");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, false);
      setAriaHidden(roofPage, true);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    function showBaseBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "block");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "none");
      setAriaHidden(bomPage, false);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, true);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    function showRoofBOM() {
      var camera = window.__dbg.camera;

      setDisplay(canvas, "none");
      setAriaHidden(canvas, true);

      var bomPage = $("bomPage");
      var wallsPage = $("wallsBomPage");
      var roofPage = $("roofBomPage");
      setDisplay(bomPage, "none");
      setDisplay(wallsPage, "none");
      setDisplay(roofPage, "block");
      setAriaHidden(bomPage, true);
      setAriaHidden(wallsPage, true);
      setAriaHidden(roofPage, false);

      try { if (camera && typeof camera.detachControl === "function") camera.detachControl(); } catch (e) {}
    }

    // ---- NEW: deterministic view snapping helpers (camera + framing) ----
    function getActiveSceneCamera() {
      var scene = window.__dbg && window.__dbg.scene ? window.__dbg.scene : null;
      var camera = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      return { scene: scene, camera: camera };
    }

    function isFiniteVec3(v) {
      return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
    }

    function computeModelBoundsWorld(scene) {
      var BAB = window.BABYLON;
      if (!scene || !BAB) return null;

      var min = new BAB.Vector3(+Infinity, +Infinity, +Infinity);
      var max = new BAB.Vector3(-Infinity, -Infinity, -Infinity);
      var any = false;

      var meshes = scene.meshes || [];
      for (var i = 0; i < meshes.length; i++) {
        var m = meshes[i];
        if (!m) continue;
        if (m.isDisposed && m.isDisposed()) continue;
        if (m.isVisible === false) continue;

        // Prefer dynamic + core model meshes; skip obvious non-model overlays if any.
        var nm = String(m.name || "");
        var isModel = (m.metadata && m.metadata.dynamic === true) ||
          nm.indexOf("wall-") === 0 || nm.indexOf("roof-") === 0 || nm.indexOf("base-") === 0 || nm.indexOf("clad-") === 0;
        if (!isModel) continue;

        try { m.computeWorldMatrix(true); } catch (e0) {}

        var bi = null;
        try { bi = (typeof m.getBoundingInfo === "function") ? m.getBoundingInfo() : null; } catch (e1) { bi = null; }
        if (!bi || !bi.boundingBox) continue;

        var bb = bi.boundingBox;
        var mi = bb.minimumWorld, ma = bb.maximumWorld;
        if (!isFiniteVec3(mi) || !isFiniteVec3(ma)) continue;

        any = true;
        min.x = Math.min(min.x, mi.x); min.y = Math.min(min.y, mi.y); min.z = Math.min(min.z, mi.z);
        max.x = Math.max(max.x, ma.x); max.y = Math.max(max.y, ma.y); max.z = Math.max(max.z, ma.z);
      }

      if (!any) return null;

      var center = min.add(max).scale(0.5);
      var ext = max.subtract(min).scale(0.5);
      return { min: min, max: max, center: center, extents: ext };
    }

    function setOrthoForView(camera, viewName, bounds) {
      var BAB = window.BABYLON;
      if (!BAB || !camera || !bounds) return;

      // True orthographic for these snapped views.
      try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e0) {}

      var ext = bounds.extents;
      var margin = 1.10;

      // Determine ortho extents in the view plane.
      var halfW = 1, halfH = 1;

      if (viewName === "plan") {
        // X (width) and Z (depth) are visible; vertical is Y.
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.z));
      } else if (viewName === "front" || viewName === "back") {
        // X (width) and Y (height) are visible; depth is Z.
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.y));
      } else if (viewName === "left" || viewName === "right") {
        // Z (depth) and Y (height) are visible; width is X.
        halfW = Math.max(0.01, Math.abs(ext.z));
        halfH = Math.max(0.01, Math.abs(ext.y));
      } else {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.y));
      }

      halfW *= margin;
      halfH *= margin;

      try {
        camera.orthoLeft = -halfW;
        camera.orthoRight = +halfW;
        camera.orthoBottom = -halfH;
        camera.orthoTop = +halfH;
      } catch (e1) {}
    }

    function setArcRotateOrientation(camera, viewName) {
      // Deterministic axis-aligned orientations:
      // Babylon ArcRotate:
      //   x = r*cos(alpha)*sin(beta)
      //   z = r*sin(alpha)*sin(beta)
      //   y = r*cos(beta)
      var PI = Math.PI;

      var alpha = camera.alpha != null ? camera.alpha : 0;
      var beta = camera.beta != null ? camera.beta : (PI / 2);

      if (viewName === "plan") {
        // Top-down: beta near 0 (avoid singularity).
        beta = 0.0001;
        alpha = PI / 2;
      } else if (viewName === "front") {
        // Camera on +Z axis looking toward origin.
        beta = PI / 2;
        alpha = PI / 2;
      } else if (viewName === "back") {
        // Camera on -Z axis.
        beta = PI / 2;
        alpha = -PI / 2;
      } else if (viewName === "right") {
        // Camera on +X axis.
        beta = PI / 2;
        alpha = 0;
      } else if (viewName === "left") {
        // Camera on -X axis.
        beta = PI / 2;
        alpha = PI;
      }

      try { camera.alpha = alpha; } catch (e0) {}
      try { camera.beta = beta; } catch (e1) {}
    }

    function frameCameraToBounds(camera, bounds, viewName) {
      var BAB = window.BABYLON;
      if (!BAB || !camera || !bounds) return;

      var c = bounds.center;

      // Set target to model center (deterministic).
      try {
        if (typeof camera.setTarget === "function") camera.setTarget(c);
        else if (camera.target) camera.target = c;
      } catch (e0) {}

      // Ensure radius is sane so camera is outside bounds even in ortho mode.
      var ext = bounds.extents;
      var maxDim = Math.max(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
      var safeR = Math.max(0.5, maxDim * 4.0);

      try {
        if (camera.radius != null) camera.radius = safeR;
      } catch (e1) {}

      // Apply orthographic extents for the specific snapped view.
      setOrthoForView(camera, viewName, bounds);

      // Keep near/far stable-ish.
      try {
        if (camera.minZ != null) camera.minZ = 0.01;
        if (camera.maxZ != null) camera.maxZ = Math.max(100, safeR * 50);
      } catch (e2) {}
    }

    function snapCameraToView(viewName) {
      var BAB = window.BABYLON;
      var sc = getActiveSceneCamera();
      var scene = sc.scene;
      var camera = sc.camera;

      if (!BAB || !scene || !camera) return false;

      // Compute bounds of the current built model.
      var bounds = computeModelBoundsWorld(scene);
      if (!bounds) return false;

      // ArcRotate path (preferred if present).
      var isArcRotate = (camera.alpha != null && camera.beta != null && camera.radius != null);

      try {
        if (isArcRotate) {
          setArcRotateOrientation(camera, viewName);
          frameCameraToBounds(camera, bounds, viewName);
        } else {
          // Fallback: try generic target + position alignment.
          var c = bounds.center;
          var ext = bounds.extents;
          var maxDim = Math.max(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
          var dist = Math.max(0.5, maxDim * 4.0);

          var pos = null;
          if (viewName === "plan") pos = new BAB.Vector3(c.x, c.y + dist, c.z);
          else if (viewName === "front") pos = new BAB.Vector3(c.x, c.y, c.z + dist);
          else if (viewName === "back") pos = new BAB.Vector3(c.x, c.y, c.z - dist);
          else if (viewName === "right") pos = new BAB.Vector3(c.x + dist, c.y, c.z);
          else if (viewName === "left") pos = new BAB.Vector3(c.x - dist, c.y, c.z);

          if (pos) {
            try { camera.position = pos; } catch (e0) {}
            try { if (typeof camera.setTarget === "function") camera.setTarget(c); } catch (e1) {}
          }

          // If the camera supports ortho, apply ortho bounds too.
          try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e2) {}
          setOrthoForView(camera, viewName, bounds);
        }

        // Debug stamp (optional, non-invasive)
        try {
          window.__dbg.viewSnap.last = { view: viewName, t: Date.now() };
        } catch (e3) {}

        return true;
      } catch (e) {
        window.__dbg.lastError = "snapCameraToView failed: " + String(e && e.message ? e.message : e);
        return false;
      }
    }
    // ---- END view snapping helpers ----

    // Expose hooks for views.js (no dependency/import changes).
    window.__viewHooks = {
      resume3D: resume3D,
      showWallsBOM: showWallsBOM,
      showBaseBOM: showBaseBOM,
      showRoofBOM: showRoofBOM,

      // NEW: camera snap API for views.js
      getActiveSceneCamera: getActiveSceneCamera,
      snapCameraToView: snapCameraToView
    };

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

    function isPentRoofStyle(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      return roofStyle === "pent";
    }

    function clampHeightMm(v, def) {
      var n = Math.max(100, Math.floor(Number(v)));
      return Number.isFinite(n) ? n : def;
    }

    function getPentMinMax(state) {
      var base = (state && state.walls && state.walls.height_mm != null) ? clampHeightMm(state.walls.height_mm, 2400) : 2400;
      var p = (state && state.roof && state.roof.pent) ? state.roof.pent : null;
      var minH = clampHeightMm(p && p.minHeight_mm != null ? p.minHeight_mm : base, base);
      var maxH = clampHeightMm(p && p.maxHeight_mm != null ? p.maxHeight_mm : base, base);
      return { minH: minH, maxH: maxH };
    }

    function computePentDisplayHeight(state) {
      var mm = getPentMinMax(state);
      var mid = Math.round((mm.minH + mm.maxH) / 2);
      return Math.max(100, mid);
    }

    function getPentHeightsFromState(state) {
      var base = (state && state.walls && state.walls.height_mm != null) ? clampHeightMm(state.walls.height_mm, 2400) : 2400;
      var p = (state && state.roof && state.roof.pent) ? state.roof.pent : null;
      var minH = clampHeightMm(p && p.minHeight_mm != null ? p.minHeight_mm : base, base);
      var maxH = clampHeightMm(p && p.maxHeight_mm != null ? p.maxHeight_mm : base, base);
      return { minH: minH, maxH: maxH, base: base };
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

        var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";

        // Build roof for supported styles (pent + apex). (No behavior change for pent.)
        if (roofStyle === "pent" || roofStyle === "apex") {
          var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(R.roof.w_mm)) : Math.max(1, Math.floor(R.base.w_mm));
          var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(R.roof.d_mm)) : Math.max(1, Math.floor(R.base.d_mm));
          var roofState = Object.assign({}, state, { w: roofW, d: roofD });

          if (Roof && typeof Roof.build3D === "function") Roof.build3D(roofState, ctx);
          shiftRoofMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);

          if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(roofState);
        } else {
          try {
            if (Roof && typeof Roof.updateBOM === "function") Roof.updateBOM(Object.assign({}, state, { roof: Object.assign({}, state.roof || {}, { style: roofStyle }) }));
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

    // ... remainder of file unchanged ...
    // NOTE: Your provided snippet ends mid-file in this chat; keep the remainder of your existing file content exactly as-is below this point.