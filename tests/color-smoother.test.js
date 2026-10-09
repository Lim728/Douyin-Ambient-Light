import { describe, expect, it } from 'vitest';
import { ColorSmoother, MAX_TAU, MIN_TAU, blendEdgeAndGlobal, tauForSmoothness } from '../src/content/color-smoother.js';
import { luma, rgb } from '../src/shared/color.js';

function state(global, edges) {
  const edge = edges ?? {
    top: global,
    bottom: global,
    left: global,
    right: global,
  };
  return {
    global,
    edgeAverage: global,
    edges: edge,
    luma: luma(global) / 255,
  };
}

/** A 3x3 zone state, i.e. the shape ColorSampler.sample() returns for the zoned renderer. */
function zonedState(zones, global = rgb(0, 0, 0)) {
  return {
    ...state(global),
    zones,
    grid: { rows: 3, cols: 3 },
  };
}

const zoneGrid = (color) => Array.from({ length: 9 }, () => ({ ...color }));
const blackZones = () => zoneGrid(rgb(0, 0, 0));

describe('tauForSmoothness', () => {
  it('grows monotonically with the slider', () => {
    expect(tauForSmoothness(0)).toBeCloseTo(MIN_TAU, 6);
    expect(tauForSmoothness(100)).toBeCloseTo(MAX_TAU, 6);
    expect(tauForSmoothness(50)).toBeGreaterThan(tauForSmoothness(25));
  });
});

describe('ColorSmoother', () => {
  it('snaps on the first sample', () => {
    const smoother = new ColorSmoother({ smoothness: 80 });
    const result = smoother.update(state(rgb(0, 0, 255)), 0.08);
    expect(result.global).toEqual(rgb(0, 0, 255));
  });

  it('is frame rate independent', () => {
    const smoother = new ColorSmoother({ smoothness: 60 });
    // Ten small steps must compose to the same blend as one big step.
    const single = smoother.alpha(0.1);
    const stepped = 1 - Math.pow(1 - smoother.alpha(0.01), 10);
    expect(Math.abs(single - stepped)).toBeLessThan(0.001);
  });

  it('reaches a similar colour at 60 fps and at 240 fps', () => {
    const slow = new ColorSmoother({ smoothness: 60 });
    const fast = new ColorSmoother({ smoothness: 60 });
    slow.update(state(rgb(0, 0, 0)), 1 / 60);
    fast.update(state(rgb(0, 0, 0)), 1 / 60);
    for (let i = 0; i < 60; i++) slow.update(state(rgb(255, 0, 0)), 1 / 60);
    for (let i = 0; i < 240; i++) fast.update(state(rgb(255, 0, 0)), 1 / 240);
    expect(Math.abs(slow.state.global.r - fast.state.global.r)).toBeLessThanOrEqual(6);
  });

  it('never overshoots and converges to the target', () => {
    const smoother = new ColorSmoother({ smoothness: 50 });
    smoother.update(state(rgb(0, 0, 0)), 0.1);
    for (let i = 0; i < 200; i++) smoother.update(state(rgb(255, 128, 0)), 0.08);
    expect(smoother.state.global.r).toBe(255);
    expect(smoother.state.global.g).toBe(128);
  });

  it('passes through purple when going from blue to red', () => {
    const smoother = new ColorSmoother({ smoothness: 100 });
    smoother.update(state(rgb(0, 0, 255)), 0.08);
    let sawPurple = false;
    for (let i = 0; i < 60; i++) {
      const current = smoother.update(state(rgb(255, 0, 0)), 0.08).global;
      if (current.r > 60 && current.b > 60) sawPurple = true;
    }
    expect(sawPurple).toBe(true);
  });

  it('moves slower with a higher smoothness setting', () => {
    const quick = new ColorSmoother({ smoothness: 0 });
    const lazy = new ColorSmoother({ smoothness: 100 });
    quick.update(state(rgb(0, 0, 0)), 0.05);
    lazy.update(state(rgb(0, 0, 0)), 0.05);
    const a = quick.update(state(rgb(255, 255, 255)), 0.05).global.r;
    const b = lazy.update(state(rgb(255, 255, 255)), 0.05).global.r;
    expect(a).toBeGreaterThan(b);
  });

  it('clears its history on reset', () => {
    const smoother = new ColorSmoother({ smoothness: 50 });
    smoother.update(state(rgb(0, 0, 0)), 0.1);
    smoother.reset();
    expect(smoother.state).toBeNull();
  });

  it('ignores missing samples', () => {
    const smoother = new ColorSmoother();
    smoother.update(state(rgb(10, 20, 30)), 0.05);
    expect(smoother.update(null, 0.05).global).toEqual(rgb(10, 20, 30));
  });
});

/**
 * The zoned renderer draws the halo from `state.zones`, so the temporal filter has to carry one
 * independent history entry per zone. A regression here (a single frozen array) is invisible in
 * the renderer but makes every zone look identical, which is exactly the bug these tests lock
 * down.
 */
describe('ColorSmoother zones', () => {
  it('smooths every zone on its own (a bright top left must not move a dark bottom right)', () => {
    const smoother = new ColorSmoother({ smoothness: 80 });
    smoother.update(zonedState(blackZones()), 0.08);

    const target = blackZones();
    target[0] = rgb(255, 0, 0); // top left
    target[8] = rgb(0, 0, 255); // bottom right
    const mixed = smoother.update(zonedState(target, rgb(20, 20, 20)), 0.08);

    expect(mixed.zones).toHaveLength(9);
    expect(mixed.zones[0].r).toBeGreaterThan(0);
    expect(mixed.zones[0].b).toBe(0);
    expect(mixed.zones[8].b).toBeGreaterThan(0);
    expect(mixed.zones[8].r).toBe(0);
    // Untouched zones stay exactly where they were.
    expect(mixed.zones[4]).toEqual(rgb(0, 0, 0));
    expect(mixed.zones[1]).toEqual(rgb(0, 0, 0));
  });

  it('drives every zone towards its own target over time', () => {
    const smoother = new ColorSmoother({ smoothness: 40 });
    smoother.update(zonedState(blackZones()), 0.08);

    const target = blackZones();
    target[2] = rgb(0, 255, 0);
    let latest = smoother.update(zonedState(target), 0.08);
    for (let i = 0; i < 200; i++) latest = smoother.update(zonedState(target), 0.08);

    expect(latest.zones[2]).toEqual(rgb(0, 255, 0));
    expect(latest.zones[3]).toEqual(rgb(0, 0, 0));
  });

  it('never drops the zone array while zones keep arriving', () => {
    const smoother = new ColorSmoother({ smoothness: 50 });
    smoother.update(zonedState(blackZones()), 0.08);
    for (let i = 0; i < 5; i++) {
      const target = blackZones();
      target[0] = rgb(255, 0, 0);
      const mixed = smoother.update(zonedState(target), 0.08);
      expect(Array.isArray(mixed.zones)).toBe(true);
      expect(mixed.zones).toHaveLength(9);
    }
  });

  it('keeps the previous zones when a state without zones arrives (fallback tolerance)', () => {
    const smoother = new ColorSmoother({ smoothness: 0 });
    smoother.update(zonedState(zoneGrid(rgb(10, 20, 30))), 0.08);
    const fallback = smoother.update(state(rgb(200, 0, 0)), 0.08);
    expect(fallback.zones[0]).toEqual(rgb(10, 20, 30));
    expect(fallback.zones[8]).toEqual(rgb(10, 20, 30));
  });
});

describe('blendEdgeAndGlobal', () => {
  it('returns the global colour at 0', () => {
    const value = { global: rgb(10, 10, 10), edgeAverage: rgb(200, 200, 200) };
    expect(blendEdgeAndGlobal(value, 0)).toEqual(rgb(10, 10, 10));
  });

  it('returns the edge colour at 100', () => {
    const value = { global: rgb(10, 10, 10), edgeAverage: rgb(200, 200, 200) };
    expect(blendEdgeAndGlobal(value, 100)).toEqual(rgb(200, 200, 200));
  });

  it('mixes in between', () => {
    const value = { global: rgb(0, 0, 0), edgeAverage: rgb(255, 255, 255) };
    const mixed = blendEdgeAndGlobal(value, 50);
    expect(mixed.r).toBeGreaterThan(100);
    expect(mixed.r).toBeLessThan(200);
  });
});
