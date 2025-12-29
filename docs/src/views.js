// FILE: docs/src/views.js
export function initViews() {
  var canvas = document.getElementById("renderCanvas");
  var basePage = document.getElementById("bomPage");
  var wallsPage = document.getElementById("wallsBomPage");
  var viewSelect = document.getElementById("viewSelect");
  var topbar = document.getElementById("topbar");
  var controlPanel = document.getElementById("controlPanel");

  if (!canvas || !basePage || !wallsPage || !viewSelect || !topbar) return;

  var VIEWS = ["3d", "base", "walls"];
  var STORAGE_KEY = "viewMode";

  function parseHashView(hash) {
    var h = (hash || "").replace(/^#/, "");
    var m = /(?:^|&)view=([^&]+)/.exec(h);
    var v = m ? decodeURIComponent(m[1] || "") : "";
    return VIEWS.indexOf(v) >= 0 ? v : null;
  }

  function setHashView(v) {
    var cur = (location.hash || "").replace(/^#/, "");
    var params = new URLSearchParams(cur ? cur.split("&").filter(Boolean) : []);
    params.set("view", v);
    var next = "#" + params.toString();
    if (location.hash !== next) history.replaceState(null, "", next);
  }

  function getInitialView() {
    var fromHash = parseHashView(location.hash);
    if (fromHash) return fromHash;

    try {
      var fromStorage = localStorage.getItem(STORAGE_KEY);
      if (VIEWS.indexOf(fromStorage) >= 0) return fromStorage;
    } catch (e) {}

    return "3d";
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  function safeResize3D() {
    try {
      var eng = window.__dbg && window.__dbg.engine ? window.__dbg.engine : null;
      if (eng && typeof eng.resize === "function") eng.resize();
    } catch (e) {}
  }

  function safeAttach3D() {
    try {
      var cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.attachControl === "function") cam.attachControl(canvas, true);
    } catch (e) {}
    safeResize3D();
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
    var heading = page.querySelector("h1,h2,[data-focus], [tabindex]") || page;
    if (heading && typeof heading.focus === "function") {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      try { heading.focus({ preventScroll: false }); } catch (e) {}
    }
  }

  function showOnly(view) {
    var v = VIEWS.indexOf(view) >= 0 ? view : "3d";

    document.body.setAttribute("data-view", v);

    var is3d = v === "3d";
    var isBase = v === "base";
    var isWalls = v === "walls";

    canvas.style.display = is3d ? "block" : "none";
    canvas.setAttribute("aria-hidden", String(!is3d));

    basePage.style.display = isBase ? "block" : "none";
    basePage.setAttribute("aria-hidden", String(!isBase));

    wallsPage.style.display = isWalls ? "block" : "none";
    wallsPage.setAttribute("aria-hidden", String(!isWalls));

    if (controlPanel) controlPanel.style.display = is3d ? "none" : "block";

    viewSelect.value = v;

    if (is3d) safeAttach3D();
    else safeDetach3D();

    purgeSidebars(document);
    focusActive(v);
  }

  function isProtected(el) {
    if (!el) return false;
    if (el === canvas || el.contains(canvas) || canvas.contains(el)) return true;
    if (el === topbar || el.contains(topbar) || topbar.contains(el)) return true;
    if (controlPanel && (el === controlPanel || el.contains(controlPanel) || controlPanel.contains(el))) return true;
    if (el === basePage || el.contains(basePage) || basePage.contains(el)) return true;
    if (el === wallsPage || el.contains(wallsPage) || wallsPage.contains(el)) return true;
    return false;
  }

  function purgeSidebars(root) {
    var selectors = [
      "#ui-layer", "#controls",
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

  function setView(view, reason) {
    var v = VIEWS.indexOf(view) >= 0 ? view : "3d";
    if (viewSelect.value !== v) viewSelect.value = v;

    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) {}
    if (reason !== "hash") setHashView(v);

    showOnly(v);
  }

  viewSelect.addEventListener("change", function (e) {
    var v = e && e.target ? e.target.value : "3d";
    setView(v, "select");
  });

  window.addEventListener("hashchange", function () {
    var v = parseHashView(location.hash);
    if (v) setView(v, "hash");
  });

  window.addEventListener("keydown", function (e) {
    if (!e || e.defaultPrevented) return;
    if (isTypingTarget(document.activeElement)) return;

    if (e.key === "1") setView("3d", "key");
    else if (e.key === "2") setView("walls", "key");
    else if (e.key === "3") setView("base", "key");
  });

  window.addEventListener("resize", function () {
    if (document.body.getAttribute("data-view") === "3d") safeResize3D();
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

  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  var initial = getInitialView();
  setView(initial, "init");
}
