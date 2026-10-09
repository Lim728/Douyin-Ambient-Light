/**
 * Colour helpers.
 *
 * Averaging and interpolating colours in gamma encoded sRGB is the classic source of
 * "muddy" results: a blue -> red fade turns grey in the middle. Everything here therefore
 * works in linear light, which produces the expected blue -> purple -> red ramp and matches
 * how a real projector / TV backlight physically blends.
 *
 * Two flavours exist on purpose:
 *  - byte based helpers (`srgbToLinear`, `linearToSrgb`, `rgb`, `averageRgb`) used by the
 *    sampling inner loops, where values come straight out of `ImageData`;
 *  - fractional helpers (`srgbValueToLinear`, `linearToSrgbValue`, `mixRgbFloat`) used by the
 *    temporal filter, which must not round to 8 bit between steps.
 */

import { clamp } from './utils.js';

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB byte (0-255) -> linear light (0-1). Table lookup, used by the sampling inner loops. */
export const srgbToLinear = (byte) => SRGB_TO_LINEAR[clamp(byte | 0, 0, 255)];

/** linear light (0-1) -> sRGB byte (0-255). */
export function linearToSrgb(value) {
  return Math.round(linearToSrgbValue(value));
}

/** Fractional sRGB value (0-255) -> linear light (0-1). */
export function srgbValueToLinear(value) {
  const c = clamp(value, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear light (0-1) -> fractional sRGB value (0-255). */
export function linearToSrgbValue(value) {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(s, 0, 1) * 255;
}

/** Creates an rgb colour object from byte components. */
export function rgb(r, g, b) {
  return { r: r | 0, g: g | 0, b: b | 0 };
}

/** Perceptual luminance (Rec. 709) of an sRGB colour, 0-255 scale. */
export function luma({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Linear-light mix without rounding back to bytes.
 * The temporal filter runs on this so that repeated steps cannot drift or stall on 8 bit
 * quantisation (a 12 fps and a 60 fps update must land on the same colour).
 */
export function mixRgbFloat(a, b, t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (k === 0) return { r: a.r, g: a.g, b: a.b };
  if (k === 1) return { r: b.r, g: b.g, b: b.b };
  const ar = srgbValueToLinear(a.r);
  const ag = srgbValueToLinear(a.g);
  const ab = srgbValueToLinear(a.b);
  const br = srgbValueToLinear(b.r);
  const bg = srgbValueToLinear(b.g);
  const bb = srgbValueToLinear(b.b);
  return {
    r: linearToSrgbValue(ar + (br - ar) * k),
    g: linearToSrgbValue(ag + (bg - ag) * k),
    b: linearToSrgbValue(ab + (bb - ab) * k),
  };
}

/** `rgba(r, g, b, a)` CSS string. Accepts fractional channels. `alpha` is clamped to 0-1. */
export function rgba(color, alpha = 1) {
  const a = clamp(alpha, 0, 1);
  const channel = (value) => Math.round(clamp(value, 0, 255));
  return `rgba(${channel(color.r)},${channel(color.g)},${channel(color.b)},${a.toFixed(4)})`;
}

/** Formats an rgb object (fractional channels allowed) as `#rrggbb`. */
export function rgbToHex({ r, g, b }) {
  const part = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Parses `#rgb` / `#rrggbb` into an rgb object. */
export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return rgb(0, 0, 0);
  let value = match[1];
  if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  return rgb(
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  );
}

/** Average of a list of colours, computed in linear light. Returns black for an empty list. */
export function averageRgb(colors) {
  if (!colors || colors.length === 0) return rgb(0, 0, 0);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const color of colors) {
    r += srgbToLinear(color.r);
    g += srgbToLinear(color.g);
    b += srgbToLinear(color.b);
  }
  const n = colors.length;
  return { r: linearToSrgb(r / n), g: linearToSrgb(g / n), b: linearToSrgb(b / n) };
}

/**
 * "Is there any light in this zone?" measured as the HSV value (the highest channel).
 *
 * A luminance gate would wrongly suppress saturated colours - pure red has a Rec.709 luma of
 * only 0.21 even though it is a fully lit pixel - and the whole point of the zoned renderer is
 * that a red region keeps glowing red. The highest channel answers "is this region lit?" no
 * matter which hue the light has.
 *
 * @param {{r:number,g:number,b:number}} color
 * @returns {number} 0-1
 */
export function zoneLevel({ r, g, b }) {
  return Math.max(r, g, b) / 255;
}

/** Zone light level that `blackThreshold = 100` maps to (the strongest possible black cut). */
export const MAX_BLACK_CUT = 0.45;

/**
 * Glow gain of a single zone.
 *
 * `cut` is the light level at (or below) which a zone counts as black, `contrast` (0-1) scales
 * how aggressively the cut and the curve suppress dim zones. A zone that carries no light at
 * all always returns 0, so a black region can never be lit up by its neighbours.
 *
 * @param {number} level 0-1, see zoneLevel()
 * @param {number} cut 0-1, black level
 * @param {number} contrast 0-1
 * @returns {number} 0-1 multiplier for the zone's alpha
 */
export function zoneIntensity(level, cut = 0, contrast = 1) {
  const c = clamp(contrast, 0, 1);
  const threshold = clamp(cut, 0, 0.95) * c;
  if (!(level > threshold)) return 0;
  const t = clamp((level - threshold) / Math.max(1e-3, 1 - threshold), 0, 1);
  // Higher contrast = steeper curve = dim zones fall off faster (darker room).
  const gamma = 0.45 + 1.05 * c;
  return Math.pow(t, gamma);
}
