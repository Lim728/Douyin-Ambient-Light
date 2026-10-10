/**
 * Ambient light renderer.
 *
 * Structure on the page (the light never covers the player itself):
 *
 *   div.dal-root (shadow host)   position: fixed, viewport sized
 *     canvas.dal-canvas            the halo, painted with one texel per sampling zone
 *     div.dal-noise                subtle dithering so dark gradients do not band
 *
 * The canvas backing store is intentionally tiny (longest side ~480 px) and is stretched to
 * the viewport by CSS: a Gaussian halo has no high frequency detail, so upscaling it costs
 * nothing and the per frame work stays proportional to the *glow*, not to the screen.
 *
 * How the glow is built (per frame, all in the small canvas):
 *   1. lattice   - a tiny (zones-per-axis) canvas holds one texel per sampling zone, i.e. the
 *                  top left of the video has its own colour, the bottom right its own, and so
 *                  on. Each texel's alpha is that zone's glow gain, so a black zone simply
 *                  contributes nothing and cannot be tinted by its brighter neighbours.
 *   2. levels    - the lattice is stamped `LEVEL_COUNT` times, growing outwards, with an alpha
 *                  ramp that decays towards the outside. Drawing the tiny lattice scaled up
 *                  with image smoothing is what gives the smooth spatial gradient.
 *   3. wash      - optional `fullPageBackground` wash: the same lattice stretched over the
 *                  whole page, masked by a radial falloff around the player.
 *   4. CSS filter- blur / saturate / brightness and the intensity live on the element, so the
 *                  final softening happens on the compositor instead of on the CPU.
 *   5. cutout    - in overlay mode the video rectangle is punched out with `destination-out`.
 *
 * The multi level projection is the technique used by "Ambient light for YouTube"
 * (github.com/WesselKroos/youtube-ambilight, MIT) and its Bilibili port
 * (github.com/Miruko2/bilibili-ambient-light, MIT). See THIRD-PARTY-NOTICES.md.
 */

import { MAX_BLACK_CUT, hexToRgb, rgba, zoneIntensity, zoneLevel } from '../shared/color.js';
import { DEFAULT_ZONE_GRID } from '../shared/config.js';
import { centreCells } from './color-sampler.js';
import { clamp } from '../shared/utils.js';

const ROOT_CLASS = 'dal-root';
const OVERLAY_CLASS = 'dal-root--overlay';
const CANVAS_CLASS = 'dal-canvas';
const NOISE_CLASS = 'dal-noise';


/**
 * z-index of the "force visible" layer. Kept below the maximum (2147483647) so a page that
 * pushes its own overlay to the very top still wins, but far above any player UI.
 */
const OVERLAY_Z_INDEX = '2147483000';

/** Width of the soft ramp around the punched out video rectangle, in CSS pixels. */
const HOLE_FEATHER_PX = 11;

/** Styles living inside the shadow root, so the host page cannot restyle the layer. */
const SHADOW_CSS = `
  :host { display: block; }
  .${CANVAS_CLASS} { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .${NOISE_CLASS} {
    position: absolute; inset: 0; display: block;
    background-repeat: repeat; background-size: 128px 128px;
    mix-blend-mode: overlay;
  }
`;

/** Longest side of the working canvas, in backing store pixels. */
const TARGET_LONG_SIDE = 480;
/** Number of lattice stamps used to build the falloff. More stamps = smoother ramp. */
const LEVEL_COUNT = 16;
/**
 * Peak alpha of a single stamp. A little higher than a pure "average" stamp would need,
 * because every zone is additionally scaled by its own glow gain (see zoneIntensity), so a
 * mid bright zone contributes roughly half of it.
 */
const LEVEL_ALPHA = 0.33;
/** Falloff exponent of the stamp alpha ramp. */
const LEVEL_FALLOFF = 2.6;
/** Extra softening applied by CSS, in CSS pixels, at blur = 100. */
const MAX_CSS_BLUR = 22;
const NOISE_TILE = 128;
const NOISE_OPACITY = 0.055;

/** Rendered picture rectangle (object-fit aware) of a video element. */
export function pictureRect(rect, videoWidth, videoHeight, objectFit = 'contain') {
  if (!rect) return null;
  if (!videoWidth || !videoHeight || objectFit !== 'contain') return { ...rect };
  const elementAspect = rect.width / rect.height;
  const videoAspect = videoWidth / videoHeight;
  if (!Number.isFinite(elementAspect) || elementAspect <= 0 || !Number.isFinite(videoAspect)) {
    return { ...rect };
  }
  let width;
  let height;
  if (videoAspect > elementAspect) {
    width = rect.width;
    height = rect.width / videoAspect;
  } else {
    height = rect.height;
    width = rect.height * videoAspect;
  }
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
    right: rect.left + (rect.width + width) / 2,
    bottom: rect.top + (rect.height + height) / 2,
  };
}

/** Generates a small dithering tile as a data URL (no bundled binary asset needed). */
export function createNoiseDataUrl(document, size = NOISE_TILE) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 90 + Math.random() * 76;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = Math.random() < 0.35 ? 255 : 0;
  }
  ctx.putImageData(image, 0, 0);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

export class AmbientRenderer {
  constructor(options = {}) {
    this.document = options.document ?? globalThis.document;
    this.window = options.window ?? this.document?.defaultView ?? globalThis;
    this.logger = options.logger ?? { warn: () => {} };

    /** `page` (default) or `preview` (absolute inside a host element). */
    this.mode = options.mode ?? 'page';
    /** Element whose box defines the render area; defaults to <html> (the viewport). */
    this.measureTarget = options.measureTarget ?? null;
    /** `overlay` paints above the page (video area punched out), `background` behind it. */
    this.layerMode = options.layerMode ?? 'overlay';
    this.settings = null;
    this.mounted = false;
    this.visible = false;
    this.root = null;
    this.shadow = null;
    this.canvas = null;
    this.ctx = null;
    this.noise = null;

    this.glow = null;
    this.glowCtx = null;
    /** Tiny (zones-per-axis) canvas holding one texel per sampling zone. */
    this.lattice = null;
    this.latticeCtx = null;
    /** Full size scratch canvas used by the `fullPageBackground` wash. */
    this.wash = null;
    this.washCtx = null;

    this.layout = { width: 0, height: 0, cssWidth: 0, cssHeight: 0, scale: 1 };
    this.layoutDirty = true;
    this.lastFrame = null;
  }

  // --------------------------------------------------------------- public API

  /** `true` when the layer is painted above the page instead of behind it. */
  get isOverlay() {
    return this.mode !== 'preview' && this.layerMode === 'overlay';
  }

  /** The canvas element that actually holds the glow (inside the shadow root). */
  get canvasElement() {
    return this.canvas;
  }

  setSettings(settings) {
    this.settings = settings;
    if (typeof settings.layerMode === 'string') this.layerMode = settings.layerMode;
    this.applyElementStyle();
    this.layoutDirty = true;
  }

  /**
   * Switches between `overlay` and `background`. The DOM is rebuilt because the stacking
   * position of the layer (and therefore its host element) changes with the mode.
   */
  setLayerMode(mode) {
    if (typeof mode !== 'string' || mode === this.layerMode) return false;
    this.layerMode = mode;
    // The host element and the z-index both depend on the mode, so drop the old DOM; the
    // adapter re-mounts it on its next update pass.
    if (this.root) this.destroy();
    return true;
  }

  /** Marks the cached viewport geometry as stale (resize, zoom, fullscreen change). */
  invalidate() {
    this.layoutDirty = true;
  }

  /**
   * Where the layer belongs in the document.
   *
   * Overlay mode is appended to <html> (as the last child) on purpose: a fixed element
   * inside a transformed / filtered / will-change ancestor stops being viewport relative,
   * and Douyin does use such wrappers. `background` mode stays inside <body> where the
   * transparent-ancestor trick can expose it.
   */
  defaultHost() {
    if (this.mode === 'preview') return this.measureTarget ?? this.document?.body ?? null;
    if (this.isOverlay) return this.document?.documentElement ?? this.document?.body ?? null;
    return this.document?.body ?? this.document?.documentElement ?? null;
  }

  /** Creates the DOM once; safe to call repeatedly. */
  mount(parent) {
    if (!this.root) this.build();
    const host = parent ?? this.defaultHost();
    if (!host || !this.root) return;
    if (this.mounted) {
      if (this.root.parentElement !== host) host.append(this.root);
      return;
    }
    // Overlay layers go last (on top of the page), background layers first.
    if (this.isOverlay) host.append(this.root);
    else host.insertBefore(this.root, host.firstChild);
    this.mounted = true;
    this.layoutDirty = true;
  }

  unmount() {
    if (this.root && this.root.parentElement) this.root.remove();
    this.mounted = false;
    this.visible = false;
    this.lastFrame = null;
  }

  setVisible(visible) {
    if (!this.root) return;
    this.visible = Boolean(visible);
    this.root.style.setProperty('display', this.visible ? 'block' : 'none', 'important');
  }

  destroy() {
    this.unmount();
    this.root = null;
    this.shadow = null;
    this.canvas = null;
    this.ctx = null;
    this.noise = null;
    this.glow = null;
    this.glowCtx = null;
    this.lattice = null;
    this.latticeCtx = null;
    this.wash = null;
    this.washCtx = null;
  }

  // --------------------------------------------------------------- internals

  build() {
    const root = this.document.createElement('div');
    root.className = this.isOverlay ? `${ROOT_CLASS} ${OVERLAY_CLASS}` : ROOT_CLASS;
    root.setAttribute('aria-hidden', 'true');
    // Styles are applied inline with `important` so the layer keeps its geometry no matter
    // what the host page (or a user stylesheet) does to divs and canvases. Inline
    // `!important` beats every page rule, which is why the layer cannot be hidden by
    // Douyin's CSS.
    setImportant(root, {
      position: this.mode === 'preview' ? 'absolute' : 'fixed',
      inset: '0',
      // Overlay: on top of everything (the video area is punched out, see punchHole()).
      // Background: behind every page box, above the page background.
      'z-index': this.mode === 'preview' ? '0' : this.isOverlay ? OVERLAY_Z_INDEX : '-1',
      display: 'none',
      visibility: 'visible',
      overflow: 'hidden',
      'pointer-events': 'none',
      'user-select': 'none',
      'clip-path': 'none',
      transform: 'none',
      opacity: '1',
      contain: 'layout style paint',
    });
    // The overlay is painted *over* the live page, so it must not paint a backdrop of its
    // own: an opaque root would hide the whole Douyin interface behind the glow. Only the
    // canvas (which is cleared and then filled with the halo) contributes pixels.
    if (this.isOverlay) root.style.setProperty('background', 'transparent', 'important');

    // Shadow DOM isolation: the page stylesheet cannot reach the canvas / noise layer, so
    // a rule like `canvas { display: none !important }` (or an aggressive reset) is inert.
    let shadow = root;
    if (typeof root.attachShadow === 'function') {
      try {
        shadow = root.attachShadow({ mode: 'open' });
        const style = this.document.createElement('style');
        style.textContent = SHADOW_CSS;
        shadow.append(style);
      } catch {
        shadow = root;
      }
    }
    this.shadow = shadow === root ? null : shadow;

    const canvas = this.document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    setImportant(canvas, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      'pointer-events': 'none',
      'will-change': 'filter',
    });
    this.ctx = canvas.getContext('2d', { alpha: true });

    const noise = this.document.createElement('div');
    noise.className = NOISE_CLASS;
    setImportant(noise, {
      position: 'absolute',
      inset: '0',
      display: 'block',
      'pointer-events': 'none',
      'background-repeat': 'repeat',
      'background-size': '128px 128px',
      'mix-blend-mode': 'overlay',
      opacity: String(NOISE_OPACITY),
    });
    const noiseUrl = createNoiseDataUrl(this.document);
    if (noiseUrl) noise.style.backgroundImage = `url("${noiseUrl}")`;

    shadow.append(canvas, noise);
    // The dither tile only makes sense when the canvas paints its own opaque backdrop; over
    // the live page it would add grain to Douyin's own UI.
    if (this.isOverlay) noise.style.setProperty('display', 'none', 'important');

    const glow = this.document.createElement('canvas');
    this.glowCtx = glow.getContext('2d', { alpha: true });
    const wash = this.document.createElement('canvas');
    this.washCtx = wash.getContext('2d', { alpha: true });
    const lattice = this.document.createElement('canvas');
    lattice.width = DEFAULT_ZONE_GRID;
    lattice.height = DEFAULT_ZONE_GRID;
    this.latticeCtx = lattice.getContext('2d', { alpha: true });

    this.root = root;
    this.canvas = canvas;
    this.noise = noise;
    this.glow = glow;
    this.wash = wash;
    this.lattice = lattice;

    // `setSettings` may have run before the layer existed; apply the current values now.
    this.applyElementStyle();
  }

  applyElementStyle() {
    if (!this.canvas || !this.settings) return;
    const { blur, saturation, brightness, intensity, backgroundColor } = this.settings;
    const cssBlur = (clamp(blur, 0, 100) / 100) * MAX_CSS_BLUR;
    const filters = [];
    if (cssBlur > 0.05) filters.push(`blur(${cssBlur.toFixed(2)}px)`);
    if (saturation !== 100) filters.push(`saturate(${clamp(saturation, 0, 200)}%)`);
    if (brightness !== 100) filters.push(`brightness(${clamp(brightness, 0, 200)}%)`);
    this.canvas.style.setProperty('filter', filters.join(' '), 'important');
    this.canvas.style.setProperty('opacity', String(clamp(intensity, 0, 200) / 100), 'important');
    // `--dal-bg` is consumed by both the layer and `html[data-dal='on']`, so it has to be
    // declared on the document element: a custom property set on a child never reaches up
    // to its ancestors. Overlay mode never touches the page, so the property is only
    // published for the `background` / `preview` modes.
    if (this.isOverlay) return;
    if (this.document?.documentElement) {
      this.document.documentElement.style.setProperty('--dal-bg', backgroundColor);
    }
    if (this.root) this.root.style.setProperty('--dal-bg', backgroundColor);
  }

  /** Recomputes the working canvas size. Returns true when it changed. */
  updateLayout() {
    const target = this.measureTarget ?? this.document.documentElement;
    const cssWidth = Math.max(1, target?.clientWidth || this.window?.innerWidth || 1280);
    const cssHeight = Math.max(1, target?.clientHeight || this.window?.innerHeight || 720);
    const scale = Math.min(1, TARGET_LONG_SIDE / Math.max(cssWidth, cssHeight));
    const width = Math.max(64, Math.round(cssWidth * scale));
    const height = Math.max(64, Math.round(cssHeight * scale));

    const changed =
      this.layout.width !== width ||
      this.layout.height !== height ||
      this.layout.cssWidth !== cssWidth ||
      this.layout.cssHeight !== cssHeight;

    this.layout = { width, height, cssWidth, cssHeight, scale: width / cssWidth };

    if (changed) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.glow.width = width;
      this.glow.height = height;
      this.wash.width = width;
      this.wash.height = height;
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'low';
    }
    this.layoutDirty = false;
    return changed;
  }

  /**
   * The zone colours that drive the halo.
   *
   * Normal frames carry an explicit `zones` array (one entry per sampling cell). When an older
   * / fallback state is passed in, a uniform lattice is synthesised from the frame average so
   * the renderer keeps working instead of throwing.
   */
  zonesFromState(colors) {
    const grid = colors?.grid ?? { rows: DEFAULT_ZONE_GRID, cols: DEFAULT_ZONE_GRID };
    const rows = Math.max(1, Math.round(grid.rows) || DEFAULT_ZONE_GRID);
    const cols = Math.max(1, Math.round(grid.cols) || DEFAULT_ZONE_GRID);
    const zones = colors?.zones;
    if (Array.isArray(zones) && zones.length === rows * cols) {
      return { zones, rows, cols };
    }
    const uniform = colors?.edgeAverage ?? colors?.global ?? { r: 0, g: 0, b: 0 };
    const fallback = new Array(rows * cols);
    for (let i = 0; i < fallback.length; i++) fallback[i] = { ...uniform };
    return { zones: fallback, rows, cols };
  }

  /**
   * Bakes the zone colours into the tiny lattice canvas: one texel per zone, with the texel
   * alpha set to that zone's glow gain.
   *
   * Dark zones get a near / exactly zero alpha, so when the lattice is stretched over the
   * video the dark regions simply stop contributing - no neighbour can tint them. The cells
   * behind the player are always transparent (their light would land on the video itself).
   * Upscaling this lattice with image smoothing is what produces the smooth spatial gradient.
   */
  buildLattice(rows, cols, zones) {
    const lattice = this.lattice;
    if (lattice.width !== cols || lattice.height !== rows) {
      lattice.width = cols;
      lattice.height = rows;
    }
    const ctx = this.latticeCtx;
    const image = ctx.createImageData(cols, rows);
    const cut = (clamp(this.settings?.blackThreshold ?? 0, 0, 100) / 100) * MAX_BLACK_CUT;
    const contrast = clamp(this.settings?.edgeFocus ?? 100, 0, 100) / 100;
    const centre = centreCells({ rows, cols });
    for (let index = 0; index < rows * cols; index++) {
      const zone = zones[index] ?? { r: 0, g: 0, b: 0 };
      const gain = centre.has(index) ? 0 : zoneIntensity(zoneLevel(zone), cut, contrast);
      const offset = index * 4;
      image.data[offset] = clamp(Math.round(zone.r), 0, 255);
      image.data[offset + 1] = clamp(Math.round(zone.g), 0, 255);
      image.data[offset + 2] = clamp(Math.round(zone.b), 0, 255);
      image.data[offset + 3] = Math.round(gain * 255);
    }
    ctx.putImageData(image, 0, 0);
  }

  /**
   * Optional `fullPageBackground` wash: the whole page is tinted with the same spatially
   * varying lattice (not with a single averaged colour), masked by a radial falloff so the
   * tint is strongest around the player and disappears towards the page corners.
   */
  drawWash(width, height, cx, cy, radius, minRadius, peak) {
    const wash = this.washCtx;
    wash.setTransform(1, 0, 0, 1, 0, 0);
    wash.globalCompositeOperation = 'source-over';
    wash.globalAlpha = 1;
    wash.clearRect(0, 0, width, height);
    wash.imageSmoothingEnabled = true;
    wash.imageSmoothingQuality = 'low';

    wash.globalAlpha = peak;
    wash.drawImage(this.lattice, 0, 0, width, height);
    wash.globalAlpha = 1;

    wash.globalCompositeOperation = 'destination-in';
    const mask = wash.createRadialGradient(cx, cy, Math.max(1, minRadius), cx, cy, Math.max(1, radius));
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    wash.fillStyle = mask;
    wash.fillRect(0, 0, width, height);
    wash.globalCompositeOperation = 'source-over';
  }

  /**
   * Renders one frame.
   * @param {object} frame
   * @param {object} frame.rect video element rect in CSS pixels
   * @param {number} frame.videoWidth
   * @param {number} frame.videoHeight
   * @param {string} frame.objectFit
   * @param {object} frame.colors smoothed colour state
   */
  render(frame) {
    if (!this.ctx || !this.settings || !this.visible) return;
    if (this.layoutDirty) this.updateLayout();

    const { width, height, scale } = this.layout;
    const ctx = this.ctx;
    const settings = this.settings;
    const picture = pictureRect(frame.rect, frame.videoWidth, frame.videoHeight, frame.objectFit);
    if (!picture || picture.width <= 0 || picture.height <= 0) return;

    const x = picture.left * scale;
    const y = picture.top * scale;
    const w = Math.max(2, picture.width * scale);
    const h = Math.max(2, picture.height * scale);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);

    // Background mode paints its own opaque backdrop; overlay mode must stay transparent so
    // the page under the layer keeps showing through.
    if (!this.isOverlay) {
      // `pureBlackBackground` overrides the backdrop colour so the halo sits on a black wall
      // (only meaningful here: in overlay mode the page itself is darkened by the adapter).
      const background = hexToRgb(settings.pureBlackBackground ? '#000000' : settings.backgroundColor);
      ctx.fillStyle = rgba(background, 1);
      ctx.fillRect(0, 0, width, height);
    }

    // One texel per sampling zone. Upscaling this lattice with image smoothing is what turns
    // the discrete zones into a smooth, spatially faithful gradient.
    const { zones, rows, cols } = this.zonesFromState(frame.colors);
    this.buildLattice(rows, cols, zones);

    if (settings.fullPageBackground) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const radius = Math.max(
        1,
        Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))
      );
      // Over the live page the wash has to stay subtle, otherwise it would tint Douyin's
      // whole interface instead of just lighting up the room around the player.
      const peak = this.isOverlay ? 0.34 : 0.55;
      this.drawWash(width, height, cx, cy, radius, Math.min(w, h) * 0.35, peak);
      ctx.drawImage(this.wash, 0, 0);
    }

    // Soft halo built from growing stamps of the zone lattice.
    const inflate = (clamp(settings.spread, 0, 100) / 100) * Math.min(width, height) * 0.55;
    const gctx = this.glowCtx;
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.globalCompositeOperation = 'source-over';
    gctx.globalAlpha = 1;
    gctx.clearRect(0, 0, width, height);
    gctx.imageSmoothingEnabled = true;
    gctx.imageSmoothingQuality = 'low';

    if (inflate > 0.5) {
      for (let level = LEVEL_COUNT - 1; level >= 0; level--) {
        const t = level / (LEVEL_COUNT - 1);
        const grow = inflate * t;
        gctx.globalAlpha = LEVEL_ALPHA * Math.pow(1 - t, LEVEL_FALLOFF);
        gctx.drawImage(this.lattice, x - grow, y - grow, w + grow * 2, h + grow * 2);
      }
    } else {
      gctx.globalAlpha = 1;
      gctx.drawImage(this.lattice, x, y, w, h);
    }
    gctx.globalAlpha = 1;
    ctx.drawImage(this.glow, 0, 0);

    if (this.isOverlay) this.punchHole(ctx, x, y, w, h, scale);

    this.lastFrame = { x, y, w, h, inflate };
  }

  /**
   * Cuts the video rectangle out of the finished frame (overlay mode only).
   *
   * The layer is painted on top of the page, so without this the blurred glow would also
   * cover the player. Destination-out with three concentric rings removes the light over
   * the picture itself (alpha 1) and fades it out over a short ramp around the edges, which
   * gives the "light bleeding onto the wall" look while guaranteeing that not a single
   * pixel is drawn on top of the video.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x video rect in backing store pixels
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} scale backing store pixels per CSS pixel
   */
  punchHole(ctx, x, y, w, h, scale) {
    const feather = Math.max(2, HOLE_FEATHER_PX * scale);
    const rings = [
      [feather, 0.4],
      [feather * 0.5, 0.65],
      [0, 1],
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (const [grow, alpha] of rings) {
      ctx.globalAlpha = alpha;
      ctx.fillRect(x - grow, y - grow, w + grow * 2, h + grow * 2);
    }
    ctx.restore();
  }
}

/** Assigns a map of CSS declarations with the `important` priority. */
function setImportant(element, declarations) {
  for (const [property, value] of Object.entries(declarations)) {
    element.style.setProperty(property, value, 'important');
  }
}
