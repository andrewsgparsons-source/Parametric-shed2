// FILE: docs/src/views.js
export function initViews() {
  const canvas = document.getElementById("renderCanvas");
  const basePage = document.getElementById("bomPage");
  const wallsPage = document.getElementById("wallsBomPage");
  const viewSelect = document.getElementById("viewSelect");
  const topbar = document.getElementById("topbar");
  const controlsPanel = document.getElementById("controlsPanel");

  if (!canvas || !basePage || !wallsPage || !viewSelect || !topbar) return;

  const VIEW_KEYS = ["3d", "base", "walls"];
  const STORAGE_KEY = "viewMode";

  function parseHashView(hash) {
    const h = (hash || "").replace(/^#/, "");
    const m = /(?:^|&)view=([^&]+)/.exec(h);
    const v = m ? decodeURIComponent(m[1] || "") : "";
    return VIEW_KEYS.includes(v) ? v : null;
  }

  function setHashView(v) {
    const cur = location.hash.replace(/^#/, "");
    const params = new URLSearchParams(cur ? cur.split("&").filter(Boolean) : []);
    params.set("view", v);
    const next = "#" + params.toString();
    if (location.hash !== next) history.replaceState(null, "", next);
  }

  function getInitialView() {
    const fromHash = parseHashView(location.hash);
    if (fromHash) return fromHash;

    try {
      const fromStorage = localStorage.getItem(STORAGE_KEY);
      if (VIEW_KEYS.includes(fromStorage)) return fromStorage;
    } catch {}

    return "3d";
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  function safeAttach3D() {
    try {
      const cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.attachControl === "function") cam.attachControl(canvas, true);
    } catch {}
    try {
      const eng = window.__dbg && window.__dbg.engine ? window.__dbg.engine : null;
      if (eng && typeof eng.resize === "function") eng.resize();
    } catch {}
  }

  function safeDetach3D() {
    try {
      const cam = window.__dbg && window.__dbg.camera ? window.__dbg.camera : null;
      if (cam && typeof cam.detachControl === "function") cam.detachControl();
    } catch {}
  }

  function focusActive(view) {
    if (view === "3d") {
      try { viewSelect.focus({ preventScroll: true }); } catch {}
      return;
    }
    const page = view === "base" ? basePage : wallsPage;
    const heading = page.querySelector("h1,h2,[data-focus], [tabindex]") || page;
    if (heading && typeof heading.focus === "function") {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      try { heading.focus({ preventScroll: false }); } catch {}
    }
  }

  function showOnly(view) {
    const v = VIEW_KEYS.includes(view) ? view : "3d";

    document.body.dataset.view = v;

    const is3d = v === "3d";
    const isBase = v === "base";
    const isWalls = v === "walls";

    canvas.style.display = is3d ? "block" : "none";
    canvas.setAttribute("aria-hidden", String(!is3d));

    basePage.style.display = isBase ? "block" : "none";
    basePage.setAttribute("aria-hidden", String(!isBase));

    wallsPage.style.display = isWalls ? "block" : "none";
    wallsPage.setAttribute("aria-hidden", String(!isWalls));

    if (controlsPanel) controlsPanel.style.display = is3d ? "none" : "block";

    viewSelect.value = v;

    if (is3d) safeAttach3D();
    else safeDetach3D();

    purgeSidebars(document);
    focusActive(v);
  }

  function purgeSidebars(root) {
    const keep = new Set([canvas, topbar, controlsPanel, basePage, wallsPage].filter(Boolean));

    const selectors = [
      "#ui-layer", "#controls",
      "[id*='sidebar' i]", "[class*='sidebar' i]",
      "[id*='panel' i]", "[class*='panel' i]",
      "[id*='inspector' i]", "[class*='inspector' i]",
      "[id*='gui' i]", "[class*='gui' i]",
      ".dg.ac"
    ];

    try {
      root.querySelectorAll(selectors.join(",")).forEach((el) => {
        if (!el) return;
        for (const k of keep) {
          if (k && (el === k || el.contains(k) || k.contains(el))) return;
        }
        try { el.remove(); } catch {}
      });
    } catch {}

    try {
      const all = Array.from(root.querySelectorAll("body *"));
      for (const el of all) {
        if (!el) continue;

        for (const k of keep) {
          if (k && (el === k || el.contains(k) || k.contains(el))) {
            continue;
          }
        }

        const st = getComputedStyle(el);
        if (!st || st.display === "none") continue;

        const pos = st.position;
        if (pos !== "fixed" && pos !== "absolute") continue;

        const rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) continue;

        const nearRight = (window.innerWidth - rect.right) <= 2;
        const bigEnough = rect.width >= 200 && rect.height >= 100;

        let z = 0;
        const zRaw = st.zIndex;
        if (zRaw && zRaw !== "auto") {
          const zi = parseInt(zRaw, 10);
          z = Number.isFinite(zi) ? zi : 0;
        }

        if (nearRight && bigEnough && z >= 1000) {
          if (el === topbar || el.contains(topbar)) continue;
          if (el === canvas || el.contains(canvas)) continue;
          if (controlsPanel && (el === controlsPanel || el.contains(controlsPanel))) continue;
          try { el.remove(); } catch {}
        }
      }
    } catch {}
  }

  function setView(view, reason) {
    const v = VIEW_KEYS.includes(view) ? view : "3d";
    if (viewSelect.value !== v) viewSelect.value = v;

    try { localStorage.setItem(STORAGE_KEY, v); } catch {}
    if (reason !== "hash") setHashView(v);

    showOnly(v);
  }

  viewSelect.addEventListener("change", (e) => {
    const v = e && e.target ? e.target.value : "3d";
    setView(v, "select");
  });

  window.addEventListener("hashchange", () => {
    const v = parseHashView(location.hash);
    if (v) setView(v, "hash");
  });

  window.addEventListener("keydown", (e) => {
    if (!e || e.defaultPrevented) return;
    if (isTypingTarget(document.activeElement)) return;

    const k = e.key;
    if (k === "1") setView("3d", "key");
    else if (k === "2") setView("walls", "key");
    else if (k === "3") setView("base", "key");
  });

  window.addEventListener("resize", () => {
    if (document.body.dataset.view === "3d") safeAttach3D();
    purgeSidebars(document);
  });

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) {
        purgeSidebars(document);
        break;
      }
    }
  });
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  const initial = getInitialView();
  setView(initial, "init");
}
