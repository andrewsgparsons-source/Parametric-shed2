/**
 * @fileoverview Main Application Entry Point
 * 
 * This is the primary orchestrator for the Parametric Shed Configurator.
 * It handles:
 * - Babylon.js scene initialization
 * - State management and reactive updates
 * - UI panel generation and event binding
 * - Profile system for different user modes (admin/customer/viewer)
 * - URL state encoding/decoding for shareable designs
 * - BOM (Bill of Materials) calculation and display
 * 
 * ## Application Flow
 * 1. Load profile definitions from profiles.json
 * 2. Initialize Babylon.js scene with materials
 * 3. Create state store with defaults (or from URL)
 * 4. Generate UI controls based on active profile
 * 5. Subscribe to state changes → trigger rebuild()
 * 6. On any state change: dispose old geometry, build new, update BOM
 * 
 * ## Debug Access
 * Global `window.__dbg` object exposes:
 * - `engine` - Babylon.js engine instance
 * - `scene` - Babylon.js scene
 * - `camera` - Active camera
 * - `frames` - Frame counter
 * - `buildCalls` - Rebuild counter
 * - `lastError` - Last caught error
 * 
 * @module index
 */

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

import { createStateStore, deepMerge } from "./state.js";
import { DEFAULTS, resolveDims, CONFIG, createAttachment, ATTACHMENT_DEFAULTS } from "./params.js";
import { boot, disposeAll } from "./renderer/babylon.js";
import * as Base from "./elements/base.js";
import * as Walls from "./elements/walls.js";
import * as Dividers from "./elements/dividers.js";
import * as Roof from "./elements/roof.js";
import * as Attachments from "./elements/attachments.js";
import { renderBOM } from "./bom/index.js";
import { initInstancesUI } from "./instances.js";
import * as Doors from "./elements/doors.js";
import * as Windows from "./elements/windows.js";
import { findBuiltInPresetById, getDefaultBuiltInPresetId } from "../instances.js";
import { initViews } from "./views.js";
import * as Sections from "./sections.js";
import { isViewerMode, parseUrlState, applyViewerProfile, copyViewerUrlToClipboard, loadProfiles, applyProfile, getProfileFromUrl, isFieldVisible, isFieldDisabled, getFieldDefault, getFieldOptionRestrictions, getCurrentProfile, hideDisabledVisibilityControls } from "./profiles.js";
import { initProfileEditor } from "./profile-editor.js";
import { initPanelResize } from "./ui/panel-resize.js";

function $(id) { return document.getElementById(id); }
function setDisplay(el, val) { if (el && el.style) el.style.display = val; }
function setAriaHidden(el, hidden) { if (el) el.setAttribute("aria-hidden", String(!!hidden)); }

/**
 * Update the Openings (Doors & Windows) BOM tables
 */
function updateOpeningsBOM(state) {
  // Get doors BOM
  var doorsBom = (Doors && typeof Doors.updateBOM === "function") ? Doors.updateBOM(state) : { sections: [] };
  var doorsSections = (doorsBom && doorsBom.sections) ? doorsBom.sections : [];

  // Get windows BOM
  var windowsBom = (Windows && typeof Windows.updateBOM === "function") ? Windows.updateBOM(state) : { sections: [] };
  var windowsSections = (windowsBom && windowsBom.sections) ? windowsBom.sections : [];

  // Render doors table
  var doorsTbody = $("doorsBomTable");
  if (doorsTbody) {
    doorsTbody.innerHTML = "";
    if (doorsSections.length === 0) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 6;
      emptyCell.textContent = "No doors configured.";
      emptyRow.appendChild(emptyCell);
      doorsTbody.appendChild(emptyRow);
    } else {
      doorsSections.forEach(function(row) {
        var tr = document.createElement("tr");
        var item = row && row.length ? row[0] : "";
        var qty = row && row.length > 1 ? row[1] : "";
        var L = row && row.length > 2 ? row[2] : "";
        var W = row && row.length > 3 ? row[3] : "";
        var D = row && row.length > 4 ? row[4] : "";
        var notes = row && row.length > 5 ? row[5] : "";

        [item, qty, L, W, D, notes].forEach(function(val) {
          var td = document.createElement("td");
          td.textContent = String(val);
          tr.appendChild(td);
        });
        doorsTbody.appendChild(tr);
      });
    }
  }

  // Render windows table
  var windowsTbody = $("windowsBomTable");
  if (windowsTbody) {
    windowsTbody.innerHTML = "";
    if (windowsSections.length === 0) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 6;
      emptyCell.textContent = "No windows configured.";
      emptyRow.appendChild(emptyCell);
      windowsTbody.appendChild(emptyRow);
    } else {
      windowsSections.forEach(function(row) {
        var tr = document.createElement("tr");
        var item = row && row.length ? row[0] : "";
        var qty = row && row.length > 1 ? row[1] : "";
        var L = row && row.length > 2 ? row[2] : "";
        var W = row && row.length > 3 ? row[3] : "";
        var D = row && row.length > 4 ? row[4] : "";
        var notes = row && row.length > 5 ? row[5] : "";

        [item, qty, L, W, D, notes].forEach(function(val) {
          var td = document.createElement("td");
          td.textContent = String(val);
          tr.appendChild(td);
        });
        windowsTbody.appendChild(tr);
      });
    }
  }
}

var WALL_OVERHANG_MM = 25;
var WALL_RISE_MM = 168;

function shiftWallMeshes(scene, dx_mm, dy_mm, dz_mm, sectionContext) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;
  var sectionId = sectionContext && sectionContext.sectionId;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string") continue;
    if (m.name.indexOf("wall-") !== 0 && m.name.indexOf("clad-") !== 0) continue;
    // If section context provided, only shift meshes belonging to this section
    if (sectionId) {
      if (m.metadata.sectionId !== sectionId) continue;
      // In multi-section mode, skip meshes that have already been shifted
      if (m.metadata.__shifted) continue;
      m.metadata.__shifted = true;
    }
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  }
}

function shiftRoofMeshes(scene, dx_mm, dy_mm, dz_mm, sectionContext) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;
  var sectionId = sectionContext && sectionContext.sectionId;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("roof-") !== 0) continue;
    // If section context provided, only shift meshes belonging to this section
    if (sectionId) {
      if (m.metadata.sectionId !== sectionId) continue;
      // In multi-section mode, skip meshes that have already been shifted
      if (m.metadata.__shifted) continue;
      m.metadata.__shifted = true;
    }
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  }
}

function shiftDividerMeshes(scene, dx_mm, dy_mm, dz_mm, sectionContext) {
  if (!scene || !scene.meshes) return;
  var dx = (dx_mm || 0) / 1000;
  var dy = (dy_mm || 0) / 1000;
  var dz = (dz_mm || 0) / 1000;
  var sectionId = sectionContext && sectionContext.sectionId;

  for (var i = 0; i < scene.meshes.length; i++) {
    var m = scene.meshes[i];
    if (!m || !m.metadata || m.metadata.dynamic !== true) continue;
    if (typeof m.name !== "string" || m.name.indexOf("divider-") === -1) continue;
    // If section context provided, only shift meshes belonging to this section
    if (sectionId) {
      if (m.metadata.sectionId !== sectionId) continue;
      // In multi-section mode, skip meshes that have already been shifted
      if (m.metadata.__shifted) continue;
      m.metadata.__shifted = true;
    }
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
  var openingsPage = $("openingsBomPage") || ensureEl("div", "openingsBomPage", document.body);

  // Make sure they start hidden (view system will show/hide).
  if (bomPage && bomPage.style && bomPage.style.display === "") bomPage.style.display = "none";
  if (wallsPage && wallsPage.style && wallsPage.style.display === "") wallsPage.style.display = "none";
  if (roofPage && roofPage.style && roofPage.style.display === "") roofPage.style.display = "none";
  if (openingsPage && openingsPage.style && openingsPage.style.display === "") openingsPage.style.display = "none";

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

  var defaultPreset = findBuiltInPresetById(getDefaultBuiltInPresetId());

    // Debug: Log what we're starting with
    console.log("[INIT] DEFAULTS.vis:", DEFAULTS.vis);
    console.log("[INIT] defaultPreset.state.vis:", defaultPreset?.state?.vis);

    var initialState = defaultPreset && defaultPreset.state
      ? deepMerge(DEFAULTS, defaultPreset.state)
      : DEFAULTS;

    // Check for viewer mode - merge URL parameters into state
    var viewerMode = isViewerMode();
    if (viewerMode) {
      console.log("[INIT] Viewer mode detected - parsing URL state");
      var urlState = parseUrlState();
      console.log("[INIT] URL state:", urlState);
      initialState = deepMerge(initialState, urlState);
      console.log("[INIT] State after URL merge:", initialState);
      console.log("[INIT] State vis object:", initialState.vis);
      console.log("[INIT] State dim object:", initialState.dim);
    }

    // Check for profile links with state parameter (e.g., ?profile=customer&state=...)
    // This allows sharing specific models with profile-restricted controls
    var urlProfile = getProfileFromUrl();
    var hasStateParam = new URLSearchParams(window.location.search).has("state");
    console.log("[INIT] Profile URL check - urlProfile:", urlProfile, "hasStateParam:", hasStateParam, "viewerMode:", viewerMode);
    if (!viewerMode && urlProfile && hasStateParam) {
      console.log("[INIT] Profile link with state detected - parsing URL state");
      var profileUrlState = parseUrlState();
      console.log("[INIT] Parsed profile URL state:", profileUrlState);
      console.log("[INIT] Parsed state.dim:", profileUrlState.dim);
      console.log("[INIT] Parsed state.w:", profileUrlState.w);
      initialState = deepMerge(initialState, profileUrlState);
      console.log("[INIT] State after profile URL merge - dim:", initialState.dim);
      // Hide visibility checkboxes for components that are hidden in the shared state
      setTimeout(function() {
        hideDisabledVisibilityControls(initialState);
      }, 0);
    }

    var store = createStateStore(initialState);
    window.__dbg.store = store; // Expose for debugging
    window.__dbg.viewerMode = viewerMode; // Track viewer mode

    // Apply viewer profile UI changes after DOM is ready
    if (viewerMode) {
      // Defer to ensure DOM is fully ready
      setTimeout(function() {
        applyViewerProfile();
        // Hide visibility checkboxes for components that are hidden in the shared state
        hideDisabledVisibilityControls(initialState);
      }, 0);
    }

    var vWallsEl = $("vWalls");
    var vRoofEl = $("vRoof");
    var vRoofStructureEl = $("vRoofStructure");
    var vRoofOsbEl = $("vRoofOsb");
    var vBaseAllEl = $("vBaseAll");
    var vBaseEl = $("vBase");
    var vFrameEl = $("vFrame");
    var vInsEl = $("vIns");
    var vDeckEl = $("vDeck");
    var vCladdingEl = $("vCladding");
    var vOpeningsEl = $("vOpenings");

var unitModeMetricEl = $("unitModeMetric");
    var unitModeImperialEl = $("unitModeImperial");
    var wFtInEl = $("wFtIn");
    var dFtInEl = $("dFtIn");
var roofApexEaveFtInEl = $("roofApexEaveFtIn");
    var roofApexCrestFtInEl = $("roofApexCrestFtIn");
    var roofMinFtInEl = $("roofMinFtIn");
    var roofMaxFtInEl = $("roofMaxFtIn");
    
    var overUniformLabelEl = $("overUniformLabel");
    var overUniformFtInEl = $("overUniformFtIn");
    var overFrontLabelEl = $("overFrontLabel");
    var overFrontFtInEl = $("overFrontFtIn");
    var overBackLabelEl = $("overBackLabel");
    var overBackFtInEl = $("overBackFtIn");
    var overLeftLabelEl = $("overLeftLabel");
    var overLeftFtInEl = $("overLeftFtIn");
    var overRightLabelEl = $("overRightLabel");
    var overRightFtInEl = $("overRightFtIn");

    var vWallFrontEl = $("vWallFront");
    var vWallBackEl = $("vWallBack");
    var vWallLeftEl = $("vWallLeft");
    var vWallRightEl = $("vWallRight");
    var vWallInsulationEl = $("vWallInsulation");
    var vWallPlywoodEl = $("vWallPlywood");

    // Attachment visibility elements
    var vAttachmentsSectionEl = $("vAttachmentsSection");
    var vAttBaseEl = $("vAttBase");
    var vAttWallsEl = $("vAttWalls");
    var vAttRoofEl = $("vAttRoof");
    var vAttCladdingEl = $("vAttCladding");
    var vAttBaseGridEl = $("vAttBaseGrid");
    var vAttBaseFrameEl = $("vAttBaseFrame");
    var vAttBaseDeckEl = $("vAttBaseDeck");
    var vAttWallFrontEl = $("vAttWallFront");
    var vAttWallBackEl = $("vAttWallBack");
    var vAttWallLeftEl = $("vAttWallLeft");
    var vAttWallRightEl = $("vAttWallRight");
    var vAttWallOuterEl = $("vAttWallOuter");

    // Developer panel attachment visibility controls (mirrors the main visibility section)
    var devVAttBaseEl = $("devVAttBase");
    var devVAttWallsEl = $("devVAttWalls");
    var devVAttRoofEl = $("devVAttRoof");
    var devVAttCladdingEl = $("devVAttCladding");
    var devVAttBaseGridEl = $("devVAttBaseGrid");
    var devVAttBaseFrameEl = $("devVAttBaseFrame");
    var devVAttBaseDeckEl = $("devVAttBaseDeck");
    var devVAttWallFrontEl = $("devVAttWallFront");
    var devVAttWallBackEl = $("devVAttWallBack");
    var devVAttWallLeftEl = $("devVAttWallLeft");
    var devVAttWallRightEl = $("devVAttWallRight");
    var devVAttWallOuterEl = $("devVAttWallOuter");

    var dimModeEl = $("dimMode");
    var wInputEl = $("wInput");
    var dInputEl = $("dInput");

    var roofStyleEl = $("roofStyle");

    var roofMinHeightEl = $("roofMinHeight");
    var roofMaxHeightEl = $("roofMaxHeight");

    // Apex roof absolute heights (mm). IDs may vary across UI versions; accept common fallbacks.
    // These map to state.roof.apex.heightToEaves_mm / heightToCrest_mm (see wiring below).
    var roofApexEavesHeightEl =
      $("roofApexEaveHeight");
    var roofApexCrestHeightEl =
      $("roofApexCrestHeight");

    // Apex roof: truss count + spacing readout (mm only)
    var roofApexTrussCountEl = $("roofApexTrussCount");
    var roofApexTrussSpacingEl = $("roofApexTrussSpacing");
    var roofApexTieBeamEl = $("roofApexTieBeam");

    var overUniformEl = $("roofOverUniform");
    var overFrontEl = $("roofOverFront");
    var overBackEl = $("roofOverBack");
    var overLeftEl = $("roofOverLeft");
    var overRightEl = $("roofOverRight");

    var wallSectionEl = $("wallSection"); // NEW
    var wallsVariantEl = $("wallsVariant");
    var wallHeightEl = $("wallHeight");
    var claddingStyleEl = $("claddingStyle");

    var addDoorBtnEl = $("addDoorBtn");
    var removeAllDoorsBtnEl = $("removeAllDoorsBtn");
    var doorsListEl = $("doorsList");

    var addWindowBtnEl = $("addWindowBtn");
    var removeAllWindowsBtnEl = $("removeAllWindowsBtn");
    var windowsListEl = $("windowsList");

    // Attachment controls (simplified - most inputs are dynamically created)
    var attachmentWallEl = $("attachmentWall");
    var addAttachmentBtnEl = $("addAttachmentBtn");
    var removeAllAttachmentsBtnEl = $("removeAllAttachmentsBtn");
    var attachmentsListEl = $("attachmentsList");

    // Divider controls
    var addDividerBtnEl = $("addDividerBtn");
    var removeAllDividersBtnEl = $("removeAllDividersBtn");
    var dividersListEl = $("dividersList");

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

      // Only change disabled state if not profile-disabled
      if (!wallHeightEl.classList.contains("profile-disabled")) {
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

    // Unit conversion helpers
    function mmToFeetInches(mm) {
      var totalInches = mm / 25.4;
      var feet = Math.floor(totalInches / 12);
      var inches = totalInches % 12;
      return { feet: feet, inches: inches, display: feet + "'" + inches.toFixed(1) + '"' };
    }

    function feetInchesToMm(feet, inches) {
      var totalInches = (feet * 12) + inches;
      return Math.round(totalInches * 25.4);
    }

    function parseFeetInchesInput(str) {
      // Accepts: 9'10.5" or 9'10.5 or 9 10.5 or just a number (treated as inches)
      str = String(str || "").trim();
      var match = str.match(/^(\d+)['\s]+(\d+\.?\d*)[""]?$/);
      if (match) {
        return { feet: parseInt(match[1], 10), inches: parseFloat(match[2]) };
      }
      // Try just inches
      var n = parseFloat(str);
      if (isFinite(n)) {
        return { feet: Math.floor(n / 12), inches: n % 12 };
      }
      return null;
    }

    function getUnitMode(state) {
      return (state && state.unitMode) ? String(state.unitMode) : "metric";
    }

function formatDimension(mm, unitMode) {
      if (unitMode === "imperial") {
        // Display as decimal inches for number input compatibility
        var totalInches = mm / 25.4;
        return String(Math.round(totalInches * 10) / 10);
      }
      return String(Math.round(mm));
    }

    function formatFeetInchesReadout(mm) {
      var totalInches = mm / 25.4;
      var feet = Math.floor(totalInches / 12);
      var inches = totalInches % 12;
      return feet + "'" + inches.toFixed(1) + '"';
    }


    // Apex trusses: run length + deterministic spacing (must match roof.js placement basis)
    function apexMemberW_mm() {
      // Must match docs/src/elements/roof.js apex: memberW_mm = CONFIG.timber.d
      var mw = Math.floor(Number(CONFIG && CONFIG.timber ? CONFIG.timber.d : 100));
      return (Number.isFinite(mw) && mw > 0) ? mw : 100;
    }

    function getApexTrussCountFromState(state) {
      var n = null;
      try { n = state && state.roof && state.roof.apex && state.roof.apex.trussCount != null ? Math.floor(Number(state.roof.apex.trussCount)) : null; } catch (e) { n = null; }
      return (Number.isFinite(n) && n >= 2) ? n : null;
    }

    function computeLegacyApexTrussCount(state) {
      // Mirrors roof.js apex truss position generation (spacing=600, last forced to maxP), but on FRAME ridge span.
      var spacing = 600;
      var R = resolveDims(state || {});

      var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(Number(R.roof.w_mm))) : 1;
      var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(Number(R.roof.d_mm))) : 1;

      var frameW = (R && R.frame && R.frame.w_mm != null) ? Math.max(1, Math.floor(Number(R.frame.w_mm))) : 1;
      var frameD = (R && R.frame && R.frame.d_mm != null) ? Math.max(1, Math.floor(Number(R.frame.d_mm))) : 1;

      var ovh = (R && R.overhang) ? R.overhang : null;
      var l_mm = (ovh && ovh.l_mm != null) ? Math.max(0, Math.floor(Number(ovh.l_mm))) : 0;
      var f_mm = (ovh && ovh.f_mm != null) ? Math.max(0, Math.floor(Number(ovh.f_mm))) : 0;

      var ridgeAlongWorldX = (roofW >= roofD);
      var ridgeFrameLen_mm = ridgeAlongWorldX ? frameW : frameD;
      var ridgeStart_mm = ridgeAlongWorldX ? l_mm : f_mm;

      var memberW = apexMemberW_mm();

      var minP = Math.max(0, Math.floor(ridgeStart_mm));
      var maxP = Math.max(minP, Math.floor(ridgeStart_mm + ridgeFrameLen_mm - memberW));

      var pos = [];
      var p = minP;
      while (p <= maxP) { pos.push(Math.floor(p)); p += spacing; }
      if (pos.length) {
        var last = pos[pos.length - 1];
        if (Math.abs(last - maxP) > 0) pos.push(Math.floor(maxP));
      } else {
        pos.push(minP);
      }

      // Count includes both gable ends.
      var n = pos.length;
      return (Number.isFinite(n) && n >= 2) ? n : 2;
    }

    function getApexTrussRunMm(state) {
      // Must match roof.js apex run basis used for left-edge z0_mm placement: run = ridgeFrameLen_mm - memberW_mm
      var R = resolveDims(state || {});

      var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(Number(R.roof.w_mm))) : 1;
      var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(Number(R.roof.d_mm))) : 1;

      var frameW = (R && R.frame && R.frame.w_mm != null) ? Math.max(1, Math.floor(Number(R.frame.w_mm))) : 1;
      var frameD = (R && R.frame && R.frame.d_mm != null) ? Math.max(1, Math.floor(Number(R.frame.d_mm))) : 1;

      var ridgeAlongWorldX = (roofW >= roofD);
      var ridgeFrameLen_mm = ridgeAlongWorldX ? frameW : frameD;

      var memberW = apexMemberW_mm();
      return Math.max(0, Math.floor(ridgeFrameLen_mm - memberW));
    }

    function computeApexTrussSpacingText(state) {
      var style = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "apex";
      if (style !== "apex") return "—";

      var n = getApexTrussCountFromState(state);
      if (n == null) n = computeLegacyApexTrussCount(state);

      var run_mm = getApexTrussRunMm(state);
      var denom = (n - 1);
      if (denom <= 0) return "—";

      var spacing = run_mm / denom;
      if (!isFinite(spacing)) return "—";

      return String(Math.round(spacing));
    }

    // Ensure deterministic default truss count (so UI + geometry have a stable baseline).
    try {
      var sInitApex = store.getState();
      var hasApexCount = !!(sInitApex && sInitApex.roof && sInitApex.roof.apex && sInitApex.roof.apex.trussCount != null);
      if (!hasApexCount) {
        store.setState({ roof: { apex: { trussCount: computeLegacyApexTrussCount(sInitApex) } } });
      }
    } catch (eInitApex) {}

    // Ensure cladding toggle has a deterministic default (matches current checkbox if state missing).
    try {
      var sInitClad = store.getState();
      var hasClad = !!(sInitClad && sInitClad.vis && typeof sInitClad.vis.cladding === "boolean");
      if (!hasClad && vCladdingEl) {
        store.setState({ vis: { cladding: !!vCladdingEl.checked } });
      }
    } catch (eInitClad) {}

    function getWallsEnabled(state) {
      var vis = state && state.vis ? state.vis : null;
      if (vis && typeof vis.walls === "boolean") return vis.walls;
      if (vis && typeof vis.wallsEnabled === "boolean") return vis.wallsEnabled;
      return true;
    }

    function getRoofEnabled(state) { return (state && state.vis && typeof state.vis.roof === "boolean") ? state.vis.roof : true; }
    function getBaseEnabled(state) { return (state && state.vis && typeof state.vis.baseAll === "boolean") ? state.vis.baseAll : true; }
    function getCladdingEnabled(state) { return (state && state.vis && typeof state.vis.cladding === "boolean") ? state.vis.cladding : true; }

    function applyCladdingVisibility(scene, on) {
      if (!scene || !scene.meshes) return;

      var visible = (on !== false);

      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;

        var nm = String(m.name || "");
        // Check for cladding meshes:
        // 1. Main building: name starts with "clad-" (e.g., "clad-front-panel-0")
        // 2. Section-based: name contains "clad-" (e.g., "section-main-clad-front-panel-0")
        // 3. Attachments: name contains "clad-" (e.g., "att-123-clad-outer-c0")
        // 4. Metadata type === "cladding"
        // 5. Metadata cladding === true (corner boards)
        var isClad = (nm.indexOf("clad-") >= 0) ||
                     (m.metadata && m.metadata.type === "cladding") ||
                     (m.metadata && m.metadata.cladding === true);
        if (!isClad) continue;

        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

function applyOpeningsVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        // Check for door/window meshes:
        // 1. Main building: name starts with "door-" or "window-"
        // 2. Attachments (future): name contains "door-" or "window-"
        // 3. Metadata type === "door" or "window"
        var isDoor = (nm.indexOf("door-") >= 0) ||
                     (m.metadata && m.metadata.type === "door");
        var isWindow = (nm.indexOf("window-") >= 0) ||
                       (m.metadata && m.metadata.type === "window");
        if (!isDoor && !isWindow) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Base visibility - controls base frame, insulation, deck for main building and attachments
    function applyBaseVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        // Check for base meshes:
        // 1. Base module uses simple names ('g', 'r', 'j', 'i', 'd') parented to shed-root
        // 2. Attachments: metadata.type === 'base', 'frame', or 'deck'
        // 3. Check parent name contains 'shed-root' or 'base'
        var isBase = false;

        // Check metadata type for attachments
        if (m.metadata && (m.metadata.type === "base" || m.metadata.type === "frame" || m.metadata.type === "deck")) {
          // Only count as base if it's from attachment (has attachmentId) or specifically base type
          if (m.metadata.attachmentId || m.metadata.type === "base" || m.metadata.type === "deck") {
            isBase = true;
          }
        }

        // Check if parented to shed-root (main building base)
        if (!isBase && m.parent) {
          var parentName = String(m.parent.name || "");
          if (parentName.indexOf("shed-root") >= 0) {
            // This is a main building base mesh
            isBase = true;
          }
        }

        // Attachment base meshes by name pattern
        if (!isBase && nm.indexOf("att-") === 0) {
          if (nm.indexOf("-base-") >= 0) {
            isBase = true;
          }
        }

        if (!isBase) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Walls visibility - controls wall frame studs, plates for main building and attachments
    function applyWallsVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        // Check for wall frame meshes:
        // 1. Main building: name contains "wall-" (e.g., "wall-front-plate-bottom", "wall-front-stud-0")
        // 2. Attachments: metadata.type === "wall-frame"
        // 3. Dividers: name contains "divider-" (internal partition walls)
        var isWall = (nm.indexOf("wall-") >= 0) ||
                     (nm.indexOf("divider-") >= 0) ||
                     (m.metadata && m.metadata.type === "wall-frame");

        // Exclude cladding (handled by applyCladdingVisibility)
        if (nm.indexOf("clad-") >= 0 || (m.metadata && m.metadata.type === "cladding")) {
          isWall = false;
        }

        if (!isWall) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Roof visibility - controls rafters, OSB, covering, fascia for main building and attachments
    function applyRoofVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        // Check for roof meshes:
        // 1. Main building: name contains "roof-" (e.g., "roof-root", "roof-truss-0")
        // 2. Attachments: metadata.type === "roof"
        // 3. Attachment roof meshes: name pattern "att-{id}-rafter-", "att-{id}-osb", "att-{id}-fascia-"
        var isRoof = (nm.indexOf("roof-") >= 0) ||
                     (m.metadata && m.metadata.type === "roof") ||
                     (m.metadata && m.metadata.roof); // metadata.roof = "apex" or "pent"

        // Also catch attachment roof parts by name pattern
        if (!isRoof && nm.indexOf("att-") === 0) {
          if (nm.indexOf("-rafter") >= 0 || nm.indexOf("-osb") >= 0 ||
              nm.indexOf("-fascia") >= 0 || nm.indexOf("-roof-") >= 0 ||
              nm.indexOf("-rim-") >= 0 || nm.indexOf("-covering") >= 0) {
            isRoof = true;
          }
        }

        if (!isRoof) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Roof Structure visibility - controls rafters, rim joists, trusses for main building and attachments
    function applyRoofStructureVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        var meta = m.metadata || {};

        var isStructure = false;

        // Main building roof structure (trusses, rafters)
        if (nm.indexOf("roof-truss") >= 0 || nm.indexOf("roof-rafter") >= 0) {
          isStructure = true;
        }
        // Main building: metadata.part includes structure-related parts
        if (meta.roof && (meta.part === "truss" || meta.member === "kingpost" || meta.part === "rafter")) {
          isStructure = true;
        }

        // Attachment roof structure
        if (nm.indexOf("att-") === 0) {
          if (nm.indexOf("-rafter") >= 0 || nm.indexOf("-rim-") >= 0) {
            isStructure = true;
          }
          if (meta.part === "rafter" || meta.part === "rim") {
            isStructure = true;
          }
        }

        if (!isStructure) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Roof OSB visibility - controls OSB/sheathing for main building and attachments
    function applyRoofOsbVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        var meta = m.metadata || {};

        var isOsb = false;

        // Main building OSB
        if (nm.indexOf("roof-osb") >= 0 || nm.indexOf("-osb-") >= 0) {
          isOsb = true;
        }
        if (meta.roof && meta.part === "osb") {
          isOsb = true;
        }

        // Attachment OSB
        if (nm.indexOf("att-") === 0 && nm.indexOf("-osb") >= 0) {
          isOsb = true;
        }
        if (meta.attachmentId && meta.part === "osb") {
          isOsb = true;
        }

        if (!isOsb) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // Roof Covering visibility - controls felt/covering for main building and attachments
    function applyRoofCoveringVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m) continue;
        var nm = String(m.name || "");
        var meta = m.metadata || {};

        var isCovering = false;

        // Main building covering
        if (nm.indexOf("roof-covering") >= 0 || nm.indexOf("roof-felt") >= 0) {
          isCovering = true;
        }
        if (meta.roof && (meta.part === "covering" || meta.part === "felt")) {
          isCovering = true;
        }

        // Attachment covering
        if (nm.indexOf("att-") === 0 && nm.indexOf("-covering") >= 0) {
          isCovering = true;
        }
        if (meta.attachmentId && (meta.part === "covering" || meta.part === "covering-eaves" ||
            meta.part === "covering-ridge" || (meta.part && meta.part.indexOf("covering") >= 0))) {
          isCovering = true;
        }

        // Also check for roof ribbon meshes (apex roof covering panels)
        if (nm.indexOf("att-") === 0 && (nm.indexOf("-roof-left") >= 0 || nm.indexOf("-roof-right") >= 0)) {
          isCovering = true;
        }

        if (!isCovering) continue;
        try { m.isVisible = visible; } catch (e0) {}
        try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e1) {}
      }
    }

    // ==================== ATTACHMENT VISIBILITY FUNCTIONS ====================

    /**
     * Show or hide the attachments visibility section based on whether attachments exist
     */
    function updateAttachmentVisibilitySection() {
      if (!vAttachmentsSectionEl) return;
      var s = store.getState();
      var atts = (s && s.sections && s.sections.attachments) ? s.sections.attachments : [];
      var hasAttachments = atts.length > 0;
      vAttachmentsSectionEl.style.display = hasAttachments ? "" : "none";
    }

    /**
     * Apply visibility to attachment base (all base components)
     */
    function applyAttachmentBaseVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentBaseVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        var t = m.metadata.type;
        if (t === "base" || t === "frame" || t === "deck") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment base meshes affected:", count);
    }

    /**
     * Apply visibility to attachment base grid only
     */
    function applyAttachmentBaseGridVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentBaseGridVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        if (m.metadata.type === "base") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment base grid meshes affected:", count);
    }

    /**
     * Apply visibility to attachment floor frame only
     */
    function applyAttachmentBaseFrameVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentBaseFrameVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        if (m.metadata.type === "frame") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment base frame meshes affected:", count);
    }

    /**
     * Apply visibility to attachment decking (OSB floor) only
     */
    function applyAttachmentBaseDeckVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentBaseDeckVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        if (m.metadata.type === "deck") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment base deck meshes affected:", count);
    }

    /**
     * Apply visibility to attachment walls (all wall framing)
     */
    function applyAttachmentWallsVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentWallsVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        if (m.metadata.type === "wall-frame") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment walls meshes affected:", count);
    }

    /**
     * Apply visibility to a specific attachment wall by wallId
     * @param {string} wallId - 'front', 'back', 'left', 'right', or 'outer'
     */
    function applyAttachmentWallVisibility(scene, wallId, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentWallVisibility:", wallId, visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        var nm = String(m.name || "");
        var isTargetWall = false;

        // Check wall frame by name pattern: att-{id}-{wallId}-
        if (m.metadata.type === "wall-frame") {
          var prefix = "att-" + m.metadata.attachmentId + "-" + wallId + "-";
          if (nm.indexOf(prefix) === 0) {
            isTargetWall = true;
          }
        }

        // Check cladding by wallId metadata
        if (m.metadata.type === "cladding" && m.metadata.wallId === wallId) {
          isTargetWall = true;
        }

        if (isTargetWall) {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment wall", wallId, "meshes affected:", count);
    }

    /**
     * Apply visibility to attachment roof (all roof components)
     */
    function applyAttachmentRoofVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentRoofVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        var nm = String(m.name || "");
        var isRoof = m.metadata.type === "roof";
        // Also catch roof-related meshes by name
        if (nm.indexOf("-rafter") >= 0 || nm.indexOf("-osb") >= 0 ||
            nm.indexOf("-fascia") >= 0 || nm.indexOf("-covering") >= 0 ||
            nm.indexOf("-rim-") >= 0 || nm.indexOf("-roof-") >= 0) {
          isRoof = true;
        }
        if (isRoof) {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment roof meshes affected:", count);
    }

    /**
     * Apply visibility to attachment cladding
     */
    function applyAttachmentCladdingVisibility(scene, on) {
      if (!scene || !scene.meshes) return;
      var visible = (on !== false);
      console.log("[vis] applyAttachmentCladdingVisibility:", visible);
      var count = 0;
      for (var i = 0; i < scene.meshes.length; i++) {
        var m = scene.meshes[i];
        if (!m || !m.metadata || !m.metadata.attachmentId) continue;
        if (m.metadata.type === "cladding") {
          try { m.isVisible = visible; } catch (e) {}
          try { if (typeof m.setEnabled === "function") m.setEnabled(visible); } catch (e) {}
          count++;
        }
      }
      console.log("[vis] attachment cladding meshes affected:", count);
    }

    /**
     * Get attachment visibility settings from state (with defaults to true)
     */
    function getAttachmentVisibility(state) {
      var attVis = (state && state.vis && state.vis.attachments) ? state.vis.attachments : {};
      return {
        base: attVis.base !== false,
        walls: attVis.walls !== false,
        roof: attVis.roof !== false,
        cladding: attVis.cladding !== false,
        baseGrid: attVis.baseGrid !== false,
        baseFrame: attVis.baseFrame !== false,
        baseDeck: attVis.baseDeck !== false,
        wallFront: attVis.wallFront !== false,
        wallBack: attVis.wallBack !== false,
        wallLeft: attVis.wallLeft !== false,
        wallRight: attVis.wallRight !== false,
        wallOuter: attVis.wallOuter !== false
      };
    }

    /**
     * Apply all attachment visibility settings
     */
    function applyAllAttachmentVisibility(scene, state) {
      var av = getAttachmentVisibility(state);

      // Apply master toggles
      applyAttachmentBaseVisibility(scene, av.base);
      applyAttachmentWallsVisibility(scene, av.walls);
      applyAttachmentRoofVisibility(scene, av.roof);
      applyAttachmentCladdingVisibility(scene, av.cladding);

      // Apply granular toggles (only if master is on)
      if (av.base) {
        applyAttachmentBaseGridVisibility(scene, av.baseGrid);
        applyAttachmentBaseFrameVisibility(scene, av.baseFrame);
        applyAttachmentBaseDeckVisibility(scene, av.baseDeck);
      }

      if (av.walls) {
        applyAttachmentWallVisibility(scene, "front", av.wallFront);
        applyAttachmentWallVisibility(scene, "back", av.wallBack);
        applyAttachmentWallVisibility(scene, "left", av.wallLeft);
        applyAttachmentWallVisibility(scene, "right", av.wallRight);
        applyAttachmentWallVisibility(scene, "outer", av.wallOuter);
      }
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

        var nm = String(m.name || "");
        var isModel =
          (m.metadata && m.metadata.dynamic === true) ||
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
      // Keep perspective mode - orthographic causes distortion and breaks zoom
      // try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e0) {}

      var ext = bounds.extents;
      var margin = 1.10;

      var halfW = 1, halfH = 1;

      if (viewName === "plan") {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.z));
      } else if (viewName === "front" || viewName === "back") {
        halfW = Math.max(0.01, Math.abs(ext.x));
        halfH = Math.max(0.01, Math.abs(ext.y));
      } else if (viewName === "left" || viewName === "right") {
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
      var PI = Math.PI;

      var alpha = camera.alpha != null ? camera.alpha : 0;
      var beta = camera.beta != null ? camera.beta : (PI / 2);

      if (viewName === "plan") {
        beta = 0.0001;
        alpha = PI / 2;
      } else if (viewName === "front") {
        beta = PI / 2;
        alpha = -PI / 2;
      } else if (viewName === "back") {
        beta = PI / 2;
        alpha = PI / 2;
      } else if (viewName === "right") {
        beta = PI / 2;
        alpha = 0;
      } else if (viewName === "left") {
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

      try {
        if (typeof camera.setTarget === "function") camera.setTarget(c);
        else if (camera.target) camera.target = c;
      } catch (e0) {}

      var ext = bounds.extents;
      var maxDim = Math.max(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
      var safeR = Math.max(0.5, maxDim * 4.0);

      try { if (camera.radius != null) camera.radius = safeR; } catch (e1) {}

      setOrthoForView(camera, viewName, bounds);

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

      var bounds = computeModelBoundsWorld(scene);
      if (!bounds) return false;

      var isArcRotate = (camera.alpha != null && camera.beta != null && camera.radius != null);

      try {
        if (isArcRotate) {
          setArcRotateOrientation(camera, viewName);
          frameCameraToBounds(camera, bounds, viewName);
        } else {
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

          try { camera.mode = BAB.Camera.ORTHOGRAPHIC_CAMERA; } catch (e2) {}
          setOrthoForView(camera, viewName, bounds);
        }

        try { window.__dbg.viewSnap.last = { view: viewName, t: Date.now() }; } catch (e3) {}

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
    // Show only the matching roof height block (Apex / Pent / Hipped) in the UI.
    
    function updateRoofHeightBlocks(activeStyle) {
      var style = String(activeStyle || "").toLowerCase();
      var blocks = document.querySelectorAll("#roofHeightOptions .roofHeightsBlock");
      if (!blocks || !blocks.length) return;

      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        if (!block) continue;

        var id = String(block.id || ""); // e.g. "roofHeightsApex"
        var styleName = id.replace("roofHeights", "").toLowerCase(); // "apex", "pent", "hipped"
        var isActive = (styleName === style);

        if (block.style) block.style.display = isActive ? "" : "none";
        block.setAttribute("aria-hidden", isActive ? "false" : "true");
      }
    }

    function isPentRoofStyle(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      return roofStyle === "pent";
    }

    function isApexRoofStyle(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      return roofStyle === "apex";
    }

    function clampHeightMm(v, def) {
      var n = Math.max(100, Math.floor(Number(v)));
      return Number.isFinite(n) ? n : def;
    }

    // Read apex absolute height fields with backwards-compatible key fallbacks.
    // NOTE: Geometry/derived wall height is handled in params.js / roof.js; this is UI/state wiring only.
    function getApexHeightsFromState(state) {
      var a = (state && state.roof && state.roof.apex) ? state.roof.apex : null;

      function pick(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (obj && obj[k] != null) {
            var n = Math.floor(Number(obj[k]));
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
        return null;
      }

      var eaves = pick(a, ["heightToEaves_mm", "eavesHeight_mm", "eaves_mm", "heightEaves_mm"]);
      var crest = pick(a, ["heightToCrest_mm", "crestHeight_mm", "crest_mm", "heightCrest_mm"]);

      return { eaves: eaves, crest: crest };
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
      console.log("[RENDER] render() called");
      console.log("[RENDER] state:", state ? "exists" : "null/undefined");
      console.log("[RENDER] state.sections:", state ? state.sections : "N/A");
      try {
        window.__dbg.buildCalls += 1;

        // CRITICAL: Legacy mode check - if sections not enabled, use current code unchanged
        // This ensures zero impact on existing functionality
        if (!state.sections || !state.sections.enabled || !state.sections.attachments || state.sections.attachments.length === 0) {
          // LEGACY PATH - existing code runs exactly as before
          console.log("[RENDER] Taking LEGACY path -> renderLegacyMode");
          renderLegacyMode(state);
          return;
        }

        // NEW CODE PATH - only executes when sections.enabled === true AND attachments exist
        // Phase 1.3 - Multi-section rendering
        console.log("[RENDER] Taking MULTI-SECTION path");
        renderMultiSectionMode(state);

      } catch (e) {
        console.error("[RENDER] render() threw:", e);
        window.__dbg.lastError = "render() failed: " + String(e && e.message ? e.message : e);
      }
    }

    // Legacy single-building render path - preserved unchanged from original render()
    function renderLegacyMode(state) {
        console.log("[RENDER_DEBUG] renderLegacyMode called");
        console.log("[RENDER_DEBUG] ctx:", ctx ? "exists" : "null/undefined");
        console.log("[RENDER_DEBUG] ctx.scene:", ctx && ctx.scene ? "exists" : "null/undefined");
        console.log("[RENDER_DEBUG] state.dim:", state.dim);
        console.log("[RENDER_DEBUG] state.vis:", state.vis);

        var R = resolveDims(state);
        console.log("[RENDER_DEBUG] R (resolved dims):", R);

        var baseState = Object.assign({}, state, { w: R.base.w_mm, d: R.base.d_mm });

        var wallDims = getWallOuterDimsFromState(state);
        var wallState = Object.assign({}, state, { w: wallDims.w_mm, d: wallDims.d_mm });

        // Apex only: allow params.resolveDims(...) to provide a derived wall height that satisfies
        // absolute "Height to Eaves" (ground->underside at wall line) once that logic is implemented there.
        // No effect unless R.walls.height_mm is populated by params.js, and does NOT change pent behavior.
        try {
          var roofStyleNow = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
          if (roofStyleNow === "apex" && R && R.walls && R.walls.height_mm != null) {
            wallState = Object.assign({}, wallState, {
              walls: Object.assign({}, wallState.walls || {}, { height_mm: Math.floor(Number(R.walls.height_mm)) })
            });
          }
        } catch (eWallDerive) {}

        safeDispose();

        console.log("[RENDER_DEBUG] getBaseEnabled:", getBaseEnabled(state));
        console.log("[RENDER_DEBUG] getWallsEnabled:", getWallsEnabled(state));
        console.log("[RENDER_DEBUG] Base module:", Base ? "exists" : "null");
        console.log("[RENDER_DEBUG] Walls module:", Walls ? "exists" : "null");

        if (getBaseEnabled(state)) {
          console.log("[RENDER_DEBUG] Building base with baseState.w/d:", baseState.w, baseState.d);
          try {
            if (Base && typeof Base.build3D === "function") Base.build3D(baseState, ctx, undefined);
            console.log("[RENDER_DEBUG] Base.build3D complete, meshes:", ctx.scene.meshes.length);
          } catch (baseError) {
            console.error("[RENDER_DEBUG] Base.build3D threw:", baseError);
          }
        }

if (getWallsEnabled(state)) {
          console.log("[RENDER_DEBUG] Building walls with wallState.w/d:", wallState.w, wallState.d);
          try {
            if (Walls && typeof Walls.build3D === "function") Walls.build3D(wallState, ctx, undefined);
            console.log("[RENDER_DEBUG] Walls.build3D complete, meshes:", ctx.scene.meshes.length);
          } catch (wallError) {
            console.error("[RENDER_DEBUG] Walls.build3D threw:", wallError);
          }
          shiftWallMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
        }

        // Build internal dividers (always build if they exist)
        if (Dividers && typeof Dividers.build3D === "function") {
          Dividers.build3D(wallState, ctx, undefined);
          shiftDividerMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
        }

        // Build door and window geometry into openings (always build regardless of wall visibility)
        if (Doors && typeof Doors.build3D === "function") Doors.build3D(wallState, ctx, undefined);
        if (Windows && typeof Windows.build3D === "function") Windows.build3D(wallState, ctx, undefined);

        var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
        var roofEnabled = getRoofEnabled(state);
        console.log("[RENDER_LEGACY] Roof check:", { roofEnabled, roofStyle, visRoof: state?.vis?.roof });

        // Build roof for supported styles (pent + apex). (No behavior change for pent.)
        if (roofEnabled && (roofStyle === "pent" || roofStyle === "apex")) {
          console.log("[RENDER_LEGACY] Building roof...");
          var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(R.roof.w_mm)) : Math.max(1, Math.floor(R.base.w_mm));
          var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(R.roof.d_mm)) : Math.max(1, Math.floor(R.base.d_mm));
          var roofState = Object.assign({}, state, { w: roofW, d: roofD });

          if (Roof && typeof Roof.build3D === "function") Roof.build3D(roofState, ctx, undefined);
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
        updateOpeningsBOM(state);

       // Apply all visibility settings
        try {
          var _baseOn = getBaseEnabled(state);
          var _wallsOn = getWallsEnabled(state);
          var _roofOn = getRoofEnabled(state);
          var _cladOn = getCladdingEnabled(state);
          var _openOn = (state && state.vis && typeof state.vis.openings === "boolean") ? state.vis.openings : true;

          // Get roof sub-component visibility
          var rp = (state && state.vis && state.vis.roofParts) ? state.vis.roofParts : {};
          var _roofStructOn = rp.structure !== false;
          var _roofOsbOn = rp.osb !== false;
          var _roofCoverOn = rp.covering !== false;

          applyBaseVisibility(ctx.scene, _baseOn);
          applyWallsVisibility(ctx.scene, _wallsOn);
          applyRoofVisibility(ctx.scene, _roofOn);
          applyRoofStructureVisibility(ctx.scene, _roofOn && _roofStructOn);
          applyRoofOsbVisibility(ctx.scene, _roofOn && _roofOsbOn);
          applyRoofCoveringVisibility(ctx.scene, _roofOn && _roofCoverOn);
          applyCladdingVisibility(ctx.scene, _cladOn);
          applyOpeningsVisibility(ctx.scene, _openOn);
          applyAllAttachmentVisibility(ctx.scene, state);

          requestAnimationFrame(function () {
            try { applyBaseVisibility(ctx.scene, _baseOn); } catch (e0) {}
            try { applyWallsVisibility(ctx.scene, _wallsOn); } catch (e0) {}
            try { applyRoofVisibility(ctx.scene, _roofOn); } catch (e0) {}
            try { applyRoofStructureVisibility(ctx.scene, _roofOn && _roofStructOn); } catch (e0) {}
            try { applyRoofOsbVisibility(ctx.scene, _roofOn && _roofOsbOn); } catch (e0) {}
            try { applyRoofCoveringVisibility(ctx.scene, _roofOn && _roofCoverOn); } catch (e0) {}
            try { applyCladdingVisibility(ctx.scene, _cladOn); } catch (e0) {}
            try { applyOpeningsVisibility(ctx.scene, _openOn); } catch (e0) {}
            try { applyAllAttachmentVisibility(ctx.scene, state); } catch (e0) {}
          });
        } catch (e1) {}
    }

    // Multi-section render path - renders main building + all attachments (v2)
    function renderMultiSectionMode(state) {
      console.log("[RENDER_MULTI] Starting multi-section render (v2)...");

      // Dispose all existing meshes first
      safeDispose();

      // Also dispose any attachment-specific meshes
      if (Attachments && typeof Attachments.disposeAllAttachments === "function") {
        Attachments.disposeAllAttachments(ctx.scene);
      }

      // STEP 1: Render the main building using legacy path
      console.log("[RENDER_MULTI] Rendering main building...");

      var R = resolveDims(state);
      var baseState = Object.assign({}, state, { w: R.base.w_mm, d: R.base.d_mm });

      var wallDims = getWallOuterDimsFromState(state);
      var wallState = Object.assign({}, state, { w: wallDims.w_mm, d: wallDims.d_mm });

      // Build main building base
      if (getBaseEnabled(state)) {
        if (Base && typeof Base.build3D === "function") Base.build3D(baseState, ctx, undefined);
      }

      // Build main building walls
      if (getWallsEnabled(state)) {
        if (Walls && typeof Walls.build3D === "function") Walls.build3D(wallState, ctx, undefined);
        shiftWallMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
      }

      // Build internal dividers
      if (Dividers && typeof Dividers.build3D === "function") {
        Dividers.build3D(wallState, ctx, undefined);
        shiftDividerMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
      }

      // Build doors/windows
      if (Doors && typeof Doors.build3D === "function") Doors.build3D(wallState, ctx, undefined);
      if (Windows && typeof Windows.build3D === "function") Windows.build3D(wallState, ctx, undefined);

      // Build main building roof
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      var roofEnabled = getRoofEnabled(state);
      var roofW = (R && R.roof && R.roof.w_mm != null) ? Math.max(1, Math.floor(R.roof.w_mm)) : Math.max(1, Math.floor(R.base.w_mm));
      var roofD = (R && R.roof && R.roof.d_mm != null) ? Math.max(1, Math.floor(R.roof.d_mm)) : Math.max(1, Math.floor(R.base.d_mm));

      if (roofEnabled && (roofStyle === "pent" || roofStyle === "apex")) {
        var roofState = Object.assign({}, state, { w: roofW, d: roofD });

        if (Roof && typeof Roof.build3D === "function") Roof.build3D(roofState, ctx, undefined);
        shiftRoofMeshes(ctx.scene, -WALL_OVERHANG_MM, WALL_RISE_MM, -WALL_OVERHANG_MM);
      }

      // STEP 2: Render all attachments using the new Attachments module
      var attachments = state.sections?.attachments || [];
      console.log("[RENDER_MULTI] Rendering", attachments.length, "attachments...");

      for (var i = 0; i < attachments.length; i++) {
        var attachment = attachments[i];
        if (!attachment || !attachment.enabled) continue;

        console.log("[RENDER_MULTI] Building attachment:", attachment.id, "on", attachment.attachTo?.wall);

        try {
          if (Attachments && typeof Attachments.build3D === "function") {
            Attachments.build3D(state, attachment, ctx);
          }
        } catch (attError) {
          console.error("[RENDER_MULTI] Error building attachment:", attachment.id, attError);
        }
      }

      // Update BOM for main building
      if (Walls && typeof Walls.updateBOM === "function") {
        var wallsBom = Walls.updateBOM(wallState);
        if (wallsBom && wallsBom.sections) renderBOM(wallsBom.sections);
      }

      if (roofEnabled && Roof && typeof Roof.updateBOM === "function") {
        Roof.updateBOM(Object.assign({}, state, { w: roofW, d: roofD }));
      }
      if (Base && typeof Base.updateBOM === "function") Base.updateBOM(baseState);
      updateOpeningsBOM(state);

      // Apply all visibility settings to main building AND attachments
      try {
        var _baseOn = getBaseEnabled(state);
        var _wallsOn = getWallsEnabled(state);
        var _roofOn = getRoofEnabled(state);
        var _cladOn = getCladdingEnabled(state);
        var _openOn = (state && state.vis && typeof state.vis.openings === "boolean") ? state.vis.openings : true;

        // Get roof sub-component visibility
        var rp = (state && state.vis && state.vis.roofParts) ? state.vis.roofParts : {};
        var _roofStructOn = rp.structure !== false;
        var _roofOsbOn = rp.osb !== false;
        var _roofCoverOn = rp.covering !== false;

        applyBaseVisibility(ctx.scene, _baseOn);
        applyWallsVisibility(ctx.scene, _wallsOn);
        applyRoofVisibility(ctx.scene, _roofOn);
        applyRoofStructureVisibility(ctx.scene, _roofOn && _roofStructOn);
        applyRoofOsbVisibility(ctx.scene, _roofOn && _roofOsbOn);
        applyRoofCoveringVisibility(ctx.scene, _roofOn && _roofCoverOn);
        applyCladdingVisibility(ctx.scene, _cladOn);
        applyOpeningsVisibility(ctx.scene, _openOn);
        applyAllAttachmentVisibility(ctx.scene, state);

        requestAnimationFrame(function () {
          try { applyBaseVisibility(ctx.scene, _baseOn); } catch (e0) {}
          try { applyWallsVisibility(ctx.scene, _wallsOn); } catch (e0) {}
          try { applyRoofVisibility(ctx.scene, _roofOn); } catch (e0) {}
          try { applyRoofStructureVisibility(ctx.scene, _roofOn && _roofStructOn); } catch (e0) {}
          try { applyRoofOsbVisibility(ctx.scene, _roofOn && _roofOsbOn); } catch (e0) {}
          try { applyRoofCoveringVisibility(ctx.scene, _roofOn && _roofCoverOn); } catch (e0) {}
          try { applyCladdingVisibility(ctx.scene, _cladOn); } catch (e0) {}
          try { applyOpeningsVisibility(ctx.scene, _openOn); } catch (e0) {}
          try { applyAllAttachmentVisibility(ctx.scene, state); } catch (e0) {}
        });
      } catch (eVis) {
        console.error("[RENDER_MULTI] Error applying visibility:", eVis);
      }

      console.log("[RENDER_MULTI] Multi-section render complete.");
    }

    function getOpeningsFromState(state) {
      return (state && state.walls && Array.isArray(state.walls.openings)) ? state.walls.openings : [];
    }

    /**
     * Get wall height for openings validation
     * For pent roofs, use the minimum height (low wall) as the constraint
     * For apex/hipped, use the eaves height
     */
    function getWallHeightForOpenings(state) {
      var roofStyle = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
      
      if (roofStyle === "pent") {
        var pentMinH = (state.roof && state.roof.pent && state.roof.pent.minHeight_mm) 
          ? state.roof.pent.minHeight_mm : 2100;
        return Math.max(1000, pentMinH);
      } else if (roofStyle === "apex") {
        var apexEaves = (state.roof && state.roof.apex && state.roof.apex.heightToEaves_mm)
          ? state.roof.apex.heightToEaves_mm : 1850;
        return Math.max(800, apexEaves);
      } else {
        // Hipped or default
        return 2000;
      }
    }

    /**
     * Validate and clamp openings to ensure:
     * 1. Openings don't extend beyond wall boundaries
     * 2. Openings don't overlap each other on the same wall
     */
    function validateAndClampOpenings(openings, state) {
      if (!Array.isArray(openings) || openings.length === 0) return openings;
      
      var lens = getWallLengthsForOpenings(state);
      var wallHeight = getWallHeightForOpenings(state);
      var MIN_GAP = 50; // Minimum gap between openings in mm
      var MIN_EDGE_GAP = 100; // Minimum gap from wall edge
      
      // Clone openings to avoid mutating original
      var result = openings.map(function(o) {
        return Object.assign({}, o);
      });
      
      // Group openings by wall
      var byWall = { front: [], back: [], left: [], right: [] };
      for (var i = 0; i < result.length; i++) {
        var o = result[i];
        if (!o || !o.enabled) continue;
        var wall = o.wall || "front";
        if (byWall[wall]) byWall[wall].push({ index: i, opening: o });
      }
      
      // Process each wall
      ["front", "back", "left", "right"].forEach(function(wall) {
        var wallLen = lens[wall] || 1000;
        var items = byWall[wall];
        if (!items || items.length === 0) return;
        
        // First pass: clamp each opening to wall boundaries
        items.forEach(function(item) {
          var o = item.opening;
          var w = Math.max(100, o.width_mm || 800);
          var h = Math.max(100, o.height_mm || (o.type === "door" ? 2000 : 600));
          var x = o.x_mm || 0;
          var y = o.y_mm || 0;
          
          // For doors, y is typically 0 (floor level)
          if (o.type === "door") {
            y = 0;
            // Door height can't exceed wall height
            if (h > wallHeight - MIN_EDGE_GAP) {
              h = wallHeight - MIN_EDGE_GAP;
            }
          } else {
            // Window: check y + height doesn't exceed wall height
            if (y + h > wallHeight - MIN_EDGE_GAP) {
              // Try lowering the window first
              y = wallHeight - MIN_EDGE_GAP - h;
              if (y < MIN_EDGE_GAP) {
                y = MIN_EDGE_GAP;
                h = wallHeight - 2 * MIN_EDGE_GAP;
              }
            }
            if (y < MIN_EDGE_GAP) y = MIN_EDGE_GAP;
          }
          
          // Clamp width to wall length
          if (w > wallLen - 2 * MIN_EDGE_GAP) {
            w = wallLen - 2 * MIN_EDGE_GAP;
          }
          
          // Clamp x position
          if (x < MIN_EDGE_GAP) x = MIN_EDGE_GAP;
          if (x + w > wallLen - MIN_EDGE_GAP) {
            x = wallLen - MIN_EDGE_GAP - w;
          }
          
          // Update the opening
          o.x_mm = Math.max(MIN_EDGE_GAP, Math.floor(x));
          o.width_mm = Math.max(100, Math.floor(w));
          o.height_mm = Math.max(100, Math.floor(h));
          if (o.type === "window") {
            o.y_mm = Math.max(MIN_EDGE_GAP, Math.floor(y));
          }
        });
        
        // Second pass: resolve overlaps (sort by x, then shift right if overlapping)
        items.sort(function(a, b) {
          return (a.opening.x_mm || 0) - (b.opening.x_mm || 0);
        });
        
        for (var j = 1; j < items.length; j++) {
          var prev = items[j - 1].opening;
          var curr = items[j].opening;
          
          var prevEnd = (prev.x_mm || 0) + (prev.width_mm || 800);
          var currStart = curr.x_mm || 0;
          
          // Check for overlap (X-axis only - Y overlap allowed for windows at different heights)
          // For simplicity, treat all openings as needing X separation
          if (currStart < prevEnd + MIN_GAP) {
            // Shift current opening to the right
            curr.x_mm = prevEnd + MIN_GAP;
            
            // If this pushes it off the wall, try shrinking it
            if (curr.x_mm + curr.width_mm > wallLen - MIN_EDGE_GAP) {
              var maxWidth = wallLen - MIN_EDGE_GAP - curr.x_mm;
              if (maxWidth >= 100) {
                curr.width_mm = maxWidth;
              } else {
                // Can't fit - disable this opening
                console.warn("[validateOpenings] Opening " + curr.id + " doesn't fit on wall " + wall + ", disabling");
                curr.enabled = false;
              }
            }
          }
        }
      });
      
      return result;
    }

    function setOpenings(nextOpenings) {
      var state = store.getState();
      var validated = validateAndClampOpenings(nextOpenings, state);
      store.setState({ walls: { openings: validated } });
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

    // ─────────────────────────────────────────────────────────────────────────
    // DIVIDER STATE HELPERS & VALIDATION
    // ─────────────────────────────────────────────────────────────────────────

    var __dividerSeq = 1;

    function getDividersFromState(state) {
      return (state && state.dividers && Array.isArray(state.dividers.items)) ? state.dividers.items : [];
    }

    function setDividers(nextDividers) {
      store.setState({ dividers: { items: nextDividers } });
    }

    function patchDividerById(dividerId, patch) {
      var cur = getDividersFromState(store.getState());
      var next = cur.map(function(d) {
        if (d && String(d.id || "") === String(dividerId)) {
          return Object.assign({}, d, patch);
        }
        return d;
      });
      setDividers(next);
    }

    function addDividerOpening(dividerId, opening) {
      var cur = getDividersFromState(store.getState());
      var next = cur.map(function(d) {
        if (d && String(d.id || "") === String(dividerId)) {
          var openings = Array.isArray(d.openings) ? d.openings.slice() : [];
          openings.push(opening);
          return Object.assign({}, d, { openings: openings });
        }
        return d;
      });
      setDividers(next);
    }

    function removeDividerOpening(dividerId, openingId) {
      var cur = getDividersFromState(store.getState());
      var next = cur.map(function(d) {
        if (d && String(d.id || "") === String(dividerId)) {
          var openings = Array.isArray(d.openings) ? d.openings.filter(function(o) {
            return o && String(o.id || "") !== String(openingId);
          }) : [];
          return Object.assign({}, d, { openings: openings });
        }
        return d;
      });
      setDividers(next);
    }

    function patchDividerOpening(dividerId, openingId, patch) {
      var cur = getDividersFromState(store.getState());
      var next = cur.map(function(d) {
        if (d && String(d.id || "") === String(dividerId)) {
          var openings = Array.isArray(d.openings) ? d.openings.map(function(o) {
            if (o && String(o.id || "") === String(openingId)) {
              return Object.assign({}, o, patch);
            }
            return o;
          }) : [];
          return Object.assign({}, d, { openings: openings });
        }
        return d;
      });
      setDividers(next);
    }

    function getInternalDimensions(state) {
      var dims = resolveDims(state);
      var variant = (state && state.walls && state.walls.variant) || "basic";
      var wallThk = variant === "insulated" ? 100 : 75;
      return {
        internalW: Math.max(1, dims.frame.w_mm - 2 * wallThk),
        internalD: Math.max(1, dims.frame.d_mm - 2 * wallThk),
        wallThk: wallThk
      };
    }

    function validateDividers(state) {
      var res = { invalidById: {}, invalidIds: [] };
      var dividers = getDividersFromState(state);
      if (!dividers.length) return res;

      var internal = getInternalDimensions(state);
      var MIN_GAP = 50;
      var MIN_DIVIDER_GAP = 200;

      for (var i = 0; i < dividers.length; i++) {
        var d = dividers[i];
        if (!d) continue;
        var axis = d.axis || "x";
        var pos = Math.floor(Number(d.position_mm || 0));

        // Boundary validation
        var maxPos = axis === "x" ? internal.internalW : internal.internalD;
        var minPos = MIN_GAP;
        var maxAllowed = Math.max(minPos, maxPos - MIN_GAP);

        if (pos < minPos || pos > maxAllowed) {
          res.invalidById[String(d.id)] = "Position must be between " + minPos + "mm and " + maxAllowed + "mm";
          res.invalidIds.push(String(d.id));
          continue;
        }

        // Overlap validation (check against other dividers on same axis)
        for (var j = 0; j < dividers.length; j++) {
          if (i === j) continue;
          var other = dividers[j];
          if (!other || other.axis !== axis) continue;
          var otherPos = Math.floor(Number(other.position_mm || 0));
          if (Math.abs(pos - otherPos) < MIN_DIVIDER_GAP) {
            if (!res.invalidById[String(d.id)]) {
              res.invalidById[String(d.id)] = "Too close to divider " + other.id + " (min " + MIN_DIVIDER_GAP + "mm gap)";
              res.invalidIds.push(String(d.id));
            }
            break;
          }
        }

        // Validate openings within divider
        var dividerLength = axis === "x" ? internal.internalD : internal.internalW;
        var openings = Array.isArray(d.openings) ? d.openings : [];
        for (var k = 0; k < openings.length; k++) {
          var opening = openings[k];
          if (!opening || opening.enabled === false) continue;
          var openingPos = Math.floor(Number(opening.position_mm || 0));
          var openingWidth = Math.floor(Number(opening.width_mm || 800));
          var openingEnd = openingPos + openingWidth;

          if (openingPos < MIN_GAP || openingEnd > dividerLength - MIN_GAP) {
            if (!res.invalidById[String(d.id)]) {
              res.invalidById[String(d.id)] = "Opening \"" + opening.id + "\" extends outside divider bounds";
              res.invalidIds.push(String(d.id));
            }
            break;
          }
        }
      }

      return res;
    }

    // ─────────────────────────────────────────────────────────────────────────

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
      console.log("[syncInvalidOpeningsIntoState] Called");
      if (_invalidSyncGuard) {
        console.log("[syncInvalidOpeningsIntoState] Guard active, returning early");
        return { doors: { invalidById: {}, invalidIds: [] }, windows: { invalidById: {}, invalidIds: [] } };
      }

      var s = store.getState();
      console.log("[syncInvalidOpeningsIntoState] Got state, calling validateDoors...");
      var dv = validateDoors(s);
      console.log("[syncInvalidOpeningsIntoState] validateDoors returned, calling validateWindows...");
      var wv = validateWindows(s);
      console.log("[syncInvalidOpeningsIntoState] validateWindows returned");

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
      var lastValue = inputEl.value;
      var inputId = inputEl.id || "unknown";
      var userHasTyped = false; // Track if user has interacted
      console.log("[wireCommitOnly] Wiring input:", inputId, "initial lastValue:", lastValue);

      // Track input events - this means user is typing
      inputEl.addEventListener("input", function() {
        userHasTyped = true;
        console.log("[wireCommitOnly]", inputId, "input event. value now:", inputEl.value, "lastValue still:", lastValue, "userHasTyped:", userHasTyped);
      });

      // Track focus to know when user starts editing
      inputEl.addEventListener("focus", function() {
        // When user focuses, capture the current value as lastValue
        // This ensures we compare against what was showing when they started editing
        lastValue = inputEl.value;
        userHasTyped = false;
        console.log("[wireCommitOnly]", inputId, "focus. Set lastValue to:", lastValue);
      });

      function doCommit(eventType) {
        console.log("[wireCommitOnly]", inputId, eventType, "fired. currentValue:", inputEl.value, "lastValue:", lastValue, "userHasTyped:", userHasTyped);
        if (inputEl.value !== lastValue) {
          console.log("[wireCommitOnly]", inputId, "value changed, calling onCommit");
          lastValue = inputEl.value;
          onCommit();
        } else {
          console.log("[wireCommitOnly]", inputId, "value unchanged, skipping onCommit");
        }
        userHasTyped = false;
      }

      inputEl.addEventListener("blur", function() { doCommit("blur"); });
      // Skip change events - blur is sufficient and more reliable
      inputEl.addEventListener("keydown", function (e) {
        if (!e) return;
        if (e.key === "Enter") {
          e.preventDefault();
          try { e.target.blur(); } catch (ex) {}
        }
      });
    }

    /**
     * Apply profile field restrictions to a DOM element
     * @param {HTMLElement} element - The element (or its parent label)
     * @param {string} fieldKey - e.g., "door.wall", "window.x"
     */
    function applyFieldRestriction(element, fieldKey) {
      if (!element) return;

      // Admin profile = no restrictions at all
      var currentProfile = getCurrentProfile();
      console.log("[applyFieldRestriction] currentProfile:", currentProfile, "fieldKey:", fieldKey);
      if (!currentProfile || currentProfile === "admin") {
        // Make sure element is visible and enabled (reset any prior restrictions)
        element.style.display = "";
        element.disabled = false;
        element.style.opacity = "";
        var parent = element.closest("label");
        if (parent) parent.style.display = "";
        return;
      }

      // Check visibility
      if (!isFieldVisible(fieldKey)) {
        // Hide the element or its parent label
        var parent = element.closest("label") || element;
        parent.style.display = "none";
        return;
      }

      // Check if disabled
      if (isFieldDisabled(fieldKey)) {
        element.disabled = true;
        element.style.opacity = "0.6";
      }

      // Apply option-level restrictions for SELECT elements
      if (element.tagName === "SELECT") {
        var optionRestrictions = getFieldOptionRestrictions(fieldKey);
        if (optionRestrictions) {
          var options = element.querySelectorAll("option");
          options.forEach(function(opt) {
            var optValue = opt.value;
            var optConfig = optionRestrictions[optValue];
            if (optConfig) {
              if (optConfig.visible === false) {
                // Hide the option completely
                opt.style.display = "none";
                opt.disabled = true;
              } else if (optConfig.editable === false) {
                // Show but grey out (not selectable)
                opt.style.display = "";
                opt.disabled = true;
                opt.style.color = "#999";
              } else {
                // Fully enabled
                opt.style.display = "";
                opt.disabled = false;
                opt.style.color = "";
              }
            }
          });
        }
      }

      // Apply default if specified and no value set
      var defaultVal = getFieldDefault(fieldKey);
      if (defaultVal !== undefined) {
        if (element.type === "checkbox") {
          if (!element.hasAttribute("data-user-set")) {
            element.checked = !!defaultVal;
          }
        } else if (element.value === "" || element.value === undefined) {
          element.value = defaultVal;
        }
      }
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

var styleLabel = document.createElement("label");
          styleLabel.textContent = "Style";
var styleSel = document.createElement("select");
          var doorWidthMm = Math.floor(Number(door.width_mm || 900));
          var styleOptions = '<option value="standard">Standard</option>';
          if (doorWidthMm >= 1200) {
            styleOptions += '<option value="double-standard">Double Standard</option>';
          }
          styleOptions += '<option value="mortise-tenon">Mortise & Tenon</option>';
          if (doorWidthMm >= 1200) {
            styleOptions += '<option value="double-mortise-tenon">Double Mortise & Tenon</option>';
          }
          if (doorWidthMm > 1200) {
            styleOptions += '<option value="french">French Doors</option>';
          }
          styleSel.innerHTML = styleOptions;
          var currentStyle = String(door.style || "standard");
          if (currentStyle === "french" && doorWidthMm <= 1200) {
            currentStyle = "standard";
            patchOpeningById(id, { style: "standard" });
          }
          if ((currentStyle === "double-standard" || currentStyle === "double-mortise-tenon") && doorWidthMm < 1200) {
            currentStyle = "standard";
            patchOpeningById(id, { style: "standard" });
          }
          styleSel.value = currentStyle;
          styleLabel.appendChild(styleSel);

          var hingeLabel = document.createElement("label");
          hingeLabel.textContent = "Hinge";
          var hingeSel = document.createElement("select");
          hingeSel.innerHTML =
            '<option value="left">Left</option>' +
            '<option value="right">Right</option>';
          hingeSel.value = String(door.handleSide || "left");
          hingeLabel.appendChild(hingeSel);

          var openLabel = document.createElement("label");
          openLabel.className = "openLabel";
          var openCheck = document.createElement("input");
          openCheck.type = "checkbox";
          openCheck.checked = !!(door.isOpen);
          openLabel.appendChild(openCheck);
          openLabel.appendChild(document.createTextNode(" Open"));

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
          top.appendChild(styleLabel);
          top.appendChild(hingeLabel);
          top.appendChild(openLabel);
          top.appendChild(actions);

          var row = document.createElement("div");
          row.className = "row3";

var unitMode = getUnitMode(state);
          var dimUnit = (unitMode === "imperial") ? "(in)" : "(mm)";
          var stepVal = (unitMode === "imperial") ? "0.5" : "10";
          var minVal = (unitMode === "imperial") ? "0" : "0";
          var minSizeVal = (unitMode === "imperial") ? "4" : "100";
          
          function makeNum(labelTxt, valueMm, minAttr, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(minAttr);
            inp.step = String(step);
            inp.value = formatDimension(valueMm, unitMode);
            lab.appendChild(inp);
            
            // Add feet-inches hint
            if (unitMode === "imperial" && valueMm > 0) {
              var hint = document.createElement("span");
              hint.className = "ftInHint";
              hint.textContent = "= " + formatFeetInchesReadout(valueMm);
              lab.appendChild(hint);
            }
            
            return { lab: lab, inp: inp, valueMm: valueMm };
          }

          var xField = makeNum("Door X " + dimUnit, Math.floor(Number(door.x_mm ?? 0)), minVal, stepVal);
          var wField = makeNum("Door W " + dimUnit, Math.floor(Number(door.width_mm ?? 900)), minSizeVal, stepVal);
          var hField = makeNum("Door H " + dimUnit, Math.floor(Number(door.height_mm ?? 2000)), minSizeVal, stepVal);

          row.appendChild(xField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          // Apply profile field restrictions
          applyFieldRestriction(wallSel, "door.wall");
          applyFieldRestriction(styleSel, "door.style");
          applyFieldRestriction(hingeSel, "door.hinge");
          applyFieldRestriction(openCheck, "door.open");
          applyFieldRestriction(xField.inp, "door.x");
          applyFieldRestriction(wField.inp, "door.width");
          applyFieldRestriction(hField.inp, "door.height");
          applyFieldRestriction(snapBtn, "door.snapBtn");
          applyFieldRestriction(rmBtn, "door.removeBtn");

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

function parseOpeningDim(val, defaultMm) {
            var s = store.getState();
            var um = getUnitMode(s);
            var n = parseFloat(val);
            if (!isFinite(n) || n < 0) return defaultMm;
            if (um === "imperial") {
              return Math.round(n * 25.4);
            }
            return Math.floor(n);
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: parseOpeningDim(xField.inp.value, Math.floor(Number(door.x_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: parseOpeningDim(wField.inp.value, Math.floor(Number(door.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: parseOpeningDim(hField.inp.value, Math.floor(Number(door.height_mm ?? 2000))) });
          });

          wallSel.addEventListener("change", function () {
            patchOpeningById(id, { wall: String(wallSel.value || "front") });
          });

          styleSel.addEventListener("change", function () {
            patchOpeningById(id, { style: String(styleSel.value || "standard") });
          });

          hingeSel.addEventListener("change", function () {
            patchOpeningById(id, { handleSide: String(hingeSel.value || "left") });
          });

          openCheck.addEventListener("change", function () {
            patchOpeningById(id, { isOpen: !!openCheck.checked });
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

var unitMode = getUnitMode(state);
          var dimUnit = (unitMode === "imperial") ? "(in)" : "(mm)";
          var stepVal = (unitMode === "imperial") ? "0.5" : "10";
          var minVal = (unitMode === "imperial") ? "0" : "0";
          var minSizeVal = (unitMode === "imperial") ? "4" : "100";
          
          function makeNum(labelTxt, valueMm, minAttr, step) {
            var lab = document.createElement("label");
            lab.textContent = labelTxt;
            var inp = document.createElement("input");
            inp.type = "number";
            inp.min = String(minAttr);
            inp.step = String(step);
            inp.value = formatDimension(valueMm, unitMode);
            lab.appendChild(inp);
            
            // Add feet-inches hint
            if (unitMode === "imperial" && valueMm > 0) {
              var hint = document.createElement("span");
              hint.className = "ftInHint";
              hint.textContent = "= " + formatFeetInchesReadout(valueMm);
              lab.appendChild(hint);
            }
            
            return { lab: lab, inp: inp, valueMm: valueMm };
          }

          var xField = makeNum("Win X " + dimUnit, Math.floor(Number(win.x_mm ?? 0)), minVal, stepVal);
          var yField = makeNum("Win Y " + dimUnit, Math.floor(Number(win.y_mm ?? 0)), minVal, stepVal);
          var wField = makeNum("Win W " + dimUnit, Math.floor(Number(win.width_mm ?? 900)), minSizeVal, stepVal);
          var hField = makeNum("Win H " + dimUnit, Math.floor(Number(win.height_mm ?? 600)), minSizeVal, stepVal);

          row.appendChild(xField.lab);
          row.appendChild(yField.lab);
          row.appendChild(wField.lab);
          row.appendChild(hField.lab);

          // Apply profile field restrictions for windows
          applyFieldRestriction(wallSel, "window.wall");
          applyFieldRestriction(xField.inp, "window.x");
          applyFieldRestriction(yField.inp, "window.y");
          applyFieldRestriction(wField.inp, "window.width");
          applyFieldRestriction(hField.inp, "window.height");
          applyFieldRestriction(snapBtn, "window.snapBtn");
          applyFieldRestriction(rmBtn, "window.removeBtn");

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

function parseOpeningDim(val, defaultMm) {
            var s = store.getState();
            var um = getUnitMode(s);
            var n = parseFloat(val);
            if (!isFinite(n) || n < 0) return defaultMm;
            if (um === "imperial") {
              return Math.round(n * 25.4);
            }
            return Math.floor(n);
          }

          wireCommitOnly(xField.inp, function () {
            patchOpeningById(id, { x_mm: parseOpeningDim(xField.inp.value, Math.floor(Number(win.x_mm ?? 0))) });
          });
          wireCommitOnly(yField.inp, function () {
            patchOpeningById(id, { y_mm: parseOpeningDim(yField.inp.value, Math.floor(Number(win.y_mm ?? 0))) });
          });
          wireCommitOnly(wField.inp, function () {
            patchOpeningById(id, { width_mm: parseOpeningDim(wField.inp.value, Math.floor(Number(win.width_mm ?? 900))) });
          });
          wireCommitOnly(hField.inp, function () {
            patchOpeningById(id, { height_mm: parseOpeningDim(hField.inp.value, Math.floor(Number(win.height_mm ?? 600))) });
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
        // Unit mode sync
        var unitMode = getUnitMode(state);
        if (unitModeMetricEl) unitModeMetricEl.checked = (unitMode === "metric");
        if (unitModeImperialEl) unitModeImperialEl.checked = (unitMode === "imperial");

// Update dimension labels based on unit mode
        var unitLabel = (unitMode === "imperial") ? "(inches)" : "(mm)";
        var wLabel = wInputEl && wInputEl.parentElement ? wInputEl.parentElement : null;
        var dLabel = dInputEl && dInputEl.parentElement ? dInputEl.parentElement : null;
        if (wLabel && wLabel.childNodes[0]) wLabel.childNodes[0].textContent = "Width " + unitLabel + " ";
        if (dLabel && dLabel.childNodes[0]) dLabel.childNodes[0].textContent = "Depth " + unitLabel + " ";
        
// Keep as number input, adjust step and min for imperial
        if (wInputEl) {
          wInputEl.step = (unitMode === "imperial") ? "0.5" : "10";
          wInputEl.min = (unitMode === "imperial") ? "1" : "1";
        }
        if (dInputEl) {
          dInputEl.step = (unitMode === "imperial") ? "0.5" : "10";
          dInputEl.min = (unitMode === "imperial") ? "1" : "1";
        }

        // Show feet-inches readout when in imperial mode
        if (unitMode === "imperial") {
          try {
            var R0ft = resolveDims(state || {});
            var m0ft = (state && state.dimMode) ? String(state.dimMode) : "base";
            var wMmFt, dMmFt;
            if (m0ft === "frame") {
              wMmFt = R0ft.frame.w_mm;
              dMmFt = R0ft.frame.d_mm;
            } else if (m0ft === "roof") {
              wMmFt = R0ft.roof.w_mm;
              dMmFt = R0ft.roof.d_mm;
            } else {
              wMmFt = R0ft.base.w_mm;
              dMmFt = R0ft.base.d_mm;
            }
            if (wFtInEl) {
              wFtInEl.textContent = "= " + formatFeetInchesReadout(wMmFt);
              wFtInEl.style.display = "inline";
            }
            if (dFtInEl) {
              dFtInEl.textContent = "= " + formatFeetInchesReadout(dMmFt);
              dFtInEl.style.display = "inline";
            }
          } catch (eFt) {}
        } else {
          if (wFtInEl) wFtInEl.style.display = "none";
          if (dFtInEl) dFtInEl.style.display = "none";
        }

        if (dimModeEl) dimModeEl.value = (state && state.dimMode) ? state.dimMode : "base";

if (wInputEl && dInputEl) {
          // Skip updating dimension inputs if either one has focus (user is editing)
          // This prevents the input from being overwritten while user is typing
          var wHasFocus = document.activeElement === wInputEl;
          var dHasFocus = document.activeElement === dInputEl;
          console.log("[syncUiFromState] wHasFocus:", wHasFocus, "dHasFocus:", dHasFocus);
          console.log("[syncUiFromState] state.dim:", state.dim);

          if (!wHasFocus && !dHasFocus) {
            var m0 = (state && state.dimMode) ? String(state.dimMode) : "base";
            try {
              var R0 = resolveDims(state || {});
              console.log("[syncUiFromState] resolveDims returned frame:", R0.frame);
              var wMm, dMm;
              if (m0 === "frame") {
                wMm = R0.frame.w_mm;
                dMm = R0.frame.d_mm;
              } else if (m0 === "roof") {
                wMm = R0.roof.w_mm;
                dMm = R0.roof.d_mm;
              } else {
                wMm = R0.base.w_mm;
                dMm = R0.base.d_mm;
              }
              console.log("[syncUiFromState] Setting inputs to wMm:", wMm, "dMm:", dMm, "mode:", m0);
              wInputEl.value = formatDimension(wMm, unitMode);
              dInputEl.value = formatDimension(dMm, unitMode);
            } catch (e0) {
              if (wInputEl && state && state.w != null) wInputEl.value = formatDimension(state.w, unitMode);
              if (dInputEl && state && state.d != null) dInputEl.value = formatDimension(state.d, unitMode);
            }
          } else {
            console.log("[syncUiFromState] Skipping dimension input update - one has focus");
          }
        }

               if (roofStyleEl) {
          var style = (state && state.roof && state.roof.style) ? String(state.roof.style) : "apex";
          roofStyleEl.value = style;
          // Keep roof height controls in sync with current roof style
          updateRoofHeightBlocks(style);
        }


        // Apex trusses UI (mm only): count + computed spacing readout
        try {
          var _roofStyleNow = (state && state.roof && state.roof.style != null) ? String(state.roof.style) : "apex";
          if (roofApexTrussCountEl) {
            var n0 = getApexTrussCountFromState(state);
            if (n0 == null) n0 = computeLegacyApexTrussCount(state);
            roofApexTrussCountEl.value = String(n0);
            // Keep usable even if hidden by CSS/layout; but disable when not apex to avoid accidental edits.
            // Only change disabled state if not profile-disabled
            if (!roofApexTrussCountEl.classList.contains("profile-disabled")) {
              roofApexTrussCountEl.disabled = (_roofStyleNow !== "apex");
              roofApexTrussCountEl.setAttribute("aria-disabled", String(_roofStyleNow !== "apex"));
            }
          }
          if (roofApexTrussSpacingEl) {
            roofApexTrussSpacingEl.textContent = computeApexTrussSpacingText(state);
          }
          if (roofApexTieBeamEl) {
            var tieBeamVal = (state && state.roof && state.roof.apex && state.roof.apex.tieBeam) || "eaves";
            roofApexTieBeamEl.value = tieBeamVal;
            if (!roofApexTieBeamEl.classList.contains("profile-disabled")) {
              roofApexTieBeamEl.disabled = (_roofStyleNow !== "apex");
            }
          }
        } catch (eApexUi) {}

var isPent = isPentRoofStyle(state);
        if (roofMinHeightEl && roofMaxHeightEl) {
          var ph = getPentHeightsFromState(state);
          roofMinHeightEl.value = formatDimension(ph.minH, unitMode);
          roofMaxHeightEl.value = formatDimension(ph.maxH, unitMode);
roofMinHeightEl.step = (unitMode === "imperial") ? "0.5" : "10";
          roofMaxHeightEl.step = (unitMode === "imperial") ? "0.5" : "10";
          roofMinHeightEl.min = (unitMode === "imperial") ? "4" : "100";
          roofMaxHeightEl.min = (unitMode === "imperial") ? "4" : "100";
          // Only change disabled state if not profile-disabled
          if (!roofMinHeightEl.classList.contains("profile-disabled")) {
            roofMinHeightEl.disabled = !isPent;
          }
          if (!roofMaxHeightEl.classList.contains("profile-disabled")) {
            roofMaxHeightEl.disabled = !isPent;
          }
          
          // Update labels
          var minLabel = roofMinHeightEl.parentElement;
          var maxLabel = roofMaxHeightEl.parentElement;
          var heightUnit = (unitMode === "imperial") ? "(inches)" : "(mm)";
          if (minLabel && minLabel.childNodes[0]) minLabel.childNodes[0].textContent = "Minimum Height " + heightUnit + " ";
          if (maxLabel && maxLabel.childNodes[0]) maxLabel.childNodes[0].textContent = "Maximum Height " + heightUnit + " ";
          
          // Feet-inches readout
          if (unitMode === "imperial" && isPent) {
            if (roofMinFtInEl) { roofMinFtInEl.textContent = "= " + formatFeetInchesReadout(ph.minH); roofMinFtInEl.style.display = "inline"; }
            if (roofMaxFtInEl) { roofMaxFtInEl.textContent = "= " + formatFeetInchesReadout(ph.maxH); roofMaxFtInEl.style.display = "inline"; }
          } else {
            if (roofMinFtInEl) roofMinFtInEl.style.display = "none";
            if (roofMaxFtInEl) roofMaxFtInEl.style.display = "none";
          }

          // Calculate and display pent pitch angle
          var roofPitchPentEl = $("roofPitchPent");
          if (roofPitchPentEl && isPent) {
            var R = resolveDims(state);
            var frameW_mm = (R && R.frame && R.frame.w_mm) ? Math.max(1, Math.floor(Number(R.frame.w_mm))) : 1000;
            var pentRise_mm = Math.max(0, ph.maxH - ph.minH);
            var pentPitchRad = Math.atan2(pentRise_mm, frameW_mm);
            var pentPitchDeg = Math.round(pentPitchRad * (180 / Math.PI));
            roofPitchPentEl.value = String(pentPitchDeg) + "°";
          }
        }

// Apex absolute eaves/crest heights (mm)
        try {
          var isApex = isApexRoofStyle(state);
          var ah = getApexHeightsFromState(state);

if (roofApexEavesHeightEl) {
            // Only change disabled state if not profile-disabled
            if (!roofApexEavesHeightEl.classList.contains("profile-disabled")) {
              roofApexEavesHeightEl.disabled = !isApex;
              roofApexEavesHeightEl.setAttribute("aria-disabled", String(!isApex));
            }
            roofApexEavesHeightEl.step = (unitMode === "imperial") ? "0.5" : "10";
            roofApexEavesHeightEl.min = (unitMode === "imperial") ? "4" : "100";
            if (isApex && ah.eaves != null) roofApexEavesHeightEl.value = formatDimension(ah.eaves, unitMode);
            
            var eaveLabel = roofApexEavesHeightEl.parentElement;
            var apexHeightUnit = (unitMode === "imperial") ? "(inches)" : "(mm)";
            if (eaveLabel && eaveLabel.childNodes[0]) eaveLabel.childNodes[0].textContent = "Height to Eaves " + apexHeightUnit + " ";
          }

          if (roofApexCrestHeightEl) {
            // Only change disabled state if not profile-disabled
            if (!roofApexCrestHeightEl.classList.contains("profile-disabled")) {
              roofApexCrestHeightEl.disabled = !isApex;
              roofApexCrestHeightEl.setAttribute("aria-disabled", String(!isApex));
            }
           roofApexCrestHeightEl.step = (unitMode === "imperial") ? "0.5" : "10";
            roofApexCrestHeightEl.min = (unitMode === "imperial") ? "4" : "100";
            if (isApex && ah.crest != null) roofApexCrestHeightEl.value = formatDimension(ah.crest, unitMode);
            
            var crestLabel = roofApexCrestHeightEl.parentElement;
            if (crestLabel && crestLabel.childNodes[0]) crestLabel.childNodes[0].textContent = "Height to Crest " + apexHeightUnit + " ";
          }
          
          // Feet-inches readout for apex
          if (unitMode === "imperial" && isApex) {
            if (roofApexEaveFtInEl && ah.eaves != null) { roofApexEaveFtInEl.textContent = "= " + formatFeetInchesReadout(ah.eaves); roofApexEaveFtInEl.style.display = "inline"; }
            if (roofApexCrestFtInEl && ah.crest != null) { roofApexCrestFtInEl.textContent = "= " + formatFeetInchesReadout(ah.crest); roofApexCrestFtInEl.style.display = "inline"; }
          } else {
            if (roofApexEaveFtInEl) roofApexEaveFtInEl.style.display = "none";
            if (roofApexCrestFtInEl) roofApexCrestFtInEl.style.display = "none";
          }

          // Calculate and display apex pitch angle
          var roofPitchApexEl = $("roofPitchApex");
          if (roofPitchApexEl && isApex && ah.eaves != null && ah.crest != null) {
            var R = resolveDims(state);
            var roofW_mm = (R && R.roof && R.roof.w_mm) ? Math.max(1, Math.floor(Number(R.roof.w_mm))) : 1000;
            var halfSpan_mm = roofW_mm / 2;
            var apexRise_mm = Math.max(0, ah.crest - ah.eaves);
            var apexPitchRad = Math.atan2(apexRise_mm, halfSpan_mm);
            var apexPitchDeg = Math.round(apexPitchRad * (180 / Math.PI));
            roofPitchApexEl.value = String(apexPitchDeg) + "°";
          }
        } catch (eApexSync) {}

if (state && state.overhang) {
          var ovhUnit = (unitMode === "imperial") ? "(in)" : "(mm)";
          
          // Update labels
          if (overUniformLabelEl) overUniformLabelEl.textContent = "Uniform " + ovhUnit;
          if (overFrontLabelEl) overFrontLabelEl.textContent = "Front " + ovhUnit;
          if (overBackLabelEl) overBackLabelEl.textContent = "Back " + ovhUnit;
          if (overLeftLabelEl) overLeftLabelEl.textContent = "Left " + ovhUnit;
          if (overRightLabelEl) overRightLabelEl.textContent = "Right " + ovhUnit;
          
          // Update step and min
          var ovhStep = (unitMode === "imperial") ? "0.5" : "1";
          if (overUniformEl) { overUniformEl.step = ovhStep; overUniformEl.min = "0"; }
          if (overFrontEl) { overFrontEl.step = ovhStep; overFrontEl.min = "0"; }
          if (overBackEl) { overBackEl.step = ovhStep; overBackEl.min = "0"; }
          if (overLeftEl) { overLeftEl.step = ovhStep; overLeftEl.min = "0"; }
          if (overRightEl) { overRightEl.step = ovhStep; overRightEl.min = "0"; }
          
          // Format values
          var uniMm = state.overhang.uniform_mm != null ? state.overhang.uniform_mm : 0;
          var leftMm = state.overhang.left_mm;
          var rightMm = state.overhang.right_mm;
          var frontMm = state.overhang.front_mm;
          var backMm = state.overhang.back_mm;
          
          if (overUniformEl) overUniformEl.value = formatDimension(uniMm, unitMode);
          if (overLeftEl) overLeftEl.value = leftMm == null ? "" : formatDimension(leftMm, unitMode);
          if (overRightEl) overRightEl.value = rightMm == null ? "" : formatDimension(rightMm, unitMode);
          if (overFrontEl) overFrontEl.value = frontMm == null ? "" : formatDimension(frontMm, unitMode);
          if (overBackEl) overBackEl.value = backMm == null ? "" : formatDimension(backMm, unitMode);
          
          // Feet-inches readouts
          if (unitMode === "imperial") {
            if (overUniformFtInEl && uniMm > 0) { overUniformFtInEl.textContent = "= " + formatFeetInchesReadout(uniMm); overUniformFtInEl.style.display = "inline"; }
            else if (overUniformFtInEl) overUniformFtInEl.style.display = "none";
            
            if (overFrontFtInEl && frontMm != null) { overFrontFtInEl.textContent = "= " + formatFeetInchesReadout(frontMm); overFrontFtInEl.style.display = "inline"; }
            else if (overFrontFtInEl) overFrontFtInEl.style.display = "none";
            
            if (overBackFtInEl && backMm != null) { overBackFtInEl.textContent = "= " + formatFeetInchesReadout(backMm); overBackFtInEl.style.display = "inline"; }
            else if (overBackFtInEl) overBackFtInEl.style.display = "none";
            
            if (overLeftFtInEl && leftMm != null) { overLeftFtInEl.textContent = "= " + formatFeetInchesReadout(leftMm); overLeftFtInEl.style.display = "inline"; }
            else if (overLeftFtInEl) overLeftFtInEl.style.display = "none";
            
            if (overRightFtInEl && rightMm != null) { overRightFtInEl.textContent = "= " + formatFeetInchesReadout(rightMm); overRightFtInEl.style.display = "inline"; }
            else if (overRightFtInEl) overRightFtInEl.style.display = "none";
          } else {
            if (overUniformFtInEl) overUniformFtInEl.style.display = "none";
            if (overFrontFtInEl) overFrontFtInEl.style.display = "none";
            if (overBackFtInEl) overBackFtInEl.style.display = "none";
            if (overLeftFtInEl) overLeftFtInEl.style.display = "none";
            if (overRightFtInEl) overRightFtInEl.style.display = "none";
          }
        }

        if (vBaseAllEl) vBaseAllEl.checked = getBaseEnabled(state);
        if (vBaseEl) vBaseEl.checked = !!(state && state.vis && state.vis.base);
        if (vFrameEl) vFrameEl.checked = !!(state && state.vis && state.vis.frame);
        if (vInsEl) vInsEl.checked = (state && state.vis && state.vis.ins !== false);
        if (vDeckEl) vDeckEl.checked = !!(state && state.vis && state.vis.deck);

        if (vWallsEl) vWallsEl.checked = getWallsEnabled(state);
        if (vRoofEl) vRoofEl.checked = getRoofEnabled(state);
        if (vCladdingEl) vCladdingEl.checked = getCladdingEnabled(state);
        if (vOpeningsEl) vOpeningsEl.checked = (state && state.vis && typeof state.vis.openings === "boolean") ? state.vis.openings : true;

        var rp = (state && state.vis && state.vis.roofParts && typeof state.vis.roofParts === "object") ? state.vis.roofParts : null;
        if (vRoofStructureEl) vRoofStructureEl.checked = rp ? (rp.structure !== false) : true;
        if (vRoofOsbEl) vRoofOsbEl.checked = rp ? (rp.osb !== false) : true;
        var vRoofCoveringEl = $("vRoofCovering");
        if (vRoofCoveringEl) vRoofCoveringEl.checked = rp ? (rp.covering !== false) : true;

        var parts = getWallParts(state);
        if (vWallFrontEl) vWallFrontEl.checked = !!parts.front;
        if (vWallBackEl) vWallBackEl.checked = !!parts.back;
        if (vWallLeftEl) vWallLeftEl.checked = !!parts.left;
        if (vWallRightEl) vWallRightEl.checked = !!parts.right;
        if (vWallInsulationEl) vWallInsulationEl.checked = state?.vis?.wallIns !== false;
        if (vWallPlywoodEl) vWallPlywoodEl.checked = state?.vis?.wallPly !== false;

        if (wallsVariantEl && state && state.walls && state.walls.variant) wallsVariantEl.value = state.walls.variant;
        if (claddingStyleEl && state && state.cladding && state.cladding.style) claddingStyleEl.value = state.cladding.style;

        if (wallHeightEl) {
          if (isPent) {
            wallHeightEl.value = String(computePentDisplayHeight(state));
          } else if (state && state.walls && state.walls.height_mm != null) {
            wallHeightEl.value = String(state.walls.height_mm);
          }
        }

       if (wallSectionEl && state && state.walls) {
          var h = null;
          try {
            if (state.frame && state.frame.depth_mm != null) h = state.frame.depth_mm;
            else if (state.walls.insulated && state.walls.insulated.section && state.walls.insulated.section.h != null) h = state.walls.insulated.section.h;
            else if (state.walls.basic && state.walls.basic.section && state.walls.basic.section.h != null) h = state.walls.basic.section.h;
          } catch (e) {}
          wallSectionEl.value = (Math.floor(Number(h)) === 75) ? "50x75" : "50x100";
          
// Update option labels for unit mode
          var opts = wallSectionEl.options;
          for (var oi = 0; oi < opts.length; oi++) {
            var opt = opts[oi];
            if (opt.value === "50x75") {
              opt.textContent = (unitMode === "imperial") ? '3" x 2"' : "75 x 50";
            } else if (opt.value === "50x100") {
              opt.textContent = (unitMode === "imperial") ? '4" x 2"' : "100 x 50";
            }
          }
        }

        // Update frame gauge label for unit mode
        var wallSectionLabel = wallSectionEl && wallSectionEl.parentElement ? wallSectionEl.parentElement : null;
        if (wallSectionLabel && wallSectionLabel.childNodes[0]) {
          wallSectionLabel.childNodes[0].textContent = (unitMode === "imperial") 
            ? "Frame Gauge/Thickness (in) " 
            : "Frame Gauge/Thickness ";
        }

        applyWallHeightUiLock(state);

        var dv = validations && validations.doors ? validations.doors : null;
        var wv = validations && validations.windows ? validations.windows : null;

        renderDoorsUi(state, dv);
        renderWindowsUi(state, wv);
      } catch (e) {
        window.__dbg.lastError = "syncUiFromState failed: " + String(e && e.message ? e.message : e);
      }
    }

    // Expose a function to refresh dynamic controls after profile changes
    // This is called by the Profile Editor after applying a profile
    window.__dbg.refreshDynamicControls = function() {
      var state = store.getState();
      var validations = syncInvalidOpeningsIntoState();
      renderDoorsUi(state, validations && validations.doors ? validations.doors : null);
      renderWindowsUi(state, validations && validations.windows ? validations.windows : null);
      console.log("[index] Refreshed dynamic controls for profile change");
    };

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
        applyWallHeightUiLock(store.getState());
        updateRoofHeightBlocks(v);
      });
    }


function commitPentHeightsFromInputs() {
      if (!roofMinHeightEl || !roofMaxHeightEl) return;
      var s = store.getState();
      var unitMode = getUnitMode(s);
      
      // Pent height constraints: 1000-2400mm for both walls
      var PENT_MIN = 1000;
      var PENT_MAX = 2400;
      
      var minVal = parseFloat(roofMinHeightEl.value) || 0;
      var maxVal = parseFloat(roofMaxHeightEl.value) || 0;
      
      if (unitMode === "imperial") {
        minVal = Math.round(minVal * 25.4);
        maxVal = Math.round(maxVal * 25.4);
      }
      
      // Clamp to valid range
      var minH = clamp(Math.floor(minVal), PENT_MIN, PENT_MAX);
      var maxH = clamp(Math.floor(maxVal), PENT_MIN, PENT_MAX);
      
      // Ensure max > min (need some pitch)
      if (maxH <= minH) {
        maxH = Math.min(minH + 100, PENT_MAX); // Add 100mm pitch minimum
        if (maxH <= minH) minH = maxH - 100; // If at max, lower the min instead
      }
      
      // Update UI to reflect clamped values
      try { 
        roofMinHeightEl.value = String(minH); 
        roofMaxHeightEl.value = String(maxH);
      } catch (e) {}
      
      store.setState({ roof: { pent: { minHeight_mm: minH, maxHeight_mm: maxH } } });
    }

    // Apex: absolute heights from ground (mm)
function commitApexHeightsFromInputs() {
      if (!roofApexEavesHeightEl || !roofApexCrestHeightEl) return;

      var s = store.getState();
      if (!isApexRoofStyle(s)) return;
      
      // Apex height constraints: eaves 800-2400mm, crest 1000-4500mm
      var APEX_EAVE_MIN = 800;
      var APEX_EAVE_MAX = 2400;
      var APEX_CREST_MIN = 1000;
      var APEX_CREST_MAX = 4500;
      
      var unitMode = getUnitMode(s);
      var eavesVal = parseFloat(roofApexEavesHeightEl.value) || 0;
      var crestVal = parseFloat(roofApexCrestHeightEl.value) || 0;
      
      if (unitMode === "imperial") {
        eavesVal = Math.round(eavesVal * 25.4);
        crestVal = Math.round(crestVal * 25.4);
      }

      // Clamp to valid ranges
      var eaves = clamp(Math.floor(eavesVal), APEX_EAVE_MIN, APEX_EAVE_MAX);
      var crest = clamp(Math.floor(crestVal), APEX_CREST_MIN, APEX_CREST_MAX);

      // Ensure crest > eaves (need some pitch)
      if (crest <= eaves) {
        crest = eaves + 100; // Minimum 100mm above eaves
        if (crest > APEX_CREST_MAX) {
          crest = APEX_CREST_MAX;
          eaves = crest - 100; // If at max crest, lower eaves
        }
      }

      // Reflect clamp immediately in UI so the user sees the correction.
      try { 
        roofApexEavesHeightEl.value = String(eaves);
        roofApexCrestHeightEl.value = String(crest); 
      } catch (e0) {}

      store.setState({ roof: { apex: { heightToEaves_mm: eaves, heightToCrest_mm: crest } } });
    }

if (roofMinHeightEl) wireCommitOnly(roofMinHeightEl, function () {
      if (!isPentRoofStyle(store.getState())) return;
      commitPentHeightsFromInputs();
    });
    if (roofMaxHeightEl) wireCommitOnly(roofMaxHeightEl, function () {
      if (!isPentRoofStyle(store.getState())) return;
      commitPentHeightsFromInputs();
    });

    // Commit-only (blur/Enter) so changes deterministically trigger state->rebuild in the same pathway as other controls.
    if (roofApexEavesHeightEl) wireCommitOnly(roofApexEavesHeightEl, commitApexHeightsFromInputs);
   if (roofApexCrestHeightEl) wireCommitOnly(roofApexCrestHeightEl, commitApexHeightsFromInputs);

    // Apex trusses (incl. gable ends): user-selected count
    // Apex trusses (incl. gable ends): user-selected count
    if (roofApexTrussCountEl) {
      roofApexTrussCountEl.addEventListener("input", function () {
        var s = store.getState();
        var style = (s && s.roof && s.roof.style != null) ? String(s.roof.style) : "apex";
        if (style !== "apex") return;

        var n = Math.floor(Number(roofApexTrussCountEl.value));
        if (!Number.isFinite(n)) n = computeLegacyApexTrussCount(s);
        n = clamp(n, 2, 200);

        store.setState({ roof: { apex: { trussCount: n } } });
      });
    }

    // Apex truss tie beam position
    if (roofApexTieBeamEl) {
      roofApexTieBeamEl.addEventListener("change", function () {
        var s = store.getState();
        var style = (s && s.roof && s.roof.style != null) ? String(s.roof.style) : "apex";
        if (style !== "apex") return;

        var val = roofApexTieBeamEl.value || "eaves";
        store.setState({ roof: { apex: { tieBeam: val } } });
      });
    }

    if (vWallsEl) {
      vWallsEl.addEventListener("change", function (e) {
        var s = store.getState();
        var on = !!(e && e.target && e.target.checked);
        // Apply visibility immediately for responsiveness
        try { applyWallsVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}

        if (s && s.vis && typeof s.vis.walls === "boolean") store.setState({ vis: { walls: on } });
        else if (s && s.vis && typeof s.vis.wallsEnabled === "boolean") store.setState({ vis: { wallsEnabled: on } });
        else store.setState({ vis: { walls: on } });
        console.log("[vis] walls=", on ? "ON" : "OFF");
      });
    }

    if (vRoofEl) vRoofEl.addEventListener("change", function(e){
      var on = !!e.target.checked;
      // Apply visibility immediately for responsiveness
      try { applyRoofVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { roof: on } });
      console.log("[vis] roof=", on ? "ON" : "OFF");
    });

if (vCladdingEl) vCladdingEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      try { applyCladdingVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { cladding: on } });
      console.log("[vis] cladding=", on ? "ON" : "OFF");
    });

    if (unitModeMetricEl) unitModeMetricEl.addEventListener("change", function () {
      if (unitModeMetricEl.checked) store.setState({ unitMode: "metric" });
    });
    if (unitModeImperialEl) unitModeImperialEl.addEventListener("change", function () {
      if (unitModeImperialEl.checked) store.setState({ unitMode: "imperial" });
    });

    if (vOpeningsEl) vOpeningsEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      console.log("[vis] openings change fired, on=", on);
      try { 
        applyOpeningsVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); 
      } catch (e0) { 
        console.log("[vis] openings error:", e0); 
      }
      store.setState({ vis: { openings: on } });
      console.log("[vis] openings=", on ? "ON" : "OFF");
    });

    if (vRoofStructureEl) vRoofStructureEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      // Apply visibility immediately for responsiveness
      try { applyRoofStructureVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      var s = store.getState();
      var cur = (s && s.vis && s.vis.roofParts && typeof s.vis.roofParts === "object") ? s.vis.roofParts : null;
      var next = cur ? Object.assign({}, cur) : {};
      next.structure = on;
      store.setState({ vis: { roofParts: next } });
      console.log("[vis] roof structure=", on ? "ON" : "OFF");
    });

    if (vRoofOsbEl) vRoofOsbEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      // Apply visibility immediately for responsiveness
      try { applyRoofOsbVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      var s = store.getState();
      var cur = (s && s.vis && s.vis.roofParts && typeof s.vis.roofParts === "object") ? s.vis.roofParts : null;
      var next = cur ? Object.assign({}, cur) : {};
      next.osb = on;
      store.setState({ vis: { roofParts: next } });
      console.log("[vis] roof osb=", on ? "ON" : "OFF");
    });

    var vRoofCoveringEl = $("vRoofCovering");
    if (vRoofCoveringEl) vRoofCoveringEl.addEventListener("change", function (e) {
      var on = !!(e && e.target && e.target.checked);
      // Apply visibility immediately for responsiveness
      try { applyRoofCoveringVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      var s = store.getState();
      var cur = (s && s.vis && s.vis.roofParts && typeof s.vis.roofParts === "object") ? s.vis.roofParts : null;
      var next = cur ? Object.assign({}, cur) : {};
      next.covering = on;
      store.setState({ vis: { roofParts: next } });
      console.log("[vis] roof covering=", on ? "ON" : "OFF");
    });

    if (vBaseAllEl) vBaseAllEl.addEventListener("change", function(e){
      var on = !!(e && e.target && e.target.checked);
      // Apply visibility immediately for responsiveness
      try { applyBaseVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { baseAll: on } });
      console.log("[vis] base=", on ? "ON" : "OFF");
    });

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
    if (vWallInsulationEl) vWallInsulationEl.addEventListener("change", function (e) { store.setState({ vis: { wallIns: !!e.target.checked } }); });
    if (vWallPlywoodEl) vWallPlywoodEl.addEventListener("change", function (e) { store.setState({ vis: { wallPly: !!e.target.checked } }); });

    // ==================== ATTACHMENT VISIBILITY EVENT HANDLERS ====================

    if (vAttBaseEl) vAttBaseEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentBaseVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { base: on } } });
      console.log("[vis] attachment base=", on ? "ON" : "OFF");
    });

    if (vAttWallsEl) vAttWallsEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallsVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { walls: on } } });
      console.log("[vis] attachment walls=", on ? "ON" : "OFF");
    });

    if (vAttRoofEl) vAttRoofEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentRoofVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { roof: on } } });
      console.log("[vis] attachment roof=", on ? "ON" : "OFF");
    });

    if (vAttCladdingEl) vAttCladdingEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentCladdingVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { cladding: on } } });
      console.log("[vis] attachment cladding=", on ? "ON" : "OFF");
    });

    if (vAttBaseGridEl) vAttBaseGridEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentBaseGridVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { baseGrid: on } } });
      console.log("[vis] attachment base grid=", on ? "ON" : "OFF");
    });

    if (vAttBaseFrameEl) vAttBaseFrameEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentBaseFrameVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { baseFrame: on } } });
      console.log("[vis] attachment base frame=", on ? "ON" : "OFF");
    });

    if (vAttBaseDeckEl) vAttBaseDeckEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentBaseDeckVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, on); } catch (e0) {}
      store.setState({ vis: { attachments: { baseDeck: on } } });
      console.log("[vis] attachment base deck=", on ? "ON" : "OFF");
    });

    if (vAttWallFrontEl) vAttWallFrontEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, "front", on); } catch (e0) {}
      store.setState({ vis: { attachments: { wallFront: on } } });
      console.log("[vis] attachment wall front=", on ? "ON" : "OFF");
    });

    if (vAttWallBackEl) vAttWallBackEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, "back", on); } catch (e0) {}
      store.setState({ vis: { attachments: { wallBack: on } } });
      console.log("[vis] attachment wall back=", on ? "ON" : "OFF");
    });

    if (vAttWallLeftEl) vAttWallLeftEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, "left", on); } catch (e0) {}
      store.setState({ vis: { attachments: { wallLeft: on } } });
      console.log("[vis] attachment wall left=", on ? "ON" : "OFF");
    });

    if (vAttWallRightEl) vAttWallRightEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, "right", on); } catch (e0) {}
      store.setState({ vis: { attachments: { wallRight: on } } });
      console.log("[vis] attachment wall right=", on ? "ON" : "OFF");
    });

    if (vAttWallOuterEl) vAttWallOuterEl.addEventListener("change", function (e) {
      var on = !!e.target.checked;
      try { applyAttachmentWallVisibility(window.__dbg && window.__dbg.scene ? window.__dbg.scene : null, "outer", on); } catch (e0) {}
      store.setState({ vis: { attachments: { wallOuter: on } } });
      console.log("[vis] attachment wall outer=", on ? "ON" : "OFF");
    });

    // Developer panel attachment visibility controls (sync with main controls)
    function syncDevAttToMain(devEl, mainEl) {
      if (devEl && mainEl) {
        devEl.addEventListener("change", function (e) {
          mainEl.checked = e.target.checked;
          mainEl.dispatchEvent(new Event("change"));
        });
      }
    }
    syncDevAttToMain(devVAttBaseEl, vAttBaseEl);
    syncDevAttToMain(devVAttWallsEl, vAttWallsEl);
    syncDevAttToMain(devVAttRoofEl, vAttRoofEl);
    syncDevAttToMain(devVAttCladdingEl, vAttCladdingEl);
    syncDevAttToMain(devVAttBaseGridEl, vAttBaseGridEl);
    syncDevAttToMain(devVAttBaseFrameEl, vAttBaseFrameEl);
    syncDevAttToMain(devVAttBaseDeckEl, vAttBaseDeckEl);
    syncDevAttToMain(devVAttWallFrontEl, vAttWallFrontEl);
    syncDevAttToMain(devVAttWallBackEl, vAttWallBackEl);
    syncDevAttToMain(devVAttWallLeftEl, vAttWallLeftEl);
    syncDevAttToMain(devVAttWallRightEl, vAttWallRightEl);
    syncDevAttToMain(devVAttWallOuterEl, vAttWallOuterEl);

    if (dimModeEl) {
      dimModeEl.addEventListener("change", function () {
        store.setState({ dimMode: dimModeEl.value });
        syncUiFromState(store.getState(), syncInvalidOpeningsIntoState());
      });
    }

/**
     * Clamp building dimensions to realistic limits for timber-framed garden buildings.
     * Rules:
     *   - Neither dimension can exceed 8000mm (8m)
     *   - If either dimension exceeds 4000mm (4m), the other is capped at 4000mm
     * This allows builds up to 8m x 4m in either orientation, but not e.g. 5m x 5m.
     * @param {number} w - Width in mm
     * @param {number} d - Depth in mm
     * @returns {{w: number, d: number, clamped: boolean}} Clamped dimensions
     */
    function clampBuildingDimensions(w, d) {
      var MAX_LONG = 8000;  // Maximum for the longer dimension
      var MAX_SHORT = 4000; // Maximum for the shorter dimension when other > 4000

      var origW = w, origD = d;

      // Enforce absolute maximum of 8000mm
      if (w > MAX_LONG) w = MAX_LONG;
      if (d > MAX_LONG) d = MAX_LONG;

      // If one dimension exceeds 4000mm, cap the other at 4000mm
      if (w > MAX_SHORT && d > MAX_SHORT) {
        // Both exceed 4000mm - cap the smaller one to 4000mm
        if (w >= d) {
          d = MAX_SHORT;
        } else {
          w = MAX_SHORT;
        }
      }

      var didClamp = (w !== origW || d !== origD);
      if (didClamp) {
        console.log("[clampBuildingDimensions] CLAMPED:", origW, "x", origD, "->", w, "x", d);
      }

      return { w: w, d: d, clamped: didClamp };
    }

function writeActiveDims() {
      var s = store.getState();
      var unitMode = getUnitMode(s);
      var w, d;

if (unitMode === "imperial") {
        // Input is in decimal inches
        var wInches = parseFloat(wInputEl ? wInputEl.value : 0) || 0;
        var dInches = parseFloat(dInputEl ? dInputEl.value : 0) || 0;
        w = Math.round(wInches * 25.4);
        d = Math.round(dInches * 25.4);
        if (w < 1) w = 1000;
        if (d < 1) d = 1000;
      } else {
        w = asPosInt(wInputEl ? wInputEl.value : null, 1000);
        d = asPosInt(dInputEl ? dInputEl.value : null, 1000);
      }

      // Apply realistic dimension constraints
      var clamped = clampBuildingDimensions(w, d);
      w = clamped.w;
      d = clamped.d;

      // If values were clamped, update the input fields to reflect the actual values
      if (clamped.clamped) {
        if (wInputEl) wInputEl.value = formatDimension(w, unitMode);
        if (dInputEl) dInputEl.value = formatDimension(d, unitMode);
        console.log("[writeActiveDims] Dimensions clamped to:", w, "x", d, "mm (max 8m x 4m)");
      }

      var mode = (s && s.dimMode) ? String(s.dimMode) : "base";

      var G = 50;
      try {
        if (s && s.dimGap_mm != null) {
          var gg = Math.floor(Number(s.dimGap_mm));
          if (Number.isFinite(gg) && gg >= 0) G = gg;
        }
      } catch (e0) {}

      var ovh = null;
      try {
        var R = resolveDims(s);
        ovh = R && R.overhang ? R.overhang : null;
      } catch (e1) { ovh = null; }

      var sumX = (ovh && ovh.l_mm != null ? Math.floor(Number(ovh.l_mm)) : 0) + (ovh && ovh.r_mm != null ? Math.floor(Number(ovh.r_mm)) : 0);
      var sumZ = (ovh && ovh.f_mm != null ? Math.floor(Number(ovh.f_mm)) : 0) + (ovh && ovh.b_mm != null ? Math.floor(Number(ovh.b_mm)) : 0);

      if (!Number.isFinite(sumX)) sumX = 0;
      if (!Number.isFinite(sumZ)) sumZ = 0;

      var frameW = 1;
      var frameD = 1;

      if (mode === "frame") {
        frameW = w;
        frameD = d;
      } else if (mode === "roof") {
        frameW = Math.max(1, Math.floor(w - sumX));
        frameD = Math.max(1, Math.floor(d - sumZ));
      } else { // base
        frameW = Math.max(1, Math.floor(w + G));
        frameD = Math.max(1, Math.floor(d + G));
      }

      var baseW = Math.max(1, Math.floor(frameW - G));
      var baseD = Math.max(1, Math.floor(frameD - G));
      var roofW = Math.max(1, Math.floor(frameW + sumX));
      var roofD = Math.max(1, Math.floor(frameD + sumZ));

      console.log("[writeActiveDims] Updating store with frameW_mm:", frameW, "frameD_mm:", frameD);
      store.setState({
        dim: { frameW_mm: frameW, frameD_mm: frameD },
        dimInputs: {
          baseW_mm: baseW,
          baseD_mm: baseD,
          frameW_mm: frameW,
          frameD_mm: frameD,
          roofW_mm: roofW,
          roofD_mm: roofD
        }
      });
      console.log("[writeActiveDims] Store updated. New state.dim:", store.getState().dim);
    }
if (wInputEl) wireCommitOnly(wInputEl, writeActiveDims);
    if (dInputEl) wireCommitOnly(dInputEl, writeActiveDims);

function parseOverhangInput(val) {
      var s = store.getState();
      var unitMode = getUnitMode(s);
      if (val == null || val === "") return null;
      var n = parseFloat(val);
      if (!isFinite(n) || n < 0) return null;
      if (unitMode === "imperial") {
        return Math.round(n * 25.4);
      }
      return Math.floor(n);
    }
    
    if (overUniformEl) {
      wireCommitOnly(overUniformEl, function () {
        var mm = parseOverhangInput(overUniformEl.value);
        store.setState({ overhang: { uniform_mm: (mm != null && mm >= 0) ? mm : 0 } });
      });
    }
    if (overLeftEl) wireCommitOnly(overLeftEl, function () { store.setState({ overhang: { left_mm: parseOverhangInput(overLeftEl.value) } }); });
    if (overRightEl) wireCommitOnly(overRightEl, function () { store.setState({ overhang: { right_mm: parseOverhangInput(overRightEl.value) } }); });
    if (overFrontEl) wireCommitOnly(overFrontEl, function () { store.setState({ overhang: { front_mm: parseOverhangInput(overFrontEl.value) } }); });
    if (overBackEl) wireCommitOnly(overBackEl, function () { store.setState({ overhang: { back_mm: parseOverhangInput(overBackEl.value) } }); });

    function sectionHFromSelectValue(v) {
      return (String(v || "").toLowerCase() === "50x75") ? 75 : 100;
    }
    function frameGaugeFromSelectValue(v) {
      var depth = sectionHFromSelectValue(v);
      return { thickness_mm: 50, depth_mm: depth };
    }
    if (wallSectionEl) {
      wallSectionEl.addEventListener("change", function () {
        var g = frameGaugeFromSelectValue(wallSectionEl.value);
        store.setState({
          frame: { thickness_mm: g.thickness_mm, depth_mm: g.depth_mm },
          walls: {
            insulated: { section: { w: g.thickness_mm, h: g.depth_mm } },
            basic: { section: { w: g.thickness_mm, h: g.depth_mm } }
          }
        });
      });
    }

    if (wallsVariantEl) wallsVariantEl.addEventListener("change", function () { store.setState({ walls: { variant: wallsVariantEl.value } }); });
    if (claddingStyleEl) claddingStyleEl.addEventListener("change", function () { store.setState({ cladding: { style: claddingStyleEl.value } }); });
    if (wallHeightEl) wallHeightEl.addEventListener("input", function () {
      if (wallHeightEl && wallHeightEl.disabled === true) return;
      store.setState({ walls: { height_mm: asPosInt(wallHeightEl.value, 2400) } });
    });

    /**
     * Find a free X position on a wall for a new opening
     * Returns the X position, or null if no space available
     */
    function findFreeSpotOnWall(wall, width, openings, wallLength) {
      var MIN_EDGE_GAP = 100;
      var MIN_GAP = 50;
      
      // Get existing openings on this wall, sorted by X
      var existing = [];
      for (var i = 0; i < openings.length; i++) {
        var o = openings[i];
        if (o && o.enabled !== false && o.wall === wall) {
          existing.push({ x: o.x_mm || 0, w: o.width_mm || 800 });
        }
      }
      existing.sort(function(a, b) { return a.x - b.x; });
      
      // Try to find a gap that fits the new opening
      var candidates = [];
      
      // Check gap at start of wall
      var firstStart = existing.length > 0 ? existing[0].x : wallLength;
      if (firstStart - MIN_EDGE_GAP >= width + MIN_GAP) {
        candidates.push(MIN_EDGE_GAP);
      }
      
      // Check gaps between existing openings
      for (var j = 0; j < existing.length - 1; j++) {
        var gapStart = existing[j].x + existing[j].w + MIN_GAP;
        var gapEnd = existing[j + 1].x - MIN_GAP;
        if (gapEnd - gapStart >= width) {
          candidates.push(gapStart);
        }
      }
      
      // Check gap at end of wall
      if (existing.length > 0) {
        var lastEnd = existing[existing.length - 1].x + existing[existing.length - 1].w;
        if (wallLength - MIN_EDGE_GAP - lastEnd - MIN_GAP >= width) {
          candidates.push(lastEnd + MIN_GAP);
        }
      }
      
      // If no existing openings, center it
      if (existing.length === 0) {
        return Math.floor((wallLength - width) / 2);
      }
      
      // Return first available candidate, or null if none
      return candidates.length > 0 ? candidates[0] : null;
    }

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
        
        // Find a free spot instead of just centering
        var x = findFreeSpotOnWall(wall, w, openings, L);
        if (x === null) {
          // No space on front wall, try other walls
          var walls = ["back", "left", "right"];
          for (var i = 0; i < walls.length; i++) {
            var tryWall = walls[i];
            var tryL = lens[tryWall] || 1000;
            x = findFreeSpotOnWall(tryWall, w, openings, tryL);
            if (x !== null) {
              wall = tryWall;
              L = tryL;
              break;
            }
          }
        }
        
        // If still no space, don't add the door
        if (x === null) {
          alert("No space available for another door. Remove an existing opening or make the building larger.");
          return;
        }

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
        
        // Find a free spot instead of just centering
        var x = findFreeSpotOnWall(wall, w, openings, L);
        if (x === null) {
          // No space on front wall, try other walls
          var walls = ["back", "left", "right"];
          for (var i = 0; i < walls.length; i++) {
            var tryWall = walls[i];
            var tryL = lens[tryWall] || 1000;
            x = findFreeSpotOnWall(tryWall, w, openings, tryL);
            if (x !== null) {
              wall = tryWall;
              L = tryL;
              break;
            }
          }
        }
        
        // If still no space, don't add the window
        if (x === null) {
          alert("No space available for another window. Remove an existing opening or make the building larger.");
          return;
        }

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

    // ==================== ATTACHMENT HANDLERS (v2 - Sub-buildings) ====================

    /** Get current attachments from state */
    function getAttachmentsFromState(s) {
      if (!s || !s.sections || !s.sections.attachments) return [];
      return s.sections.attachments.slice();
    }

    /** Update attachments in state */
    function setAttachments(attachments) {
      var s = store.getState();
      var enabled = attachments.length > 0;
      store.setState({
        sections: Object.assign({}, s.sections || {}, {
          enabled: enabled,
          main: (s.sections && s.sections.main) || {
            id: "main",
            type: "rectangular",
            dimensions: null,
            roof: null,
            walls: null
          },
          attachments: attachments
        })
      });
    }

    /** Update a single attachment by ID */
    function patchAttachmentById(attId, patch) {
      var atts = getAttachmentsFromState(store.getState());
      var updated = atts.map(function(att) {
        if (att.id !== attId) return att;
        return deepMerge(att, patch);
      });
      setAttachments(updated);
    }

    /**
     * Calculate the maximum allowed height for an attachment's inner edge
     * based on the main building's fascia bottom position
     */
    function getMaxAttachmentHeight(mainState) {
      var roofStyle = (mainState.roof && mainState.roof.style) || "apex";
      var FASCIA_DEPTH_MM = 135;
      var ROOF_STACK_MM = 70; // rafter (50) + OSB (18) + covering (2)

      var fasciaBottom;
      if (roofStyle === "apex") {
        var apex = mainState.roof && mainState.roof.apex;
        var eavesHeight = Number(
          (apex && apex.heightToEaves_mm) ||
          (apex && apex.eavesHeight_mm) ||
          1850
        );
        fasciaBottom = eavesHeight - FASCIA_DEPTH_MM;
      } else if (roofStyle === "pent") {
        var pent = mainState.roof && mainState.roof.pent;
        var minHeight = Number((pent && pent.minHeight_mm) || 2100);
        fasciaBottom = minHeight - FASCIA_DEPTH_MM;
      } else {
        fasciaBottom = 1850 - FASCIA_DEPTH_MM; // Default fallback
      }

      // Max height = fascia bottom - roof stack (so roof doesn't exceed fascia)
      return Math.max(500, fasciaBottom - ROOF_STACK_MM);
    }

    /** Render the attachments list UI - creates expandable editors for each attachment */
    function renderAttachmentsList() {
      if (!attachmentsListEl) return;
      var s = store.getState();
      var attachments = getAttachmentsFromState(s);
      var mainState = s;

      if (attachments.length === 0) {
        attachmentsListEl.innerHTML = '<div class="hint">(No attachments added)</div>';
        updateAttachmentVisibilitySection();
        return;
      }

      attachmentsListEl.innerHTML = "";

      for (var i = 0; i < attachments.length; i++) {
        (function(att, idx) {
          var attId = att.id;
          var attachWall = att.attachTo?.wall || "left";

          // Create attachment editor container
          var editor = document.createElement("div");
          editor.className = "attachment-editor";
          editor.dataset.attId = attId;

          // Header (clickable to collapse/expand)
          var header = document.createElement("div");
          header.className = "attachment-editor-header";
          header.innerHTML = '<h4>Attachment #' + (idx + 1) + '<span class="att-wall-label">(' + attachWall + ' wall)</span></h4>' +
                             '<button class="att-toggle-btn" type="button">▼</button>';
          header.addEventListener("click", function(e) {
            if (e.target.classList.contains("att-toggle-btn") || e.target.tagName === "H4" || e.target.classList.contains("att-wall-label")) {
              editor.classList.toggle("collapsed");
              var toggleBtn = header.querySelector(".att-toggle-btn");
              toggleBtn.textContent = editor.classList.contains("collapsed") ? "▶" : "▼";
            }
          });
          editor.appendChild(header);

          // Body
          var body = document.createElement("div");
          body.className = "attachment-editor-body";

          // === Position Section ===
          var posSection = document.createElement("div");
          posSection.className = "att-section";
          posSection.innerHTML = '<div class="att-section-title">Position</div>';

          var posRow1 = document.createElement("div");
          posRow1.className = "att-row";
          posRow1.innerHTML =
            '<label><span>Attach to Wall</span>' +
            '<select class="att-wall-select">' +
            '<option value="left"' + (attachWall === "left" ? " selected" : "") + '>Left</option>' +
            '<option value="right"' + (attachWall === "right" ? " selected" : "") + '>Right</option>' +
            '<option value="front"' + (attachWall === "front" ? " selected" : "") + '>Front</option>' +
            '<option value="back"' + (attachWall === "back" ? " selected" : "") + '>Back</option>' +
            '</select></label>' +
            '<label><span>Offset from Center (mm)</span>' +
            '<input type="number" class="att-offset-input" value="' + (att.attachTo?.offsetFromCenter_mm || 0) + '" step="50" /></label>';
          posSection.appendChild(posRow1);
          body.appendChild(posSection);

          // === Dimensions Section ===
          var dimSection = document.createElement("div");
          dimSection.className = "att-section";
          dimSection.innerHTML = '<div class="att-section-title">Dimensions</div>' +
            '<div class="att-hint">Width is along the attached wall, depth extends outward.</div>';

          var dimRow = document.createElement("div");
          dimRow.className = "att-row";
          dimRow.innerHTML =
            '<label><span>Width (mm)</span>' +
            '<input type="number" class="att-width-input" value="' + (att.dimensions?.width_mm || 1800) + '" min="500" step="100" /></label>' +
            '<label><span>Depth (mm)</span>' +
            '<input type="number" class="att-depth-input" value="' + (att.dimensions?.depth_mm || 1200) + '" min="500" step="100" /></label>';
          dimSection.appendChild(dimRow);
          body.appendChild(dimSection);

          // === Base Section ===
          var baseSection = document.createElement("div");
          baseSection.className = "att-section";
          baseSection.innerHTML = '<div class="att-section-title">Base & Floor</div>';

          var baseRow = document.createElement("div");
          baseRow.className = "att-row";
          baseRow.innerHTML =
            '<label><span>Level Offset (mm)</span>' +
            '<input type="number" class="att-level-input" value="' + (att.base?.levelOffset_mm || 0) + '" step="50" /></label>' +
            '<label style="display:flex;align-items:center;gap:6px;padding-top:18px;">' +
            '<input type="checkbox" class="att-base-enabled" ' + (att.base?.enabled !== false ? "checked" : "") + ' />' +
            '<span style="margin:0;">Show Base/Floor</span></label>';
          baseSection.appendChild(baseRow);
          body.appendChild(baseSection);

          // === Walls Section ===
          var wallsSection = document.createElement("div");
          wallsSection.className = "att-section";
          wallsSection.innerHTML = '<div class="att-section-title">Walls</div>' +
            '<div class="att-hint">The wall facing the main building is automatically omitted. Wall heights are controlled in the Roof section below.</div>';

          var wallsRow = document.createElement("div");
          wallsRow.className = "att-row";
          wallsRow.innerHTML =
            '<label><span>Variant</span>' +
            '<select class="att-walls-variant">' +
            '<option value="basic"' + ((att.walls?.variant || "basic") === "basic" ? " selected" : "") + '>Basic</option>' +
            '<option value="insulated"' + (att.walls?.variant === "insulated" ? " selected" : "") + '>Insulated</option>' +
            '</select></label>';
          wallsSection.appendChild(wallsRow);
          body.appendChild(wallsSection);

          // === Roof Section ===
          var roofSection = document.createElement("div");
          roofSection.className = "att-section";
          roofSection.innerHTML = '<div class="att-section-title">Roof</div>';

          var roofType = att.roof?.type || "pent";
          var roofRow1 = document.createElement("div");
          roofRow1.className = "att-row full";
          roofRow1.innerHTML =
            '<label><span>Roof Type</span>' +
            '<select class="att-roof-type">' +
            '<option value="pent"' + (roofType === "pent" ? " selected" : "") + '>Pent (single slope outward)</option>' +
            '<option value="apex"' + (roofType === "apex" ? " selected" : "") + '>Apex (gabled)</option>' +
            '<option value="overhang"' + (roofType === "overhang" ? " selected" : "") + '>Extended Overhang (no separate roof)</option>' +
            '</select></label>';
          roofSection.appendChild(roofRow1);

          // Pent roof options
          // Calculate dynamic default heights based on main building fascia
          var maxAttHeight = getMaxAttachmentHeight(mainState);
          var defaultHighHeight = att.roof?.pent?.highHeight_mm || maxAttHeight;
          var defaultLowHeight = att.roof?.pent?.lowHeight_mm || Math.max(500, maxAttHeight - 300);

          var pentOptions = document.createElement("div");
          pentOptions.className = "att-pent-options";
          pentOptions.style.display = roofType === "pent" ? "block" : "none";
          var pentRow = document.createElement("div");
          pentRow.className = "att-row";
          pentRow.innerHTML =
            '<label><span>High Height (mm)</span>' +
            '<input type="number" class="att-pent-high" value="' + defaultHighHeight + '" min="500" max="' + maxAttHeight + '" step="50" placeholder="Max: ' + maxAttHeight + 'mm" /></label>' +
            '<label><span>Low Height (mm)</span>' +
            '<input type="number" class="att-pent-low" value="' + defaultLowHeight + '" min="500" step="50" placeholder="Total height at outer edge" /></label>';
          pentOptions.appendChild(pentRow);

          // Overhang controls for pent roof
          var pentOverhang = att.roof?.pent?.overhang || {};
          var ovhEaves = pentOverhang.eaves_mm != null ? pentOverhang.eaves_mm : 75;
          var ovhVergeL = pentOverhang.vergeLeft_mm != null ? pentOverhang.vergeLeft_mm : 75;
          var ovhVergeR = pentOverhang.vergeRight_mm != null ? pentOverhang.vergeRight_mm : 75;

          var pentOverhangRow = document.createElement("div");
          pentOverhangRow.className = "att-row three-col";
          pentOverhangRow.innerHTML =
            '<label><span>Eaves Overhang</span>' +
            '<input type="number" class="att-pent-ovh-eaves" value="' + ovhEaves + '" min="0" step="25" /></label>' +
            '<label><span>Verge Left</span>' +
            '<input type="number" class="att-pent-ovh-verge-l" value="' + ovhVergeL + '" min="0" step="25" /></label>' +
            '<label><span>Verge Right</span>' +
            '<input type="number" class="att-pent-ovh-verge-r" value="' + ovhVergeR + '" min="0" step="25" /></label>';
          pentOptions.appendChild(pentOverhangRow);
          roofSection.appendChild(pentOptions);

          // Apex roof options
          var apexOptions = document.createElement("div");
          apexOptions.className = "att-apex-options";
          apexOptions.style.display = roofType === "apex" ? "block" : "none";
          var apexRow = document.createElement("div");
          apexRow.className = "att-row three-col";
          apexRow.innerHTML =
            '<label><span>Eave (mm)</span>' +
            '<input type="number" class="att-apex-eave" value="' + (att.roof?.apex?.eaveHeight_mm || 100) + '" step="50" /></label>' +
            '<label><span>Crest (mm)</span>' +
            '<input type="number" class="att-apex-crest" value="' + (att.roof?.apex?.crestHeight_mm || 400) + '" step="50" /></label>' +
            '<label><span>Trusses</span>' +
            '<input type="number" class="att-apex-trusses" value="' + (att.roof?.apex?.trussCount || 2) + '" min="2" step="1" /></label>';
          apexOptions.appendChild(apexRow);
          roofSection.appendChild(apexOptions);

          body.appendChild(roofSection);

          // === Remove Button ===
          var removeBtn = document.createElement("button");
          removeBtn.className = "att-remove-btn";
          removeBtn.type = "button";
          removeBtn.textContent = "Remove This Attachment";
          removeBtn.addEventListener("click", function() {
            var currentAtts = getAttachmentsFromState(store.getState());
            var filtered = currentAtts.filter(function(a) { return a.id !== attId; });
            setAttachments(filtered);
          });
          body.appendChild(removeBtn);

          editor.appendChild(body);
          attachmentsListEl.appendChild(editor);

          // Wire up all the input handlers
          wireAttachmentInputs(editor, attId);

        })(attachments[i], i);
      }

      // Update the visibility section visibility
      updateAttachmentVisibilitySection();
    }

    /** Wire up input change handlers for an attachment editor */
    function wireAttachmentInputs(editor, attId) {
      // Position inputs
      var wallSelect = editor.querySelector(".att-wall-select");
      var offsetInput = editor.querySelector(".att-offset-input");

      if (wallSelect) {
        wallSelect.addEventListener("change", function() {
          patchAttachmentById(attId, { attachTo: { wall: this.value } });
        });
      }
      if (offsetInput) {
        offsetInput.addEventListener("change", function() {
          patchAttachmentById(attId, { attachTo: { offsetFromCenter_mm: parseInt(this.value, 10) || 0 } });
        });
      }

      // Dimension inputs
      var widthInput = editor.querySelector(".att-width-input");
      var depthInput = editor.querySelector(".att-depth-input");

      if (widthInput) {
        widthInput.addEventListener("change", function() {
          patchAttachmentById(attId, { dimensions: { width_mm: parseInt(this.value, 10) || 1800 } });
        });
      }
      if (depthInput) {
        depthInput.addEventListener("change", function() {
          patchAttachmentById(attId, { dimensions: { depth_mm: parseInt(this.value, 10) || 1200 } });
        });
      }

      // Base inputs
      var levelInput = editor.querySelector(".att-level-input");
      var baseEnabledCheck = editor.querySelector(".att-base-enabled");

      if (levelInput) {
        levelInput.addEventListener("change", function() {
          patchAttachmentById(attId, { base: { levelOffset_mm: parseInt(this.value, 10) || 0 } });
        });
      }
      if (baseEnabledCheck) {
        baseEnabledCheck.addEventListener("change", function() {
          patchAttachmentById(attId, { base: { enabled: this.checked } });
        });
      }

      // Walls inputs
      var wallsVariantSelect = editor.querySelector(".att-walls-variant");

      if (wallsVariantSelect) {
        wallsVariantSelect.addEventListener("change", function() {
          patchAttachmentById(attId, { walls: { variant: this.value } });
        });
      }

      // Roof inputs
      var roofTypeSelect = editor.querySelector(".att-roof-type");
      var pentOptions = editor.querySelector(".att-pent-options");
      var apexOptions = editor.querySelector(".att-apex-options");

      if (roofTypeSelect) {
        roofTypeSelect.addEventListener("change", function() {
          var type = this.value;
          patchAttachmentById(attId, { roof: { type: type } });

          // Show/hide appropriate options
          if (pentOptions) pentOptions.style.display = type === "pent" ? "block" : "none";
          if (apexOptions) apexOptions.style.display = type === "apex" ? "block" : "none";
        });
      }

      // Pent roof inputs
      var pentHighInput = editor.querySelector(".att-pent-high");
      var pentLowInput = editor.querySelector(".att-pent-low");

      if (pentHighInput) {
        pentHighInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { pent: { highHeight_mm: parseInt(this.value, 10) || 300 } } });
        });
      }
      if (pentLowInput) {
        pentLowInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { pent: { lowHeight_mm: parseInt(this.value, 10) || 100 } } });
        });
      }

      // Pent roof overhang inputs
      var pentOvhEavesInput = editor.querySelector(".att-pent-ovh-eaves");
      var pentOvhVergeLInput = editor.querySelector(".att-pent-ovh-verge-l");
      var pentOvhVergeRInput = editor.querySelector(".att-pent-ovh-verge-r");

      if (pentOvhEavesInput) {
        pentOvhEavesInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { pent: { overhang: { eaves_mm: parseInt(this.value, 10) || 0 } } } });
        });
      }
      if (pentOvhVergeLInput) {
        pentOvhVergeLInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { pent: { overhang: { vergeLeft_mm: parseInt(this.value, 10) || 0 } } } });
        });
      }
      if (pentOvhVergeRInput) {
        pentOvhVergeRInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { pent: { overhang: { vergeRight_mm: parseInt(this.value, 10) || 0 } } } });
        });
      }

      // Apex roof inputs
      var apexEaveInput = editor.querySelector(".att-apex-eave");
      var apexCrestInput = editor.querySelector(".att-apex-crest");
      var apexTrussesInput = editor.querySelector(".att-apex-trusses");

      if (apexEaveInput) {
        apexEaveInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { apex: { eaveHeight_mm: parseInt(this.value, 10) || 100 } } });
        });
      }
      if (apexCrestInput) {
        apexCrestInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { apex: { crestHeight_mm: parseInt(this.value, 10) || 400 } } });
        });
      }
      if (apexTrussesInput) {
        apexTrussesInput.addEventListener("change", function() {
          patchAttachmentById(attId, { roof: { apex: { trussCount: parseInt(this.value, 10) || 2 } } });
        });
      }
    }

    // Add attachment button handler
    if (addAttachmentBtnEl) {
      addAttachmentBtnEl.addEventListener("click", function() {
        var attWall = attachmentWallEl ? attachmentWallEl.value : "left";

        // Use the new createAttachment function from params.js
        var newAttachment = createAttachment(attWall);

        var currentAtts = getAttachmentsFromState(store.getState());
        currentAtts.push(newAttachment);
        setAttachments(currentAtts);
      });
    }

    // Remove all attachments button handler
    if (removeAllAttachmentsBtnEl) {
      removeAllAttachmentsBtnEl.addEventListener("click", function() {
        setAttachments([]);
      });
    }

    // Track if we need to re-render after blur
    var pendingAttachmentRender = false;

    // Render attachments list when state changes
    // But skip if user is actively editing an attachment input (to prevent losing focus/selection)
    store.onChange(function(s) {
      var activeEl = document.activeElement;
      var isEditingAttachment = activeEl && attachmentsListEl && attachmentsListEl.contains(activeEl) &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "SELECT");
      if (!isEditingAttachment) {
        renderAttachmentsList();
        pendingAttachmentRender = false;
      } else {
        pendingAttachmentRender = true;
      }
    });

    // Re-render when user finishes editing (on blur from attachment inputs)
    if (attachmentsListEl) {
      attachmentsListEl.addEventListener("focusout", function(e) {
        if (pendingAttachmentRender && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) {
          // Small delay to ensure state update is complete
          setTimeout(function() {
            if (pendingAttachmentRender) {
              renderAttachmentsList();
              pendingAttachmentRender = false;
            }
          }, 50);
        }
      });
    }

    // Initial render of attachments list
    renderAttachmentsList();

    // ==================== END ATTACHMENT HANDLERS ====================

    // ==================== DIVIDER HANDLERS ====================

    /** Render the dividers list UI */
    function renderDividersUi(state, validation) {
      if (!dividersListEl) return;
      var dividers = getDividersFromState(state);
      var divVal = validation && validation.dividers ? validation.dividers : { invalidById: {} };

      if (dividers.length === 0) {
        dividersListEl.innerHTML = '<div class="hint">(No dividers added)</div>';
        return;
      }

      dividersListEl.innerHTML = "";
      var internal = getInternalDimensions(state);

      for (var i = 0; i < dividers.length; i++) {
        (function(div, idx) {
          var divId = String(div.id || "");
          var isInvalid = !!divVal.invalidById[divId];
          var errorMsg = divVal.invalidById[divId] || "";

          var item = document.createElement("div");
          item.className = "dividerItem" + (isInvalid ? " invalid" : "");
          item.style.cssText = "border:1px solid " + (isInvalid ? "#c00" : "#ccc") + ";padding:8px;margin-bottom:8px;border-radius:4px;background:" + (isInvalid ? "#fff0f0" : "#fafafa") + ";";

          // Header row with title and delete button
          var header = document.createElement("div");
          header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;";
          header.innerHTML = '<strong>Divider #' + (idx + 1) + '</strong>';
          var deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.textContent = "Delete";
          deleteBtn.style.cssText = "padding:2px 8px;font-size:11px;";
          deleteBtn.addEventListener("click", function() {
            var cur = getDividersFromState(store.getState());
            var next = cur.filter(function(d) { return d.id !== divId; });
            setDividers(next);
          });
          header.appendChild(deleteBtn);
          item.appendChild(header);

          // Axis selector row
          var axisRow = document.createElement("div");
          axisRow.className = "row";
          axisRow.style.cssText = "margin-bottom:6px;";
          var axisLabel = document.createElement("label");
          axisLabel.innerHTML = "Orientation ";
          var axisSelect = document.createElement("select");
          axisSelect.innerHTML = '<option value="x"' + (div.axis === "x" ? " selected" : "") + '>X-axis (front-to-back)</option>' +
                                 '<option value="z"' + (div.axis === "z" ? " selected" : "") + '>Z-axis (left-to-right)</option>';
          axisSelect.addEventListener("change", function() {
            patchDividerById(divId, { axis: this.value });
          });
          axisLabel.appendChild(axisSelect);
          axisRow.appendChild(axisLabel);
          item.appendChild(axisRow);

          // Position row
          var posRow = document.createElement("div");
          posRow.className = "row";
          posRow.style.cssText = "margin-bottom:6px;";
          var posLabel = document.createElement("label");
          var maxPos = div.axis === "x" ? internal.internalW : internal.internalD;
          posLabel.innerHTML = "Position (mm) <span style='color:#666;font-size:10px;'>(max: " + maxPos + ")</span> ";
          var posInput = document.createElement("input");
          posInput.type = "number";
          posInput.min = "50";
          posInput.max = String(maxPos - 50);
          posInput.step = "10";
          posInput.value = String(div.position_mm || 500);
          posInput.style.width = "100px";
          posInput.addEventListener("change", function() {
            patchDividerById(divId, { position_mm: parseInt(this.value, 10) || 500 });
          });
          posLabel.appendChild(posInput);
          posRow.appendChild(posLabel);
          item.appendChild(posRow);

          // Height mode row
          var heightRow = document.createElement("div");
          heightRow.className = "row";
          heightRow.style.cssText = "margin-bottom:6px;";
          var heightLabel = document.createElement("label");
          heightLabel.innerHTML = "Height ";
          var heightSelect = document.createElement("select");
          heightSelect.innerHTML = '<option value="walls"' + ((div.heightMode || "walls") === "walls" ? " selected" : "") + '>To wall top</option>' +
                                   '<option value="roof"' + (div.heightMode === "roof" ? " selected" : "") + '>Fill to roof</option>';
          heightSelect.addEventListener("change", function() {
            patchDividerById(divId, { heightMode: this.value });
          });
          heightLabel.appendChild(heightSelect);
          heightRow.appendChild(heightLabel);
          item.appendChild(heightRow);

          // Covering row
          var coverRow = document.createElement("div");
          coverRow.className = "row";
          coverRow.style.cssText = "margin-bottom:6px;";

          var leftLabel = document.createElement("label");
          leftLabel.innerHTML = "Left side ";
          var leftSelect = document.createElement("select");
          leftSelect.innerHTML = '<option value="none"' + (div.coveringLeft === "none" ? " selected" : "") + '>None</option>' +
                                 '<option value="osb"' + (div.coveringLeft === "osb" ? " selected" : "") + '>OSB</option>' +
                                 '<option value="cladding"' + (div.coveringLeft === "cladding" ? " selected" : "") + '>Cladding</option>';
          leftSelect.addEventListener("change", function() {
            patchDividerById(divId, { coveringLeft: this.value });
          });
          leftLabel.appendChild(leftSelect);
          coverRow.appendChild(leftLabel);

          var rightLabel = document.createElement("label");
          rightLabel.innerHTML = "Right side ";
          var rightSelect = document.createElement("select");
          rightSelect.innerHTML = '<option value="none"' + (div.coveringRight === "none" ? " selected" : "") + '>None</option>' +
                                  '<option value="osb"' + (div.coveringRight === "osb" ? " selected" : "") + '>OSB</option>' +
                                  '<option value="cladding"' + (div.coveringRight === "cladding" ? " selected" : "") + '>Cladding</option>';
          rightSelect.addEventListener("change", function() {
            patchDividerById(divId, { coveringRight: this.value });
          });
          rightLabel.appendChild(rightSelect);
          coverRow.appendChild(rightLabel);
          item.appendChild(coverRow);

          // Openings section
          var openingsSection = document.createElement("div");
          openingsSection.style.cssText = "border-top:1px solid #ddd;padding-top:6px;margin-top:6px;";

          var openingsHeader = document.createElement("div");
          openingsHeader.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;";
          openingsHeader.innerHTML = '<span style="font-size:12px;font-weight:bold;">Door Openings</span>';
          var addDoorBtn = document.createElement("button");
          addDoorBtn.type = "button";
          addDoorBtn.textContent = "+ Add Door";
          addDoorBtn.style.cssText = "padding:2px 6px;font-size:10px;";
          addDoorBtn.addEventListener("click", function() {
            var dividerLength = div.axis === "x" ? internal.internalD : internal.internalW;
            var newOpening = {
              id: divId + "-door" + (__dividerSeq++),
              type: "door",
              enabled: true,
              position_mm: Math.floor((dividerLength - 800) / 2),
              width_mm: 800,
              height_mm: 1900
            };
            addDividerOpening(divId, newOpening);
          });
          openingsHeader.appendChild(addDoorBtn);
          openingsSection.appendChild(openingsHeader);

          // List existing openings
          var openings = Array.isArray(div.openings) ? div.openings : [];
          if (openings.length === 0) {
            var noOpenings = document.createElement("div");
            noOpenings.className = "hint";
            noOpenings.style.cssText = "font-size:11px;color:#666;";
            noOpenings.textContent = "(No doors)";
            openingsSection.appendChild(noOpenings);
          } else {
            for (var j = 0; j < openings.length; j++) {
              (function(opening) {
                var openingId = String(opening.id || "");
                var openingRow = document.createElement("div");
                openingRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:4px;font-size:11px;";

                // Position input
                var posLab = document.createElement("label");
                posLab.textContent = "Pos ";
                var posInp = document.createElement("input");
                posInp.type = "number";
                posInp.min = "50";
                posInp.step = "10";
                posInp.value = String(opening.position_mm || 0);
                posInp.style.width = "60px";
                posInp.addEventListener("change", function() {
                  patchDividerOpening(divId, openingId, { position_mm: parseInt(this.value, 10) || 0 });
                });
                posLab.appendChild(posInp);
                openingRow.appendChild(posLab);

                // Width input
                var widLab = document.createElement("label");
                widLab.textContent = "W ";
                var widInp = document.createElement("input");
                widInp.type = "number";
                widInp.min = "400";
                widInp.step = "10";
                widInp.value = String(opening.width_mm || 800);
                widInp.style.width = "60px";
                widInp.addEventListener("change", function() {
                  patchDividerOpening(divId, openingId, { width_mm: parseInt(this.value, 10) || 800 });
                });
                widLab.appendChild(widInp);
                openingRow.appendChild(widLab);

                // Height input
                var hgtLab = document.createElement("label");
                hgtLab.textContent = "H ";
                var hgtInp = document.createElement("input");
                hgtInp.type = "number";
                hgtInp.min = "400";
                hgtInp.step = "10";
                hgtInp.value = String(opening.height_mm || 1900);
                hgtInp.style.width = "60px";
                hgtInp.addEventListener("change", function() {
                  patchDividerOpening(divId, openingId, { height_mm: parseInt(this.value, 10) || 1900 });
                });
                hgtLab.appendChild(hgtInp);
                openingRow.appendChild(hgtLab);

                // Remove button
                var remBtn = document.createElement("button");
                remBtn.type = "button";
                remBtn.textContent = "X";
                remBtn.style.cssText = "padding:1px 5px;font-size:10px;";
                remBtn.addEventListener("click", function() {
                  removeDividerOpening(divId, openingId);
                });
                openingRow.appendChild(remBtn);

                openingsSection.appendChild(openingRow);
              })(openings[j]);
            }
          }
          item.appendChild(openingsSection);

          // Error message
          if (isInvalid) {
            var errDiv = document.createElement("div");
            errDiv.style.cssText = "color:#c00;font-size:11px;margin-top:4px;";
            errDiv.textContent = errorMsg;
            item.appendChild(errDiv);
          }

          // Apply profile field restrictions for dividers
          applyFieldRestriction(axisSelect, "divider.axis");
          applyFieldRestriction(posInput, "divider.position");
          applyFieldRestriction(deleteBtn, "divider.removeBtn");

          dividersListEl.appendChild(item);
        })(dividers[i], i);
      }
    }

    // Add Divider button handler
    if (addDividerBtnEl) {
      addDividerBtnEl.addEventListener("click", function() {
        var s = store.getState();
        var internal = getInternalDimensions(s);
        var existing = getDividersFromState(s);

        var newDivider = {
          id: "div" + (__dividerSeq++),
          enabled: true,
          axis: "x",
          position_mm: Math.floor(internal.internalW / 2),
          heightMode: "walls", // "walls" = stop at wall top, "roof" = fill to roof profile
          coveringLeft: "none",
          coveringRight: "none",
          openings: []
        };

        existing.push(newDivider);
        setDividers(existing);
      });
    }

    // Remove All Dividers button handler
    if (removeAllDividersBtnEl) {
      removeAllDividersBtnEl.addEventListener("click", function() {
        setDividers([]);
      });
    }

    // ==================== END DIVIDER HANDLERS ====================

    store.onChange(function (s) {
      console.log("[store.onChange] State changed, dim:", s.dim);
      var v = syncInvalidOpeningsIntoState() || { doors: { invalidById: {}, invalidIds: [] }, windows: { invalidById: {}, invalidIds: [] } };
      // Add divider validation to v
      v.dividers = validateDividers(s);
      syncUiFromState(s, v);
      applyWallHeightUiLock(s);
      renderDividersUi(s, v);
      console.log("[store.onChange] About to call render()");
      render(s);
      console.log("[store.onChange] render() completed");
    });

    setInterval(updateOverlay, 1000);
    updateOverlay();

   console.log("[INIT] Before initInstancesUI");
   initInstancesUI({
      store: store,
      ids: {
        instanceSelect: "instanceSelect",
        loadInstanceBtn: "loadInstanceBtn",
        exportBtn: "exportBtn",
        importBtn: "importBtn",
        devModeCheck: "devModeCheck",
        devPanel: "devPanel",
        copyStateBtn: "copyStateBtn",
        instancesHint: "instancesHint"
      },
      dbg: window.__dbg
    });
    console.log("[INIT] After initInstancesUI");

    // Initialize profile system (Developer Dashboard)
    // This handles named profiles like customer, builder, admin
    var urlProfile = getProfileFromUrl();
    console.log("[INIT] urlProfile:", urlProfile, "viewerMode:", viewerMode);

    // IMPORTANT: For non-viewer mode, we need to load and apply profiles BEFORE syncUiFromState
    // because profile application shows/hides controls that syncUiFromState might otherwise leave in wrong state
    var profileLoadPromise = null;
    if (!viewerMode) {
      profileLoadPromise = loadProfiles().then(function() {
        var profileToApply = (urlProfile && urlProfile !== "admin") ? urlProfile : "admin";
        applyProfile(profileToApply, store);
        console.log("[index] Applied profile:", profileToApply);

        // Initialize Profile Editor UI AFTER profiles are loaded and applied
        // Pass skipLoadProfiles=true since we just loaded them
        console.log("[INIT] Before initProfileEditor (inside profile promise)");
        initProfileEditor({ store: store, skipLoadProfiles: true });
        console.log("[INIT] After initProfileEditor");
      });
    } else {
      // Viewer mode - no profile editor needed, but initialize if needed
      console.log("[INIT] Viewer mode - skipping initProfileEditor");
    }

    // Initialize panel resize functionality
    console.log("[INIT] Before initPanelResize");
    initPanelResize();
    console.log("[INIT] After initPanelResize");

    // Helper function to complete initialization after profile is applied
    function completeInit() {
      // Commit HTML default apex heights to state on init (ensures cladding trim works on first load)
      // Skip when loading state from URL (viewer mode or profile links with state param)
      // because the state already has correct values from URL parameters
      var hasUrlState = viewerMode || (urlProfile && hasStateParam);
      if (!hasUrlState) {
        try {
          console.log("[INIT] Calling commitApexHeightsFromInputs...");
          commitApexHeightsFromInputs();
          console.log("[INIT] commitApexHeightsFromInputs done");
        } catch (eApex) {
          console.error("[INIT] commitApexHeightsFromInputs error:", eApex);
        }
        try {
          console.log("[INIT] Calling commitPentHeightsFromInputs...");
          commitPentHeightsFromInputs();
          console.log("[INIT] commitPentHeightsFromInputs done");
        } catch (ePent) {
          console.error("[INIT] commitPentHeightsFromInputs error:", ePent);
        }
      } else {
        console.log("[INIT] Skipping commitHeights - state loaded from URL parameters");
      }
      console.log("[INIT] After commit heights");

      // Wire up camera snap view buttons
      var snapPlanBtn = document.getElementById('snapPlanBtn');
      var snapFrontBtn = document.getElementById('snapFrontBtn');
      var snapBackBtn = document.getElementById('snapBackBtn');
      var snapLeftBtn = document.getElementById('snapLeftBtn');
      var snapRightBtn = document.getElementById('snapRightBtn');
      if (snapPlanBtn) snapPlanBtn.addEventListener('click', function() { snapCameraToView('plan'); });
      if (snapFrontBtn) snapFrontBtn.addEventListener('click', function() { snapCameraToView('front'); });
      if (snapBackBtn) snapBackBtn.addEventListener('click', function() { snapCameraToView('back'); });
      if (snapLeftBtn) snapLeftBtn.addEventListener('click', function() { snapCameraToView('left'); });
      if (snapRightBtn) snapRightBtn.addEventListener('click', function() { snapCameraToView('right'); });
      console.log("[INIT] After snap buttons");

      try {
        var s0 = store.getState();
        if (s0 && s0.roof && s0.roof.pent && s0.roof.pent.minHeight_mm != null && s0.roof.pent.maxHeight_mm != null) {
        } else {
          var baseH = (s0 && s0.walls && s0.walls.height_mm != null) ? clampHeightMm(s0.walls.height_mm, 2400) : 2400;
          store.setState({ roof: { pent: { minHeight_mm: baseH, maxHeight_mm: baseH } } });
        }
      } catch (e0) {}
      console.log("[INIT] After pent heights check");

      console.log("[INIT] Before syncUiFromState");
      window.__dbg.syncUiStart = Date.now();

      // Heartbeat to detect if we get stuck
      var heartbeatId = setTimeout(function() {
        console.error("[INIT] HEARTBEAT: syncUiFromState appears stuck! No completion after 5 seconds.");
        console.error("[INIT] Check window.__dbg for state:", window.__dbg);
      }, 5000);

      try {
        console.log("[INIT] Calling syncInvalidOpeningsIntoState...");
        var validationsResult = syncInvalidOpeningsIntoState();
        console.log("[INIT] syncInvalidOpeningsIntoState took:", (Date.now() - window.__dbg.syncUiStart) + "ms");
        console.log("[INIT] syncInvalidOpeningsIntoState returned:", validationsResult);
        console.log("[INIT] Calling syncUiFromState...");
        syncUiFromState(store.getState(), validationsResult);
        console.log("[INIT] syncUiFromState returned");
        console.log("[INIT] Total sync time:", (Date.now() - window.__dbg.syncUiStart) + "ms");
        clearTimeout(heartbeatId); // Clear heartbeat on success
      } catch (eSyncUi) {
        clearTimeout(heartbeatId); // Clear heartbeat on error
        console.error("[INIT] ERROR in syncUiFromState or syncInvalidOpeningsIntoState:", eSyncUi);
        console.error("[INIT] Stack:", eSyncUi && eSyncUi.stack ? eSyncUi.stack : "no stack");
        console.log("[INIT] Error occurred at:", (Date.now() - window.__dbg.syncUiStart) + "ms");
      }
      console.log("[INIT] After syncUiFromState");

      try {
        applyWallHeightUiLock(store.getState());
      } catch (eWallLock) {
        console.error("[INIT] ERROR in applyWallHeightUiLock:", eWallLock);
      }

      console.log("[INIT] About to call render()...");
      try {
        render(store.getState());
        console.log("[INIT] render() returned successfully");
      } catch (eRender) {
        console.error("[INIT] ERROR in render():", eRender);
        console.error("[INIT] Render stack:", eRender && eRender.stack ? eRender.stack : "no stack");
      }
      resume3D();

      // Initialize view switching (3D / cutting lists)
      initViews();

      // Refresh dynamic controls after everything is set up
      if (window.__dbg && typeof window.__dbg.refreshDynamicControls === "function") {
        window.__dbg.refreshDynamicControls();
      }

      window.__dbg.initFinished = true;
    }

    // Wait for profile to load before completing init (so controls are properly visible/enabled)
    if (profileLoadPromise) {
      profileLoadPromise.then(function() {
        console.log("[INIT] Profile loaded, completing initialization...");
        completeInit();
      }).catch(function(err) {
        console.error("[INIT] Profile load failed, completing initialization anyway:", err);
        completeInit();
      });
    } else {
      // Viewer mode or no profile system - complete immediately
      completeInit();
    }

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
