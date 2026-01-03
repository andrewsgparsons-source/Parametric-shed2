// FILE: docs/src/views.js
export function initViews() {
  var canvas = document.getElementById("renderCanvas");
  var basePage = document.getElementById("bomPage");
  var wallsPage = document.getElementById("wallsBomPage");
  var roofPage = document.getElementById("roofBomPage");
  var viewSelect = document.getElementById("viewSelect");
  var topbar = document.getElementById("topbar");
  var controls = document.getElementById("controls");
  var controlPanel = document.getElementById("controlPanel");
  var uiLayer = document.getElementById("ui-layer");

  // NEW: view snap buttons (optional; must not break if missing)
  var snapPlanBtn = document.getElementById("snapPlanBtn");
  var snapFrontBtn = document.getElementById("snapFrontBtn");
  var snapBackBtn = document.getElementById("snapBackBtn");
  var snapLeftBtn = document.getElementById("snapLeftBtn");
  var snapRightBtn = document.getElementById("snapRightBtn");

  // Roof page is optional at init; required only when selecting roof view.
  if (!canvas || !basePage || !wallsPage || !viewSelect || !topbar) return;

  function readHashView() {
    try {
      var m = (window.location.hash || "").match(/(?:^|[&#])view=(3d|base|walls|roof)\b/i);
      return m ? String(m[1] || "").toLowerCase() : null;
    } catch (e) { return null; }
  }

  function writeHashView(v) {
    try {
      var u = new URL(window.location.href);
      u.hash = "view=" + v;
      history.replaceState(null, "", u.toString());
    } catch (e) {}
  }

  function readStoredView() {
    try {
      var v = localStorage.getItem("viewMode");
      return (v === "3d" || v === "base" || v === "walls" || v === "roof") ? v : null;
    } catch (e) { return null; }
  }

  function writeStoredView(v) {
    try { localStorage.setItem("viewMode", v); } catch (e) {}
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  function safeAttach3D() {
    try {
      var cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.attachControl === "function") cam.attachControl(canvas, true);
    } catch (e) {}
    try {
      var eng = window.__dbg && window.__dbg.engine ? window.__dbg.engine : null;
      if (eng && typeof eng.resize === "function") eng.resize();
    } catch (e) {}
  }

  function safeDetach3D() {
    try {
      var cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.detachControl === "function") cam.detachControl();
    } catch (e) {}
  }

  function focusActive(view) {
    if (view === "3d") {
      try { viewSelect.focus({ preventScroll: true }); } catch (e) {}
      return;
    }
    var page = view === "base" ? basePage : (view === "walls" ? wallsPage : roofPage);
    if (!page) return;
    var h = page.querySelector("h1,h2");
    var target = h || page;
    if (target && typeof target.focus === "function") {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      try { target.focus({ preventScroll: false }); } catch (e) {}
    }
  }

  function isProtected(el) {
    if (!el) return false;
    if (el === canvas || canvas.contains(el) || el.contains(canvas)) return true;
    if (el === topbar || topbar.contains(el) || el.contains(topbar)) return true;
    if (controls && (el === controls || controls.contains(el) || el.contains(controls))) return true;
    if (controlPanel && (el === controlPanel || controlPanel.contains(el) || el.contains(controlPanel))) return true;
    if (uiLayer && (el === uiLayer || uiLayer.contains(el) || el.contains(uiLayer))) return true;
    if (el === basePage || basePage.contains(el) || el.contains(basePage)) return true;
    if (el === wallsPage || wallsPage.contains(el) || el.contains(wallsPage)) return true;
    if (roofPage && (el === roofPage || roofPage.contains(el) || el.contains(roofPage))) return true;
    return false;
  }

  function purgeSidebars(root) {
    var selectors = [
      "[id*='sidebar' i]", "[class*='sidebar' i]",
      "[id*='panel' i]", "[class*='panel' i]",
      "[id*='inspector' i]", "[class*='inspector' i]",
      "[id*='gui' i]", "[class*='gui' i]",
      ".dg.ac"
    ];

    try {
      root.querySelectorAll(selectors.join(",")).forEach(function (el) {
        if (!el || isProtected(el)) return;
        try { el.remove(); } catch (e) {}
      });
    } catch (e) {}

    try {
      var all = Array.from(root.querySelectorAll("body *"));
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el || isProtected(el)) continue;

        var st = getComputedStyle(el);
        if (!st || st.display === "none") continue;

        var pos = st.position;
        if (pos !== "fixed" && pos !== "absolute") continue;

        var rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) continue;

        var nearRight = (window.innerWidth - rect.right) <= 2;
        var bigEnough = rect.width >= 200 && rect.height >= 100;

        var z = 0;
        var zRaw = st.zIndex;
        if (zRaw && zRaw !== "auto") {
          var zi = parseInt(zRaw, 10);
          z = isFinite(zi) ? zi : 0;
        }

        if (nearRight && bigEnough && z >= 1000) {
          try { el.remove(); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function applyView(view, reason) {
    var requested = (view === "3d" || view === "base" || view === "walls" || view === "roof") ? view : "3d";
    var v = requested;

    // Roof view requires the page to exist; otherwise fall back to 3d (and only then).
    if (v === "roof" && !roofPage) v = "3d";

    document.body.dataset.view = v;

    var is3d = v === "3d";
    var isBase = v === "base";
    var isWalls = v === "walls";
    var isRoof = v === "roof";

    canvas.style.display = is3d ? "block" : "none";
    canvas.setAttribute("aria-hidden", String(!is3d));

    basePage.style.display = isBase ? "block" : "none";
    basePage.setAttribute("aria-hidden", String(!isBase));

    wallsPage.style.display = isWalls ? "block" : "none";
    wallsPage.setAttribute("aria-hidden", String(!isWalls));

    if (roofPage) {
      roofPage.style.display = isRoof ? "block" : "none";
      roofPage.setAttribute("aria-hidden", String(!isRoof));
    }

    if (viewSelect.value !== v) viewSelect.value = v;

    writeStoredView(v);
    if (reason !== "hash") writeHashView(v);

    if (is3d) safeAttach3D();
    else safeDetach3D();

    purgeSidebars(document);
    focusActive(v);
  }

  function runSnap(viewName) {
    // Always ensure 3D view is active before snapping.
    applyView("3d", "snap");

    // Defer one frame so attachControl/resize has run and matrices are stable.
    requestAnimationFrame(function () {
      try {
        var hooks = window.__viewHooks || null;
        if (hooks && typeof hooks.snapCameraToView === "function") hooks.snapCameraToView(viewName);
      } catch (e) {}
    });
  }

  // Wire snap buttons (if present)
  if (snapPlanBtn)  snapPlanBtn.addEventListener("click",  function () { runSnap("plan"); });
  if (snapFrontBtn) snapFrontBtn.addEventListener("click", function () { runSnap("front"); });
  if (snapBackBtn)  snapBackBtn.addEventListener("click",  function () { runSnap("back"); });
  if (snapLeftBtn)  snapLeftBtn.addEventListener("click",  function () { runSnap("left"); });
  if (snapRightBtn) snapRightBtn.addEventListener("click", function () { runSnap("right"); });

  viewSelect.addEventListener("change", function (e) {
    var v = e && e.target ? e.target.value : "3d";
    applyView(v, "select");
  });

  window.addEventListener("hashchange", function () {
    var hv = readHashView();
    if (hv) applyView(hv, "hash");
  });

  window.addEventListener("keydown", function (e) {
    if (!e || e.defaultPrevented) return;
    if (isTypingTarget(document.activeElement)) return;

    if (e.key === "1") applyView("3d", "key");
    else if (e.key === "2") applyView("walls", "key");
    else if (e.key === "3") applyView("base", "key");
  });

  window.addEventListener("resize", function () {
    if (document.body.dataset.view === "3d") safeAttach3D();
    purgeSidebars(document);
  });

  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.addedNodes && m.addedNodes.length) {
          purgeSidebars(document);
          break;
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  var initial = readHashView() || readStoredView() || "3d";
  applyView(initial, "init");
}