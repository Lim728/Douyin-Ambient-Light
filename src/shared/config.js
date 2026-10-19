/**
 * Central configuration for the Douyin ambient light extension.
 *
 * Everything that the user can tune lives here: the defaults, the value ranges and the
 * metadata that the popup / options page use to render their controls. Keeping a single
 * source of truth avoids the classic "setting exists in the UI but not in the content
 * script" drift.
 */

/** Key used inside `chrome.storage.sync`. */
export const STORAGE_KEY = 'settings';

/** Bumped whenever the shape of the stored object changes in an incompatible way. */
export const SETTINGS_VERSION = 1;

/**
 * Selectable colour sampling rates (frames per second).
 *
 * 60 is offered on purpose: one sample is a `drawImage` of the already decoded frame into a
 * ~96x54 buffer plus a few thousand additions, so a full 60 Hz pass is still far cheaper than
 * the blur the compositor applies afterwards. A 1080p source does not change that cost: the
 * sampling buffer is sized from the aspect ratio only, so 60 fps stays affordable.
 */
export const SAMPLING_FPS_CHOICES = Object.freeze([5, 8, 10, 12, 15, 20, 30, 60]);

/**
 * Default number of sampling zones per axis. 3 means a 3x3 grid: eight glowing zones around
 * the player plus the centre cell that sits behind the video and is never rendered.
 */
export const DEFAULT_ZONE_GRID = 3;

/** Selectable sampling grids (zones per axis). */
export const ZONE_GRID_CHOICES = Object.freeze([
  { value: 3, label: '3 × 3（9 分区 · 推荐）' },
  { value: 4, label: '4 × 4（16 分区 · 更精细）' },
]);

/**
 * Where the glow layer lives. `overlay` is the default because it cannot be hidden by the
 * host page: the layer is painted on top of everything, with the video rectangle punched
 * out, so the player is never covered and the glow is always visible.
 */
export const LAYER_MODE_CHOICES = Object.freeze([
  { value: 'overlay', label: '强制覆盖（推荐，必定可见）' },
  { value: 'background', label: '页面背景（z-index:-1）' },
]);

/**
 * Default values. They are tuned for "clearly visible but not harsh, cinema like":
 * a wide, soft, slightly saturated halo that follows dark scenes down instead of
 * flooding the page with a bright rectangle.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  // 0-100, relative blur radius of the glow.
  blur: 62,
  // 0-200 %, overall opacity of the glow layer.
  intensity: 110,
  // 0-200 %, chroma boost applied to the sampled colours.
  saturation: 125,
  // 0-200 %, luminance boost applied to the sampled colours.
  brightness: 104,
  // 0-100, how far the halo reaches beyond the video edges.
  spread: 62,
  // 0-100, temporal interpolation. Higher = slower, smoother colour transitions.
  smoothness: 72,
  // One of SAMPLING_FPS_CHOICES.
  samplingFps: 12,
  // Paint the sampled colour across the whole page background, not only around the video.
  fullPageBackground: true,
  // Paint the backgrounds that sit behind the video pure black (#000000). Off by default:
  // Like the separate image option, it defaults off so an existing install
  // keeps exactly the look it had until the user opts in.
  pureBlackBackground: false,
  imageBlackBackground: false,
  // 0-100, weight of the four edge bands relative to the whole frame average.
  // Reused by the zoned renderer as the "zone contrast": how aggressively zones that carry
  // little light are suppressed (0 = every zone glows, 100 = only the brightest zones do).
  edgeFocus: 72,
  // Page background behind the glow.
  backgroundColor: '#0b0b10',
  // Make the video's ancestors transparent so the glow behind the page becomes visible.
  transparentAncestors: true,
  // Crop baked in black bars (letterbox / pillarbox) before sampling.
  detectBakedInBars: true,
  // Drop the sampling rate to idleSamplingFps while the video is paused / buffering.
  idleThrottle: true,
  // Idle sampling rate (fps) used while paused.
  idleSamplingFps: 2,
  // Patch <video> elements so Douyin's CDN frames can be read back from a canvas.
  corsCompat: true,
  // How the glow layer is attached to the page:
  //  - 'overlay'    : a fixed layer *above* the page whose centre is punched out exactly
  //                   where the video is. Always visible, even when Douyin paints opaque
  //                   containers (or transformed / stacking-context wrappers) behind the
  //                   player - which is what made the old z-index:-1 layer invisible.
  //  - 'background' : the original z-index:-1 layer plus transparent video ancestors.
  layerMode: 'overlay',
  // Colour used when the video pixels cannot be read at all (cross-origin, no CORS).
  fallbackColor: '#3a5a8c',
  // Debug: ignore the video entirely and paint a fixed colour (renderer smoke test).
  debugForce: false,
  debugColor: '#ff0000',
  // Zones per axis used by the sampler and the renderer (3 = 3x3, 4 = 4x4).
  zoneGrid: DEFAULT_ZONE_GRID,
  // 0-100, light level below which a zone is treated as black and stops glowing.
  blackThreshold: 15,
});

/** Hard limits used by `normalizeSettings`. */
const RANGES = Object.freeze({
  blur: [0, 100],
  intensity: [0, 200],
  saturation: [0, 200],
  brightness: [0, 200],
  spread: [0, 100],
  smoothness: [0, 100],
  edgeFocus: [0, 100],
  blackThreshold: [0, 100],
  idleSamplingFps: [1, 10],
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** `#rgb`, `#rrggbb` or `#rrggbbaa` -> `#rrggbb`. Returns the fallback when invalid. */
export function normalizeHexColor(value, fallback = /** @type {string} */ (DEFAULTS.backgroundColor)) {
  if (typeof value !== 'string') return fallback;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return fallback;
  let hex = match[1];
  if (hex.length === 8) hex = hex.slice(0, 6); // drop the alpha channel
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return '#' + hex.toLowerCase();
}

/**
 * Coerces arbitrary stored data into a valid settings object.
 * Unknown keys are dropped, missing / broken values fall back to the defaults.
 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  /** @type {Record<string, any>} */
  const out = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const fallback = DEFAULTS[key];
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      else if (value === 'true' || value === 1) out[key] = true;
      else if (value === 'false' || value === 0) out[key] = false;
    } else if (typeof fallback === 'number') {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string') out[key] = value;
    }
  }

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    out[key] = clamp(Math.round(out[key]), min, max);
  }

  out.samplingFps = SAMPLING_FPS_CHOICES.includes(Number(out.samplingFps))
    ? Number(out.samplingFps)
    : DEFAULTS.samplingFps;
  out.layerMode = LAYER_MODE_CHOICES.some((choice) => choice.value === out.layerMode)
    ? out.layerMode
    : DEFAULTS.layerMode;
  out.zoneGrid = ZONE_GRID_CHOICES.some((choice) => choice.value === Number(out.zoneGrid))
    ? Number(out.zoneGrid)
    : DEFAULTS.zoneGrid;
  out.backgroundColor = normalizeHexColor(out.backgroundColor);
  out.fallbackColor = normalizeHexColor(out.fallbackColor, DEFAULTS.fallbackColor);
  out.debugColor = normalizeHexColor(out.debugColor, DEFAULTS.debugColor);

  return out;
}

/** True when two settings objects are equal. Used to skip redundant re-renders. */
export function settingsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(DEFAULTS);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** One click presets offered in the options page. */
export const PRESETS = Object.freeze({
  cinema: {
    label: '影院',
    description: '柔和、宽范围，默认推荐',
    values: { ...DEFAULTS },
  },
  vivid: {
    label: '浓郁',
    description: '更高饱和度与强度，色彩更抢眼',
    values: {
      blur: 48,
      intensity: 165,
      saturation: 185,
      brightness: 108,
      spread: 74,
      smoothness: 55,
      edgeFocus: 84,
    },
  },
  subtle: {
    label: '轻淡',
    description: '几乎注意不到，只做轻微溢色',
    values: {
      blur: 74,
      intensity: 62,
      saturation: 95,
      brightness: 96,
      spread: 46,
      smoothness: 84,
      edgeFocus: 55,
      fullPageBackground: false,
    },
  },
  performance: {
    label: '省电',
    description: '低采样率、低模糊，适合笔记本与低配设备',
    values: {
      blur: 44,
      intensity: 95,
      saturation: 110,
      brightness: 100,
      spread: 52,
      smoothness: 62,
      samplingFps: 5,
      idleThrottle: true,
    },
  },
});

/**
 * Declaration of every user facing option: used to build the options page and the popup
 * without duplicating labels and ranges in the markup.
 */
export const OPTION_SCHEMA = Object.freeze([
  { key: 'enabled', type: 'toggle', label: '启用氛围光', hint: '总开关，关闭后立即停止取色并还原页面' },
  {
    key: 'layerMode', type: 'select', label: '图层模式 Layer mode', options: LAYER_MODE_CHOICES,
    hint: '「强制覆盖」把光晕画在页面上层并把视频区域镂空，抖音的不透明容器 / 层叠上下文也无法遮住它',
  },
  {
    key: 'zoneGrid', type: 'select', label: '分区数量 Zones', options: ZONE_GRID_CHOICES,
    hint: '画面被划分成多少个独立采样区，每个分区单独取色、单独发光；分区越多越精细，开销也略高',
  },
  {
    key: 'blur', type: 'range', label: '模糊 Blur', min: 0, max: 100, step: 1, suffix: '',
    hint: '光晕的柔和程度，数值越大越像电影院的漫射光',
  },
  {
    key: 'intensity', type: 'range', label: '强度 Intensity', min: 0, max: 200, step: 1, suffix: '%',
    hint: '整体亮度，100% 为基准',
  },
  {
    key: 'spread', type: 'range', label: '扩散 Spread', min: 0, max: 100, step: 1, suffix: '',
    hint: '光晕向视频四周扩散的距离',
  },
  {
    key: 'saturation', type: 'range', label: '饱和度 Saturation', min: 0, max: 200, step: 1, suffix: '%',
    hint: '色彩浓度，100% 为原始画面',
  },
  {
    key: 'brightness', type: 'range', label: '亮度 Brightness', min: 0, max: 200, step: 1, suffix: '%',
    hint: '光晕的明暗，100% 为原始画面',
  },
  {
    key: 'smoothness', type: 'range', label: '平滑 Smoothness', min: 0, max: 100, step: 1, suffix: '',
    hint: '颜色跟随的缓冲时间，越大过渡越慢越柔和',
  },
  {
    key: 'edgeFocus', type: 'range', label: '分区对比 Zone contrast', min: 0, max: 100, step: 1, suffix: '',
    hint: '分区之间的明暗对比：越高，暗的分区越彻底熄灭（哪里亮就哪里亮）；越低越接近整屏统一发光',
  },
  {
    key: 'blackThreshold', type: 'range', label: '黑电平 Black level', min: 0, max: 100, step: 1, suffix: '',
    hint: '低于该亮度的分区视为纯黑，不发光（0 = 不熄灭任何分区，100 = 只有很亮的分区才发光）',
  },
  {
    key: 'samplingFps', type: 'select', label: '采样帧率 Sampling FPS', options: SAMPLING_FPS_CHOICES,
    hint: '每秒读取画面的次数，越低越省电',
  },
  { key: 'fullPageBackground', type: 'toggle', label: '全页背景 Full-page background', hint: '让氛围光铺满整个页面背景' },
  {
    key: 'pureBlackBackground', type: 'toggle', label: '视频背景黑色',
    hint: '把视频周围的背景刷成纯黑 #000000；关闭后恢复页面原本的背景（不是统一改成透明）',
  },
  { key: 'imageBlackBackground', type: 'toggle', label: '图片背景黑色', hint: '仅将已打开图文作品的图片浏览区域背景设为纯黑，关闭后恢复原样' },
  { key: 'idleThrottle', type: 'toggle', label: '暂停时降频', hint: '视频暂停或缓冲时降低采样频率' },
  { key: 'detectBakedInBars', type: 'toggle', label: '裁剪黑边', hint: '忽略视频内嵌的黑边，避免光晕发灰' },
  { key: 'transparentAncestors', type: 'toggle', label: '透传页面背景', hint: '把视频容器的背景设为透明，让光晕透出来' },
  { key: 'corsCompat', type: 'toggle', label: '兼容取色模式', hint: '让抖音 CDN 视频可以通过 Canvas 读取像素（关闭后可能无法取色）' },
  { key: 'backgroundColor', type: 'color', label: '背景底色', hint: '光晕之外的页面底色（页面背景模式）' },
  { key: 'fallbackColor', type: 'color', label: '取色失败底色 Fallback', hint: '浏览器禁止读取视频像素（CORS）时使用的环境光底色' },
  { key: 'debugForce', type: 'toggle', label: '调试：强制光晕 Debug / Force', hint: '忽略视频取色，直接用下面的调试颜色绘制光晕，用来验证渲染链路' },
  { key: 'debugColor', type: 'color', label: '调试颜色 Debug colour', hint: '调试模式的颜色：#ff0000 红色 / #0064ff 蓝色' },
]);
