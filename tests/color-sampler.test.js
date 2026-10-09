import { describe, expect, it } from 'vitest';
import {
  BAR_LUMA_THRESHOLD,
  ColorSampler,
  DEFAULT_MAX_SIDE,
  centreCells,
  computeRegionColors,
  detectInsets,
  lumaProfile,
  normalizeGrid,
  sampleSizeFor,
  sourceCropFor,
} from '../src/content/color-sampler.js';
import { MAX_BLACK_CUT, zoneIntensity, zoneLevel } from '../src/shared/color.js';

/** Builds an RGBA buffer from a per pixel colour function. */
function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return data;
}

describe('sampleSizeFor', () => {
  it('keeps the longest side fixed', () => {
    expect(sampleSizeFor(1920, 1080, 48)).toEqual({ width: 48, height: 27 });
    expect(sampleSizeFor(1080, 1920, 48)).toEqual({ width: 27, height: 48 });
  });

  it('never returns a side below 8 px, however extreme the aspect ratio', () => {
    const size = sampleSizeFor(4096, 64, 48);
    expect(size.width).toBe(48);
    expect(size.height).toBeGreaterThanOrEqual(8);
  });

  it('falls back to 16:9 for nonsense input', () => {
    expect(sampleSizeFor(0, 0, 48)).toEqual({ width: 48, height: 27 });
  });
});

describe('sourceCropFor', () => {
  it('returns the full frame when nothing is cropped', () => {
    expect(sourceCropFor(1920, 1080, 960, 540, 'contain')).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(sourceCropFor(1920, 1080, 960, 540, 'cover')).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it('crops the sides for object-fit: cover with a taller box', () => {
    const crop = sourceCropFor(1920, 1080, 540, 960, 'cover');
    expect(crop.sw).toBe(1080 * (540 / 960));
    expect(crop.sh).toBe(1080);
    expect(crop.sx).toBeCloseTo((1920 - crop.sw) / 2, 5);
  });

  it('crops top and bottom for a wider box', () => {
    const crop = sourceCropFor(1080, 1920, 960, 540, 'cover');
    expect(crop.sw).toBe(1080);
    expect(crop.sh).toBeCloseTo(1080 / (960 / 540), 5);
    expect(crop.sy).toBeCloseTo((1920 - crop.sh) / 2, 5);
  });
});

describe('lumaProfile', () => {
  it('measures row and column luminance', () => {
    const data = makeImage(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const profile = lumaProfile(data, 4, 2);
    expect(profile.cols[0]).toBe(0);
    expect(profile.cols[3]).toBeCloseTo(255, 3);
    expect(profile.rows[0]).toBeCloseTo(127.5, 3);
  });
});

describe('detectInsets', () => {
  it('detects a letterboxed frame', () => {
    const width = 16;
    const height = 16;
    const data = makeImage(width, height, (_x, y) => (y < 4 || y > 11 ? [0, 0, 0] : [200, 120, 60]));
    const insets = detectInsets(lumaProfile(data, width, height), width, height);
    expect(insets).not.toBeNull();
    expect(insets.top).toBeCloseTo(5 / 16, 5);
    expect(insets.bottom).toBeCloseTo(5 / 16, 5);
    expect(insets.left).toBe(0);
  });

  it('detects pillarboxing', () => {
    const data = makeImage(16, 16, (x) => (x < 3 || x > 12 ? [0, 0, 0] : [90, 200, 90]));
    const insets = detectInsets(lumaProfile(data, 16, 16), 16, 16);
    expect(insets.left).toBeCloseTo(4 / 16, 5);
    expect(insets.right).toBeCloseTo(4 / 16, 5);
    expect(insets.top).toBe(0);
  });

  it('never crops a thick dark region away (the zone renderer must keep it dark)', () => {
    // Red / green / blue top row over a black frame - the pattern that used to be mistaken for
    // pillarboxing: the dark left and right thirds were cropped, the whole picture collapsed onto
    // the middle column and every zone came out green. The dark thirds are content, not bars.
    const width = 96;
    const height = 54;
    const data = makeImage(width, height, (x, y) => {
      const col = Math.floor((x * 3) / width);
      const row = Math.floor((y * 3) / height);
      if (row !== 0) return [0, 0, 0];
      return col === 0 ? [255, 0, 0] : col === 1 ? [0, 255, 0] : [0, 0, 255];
    });
    expect(detectInsets(lumaProfile(data, width, height), width, height)).toBeNull();
  });

  it('ignores an all dark frame (night scene, not bars)', () => {
    const data = makeImage(16, 16, () => [0, 0, 0]);
    expect(detectInsets(lumaProfile(data, 16, 16), 16, 16)).toBeNull();
  });

  it('ignores a bright frame without bars', () => {
    const data = makeImage(16, 16, () => [180, 180, 180]);
    const insets = detectInsets(lumaProfile(data, 16, 16), 16, 16);
    expect(insets).toBeNull();
  });

  it('uses a threshold that is clearly below mid grey', () => {
    expect(BAR_LUMA_THRESHOLD).toBeLessThan(64);
  });
});

describe('computeRegionColors', () => {
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };

  it('separates the four edge bands', () => {
    const width = 20;
    const height = 20;
    const data = makeImage(width, height, (x, y) => {
      if (y < 5) return [255, 0, 0];
      if (y >= 15) return [0, 255, 0];
      if (x < 5) return [0, 0, 255];
      if (x >= 15) return [255, 255, 0];
      return [40, 40, 40];
    });
    const result = computeRegionColors(data, width, height, insets, 0.25);
    // The top / bottom bands are pure colours, the side bands span the full height and
    // therefore also contain the red and green corners.
    expect(result.edges.top.r).toBeGreaterThan(200);
    expect(result.edges.top.g).toBeLessThan(40);
    expect(result.edges.top.b).toBeLessThan(40);
    expect(result.edges.bottom.g).toBeGreaterThan(200);
    expect(result.edges.bottom.r).toBeLessThan(40);
    expect(result.edges.left.b).toBeGreaterThan(150);
    expect(result.edges.left.b).toBeGreaterThan(result.edges.left.r);
    expect(result.edges.right.r).toBeGreaterThan(200);
    expect(result.edges.right.b).toBeLessThan(40);
    expect(result.bounds).toEqual({ x0: 0, y0: 0, x1: 20, y1: 20 });
  });

  it('respects the crop insets', () => {
    const width = 20;
    const height = 20;
    const data = makeImage(width, height, (_x, y) => (y < 5 ? [255, 255, 255] : [10, 10, 10]));
    const result = computeRegionColors(data, width, height, { top: 0.25, bottom: 0, left: 0, right: 0 }, 0.25);
    expect(result.bounds.y0).toBe(5);
    expect(result.global.r).toBeLessThan(40);
  });

  it('skips fully transparent pixels', () => {
    const width = 8;
    const height = 8;
    const data = makeImage(width, height, () => [255, 255, 255]);
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    const result = computeRegionColors(data, width, height, insets, 0.25);
    expect(result.global.r).toBe(0);
  });
});

describe('normalizeGrid / centreCells', () => {
  it('accepts a number or an object and defaults to 3x3', () => {
    expect(normalizeGrid(undefined)).toEqual({ rows: 3, cols: 3 });
    expect(normalizeGrid(4)).toEqual({ rows: 4, cols: 4 });
    expect(normalizeGrid({ rows: 3, cols: 4 })).toEqual({ rows: 3, cols: 4 });
  });

  it('marks the single middle cell of an odd grid', () => {
    expect([...centreCells(3)].sort()).toEqual([4]);
  });

  it('marks the middle four cells of an even grid', () => {
    expect([...centreCells(4)].sort((a, b) => a - b)).toEqual([5, 6, 9, 10]);
  });
});

/**
 * Spatial independence: these scenarios are the acceptance criteria for the zoned renderer
 * ("where it is bright, it is bright; where it is dark, it is dark"). They run on the real
 * sampling code, on a 3x3 grid, and only look at the zone statistics.
 */
describe('computeRegionColors zones', () => {
  const size = 30;
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const grid = 3;

  /** Cell colour helper: a 3x3 grid over a 30x30 buffer, 10 px per cell. */
  const cellImage = (colorOf, width = size, height = size) =>
    makeImage(width, height, (x, y) => colorOf(Math.floor((y / height) * 3), Math.floor((x / width) * 3)));

  const sample = (colorOf) => computeRegionColors(cellImage(colorOf), size, size, insets, 0.25, grid);
  const BLACK = [0, 0, 0];

  it('A: a fully black frame lights no zone at all', () => {
    const result = sample(() => BLACK);
    expect(result.zones).toHaveLength(9);
    for (const zone of result.zones) {
      expect(zoneLevel(zone)).toBe(0);
      expect(zoneIntensity(zoneLevel(zone), MAX_BLACK_CUT * 0.15, 0.72)).toBe(0);
    }
  });

  it('B: only the top left zone is red, every other zone stays black', () => {
    const result = sample((row, col) => (row === 0 && col === 0 ? [255, 0, 0] : BLACK));
    expect(result.zones[0].r).toBe(255);
    expect(result.zones[0].g).toBe(0);
    for (const index of [1, 2, 5, 8]) expect(result.zones[index]).toEqual({ r: 0, g: 0, b: 0 });
    // Averaging the frame into one colour would give a much dimmer red (about a third here);
    // the zone keeps the full brightness of the region.
    expect(result.global.r).toBeLessThan(200);
    expect(result.zones[0].r).toBeGreaterThan(result.global.r + 80);
  });

  it('C: only the top right zone is blue', () => {
    const result = sample((row, col) => (row === 0 && col === 2 ? [0, 0, 255] : BLACK));
    expect(result.zones[2].b).toBe(255);
    expect(result.zones[2].r).toBe(0);
    for (const index of [0, 1, 8]) expect(result.zones[index]).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('D: left red / right blue / middle black, with no cross pollution', () => {
    const result = sample((_row, col) => (col === 0 ? [255, 0, 0] : col === 2 ? [0, 0, 255] : BLACK));
    for (const index of [0, 3, 6]) {
      expect(result.zones[index].r).toBe(255);
      expect(result.zones[index].b).toBe(0);
    }
    for (const index of [2, 5, 8]) {
      expect(result.zones[index].b).toBe(255);
      expect(result.zones[index].r).toBe(0);
    }
    // The middle column is genuinely black: neither red nor blue bled into it.
    for (const index of [1, 4, 7]) expect(result.zones[index]).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('E: a white top row and a black bottom row stay independent', () => {
    const result = sample((row) => (row === 0 ? [255, 255, 255] : BLACK));
    for (const index of [0, 1, 2]) expect(result.zones[index]).toEqual({ r: 255, g: 255, b: 255 });
    for (const index of [6, 7, 8]) expect(result.zones[index]).toEqual({ r: 0, g: 0, b: 0 });
    expect(zoneIntensity(zoneLevel(result.zones[1]), MAX_BLACK_CUT * 0.15, 0.72)).toBeCloseTo(1, 2);
    expect(zoneIntensity(zoneLevel(result.zones[7]), MAX_BLACK_CUT * 0.15, 0.72)).toBe(0);
  });

  it('F: a fully white frame lights every zone evenly', () => {
    const result = sample(() => [255, 255, 255]);
    for (const zone of result.zones) expect(zone).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('G: red / green / blue keep their own colour instead of averaging to grey', () => {
    const result = sample((row, col) => {
      if (row !== 0) return BLACK;
      if (col === 0) return [255, 0, 0];
      if (col === 1) return [0, 255, 0];
      return [0, 0, 255];
    });
    expect(result.zones[0]).toEqual({ r: 255, g: 0, b: 0 });
    expect(result.zones[1]).toEqual({ r: 0, g: 255, b: 0 });
    expect(result.zones[2]).toEqual({ r: 0, g: 0, b: 255 });
    // A global average would be grey-ish; the zones must not be.
    expect(result.zones[0].g).toBe(0);
    expect(result.zones[2].r).toBe(0);
  });

  it('honours the cropping insets when building the zones', () => {
    const data = makeImage(size, size, (_x, y) => (y < 10 ? [255, 255, 255] : BLACK));
    const result = computeRegionColors(data, size, size, { top: 1 / 3, bottom: 0, left: 0, right: 0 }, 0.25, grid);
    expect(result.zones[0]).toEqual({ r: 0, g: 0, b: 0 });
  });
});

/**
 * Resolution / quality adaptivity.
 *
 * Douyin switches the stream (360p -> 720p -> 1080p, or a whole new source) on the same <video>
 * element. These tests drive the *real* ColorSampler through a stand-in canvas so the whole
 * read-back path runs: drawImage -> getImageData -> insets -> zones.
 *
 * The contract they lock down:
 *   1. the sampling buffer size comes from the aspect ratio only, so the per sample cost never
 *      follows the source resolution,
 *   2. the same picture gives the same zone colours at every resolution,
 *   3. a `videoWidth === 0` moment is "no frame yet", not a crash and not a reset.
 */
describe('ColorSampler resolution adaptivity', () => {
  const RECT = { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 };
  const BLACK = [0, 0, 0];

  /**
   * A stand-in for `<video>` + a 2d canvas. `scene(nx, ny)` returns the colour of the source at
   * normalised coordinates, and `getImageData` synthesises exactly what a real drawImage +
   * downscale would have produced, so the same scene can be sampled at any resolution.
   */
  function makeDocument() {
    // The canvas reproduces whatever element was handed to `drawImage`, which lets one document
    // (and therefore one sampler canvas) serve many sources - exactly what a quality switch on a
    // reused <video> element looks like.
    let drawn = null;
    const ctx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage(element, sx, sy, sw, sh) {
        drawn = { element, sx, sy, sw, sh };
      },
      getImageData(_x, _y, w, h) {
        const source = drawn;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // The decoded picture is always `videoWidth` x `videoHeight` of the element.
            const nx = (source.sx + ((x + 0.5) / w) * source.sw) / source.element.videoWidth;
            const ny = (source.sy + ((y + 0.5) / h) * source.sh) / source.element.videoHeight;
            const [r, g, b] = source.element.__scene(nx, ny);
            const index = (y * w + x) * 4;
            data[index] = r;
            data[index + 1] = g;
            data[index + 2] = b;
            data[index + 3] = 255;
          }
        }
        return { data, width: w, height: h };
      },
    };
    const canvas = { width: 0, height: 0, getContext: () => ctx };
    const doc = { createElement: () => canvas };
    canvas.ownerDocument = doc;
    return doc;
  }

  function fakeSource({ width, height, scene, src = 'https://cdn.example/stream.mp4', doc = null }) {
    const owner = doc ?? makeDocument();
    const element = {
      ownerDocument: owner,
      currentSrc: src,
      readyState: 4,
      isConnected: true,
      videoWidth: width,
      videoHeight: height,
      getBoundingClientRect: () => ({ ...RECT }),
      __scene: scene,
    };
    return { element, doc: owner };
  }

  /** Top left red, top right blue, everything else black - in *normalised* coordinates. */
  const PATTERN = (nx, ny) => {
    const row = Math.floor(ny * 3);
    const col = Math.floor(nx * 3);
    if (row === 0 && col === 0) return [255, 0, 0];
    if (row === 0 && col === 2) return [0, 0, 255];
    return BLACK;
  };

  const samplerFor = (options) => new ColorSampler({ detectBars: true, ...options });
  const assertPattern = (state) => {
    expect(state.zones).toHaveLength(9);
    expect(state.zones[0]).toEqual({ r: 255, g: 0, b: 0 });
    expect(state.zones[2]).toEqual({ r: 0, g: 0, b: 255 });
    for (const index of [1, 6, 7, 8]) expect(state.zones[index]).toEqual({ r: 0, g: 0, b: 0 });
  };

  it('A: samples a 640x360 stream', () => {
    const env = fakeSource({ width: 640, height: 360, scene: PATTERN });
    const sampler = samplerFor({});
    const state = sampler.sample(env.element, RECT);
    assertPattern(state);
    expect(sampler.buffer).toEqual({ width: 96, height: 54 });
    expect(sampler.media).toEqual({ width: 640, height: 360 });
  });

  it('B: samples a 1280x720 stream', () => {
    const env = fakeSource({ width: 1280, height: 720, scene: PATTERN });
    const sampler = samplerFor({});
    const state = sampler.sample(env.element, RECT);
    assertPattern(state);
    expect(sampler.buffer).toEqual({ width: 96, height: 54 });
  });

  it('C: samples a 1920x1080 stream', () => {
    const env = fakeSource({ width: 1920, height: 1080, scene: PATTERN });
    const sampler = samplerFor({});
    const state = sampler.sample(env.element, RECT);
    assertPattern(state);
    expect(sampler.buffer).toEqual({ width: 96, height: 54 });
  });

  it('keeps the working resolution (and therefore the cost) identical at 360p / 720p / 1080p', () => {
    const sizes = [
      [640, 360],
      [1280, 720],
      [1920, 1080],
    ];
    const buffers = sizes.map(([width, height]) => {
      const env = fakeSource({ width, height, scene: PATTERN });
      const sampler = samplerFor({});
      sampler.sample(env.element, RECT);
      return sampler.buffer;
    });
    expect(buffers[0]).toEqual(buffers[1]);
    expect(buffers[1]).toEqual(buffers[2]);
    // 96x54 = 5184 pixels read per sample, whatever the source is.
    expect(buffers[0].width * buffers[0].height).toBe(96 * 54);
    expect(buffers[0].width).toBe(DEFAULT_MAX_SIDE);
  });

  it('keeps the same zone colours in portrait media (720x1280)', () => {
    const env = fakeSource({ width: 720, height: 1280, scene: PATTERN });
    const sampler = samplerFor({});
    const state = sampler.sample(env.element, { ...RECT, width: 360, height: 640 });
    assertPattern(state);
    expect(sampler.buffer).toEqual({ width: 54, height: 96 });
  });

  it('D: 640x360 -> 1920x1080 rebuilds the mapping without a new canvas', () => {
    const sampler = samplerFor({});
    const small = fakeSource({ width: 640, height: 360, scene: PATTERN, src: 'https://cdn.example/360.mp4' });
    sampler.sample(small.element, RECT);
    const canvas = sampler.canvas;
    expect(sampler.canvas.width).toBe(96);

    // Quality switch on the same element: higher resolution, same document, same picture.
    const big = fakeSource({
      width: 1920,
      height: 1080,
      scene: PATTERN,
      src: 'https://cdn.example/1080.mp4',
      doc: small.doc,
    });
    const state = sampler.sample(big.element, RECT);

    assertPattern(state);
    expect(sampler.canvas).toBe(canvas); // nothing was recreated
    expect(sampler.canvas.width).toBe(96); // the working buffer did not grow
    expect(sampler.media).toEqual({ width: 1920, height: 1080 });
    expect(sampler.resolutionChanges).toBe(1);
  });

  it('E: 1920x1080 -> 1280x720 keeps the zones intact', () => {
    const sampler = samplerFor({});
    sampler.sample(fakeSource({ width: 1920, height: 1080, scene: PATTERN, src: 'a' }).element, RECT);
    const state = sampler.sample(fakeSource({ width: 1280, height: 720, scene: PATTERN, src: 'b' }).element, RECT);
    assertPattern(state);
    expect(sampler.buffer).toEqual({ width: 96, height: 54 });
    expect(sampler.resolutionChanges).toBe(1);
    expect(sampler.media).toEqual({ width: 1280, height: 720 });
  });

  it('F: a transient videoWidth of 0 is "no frame yet", never a crash or a reset', () => {
    const sampler = samplerFor({});
    const env = fakeSource({ width: 1920, height: 1080, scene: PATTERN });
    sampler.sample(env.element, RECT);
    const before = sampler.media;

    env.element.videoWidth = 0;
    env.element.videoHeight = 0;
    expect(sampler.sample(env.element, RECT)).toBeNull();
    env.element.readyState = 0;
    expect(sampler.sample(env.element, RECT)).toBeNull();

    // The last valid state survives, so diagnostics and the halo keep a sane resolution.
    expect(sampler.media).toEqual(before);
    expect(sampler.resolutionChanges).toBe(0);

    // ... and the stream comes back at a different resolution.
    env.element.readyState = 4;
    env.element.videoWidth = 1280;
    env.element.videoHeight = 720;
    assertPattern(sampler.sample(env.element, RECT));
    expect(sampler.resolutionChanges).toBe(1);
    expect(sampler.media).toEqual({ width: 1280, height: 720 });
  });

  it('G: the same picture keeps its zones at every resolution', () => {
    const at = (width, height) => {
      const env = fakeSource({ width, height, scene: PATTERN });
      return samplerFor({}).sample(env.element, RECT).zones;
    };
    const small = at(640, 360);
    const medium = at(1280, 720);
    const large = at(1920, 1080);
    expect(medium).toEqual(small);
    expect(large).toEqual(small);
  });

  it('does not count a change when nothing changed', () => {
    const sampler = samplerFor({});
    const env = fakeSource({ width: 1280, height: 720, scene: PATTERN });
    sampler.sample(env.element, RECT);
    sampler.sample(env.element, RECT);
    sampler.sample(env.element, RECT);
    expect(sampler.resolutionChanges).toBe(0);
    expect(sampler.sampleCount).toBe(3);
  });

  it('restarts the black bar detection after a resolution change', () => {
    const sampler = samplerFor({});
    const small = fakeSource({ width: 640, height: 360, scene: PATTERN });
    sampler.sample(small.element, RECT);
    sampler.sample(small.element, RECT); // two agreeing samples settle the insets
    const settled = sampler.insets;
    const big = fakeSource({ width: 1920, height: 1080, scene: PATTERN, src: 'other' });
    sampler.sample(big.element, RECT);
    expect(sampler.pendingInsets).not.toBeNull();
    expect(sampler.insets).toEqual(settled);
  });
});
