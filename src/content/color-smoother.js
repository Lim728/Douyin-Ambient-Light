/**
 * Temporal colour smoothing.
 *
 * A hard cut from a blue scene to a red scene looks like a strobe when the halo is a
 * full page background, so every sampled colour is pushed through an exponential filter:
 *
 *     current = mix(current, target, 1 - exp(-dt / tau))
 *
 * The mix itself happens in linear light, so blue -> red naturally travels through purple
 * instead of grey. `tau` grows with the user's "smoothness" setting; the filter is
 * frame rate independent, which matters because the sampling rate is configurable.
 */

import { luma, mixRgbFloat, srgbValueToLinear } from '../shared/color.js';
import { DEFAULT_ZONE_GRID } from '../shared/config.js';
import { clamp } from '../shared/utils.js';

/** Time constant in seconds for smoothness 0 and 100. */
export const MIN_TAU = 0.035;
export const MAX_TAU = 1.15;

export function tauForSmoothness(smoothness) {
  const t = clamp(smoothness, 0, 100) / 100;
  // Quadratic ramp: the low half of the slider stays responsive, the top half gets dreamy.
  return MIN_TAU + (MAX_TAU - MIN_TAU) * t * t;
}

/** Largest per channel distance between two colours in linear light. */
function linearDistance(a, b) {
  return Math.max(
    Math.abs(srgbValueToLinear(a.r) - srgbValueToLinear(b.r)),
    Math.abs(srgbValueToLinear(a.g) - srgbValueToLinear(b.g)),
    Math.abs(srgbValueToLinear(a.b) - srgbValueToLinear(b.b))
  );
}

/**
 * Mixing happens on fractional channels (no rounding to bytes) so the filter stays frame
 * rate independent; once the two colours are indistinguishable the target is adopted
 * verbatim, which keeps the state stable instead of leaving an invisible residue.
 */
const mixChannel = (from, to, alpha) => {
  if (linearDistance(from, to) < 0.002) return { r: to.r, g: to.g, b: to.b };
  return mixRgbFloat(from, to, alpha);
};

const mixState = (current, target, alpha) => ({
  global: mixChannel(current.global, target.global, alpha),
  edgeAverage: mixChannel(current.edgeAverage, target.edgeAverage, alpha),
  edges: {
    top: mixChannel(current.edges.top, target.edges.top, alpha),
    bottom: mixChannel(current.edges.bottom, target.edges.bottom, alpha),
    left: mixChannel(current.edges.left, target.edges.left, alpha),
    right: mixChannel(current.edges.right, target.edges.right, alpha),
  },
  zones: mixZones(current.zones, target.zones, alpha),
});

/**
 * Mixed one zone at a time on purpose: the zones are independent, so a change in the top left
 * must not move the bottom right. Only the *time constant* (alpha) is shared.
 *
 * Both arguments are the raw `zones` arrays (not the whole colour states): mixing the arrays
 * directly keeps the per-zone history exactly one entry deep.
 */
function mixZones(current, target, alpha) {
  if (!Array.isArray(target)) return undefined;
  const previous = Array.isArray(current) && current.length === target.length
    ? current
    : null;
  return target.map((zone, index) => {
    const from = previous?.[index];
    if (!from) return { ...zone };
    return mixChannel(from, zone, alpha);
  });
}

export class ColorSmoother {
  constructor(options = {}) {
    this.smoothness = options.smoothness ?? 70;
    this.state = null;
  }

  setSmoothness(value) {
    this.smoothness = clamp(value, 0, 100);
  }

  /** Drops the history, e.g. when the extension is toggled or the video changes. */
  reset() {
    this.state = null;
  }


  copyState(target) {
    return {
      global: { ...target.global },
      edgeAverage: { ...target.edgeAverage },
      edges: {
        top: { ...target.edges.top },
        bottom: { ...target.edges.bottom },
        left: { ...target.edges.left },
        right: { ...target.edges.right },
      },
      zones: Array.isArray(target.zones) ? target.zones.map((zone) => ({ ...zone })) : undefined,
      grid: target.grid ? { ...target.grid } : undefined,
      luma: target.luma ?? 0,
      size: target.size,
      insets: target.insets,
      bounds: target.bounds,
    };
  }

  /**
   * Advances the filter towards `target`.
   * @param {object} target state produced by ColorSampler.sample()
   * @param {number} dt seconds elapsed since the previous update
   */
  update(target, dt) {
    if (!target) return this.state;
    if (!this.state) {
      this.state = this.copyState(target);
      return this.state;
    }
    const alpha = this.alpha(dt);
    const mixed = mixState(this.state, target, alpha);
    this.state = {
      ...mixed,
      zones: mixed.zones ?? this.state.zones,
      grid: target.grid ?? this.state.grid,
      luma: Math.abs(target.luma - this.state.luma) < 0.004
        ? target.luma
        : this.state.luma + (target.luma - this.state.luma) * alpha,
      size: target.size,
      insets: target.insets,
      bounds: target.bounds,
    };
    return this.state;
  }

  /** Blend factor for a frame duration in seconds. */
  alpha(dt, smoothness = this.smoothness) {
    const step = clamp(Number.isFinite(dt) ? dt : 1 / 60, 1 / 240, 0.5);
    const tau = tauForSmoothness(smoothness);
    return 1 - Math.exp(-step / tau);
  }
}

/**
 * Builds a uniform colour state (all four edges and the global average share one colour).
 * Used by the debug / force mode and by the CORS fallback, which have no frame to sample.
 */
export function uniformState(color, rows = DEFAULT_ZONE_GRID, cols = DEFAULT_ZONE_GRID) {
  const zones = new Array(rows * cols);
  for (let i = 0; i < zones.length; i++) zones[i] = { ...color };
  return {
    global: color,
    edgeAverage: color,
    edges: { top: color, bottom: color, left: color, right: color },
    zones,
    grid: { rows, cols },
    luma: luma(color) / 255,
    size: null,
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  };
}

/**
 * Blends the four edge colours with the whole frame average according to `edgeFocus`
 * (0 = only the frame average, 100 = only the edges). Used for the large background wash.
 */
export function blendEdgeAndGlobal(state, edgeFocus) {
  const focus = clamp(edgeFocus, 0, 100) / 100;
  const edges = state.edgeAverage ?? state.global;
  return focus <= 0 ? { ...state.global } : mixRgbFloat(state.global, edges, focus);
}
