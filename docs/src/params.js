// FILE: docs/src/params.js

/** BASE constants (from reference single-file) */
export const CONFIG = {
  grid: { size: 500, h: 50 },
  timber: { w: 50, d: 100 },
  insulation: { w: 1200, d: 2400, h: 50 },
  decking: { w: 1220, d: 2440, h: 18 },
  spacing: 400
};

/** Walls + Dimension Mode defaults + Base visibility */
export const DEFAULTS = {
  // legacy placeholders; engines use derived states
  w: 3000,
  d: 4000,

  // Visibility
  vis: {
    // Base toggles
    base: true,
    frame: true,
    ins: true,
    deck: true,
    // Walls master (kept to avoid drift in UI behavior)
    wallsEnabled: true,
    // Per-wall toggles
    walls: { front: true, back: true, left: true, right: true }
  },

  // Dimension Mode system
  dimMode: "base",   // "base" | "frame" | "roof"
  dimGap_mm: 40,
  overhang: {
    uniform_mm: 0,
    front_mm: null,
    back_mm: null,
    left_mm: null,
    right_mm: null,
  },
  dimInputs: {
    baseW_mm: 3000,
    baseD_mm: 4000,
    frameW_mm: 3040,
    frameD_mm: 4040,
    roofW_mm: 3040,
    roofD_mm: 4040,
  },

  roof: {
    style: "apex",
    pent: {
      minHeight_mm: 2400,
      maxHeight_mm: 2400
    }
  },

  // Walls configuration (v1)
  walls: {
    variant: "insulated",
    height_mm: 2400,
    insulated: { section: { w: 50, h: 100 }, spacing: 400 },
    basic:     { section: { w: 50, h: 75 },  spacing: null },
    openings: [],
    invalidDoorIds: [],
    invalidWindowIds: []
  }
};

/** Return current variant key (compat) */
export function selectWallsProfile(state) {
  const v = state?.walls?.variant || "insulated";
  return v;
}

/** Resolve per-side overhangs; blanks fall back to uniform. */
function resolveOverhangSides(ovh) {
  const uni = clampNonNeg(num(ovh?.uniform_mm, 0));
  const l = ovh?.left_mm  == null ? uni : clampNonNeg(num(ovh.left_mm, 0));
  const r = ovh?.right_mm == null ? uni : clampNonNeg(num(ovh.right_mm, 0));
  const f = ovh?.front_mm == null ? uni : clampNonNeg(num(ovh.front_mm, 0));
  const b = ovh?.back_mm  == null ? uni : clampNonNeg(num(ovh.back_mm, 0));
  return { l_mm: l, r_mm: r, f_mm: f, b_mm: b };
}

/**
 * Dimension resolver implementing Base/Frame/Roof exactly.
 * Returns outer dims for base/frame/roof plus resolved overhangs.
 */
export function resolveDims(state) {
  const mode = (state?.dimMode || "base");
  const G = clampNonNeg(num(state?.dimGap_mm, 40));
  const inputs = state?.dimInputs || DEFAULTS.dimInputs;
  const ovh = resolveOverhangSides(state?.overhang || DEFAULTS.overhang);

  const sumX = ovh.l_mm + ovh.r_mm;
  const sumZ = ovh.f_mm + ovh.b_mm;

  const pair = (w, d) => ({ w_mm: clampPosInt(num(w, 1)), d_mm: clampPosInt(num(d, 1)) });

  let base, frame, roof;
  if (mode === "base") {
    const b = pair(inputs.baseW_mm, inputs.baseD_mm);
    const f = pair(b.w_mm + G, b.d_mm + G);
    const r = pair(f.w_mm + sumX, f.d_mm + sumZ);
    base = b; frame = f; roof = r;
  } else if (mode === "frame") {
    const f = pair(inputs.frameW_mm, inputs.frameD_mm);
    const b = pair(Math.max(1, f.w_mm - G), Math.max(1, f.d_mm - G));
    const r = pair(f.w_mm + sumX, f.d_mm + sumZ);
    base = b; frame = f; roof = r;
  } else { // roof
    const r = pair(inputs.roofW_mm, inputs.roofD_mm);
    const f = pair(Math.max(1, r.w_mm - sumX), Math.max(1, r.d_mm - sumZ));
    const b = pair(Math.max(1, f.w_mm - G), Math.max(1, f.d_mm - G));
    base = b; frame = f; roof = r;
  }

  return { base, frame, roof, overhang: ovh };
}

/** Utilities */
function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function clampNonNeg(n) { return Math.max(0, Math.floor(n)); }
function clampPosInt(n) { return Math.max(1, Math.floor(n)); }
