// FILE: docs/src/views.js
export function initViews() {
  var canvas = document.getElementById("renderCanvas");
  var basePage = document.getElementById("bomPage");
  var wallsPage = document.getElementById("wallsBomPage");
  var viewSelect = document.getElementById("viewSelect");
  var topbar = document.getElementById("topbar");
  var controlPanel = document.getElementById("controlPanel");
  var controls = document.getElementById("controls");
  var uiLayer = document.getElementById("ui-layer");

  if (!canvas || !basePage || !wallsPage || !viewSelect || !topbar) return;

  // SAFE hash helpers (NO URLSearchParams on location.hash)
  function readHashView() {
    try {
      var m = (window.location.hash || "").match(/(?:^|[&#])view=(3d|base|walls)\b/i);
      return m ? String(m[1] || "").toLowerCase() : null;
    } catch (e) {
      return null;
    }
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
      if (v === "3d" || v === "base" || v === "walls") return v;
    } catch (e) {}
    return null;
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
    var page = view === "base" ? basePage : wallsPage;
    var h = page.querySelector("h1,h2");
    var target = h || page;
    if (target && typeof target.focus === "function") {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      try { target.focus({ preventScroll: false }); } catch (e) {}
    }
  }

  function isProtected(el) {
    if (!el) return false;
    if (el === canvas || el.contains(canvas) || canvas.contains(el)) return true;
    if (el === topbar || el.contains(topbar) || topbar.contains(el)) return true;
    if (controls && (el === controls || el.contains(controls) || controls.contains(el))) return true;
    if (controlPanel && (el === controlPanel || el.contains(controlPanel) || controlPanel.contains(el))) return true;
    if (uiLayer && (el === uiLayer || el.contains(uiLayer) || uiLayer.contains(el))) return true;
    if (el === basePage || el.contains(basePage) || basePage.contains(el)) return true;
    if (el === wallsPage || el.contains(wallsPage) || wallsPage.contains(el)) return true;
    return false;
  }

  function purgeSidebars(root) {
    var selectors = [
      // Do NOT include '#ui-layer' or '#controls' here (index.js may use them)
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

    // Right-edge heuristic
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
    var v = (view === "base" || view === "walls" || view === "3d") ? view : "3d";

    // REQUIRED: drives CSS rules
    document.body.dataset.view = v;

    var is3d = v === "3d";
    var isBase = v === "base";
    var isWalls = v === "walls";

    canvas.style.display = is3d ? "block" : "none";
    canvas.setAttribute("aria-hidden", String(!is3d));

    basePage.style.display = isBase ? "block" : "none";
    basePage.setAttribute("aria-hidden", String(!isBase));

    wallsPage.style.display = isWalls ? "block" : "none";
    wallsPage.setAttribute("aria-hidden", String(!isWalls));

    if (viewSelect.value !== v) viewSelect.value = v;

    writeStoredView(v);
    if (reason !== "hash") writeHashView(v);

    if (is3d) safeAttach3D();
    else safeDetach3D();

    purgeSidebars(document);
    focusActive(v);
  }

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

  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.addedNodes && m.addedNodes.length) {
        purgeSidebars(document);
        break;
      }
    }
  });

  try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

  var initial = readHashView() || readStoredView() || "3d";
  applyView(initial, "init");
}
