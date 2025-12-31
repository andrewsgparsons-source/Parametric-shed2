// FILE: docs/src/views.js
// Minimal view switch controller.
// Fixes null DOM crashes by tolerating missing elements and ensures view switching calls the correct hooks.

(function () {
  function $(id) { return document.getElementById(id); }

  function findViewSelect() {
    return $("pages") || $("pagesSelect") || $("viewSelect") || $("viewsSelect") || $("view") || null;
  }

  function normalizeValue(v) {
    v = String(v || "").toLowerCase();
    if (v === "3d" || v === "scene" || v === "3d scene" || v === "3dscene") return "3d";
    if (v === "walls" || v === "wallsbom" || v === "walls cutting list" || v === "wall") return "walls";
    if (v === "base" || v === "basebom" || v === "base cutting list") return "base";
    if (v === "roof" || v === "roofbom" || v === "roof cutting list") return "roof";
    return v;
  }

  function applyView(val) {
    var hooks = window.__viewHooks || null;
    if (!hooks) return;

    var v = normalizeValue(val);

    try {
      if (v === "walls") { if (hooks.showWallsBOM) hooks.showWallsBOM(); return; }
      if (v === "base") { if (hooks.showBaseBOM) hooks.showBaseBOM(); return; }
      if (v === "roof") { if (hooks.showRoofBOM) hooks.showRoofBOM(); return; }
      if (hooks.resume3D) hooks.resume3D();
    } catch (e) {
      try { window.__dbg = window.__dbg || {}; window.__dbg.lastError = "views applyView failed: " + String(e && e.message ? e.message : e); } catch (e2) {}
    }
  }

  function init() {
    var sel = findViewSelect();
    if (!sel) return;

    sel.addEventListener("change", function () {
      applyView(sel.value);
    });

    // On load, ensure the currently selected view is applied once.
    applyView(sel.value);
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();