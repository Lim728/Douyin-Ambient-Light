/**
 * Colour sampling.
 *
 * The video frame is drawn once into a very small canvas (longest side 48 px by default,
 * i.e. the same order of magnitude as the 32x18 / 48x27 grids suggested for this kind of
 * effect) and read back with a single `getImageData` call. Everything else - edge bands,
 * whole frame average, black bar detection - is plain arithmetic on that tiny buffer, which
 * keeps the per sample cost in the tens of microseconds range even for 4K sources.
 *
 * Only the *edges* of the picture matter for the halo, so the frame is split into four edge
 * bands plus a global average. Colours are averaged in linear light (see ../shared/color.js).
 *
 * Resolution adaptivity: the buffer is sized from the aspect ratio of `videoWidth` /
 * `videoHeight` (the real media resolution, never the CSS box), clamped to a fixed working size,
 * so a quality switch (360p -> 720p -> 1080p, or a source swap) never changes the cost. What the
 * switch *does* update is the source -> buffer mapping, the zone boundaries and the black bar
 * history, which are all recomputed on the next sample (see noteMedia).
 *
 * The general pipeline (downscale -> read pixels -> build a soft projection behind the
 * player) follows the approach of "Ambient light for YouTube" by Wessel Kroos (MIT) and its
 * Bilibili port by Miruko2 (MIT); see THIRD-PARTY-NOTICES.md.
 */

import { averageRgb, linearToSrgb, rgb, srgbToLinear } from '../shared/color.js';
import { DEFAULT_ZONE_GRID } from '../shared/config.js';
import { clamp } from '../shared/utils.js';

/**
 * Longest side of the sampling buffer, in pixels.
 *
 * The buffer size is derived from the *aspect ratio* only - never from the source resolution -
 * so one sample costs exactly the same for a 360p, a 720p and a 4K stream (96x54 = 5.2k pixels,
 * i.e. 576 pixels per zone in the default 3x3 grid). When Douyin switches quality the buffer
 * keeps its size; only the source -> buffer mapping and the zone boundaries are recomputed.
 */
export const DEFAULT_MAX_SIDE = 96;
/** Fraction of each dimension used as the edge band. */
export const EDGE_BAND_FRACTION = 0.26;
/** Luminance below which a row / column counts as "black bar". */
export const BAR_LUMA_THRESHOLD = 22;
/** Never crop more than this fraction of the frame on a single side. */
export const BAR_MAX_FRACTION = 0.35;

/** Normalises `{ rows, cols } | number | undefined` into a usable grid. */
export function normalizeGrid(grid) {
  if (grid && typeof grid === 'object') {
    const rows = clamp(Math.round(Number(grid.rows) || DEFAULT_ZONE_GRID), 1, 8);
    const cols = clamp(Math.round(Number(grid.cols) || DEFAULT_ZONE_GRID), 1, 8);
    return { rows, cols };
  }
  const side = clamp(Math.round(Number(grid) || DEFAULT_ZONE_GRID), 1, 8);
  return { rows: side, cols: side };
}

/** Index of the cell(s) that sit behind the video and are therefore never rendered. */
export function centreCells(grid) {
  const { rows, cols } = normalizeGrid(grid);
  const rowsIndex = rows % 2 === 1 ? [(rows - 1) / 2] : [rows / 2 - 1, rows / 2];
  const colsIndex = cols % 2 === 1 ? [(cols - 1) / 2] : [cols / 2 - 1, cols / 2];
  const set = new Set();
  for (const row of rowsIndex) for (const col of colsIndex) set.add(row * cols + col);
  return set;
}

/**
 * Row / column luminance profile of a raw RGBA buffer.
 * Exported for unit tests (pure arithmetic, no canvas involved).
 */
export function lumaProfile(data, width, height) {
  const rows = new Float64Array(height);
  const cols = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const index = rowOffset + x * 4;
      const value = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      cols[x] += value;
      rowSum += value;
    }
    rows[y] = rowSum / Math.max(1, width);
  }
  for (let x = 0; x < width; x++) cols[x] /= Math.max(1, height);
  return { rows, cols };
}

/**
 * Finds baked in black bars (letterbox / pillarbox) from the luma profile.
 * Returns fractional insets `{ top, bottom, left, right }` of the visible picture, or null
 * when the whole frame is dark (a night scene must not be mistaken for black bars).
 *
 * Mirrors the two-step guard used by the Bilibili ambient light extension: crop
 * symmetrically, ignore frames that are dark everywhere, and keep the previous result until
 * two consecutive detections agree (hysteresis is applied by the caller).
 *
 * A third guard is specific to the zoned renderer: a bar may not eat more than a quarter of the
 * frame on either side. Dark regions that are larger than that are treated as content, not as
 * bars - see the comment on `verticalBar` below.
 */
export function detectInsets(profile, width, height) {
  const { rows, cols } = profile;
  if (!rows.length || !cols.length) return null;

  const countSide = (values, fromEnd) => {
    const max = Math.floor(values.length * BAR_MAX_FRACTION);
    let n = 0;
    while (n < max && values[fromEnd ? values.length - 1 - n : n] < BAR_LUMA_THRESHOLD) n++;
    return { n, max };
  };

  const top = countSide(rows, false);
  const bottom = countSide(rows, true);
  const left = countSide(cols, false);
  const right = countSide(cols, true);

  // Frame dark everywhere -> nothing to learn about bars.
  const rowsAllDark = top.n >= top.max && bottom.n >= bottom.max;
  const colsAllDark = left.n >= left.max && right.n >= right.max;
  if (rowsAllDark || colsAllDark) return null;

  // Symmetric crop: a subtitle inside one bar must not shift the picture.
  const vertical = Math.min(top.n, bottom.n);
  const horizontal = Math.min(left.n, right.n);
  if (vertical === 0 && horizontal === 0) return null;

  // A real letterbox / pillarbox is a thin band. A dark *region* - a dark left third, a night scene
  // with a bright middle, the dark half of a split screen - is far more likely to be content than a
  // bar, and cropping it away would replace a genuinely black area by its bright neighbours, i.e.
  // exactly the "light where there is none" the zoned renderer must never produce. So a bar may not
  // eat more than a quarter of the frame; anything thicker is content. The 35% cap above is only a
  // safety net, this is the real test. (A 25% band is the last value still treated as a bar; a dark
  // third at 33% is already content.)
  const verticalBar = vertical > 0 && vertical <= height / 4;
  const horizontalBar = horizontal > 0 && horizontal <= width / 4;
  if (!verticalBar && !horizontalBar) return null;

  return {
    top: verticalBar ? (vertical + 1) / height : 0,
    bottom: verticalBar ? (vertical + 1) / height : 0,
    left: horizontalBar ? (horizontal + 1) / width : 0,
    right: horizontalBar ? (horizontal + 1) / width : 0,
  };
}

/**
 * Splits the (already cropped) region of a raw RGBA buffer into four edge bands plus a
 * global average. Pure function, exported for unit tests.
 *
 * @param {Uint8ClampedArray} data RGBA bytes
 * @param {number} width
 * @param {number} height
 * @param {{top:number,bottom:number,left:number,right:number}} insets fractional insets
 * @param {number} bandFraction
 * @param {{rows:number,cols:number}|number} [grid] zone grid, defaults to 3x3
 */
export function computeRegionColors(
  data,
  width,
  height,
  insets,
  bandFraction = EDGE_BAND_FRACTION,
  grid = DEFAULT_ZONE_GRID
) {
  const x0 = clamp(Math.round(insets.left * width), 0, width - 1);
  const x1 = clamp(width - Math.round(insets.right * width), x0 + 1, width);
  const y0 = clamp(Math.round(insets.top * height), 0, height - 1);
  const y1 = clamp(height - Math.round(insets.bottom * height), y0 + 1, height);

  const { rows, cols } = normalizeGrid(grid);

  const bandX = Math.max(1, Math.round((x1 - x0) * bandFraction));
  const bandY = Math.max(1, Math.round((y1 - y0) * bandFraction));

  const sums = {
    all: [0, 0, 0, 0],
    top: [0, 0, 0, 0],
    bottom: [0, 0, 0, 0],
    left: [0, 0, 0, 0],
    right: [0, 0, 0, 0],
  };

  const accumulate = (bucket, index) => {
    bucket[0] += srgbToLinear(data[index]);
    bucket[1] += srgbToLinear(data[index + 1]);
    bucket[2] += srgbToLinear(data[index + 2]);
    bucket[3] += 1;
  };

  for (let y = y0; y < y1; y++) {
    const inTopBand = y < y0 + bandY;
    const inBottomBand = y >= y1 - bandY;
    const rowOffset = y * width * 4;
    for (let x = x0; x < x1; x++) {
      const index = rowOffset + x * 4;
      if (data[index + 3] === 0) continue; // fully transparent pixels carry no colour
      accumulate(sums.all, index);
      if (inTopBand) accumulate(sums.top, index);
      if (inBottomBand) accumulate(sums.bottom, index);
      if (x < x0 + bandX) accumulate(sums.left, index);
      if (x >= x1 - bandX) accumulate(sums.right, index);
    }
  }

  /** @param {number[]} bucket accumulated `[r, g, b, count]` in linear light */
  const finish = (bucket) => {
    const count = bucket[3];
    if (count === 0) return rgb(0, 0, 0);
    return {
      r: linearToSrgb(bucket[0] / count),
      g: linearToSrgb(bucket[1] / count),
      b: linearToSrgb(bucket[2] / count),
    };
  };

  const edges = {
    top: finish(sums.top),
    bottom: finish(sums.bottom),
    left: finish(sums.left),
    right: finish(sums.right),
  };

  const global = finish(sums.all);
  const edgeAverage = averageRgb([edges.top, edges.bottom, edges.left, edges.right]);

  // Independent zones: every cell is averaged on its own, so a bright / coloured region can
  // never bleed into the statistics of a dark one. No global colour is used to render.
  const zoneBuckets = new Array(rows * cols);
  for (let i = 0; i < zoneBuckets.length; i++) zoneBuckets[i] = [0, 0, 0, 0];
  for (let row = 0; row < rows; row++) {
    const cy0 = y0 + Math.floor(((y1 - y0) * row) / rows);
    const cy1 = y0 + Math.floor(((y1 - y0) * (row + 1)) / rows);
    for (let col = 0; col < cols; col++) {
      const cx0 = x0 + Math.floor(((x1 - x0) * col) / cols);
      const cx1 = x0 + Math.floor(((x1 - x0) * (col + 1)) / cols);
      const bucket = zoneBuckets[row * cols + col];
      for (let y = cy0; y < cy1; y++) {
        const rowOffset = y * width * 4;
        for (let x = cx0; x < cx1; x++) {
          const index = rowOffset + x * 4;
          if (data[index + 3] === 0) continue;
          accumulate(bucket, index);
        }
      }
    }
  }
  const zones = zoneBuckets.map(finish);

  return {
    global,
    edges,
    edgeAverage,
    zones,
    grid: { rows, cols },
    bounds: { x0, y0, x1, y1 },
    band: { x: bandX, y: bandY },
  };
}

/**
 * Sampling buffer size for a given aspect ratio: longest side fixed, shortest >= 8 px.
 *
 * Deliberately ignores the absolute source resolution: 640x360, 1280x720 and 1920x1080 all map
 * to the same buffer, so a quality switch cannot make the per sample cost grow with the source.
 * Only the aspect ratio is honoured, which is what keeps the zone grid square-ish and the halo
 * mapping correct for portrait and ultra wide media alike.
 */
export function sampleSizeFor(videoWidth, videoHeight, maxSide = DEFAULT_MAX_SIDE) {
  const aspect = videoHeight > 0 ? videoWidth / videoHeight : 16 / 9;
  if (!Number.isFinite(aspect) || aspect <= 0) return { width: maxSide, height: Math.round(maxSide * 9 / 16) };
  if (aspect >= 1) {
    return { width: maxSide, height: Math.max(8, Math.round(maxSide / aspect)) };
  }
  return { width: Math.max(8, Math.round(maxSide * aspect)), height: maxSide };
}

/**
 * Cropping of the *source* frame needed to reproduce what `object-fit` shows on screen.
 * `contain` / `fill` / `none` show the whole frame, `cover` crops it.
 */
export function sourceCropFor(videoWidth, videoHeight, elementWidth, elementHeight, objectFit) {
  const full = { sx: 0, sy: 0, sw: videoWidth, sh: videoHeight };
  if (objectFit !== 'cover' || !elementWidth || !elementHeight) return full;
  const elementAspect = elementWidth / elementHeight;
  const videoAspect = videoWidth / videoHeight;
  if (!Number.isFinite(elementAspect) || elementAspect <= 0) return full;
  if (videoAspect > elementAspect) {
    // Video is wider than the box: the sides are cropped away.
    const sw = videoHeight * elementAspect;
    return { sx: (videoWidth - sw) / 2, sy: 0, sw, sh: videoHeight };
  }
  // Video is taller than the box: top and bottom are cropped away.
  const sh = videoWidth / elementAspect;
  return { sx: 0, sy: (videoHeight - sh) / 2, sw: videoWidth, sh };
}

/**
 * Normalises the drawable sources the sampler understands.
 * Videos must have data; canvases are always ready (used by the live preview in the options
 * page, which runs the real sampling + rendering pipeline on a generated animation).
 */
export function resolveFrame(source) {
  if (!source) return null;
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    if (!source.isConnected || source.readyState < 2) return null;
    if (!source.videoWidth || !source.videoHeight) return null;
    return { element: source, width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    if (!source.width || !source.height) return null;
    return { element: source, width: source.width, height: source.height };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    if (!source.complete || !source.naturalWidth) return null;
    return { element: source, width: source.naturalWidth, height: source.naturalHeight };
  }
  if (source.videoWidth && source.videoHeight && source.readyState >= 2) {
    return { element: source, width: source.videoWidth, height: source.videoHeight };
  }
  return null;
}

/** Samples colours from an HTMLVideoElement (or a canvas, see resolveFrame). */
export class ColorSampler {
  constructor(options = {}) {
    this.maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
    this.bandFraction = options.bandFraction ?? EDGE_BAND_FRACTION;
    this.detectBars = options.detectBars !== false;
    this.grid = normalizeGrid(options.zoneGrid ?? DEFAULT_ZONE_GRID);
    this.logger = options.logger ?? { warn: () => {}, info: () => {} };
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    /** Set when the browser refuses pixel read back (cross origin without CORS). */
    this.tainted = false;
    this.lastError = null;
    this.pendingInsets = null;
    this.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    this.sampleCount = 0;
    /** Last successful poster / cover sample, used when the video frame is unreadable. */
    this.posterState = null;
    this.posterRequestedFor = null;
    this.posterUrl = null;
    /**
     * Media resolution (`videoWidth` / `videoHeight`) of the last frame that could be read.
     * Kept across a transient `videoWidth === 0` so diagnostics and the halo keep a valid size.
     */
    this.media = null;
    /** `${width}x${height}` signature of the last frame, used to spot a quality switch. */
    this.mediaSignature = '';
    /** `currentSrc` of the last frame: swapping the stream must invalidate the per-picture caches. */
    this.sourceUrl = '';
    /** Size of the sampling buffer used by the last sample (stable across source resolutions). */
    this.buffer = null;
    /** How often the media resolution changed while this document was alive (diagnostics). */
    this.resolutionChanges = 0;
  }

  setOptions(options = {}) {
    if (typeof options.detectBars === 'boolean') this.detectBars = options.detectBars;
    if (typeof options.maxSide === 'number') this.maxSide = options.maxSide;
    if (options.zoneGrid !== undefined) this.grid = normalizeGrid(options.zoneGrid);
  }

  /** Forgets black bar state, e.g. when the video element changes. */
  reset() {
    this.pendingInsets = null;
    this.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    this.posterState = null;
    this.posterRequestedFor = null;
    this.posterUrl = null;
  }

  get status() {
    return {
      tainted: this.tainted,
      lastError: this.lastError,
      samples: this.sampleCount,
      posterUrl: this.posterUrl,
      hasPoster: Boolean(this.posterState),
      media: this.media ? `${this.media.width}x${this.media.height}` : null,
      buffer: this.buffer ? `${this.buffer.width}x${this.buffer.height}` : null,
      resolutionChanges: this.resolutionChanges,
      source: this.sourceUrl || null,
    };
  }

  /**
   * Records the media the sampler is looking at and reports whether it changed.
   *
   * Douyin switches quality on the *same* `<video>` element: `videoWidth` / `videoHeight` (and
   * often `currentSrc`) change while the element, the renderer and the shadow DOM all stay put.
   * Detecting that is all the adaptation that is needed - the buffer size is resolution
   * independent (see DEFAULT_MAX_SIDE), so the next `readFrame` automatically rebuilds the
   * source -> buffer mapping and the zone boundaries from the new dimensions.
   *
   * What must *not* survive a switch is the black bar history: those fractions were measured on
   * the previous picture and would crop the new one wrongly, so the two sample hysteresis is
   * restarted (the previous insets stay in place until two fresh detections agree). A source
   * swap additionally drops the cached poster colour, which belonged to the previous stream.
   *
   * @param {number} width `video.videoWidth`
   * @param {number} height `video.videoHeight`
   * @param {string} [sourceUrl] `video.currentSrc`
   * @returns {boolean} true when either the resolution or the source changed
   */
  noteMedia(width, height, sourceUrl = '') {
    const signature = `${width}x${height}`;
    const url = String(sourceUrl ?? '').slice(0, 200);
    if (signature === this.mediaSignature && url === this.sourceUrl) return false;

    // The very first frame only establishes the baseline: there is nothing to "switch" from yet,
    // so it must not be reported as a quality change.
    const first = this.mediaSignature === '';
    const resolutionChanged = !first && signature !== this.mediaSignature;
    const sourceChanged = url !== this.sourceUrl;
    this.mediaSignature = signature;
    this.sourceUrl = url;
    this.media = { width, height };
    if (resolutionChanged) this.resolutionChanges += 1;

    // Both caches describe the previous picture: re-detect the bars and re-read the poster.
    this.pendingInsets = null;
    if (sourceChanged) {
      this.posterState = null;
      this.posterRequestedFor = null;
    }
    return true;
  }

  ensureCanvas(document, width, height) {
    if (!this.canvas || this.canvas.ownerDocument !== document) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return this.ctx;
  }

  /**
   * Reads one frame and returns the colour state, or `null` when the frame cannot be read
   * (no data yet, cross origin pixels, detached element).
   */
  sample(source, elementRect) {
    const frame = resolveFrame(source);
    if (!frame) return null;
    return this.readFrame(frame.element, frame.width, frame.height, elementRect);
  }

  /**
   * Samples an already decoded `HTMLImageElement` (used for the poster / cover fallback
   * when the video pixels themselves cannot be read).
   */
  sampleImage(image) {
    if (!image) return null;
    const frame = resolveFrame(image);
    if (!frame) return null;
    return this.readFrame(image, frame.width, frame.height, null);
  }

  /**
   * Loads `video.poster` (the cover image the player already downloaded) and samples it
   * once. Posters often come from a different host than the video stream, so on some days
   * they are readable even when the video frame is not. Nothing here is required for the
   * extension to work: a failure simply leaves `posterState` empty.
   */
  requestPosterSample(video) {
    if (!video || this.posterRequestedFor === video) return;
    this.posterRequestedFor = video;
    this.posterState = null;
    const url = typeof video.poster === 'string' ? video.poster : '';
    if (!url || typeof Image !== 'function') return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      const state = this.sampleImage(image);
      if (state) {
        this.posterState = state;
        this.posterUrl = url;
      }
    };
    image.onerror = () => {
      this.posterState = null;
    };
    try {
      image.src = url;
    } catch {
      /* ignore */
    }
  }

  /** Shared pixel pipeline: draw -> getImageData -> edge bands. */
  readFrame(element, frameWidth, frameHeight, elementRect) {
    const document = element.ownerDocument ?? globalThis.document;
    const rect =
      elementRect ?? (typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null);
    const objectFit = rect
      ? (element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.objectFit ?? 'contain')
      : 'contain';

    const size = sampleSizeFor(frameWidth, frameHeight, this.maxSide);
    const ctx = this.ensureCanvas(document, size.width, size.height);
    if (!ctx) return null;

    // Note the media *before* reading it, so a quality switch is visible even on the very first
    // frame of the new stream. The buffer size does not depend on it (see DEFAULT_MAX_SIDE).
    this.buffer = { width: size.width, height: size.height };
    this.noteMedia(frameWidth, frameHeight, element.currentSrc || element.src || '');

    const crop = sourceCropFor(frameWidth, frameHeight, rect?.width ?? 0, rect?.height ?? 0, objectFit);

    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(element, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size.width, size.height);
    } catch (error) {
      this.lastError = error;
      this.tainted = true;
      this.logger.warn('drawImage failed, sampling disabled', error);
      return null;
    }

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, size.width, size.height);
    } catch (error) {
      // SecurityError: the video is cross origin and was not fetched with CORS.
      this.tainted = true;
      this.lastError = error;
      this.logger.warn('getImageData blocked (cross-origin video without CORS)', error);
      return null;
    }

    this.tainted = false;
    this.sampleCount++;

    const insets = this.resolveInsets(imageData, size);
    const regions = computeRegionColors(
      imageData.data,
      size.width,
      size.height,
      insets,
      this.bandFraction,
      this.grid
    );

    return {
      ...regions,
      insets,
      size,
      luma: (0.2126 * regions.global.r + 0.7152 * regions.global.g + 0.0722 * regions.global.b) / 255,
      timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    };
  }

  /** Applies black bar detection with a two sample hysteresis. */
  resolveInsets(imageData, size) {
    if (!this.detectBars) return { top: 0, bottom: 0, left: 0, right: 0 };
    const profile = lumaProfile(imageData.data, size.width, size.height);
    const next = detectInsets(profile, size.width, size.height) ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const pending = this.pendingInsets;
    const same =
      pending &&
      Math.abs(pending.top - next.top) < 1e-6 &&
      Math.abs(pending.bottom - next.bottom) < 1e-6 &&
      Math.abs(pending.left - next.left) < 1e-6 &&
      Math.abs(pending.right - next.right) < 1e-6;
    this.pendingInsets = next;
    if (same) this.insets = next;
    return this.insets;
  }
}
