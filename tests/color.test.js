import { describe, expect, it } from 'vitest';
import {
  MAX_BLACK_CUT,
  averageRgb,
  hexToRgb,
  linearToSrgb,
  luma,
  mixRgbFloat,
  rgb,
  rgba,
  srgbToLinear,
  srgbValueToLinear,
  zoneIntensity,
  zoneLevel,
} from '../src/shared/color.js';

const linearLuma = (color) =>
  0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);

describe('sRGB <-> linear conversion', () => {
  it('is invertible for every byte', () => {
    for (let i = 0; i < 256; i++) expect(linearToSrgb(srgbToLinear(i))).toBe(i);
  });

  it('keeps the endpoints', () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBe(255);
  });

  it('agrees between the byte table and the fractional path', () => {
    for (let i = 0; i < 256; i += 7) {
      expect(srgbValueToLinear(i)).toBeCloseTo(srgbToLinear(i), 10);
    }
  });
});

describe('mixRgbFloat', () => {
  it('returns the endpoints unchanged, including for fractional channels', () => {
    const a = { r: 10.4, g: 20.7, b: 30.2 };
    const b = rgb(200, 100, 50);
    expect(mixRgbFloat(a, b, 0)).toEqual(a);
    expect(mixRgbFloat(a, b, 1)).toEqual(b);
  });

  it('travels through purple when fading blue to red', () => {
    const blue = rgb(0, 0, 255);
    const red = rgb(255, 0, 0);
    const middle = mixRgbFloat(blue, red, 0.5);
    expect(middle.r).toBeGreaterThan(100);
    expect(middle.b).toBeGreaterThan(100);
    expect(middle.g).toBeLessThan(1);
  });

  it('never dips below the darker endpoint (no grey valley)', () => {
    const blue = rgb(0, 0, 255);
    const red = rgb(255, 0, 0);
    const middle = mixRgbFloat(blue, red, 0.5);
    // A gamma space lerp would land at ~28 here; linear light keeps it bright.
    expect(luma(middle)).toBeGreaterThan(45);
  });

  it('preserves the physical luminance of a two colour mix', () => {
    const a = rgb(180, 120, 140);
    const b = rgb(40, 90, 200);
    const mixed = mixRgbFloat(a, b, 0.5);
    const expected = (linearLuma(a) + linearLuma(b)) / 2;
    expect(Math.abs(linearLuma(mixed) - expected)).toBeLessThan(0.004);
  });

  it('does not round to whole bytes', () => {
    const mixed = mixRgbFloat(rgb(0, 0, 0), rgb(255, 255, 255), 0.0005);
    expect(Number.isInteger(mixed.r)).toBe(false);
    expect(mixed.r).toBeGreaterThan(0);
  });
});

describe('averageRgb', () => {
  it('returns black for an empty list', () => {
    expect(averageRgb([])).toEqual(rgb(0, 0, 0));
  });

  it('averages in linear light, so black plus white is not mid grey', () => {
    const result = averageRgb([rgb(0, 0, 0), rgb(255, 255, 255)]);
    expect(result.r).toBe(188);
  });
});

describe('helpers', () => {
  it('parses short and long hex colours', () => {
    expect(hexToRgb('#abc')).toEqual(rgb(170, 187, 204));
    expect(hexToRgb('0b0b10')).toEqual(rgb(11, 11, 16));
    expect(hexToRgb('nope')).toEqual(rgb(0, 0, 0));
  });

  it('formats rgba() strings and rounds fractional channels', () => {
    expect(rgba(rgb(1, 2, 3), 0.5)).toBe('rgba(1,2,3,0.5000)');
    expect(rgba(rgb(1, 2, 3), 5)).toBe('rgba(1,2,3,1.0000)');
    expect(rgba({ r: 10.4, g: 10.6, b: -3 }, 1)).toBe('rgba(10,11,0,1.0000)');
  });
});

describe('zoneLevel', () => {
  it('reports a saturated colour as fully lit even though its luma is low', () => {
    // Pure red has a luma of only 0.21, but it is obviously a lit region.
    expect(zoneLevel(rgb(255, 0, 0))).toBeCloseTo(1, 6);
    expect(zoneLevel(rgb(0, 0, 255))).toBeCloseTo(1, 6);
  });

  it('reports black as 0 and greys proportionally', () => {
    expect(zoneLevel(rgb(0, 0, 0))).toBe(0);
    expect(zoneLevel(rgb(128, 128, 128))).toBeCloseTo(128 / 255, 6);
  });
});

describe('zoneIntensity', () => {
  it('never lights a black zone, even with contrast 0', () => {
    expect(zoneIntensity(0, 0.3, 0)).toBe(0);
    expect(zoneIntensity(0, 0, 0)).toBe(0);
    expect(zoneIntensity(0, 0.15, 1)).toBe(0);
  });

  it('keeps bright zones at full gain', () => {
    expect(zoneIntensity(1, MAX_BLACK_CUT * 0.15, 0.72)).toBeCloseTo(1, 6);
  });

  it('suppresses dark zones more with a higher contrast', () => {
    const level = 0.3;
    expect(zoneIntensity(level, 0.0675, 0.9)).toBeLessThan(zoneIntensity(level, 0.0675, 0.2));
  });

  it('is monotonic in the zone level', () => {
    const values = [0, 0.1, 0.3, 0.6, 0.9, 1].map((level) => zoneIntensity(level, 0.0675, 0.72));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });

  it('drops to (almost) zero well below the black level', () => {
    const dark = zoneIntensity(30 / 255, MAX_BLACK_CUT * 0.15, 0.72);
    const bright = zoneIntensity(1, MAX_BLACK_CUT * 0.15, 0.72);
    expect(dark).toBeLessThan(0.1);
    expect(bright / Math.max(dark, 1e-6)).toBeGreaterThan(10);
  });
});
