// FILE: docs/src/views.js
/**
 * View/page switching for the Pages dropdown.
 *
 * Goals:
 * - Restore cutting-list pages showing/hiding correctly when selected.
 * - Be robust to minor HTML differences (supports multiple conventions).
 * - Avoid drifting any geometry/BOM logic: this file ONLY manages visibility.
 *
 * Expected (any of these patterns are supported):
 * - A <select> with id="pageSelect" (preferred) or id="pagesSelect" or id="viewSelect"
 * - Page containers identified by:
 *    - [data-page] attribute, OR
 *    - class ".page", OR
 *    - ids ending with "Page" (e.g., "bomPage", "roofPage", "roofBomPage")
 * - 3D canvas container can be:
 *    - #viewport, OR
 *    - #scenePage, OR
 *    - #renderWrap, OR
 *    - the canvas itself (#renderCanvas)
 */

export function initViews() {
  // prevent double-wiring
  if (window.__views && window.__views._wired) return window.__views;

  const api = (window.__views = window.__views || {});
  api._wired = true;

  const select =
    document.getElementById("pageSelect") ||
    document.getElementById("pagesSelect") ||
    document.getElementById("viewSelect");

  function allPageEls() {
    const out = new Set();

    // Most explicit
    document.querySelectorAll("[data-page]").forEach((el) => out.add(el));

    // Common convention
    document.querySelectorAll(".page").forEach((el) => out.add(el));

    // Fallback: any element whose id ends with "Page"
    const all = document.querySelectorAll("[id]");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const id = String(el.id || "");
      if (id && /Page$/.test(id)) out.add(el);
    }

    return Array.from(out);
  }

  function resolveTargetId(val) {
    const v = String(val || "").trim();
    if (!v) return null;

    // If option value already is an element id, use it.
    if (document.getElementById(v)) return v;

    // If option value is like "roof" try "roofPage"
    const candidate = v.endsWith("Page") ? v : v + "Page";
    if (document.getElementById(candidate)) return candidate;

    // If option value is like "Roof Cutting List" etc, try matching data-page
    const pages = allPageEls();
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i];
      const dp = el.getAttribute("data-page");
      if (dp && String(dp).trim() === v) return el.id || null;
    }

    return null;
  }

  function hideAllPages() {
    const pages = allPageEls();
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i];
      if (!el) continue;
      el.style.display = "none";
    }
  }

  function showEl(el) {
    if (!el) return;
    el.style.display = "";
  }

  function is3DPageId(id) {
    // Heuristic: anything named scene/viewport/3d
    const s = String(id || "").toLowerCase();
    return (
      s === "viewport" ||
      s === "scenepage" ||
      s === "renderwrap" ||
      s.includes("scene") ||
      s.includes("viewport") ||
      s.includes("3d")
    );
  }

  function show3DIfPossible() {
    // Prefer explicit containers if they exist
    const el =
      document.getElementById("viewport") ||
      document.getElementById("scenePage") ||
      document.getElementById("renderWrap");

    if (el) showEl(el);
    else {
      // absolute fallback: ensure canvas is visible
      const c = document.getElementById("renderCanvas");
      if (c) c.style.display = "";
    }

    // Kick engine resize / layout
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (e) {}
  }

  function setPageById(id) {
    hideAllPages();

    if (!id) {
      // default to 3D view if nothing selected
      show3DIfPossible();
      api.current = null;
      return;
    }

    const el = document.getElementById(id);
    if (el) {
      showEl(el);
      api.current = id;

      // If switching to 3D-like page, ensure canvas container is visible and resized
      if (is3DPageId(id)) show3DIfPossible();
      return;
    }

    // If element doesn't exist, show 3D as safe default
    show3DIfPossible();
    api.current = null;
  }

  function setPageFromSelect() {
    if (!select) {
      // No dropdown found; ensure 3D is visible.
      show3DIfPossible();
      api.current = null;
      return;
    }
    const targetId = resolveTargetId(select.value);
    setPageById(targetId);
  }

  // Public API
  api.setPage = function (valOrId) {
    const id = resolveTargetId(valOrId) || String(valOrId || "").trim() || null;
    setPageById(id);
  };

  // Wire dropdown
  if (select && !select._viewsWired) {
    select._viewsWired = true;
    select.addEventListener("change", setPageFromSelect);
  }

  // Initial selection
  setPageFromSelect();

  return api;
}
