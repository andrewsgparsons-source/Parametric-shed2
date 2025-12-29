// FILE: docs/src/views.js
// View-layer only: hash/storage routing + visibility + purge. No geometry/BOM/state changes.

export function initViews() {
  // If called too early, bail safely.
  var canvas = document.getElementById("renderCanvas");
  var basePage = document.getElementById("bomPage");
  var wallsPage = document.getElementById("wallsBomPage");
  var viewSelect = document.getElementById("viewSelect");
  var topbar = document.getElementById("topbar");

  var controls = document.getElementById("controls");
  var controlPanel = document.getElementById("controlPanel");
  var uiLayer = document.getElementById("ui-layer");

  if (!canvas || !basePage || !wallsPage || !viewSelect || !topbar) return;

  // ---- Hash helpers (NO URLSearchParams(location.hash)) ----
  function readHashView() {
    try {
      var m = (window.location.hash || "").match(/(?:^|[&#])view=(3d|base|walls)\b/i);
      return m ? String(m[1]).toLowerCase() : null;
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
      return (v === "3d" || v === "base" || v === "walls") ? v : null;
    } catch (e) {
      return null;
    }
  }

  function writeStoredView(v) {
    try { localStorage.setItem("viewMode", v); } catch (e) {}
  }

  // ---- Small utils ----
  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.style.display = hidden ? "none" : "block";
    el.setAttribute("aria-hidden", String(!!hidden));
  }

  function focusForView(view) {
    if (view === "3d") {
      try { viewSelect.focus({ preventScroll: true }); } catch (e) {}
      return;
    }

    var page = (view === "base") ? basePage : wallsPage;
    var h = page.querySelector("h1,h2");
    var target = h || page;

    if (target && typeof target.focus === "function") {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      try { target.focus({ preventScroll: false }); } catch (e) {}
    }
  }

  function safeAttachCamera() {
    try {
      var cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.attachControl === "function") cam.attachControl(canvas, true);
    } catch (e) {}
    try {
      var eng = window.__dbg && window.__dbg.engine ? window.__dbg.engine : null;
      if (eng && typeof eng.resize === "function") eng.resize();
    } catch (e) {}
  }

  function safeDetachCamera() {
    try {
      var cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.detachControl === "function") cam.detachControl();
    } catch (e) {}
  }

  // ---- Purge (never delete our UI) ----
  function isProtected(el) {
    if (!el) return false;
    if (el === canvas || canvas.contains(el) || el.contains(canvas)) return true;
    if (el === topbar || topbar.contains(el) || el.contains(topbar)) return true;

    if (controls && (el === controls || controls.contains(el) || el.contains(controls))) return true;
    if (controlPanel && (el === controlPanel || controlPanel.contains(el) || el.contains(controlPanel))) return true;
    if (uiLayer && (el === uiLayer || uiLayer.contains(el) || el.contains(uiLayer))) return true;

    if (el === basePage || basePage.contains(el) || el.contains(basePage)) return true;
    if (el === wallsPage || wallsPage.contains(el) || el.contains(wallsPage)) return true;

    return false;
  }

  function purgeSidebars(root) {
    // Only target common 3rd-party overlays; DO NOT list #controls/#ui-layer here.
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

    // Right-edge heuristic removal
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
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

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

  // Throttle purge to avoid hammering on MutationObserver storms.
  var purgeQueued = false;
  function requestPurge() {
    if (purgeQueued) return;
    purgeQueued = true;
    requestAnimationFrame(function () {
      purgeQueued = false;
      purgeSidebars(document);
    });
  }

  // ---- Core view application ----
  function normalizeView(v) {
    return (v === "3d" || v === "base" || v === "walls") ? v : "3d";
  }

  function applyView(view, reason) {
    var v = normalizeView(view);

    // Required for CSS rules
    document.body.dataset.view = v;

    // Exactly one visible at a time
    setHidden(canvas, v !== "3d");
    // Pages default to display:none; setHidden uses display:block which is fine for your .page containers too.
    setHidden(basePage, v !== "base");
    setHidden(wallsPage, v !== "walls");

    // Keep selector consistent
    if (viewSelect.value !== v) viewSelect.value = v;

    // Persist + route
    writeStoredView(v);
    if (reason !== "hash") writeHashView(v);

    // Camera control only when 3D
    if (v === "3d") safeAttachCamera();
    else safeDetachCamera();

    requestPurge();
    focusForView(v);
  }

  // ---- Events ----
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
    // Keep canvas full-screen (CSS handles size; Babylon needs resize)
    if (document.body.dataset.view === "3d") safeAttachCamera();
    requestPurge();
  });

  // Late injected overlays
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i] && muts[i].addedNodes && muts[i].addedNodes.length) {
          requestPurge();
          break;
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // ---- Init ----
  var initial = readHashView() || readStoredView() || "3d";
  applyView(initial, "init");
}
