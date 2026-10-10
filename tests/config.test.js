import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  SAMPLING_FPS_CHOICES,
  normalizeHexColor,
  normalizeSettings,
  settingsEqual,
} from '../src/shared/config.js';

describe('normalizeSettings', () => {
  it('fills in every default for an empty input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULTS);
    expect(normalizeSettings({})).toEqual(DEFAULTS);
  });

  it('drops unknown keys', () => {
    const result = normalizeSettings({ blur: 10, somethingElse: 'x' });
    expect(result).not.toHaveProperty('somethingElse');
  });

  it('clamps numbers into range and rounds them', () => {
    expect(normalizeSettings({ blur: 999 }).blur).toBe(100);
    expect(normalizeSettings({ blur: -20 }).blur).toBe(0);
    expect(normalizeSettings({ intensity: 12.6 }).intensity).toBe(13);
  });

  it('falls back for non numeric values', () => {
    expect(normalizeSettings({ blur: 'abc' }).blur).toBe(DEFAULTS.blur);
  });

  it('only accepts known sampling rates', () => {
    expect(normalizeSettings({ samplingFps: 15 }).samplingFps).toBe(15);
    expect(normalizeSettings({ samplingFps: 7 }).samplingFps).toBe(DEFAULTS.samplingFps);
    expect(SAMPLING_FPS_CHOICES).toContain(normalizeSettings({ samplingFps: 5 }).samplingFps);
  });

  it('coerces booleans stored as strings', () => {
    expect(normalizeSettings({ enabled: 'false' }).enabled).toBe(false);
    expect(normalizeSettings({ enabled: 'true' }).enabled).toBe(true);
    expect(normalizeSettings({ enabled: 0 }).enabled).toBe(false);
  });

  it('defaults the pure black background option to off', () => {
    expect(DEFAULTS.pureBlackBackground).toBe(false);
    expect(normalizeSettings({}).pureBlackBackground).toBe(false);
    expect(normalizeSettings({ pureBlackBackground: 'nonsense' }).pureBlackBackground).toBe(false);
  });

  it('accepts an explicit pure black background value', () => {
    expect(normalizeSettings({ pureBlackBackground: true }).pureBlackBackground).toBe(true);
    expect(normalizeSettings({ pureBlackBackground: 'true' }).pureBlackBackground).toBe(true);
    expect(normalizeSettings({ pureBlackBackground: 1 }).pureBlackBackground).toBe(true);
    expect(normalizeSettings({ pureBlackBackground: 'false' }).pureBlackBackground).toBe(false);
  });

  it('validates the background colour', () => {
    expect(normalizeSettings({ backgroundColor: '#ABC' }).backgroundColor).toBe('#aabbcc');
    expect(normalizeSettings({ backgroundColor: 'red' }).backgroundColor).toBe(DEFAULTS.backgroundColor);
  });
});

describe('normalizeHexColor', () => {
  it('expands shorthand and lowercases', () => {
    expect(normalizeHexColor('#0F0')).toBe('#00ff00');
    expect(normalizeHexColor('123456')).toBe('#123456');
  });

  it('returns the fallback for garbage', () => {
    expect(normalizeHexColor(null, '#111111')).toBe('#111111');
    expect(normalizeHexColor('#12345', '#111111')).toBe('#111111');
  });
});

describe('settingsEqual', () => {
  it('compares every known key', () => {
    expect(settingsEqual(DEFAULTS, { ...DEFAULTS })).toBe(true);
    expect(settingsEqual(DEFAULTS, { ...DEFAULTS, blur: 1 })).toBe(false);
    expect(settingsEqual(DEFAULTS, null)).toBe(false);
  });
});
