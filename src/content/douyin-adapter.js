/**
 * Douyin (douyin.com) integration.
 *
 * Responsibilities:
 *  - react to the SPA: the feed mounts / unmounts players while the user scrolls, so the
 *    current video is re-detected on mutations, media events, resizes, fullscreen changes
 *    and on a slow safety poll,
 *  - keep the light behind the player by marking the video's ancestors as transparent
 *    (`data-dal-clear`) so the fixed glow layer, which sits at z-index -1, becomes visible,
 *  - move the glow layer into the fullscreen element when the user goes fullscreen,
 *  - expose a small status object for the popup.
 *
 * It never touches playback: no source rewriting, no seeking, no volume changes, no
 * network requests. The only page mutation is a set of `data-dal-*` attributes and inline
 * background overrides that are fully removed when the extension is switched off.
 */

import { ImageBackground, IMAGE_ROOT_SELECTOR } from './image-background.js';
import { PLAYER_CONTAINER_SELECTORS, findContainer, findVideos, selectBestVideo } from './video-detector.js';
import { createLogger, debounce, throttle } from '../shared/utils.js';

const POLL_INTERVAL_MS = 1500;
const MUTATION_DEBOUNCE_MS = 400;
const MEDIA_EVENT_DEBOUNCE_MS = 150;
const SCROLL_THROTTLE_MS = 80;

const CLEAR_ATTRIBUTE = 'data-dal-clear';
const ROOT_ATTRIBUTE = 'data-dal';
const MODE_ATTRIBUTE = 'data-dal-mode';
/**
 * Marker for the layer that is currently mounted. Kept separate from MARKER_ATTRIBUTE on
 * purpose: `applyRootState` runs on every update cycle while the JSON diagnostics are written
 * on a throttle, so a shared attribute would see-saw between `"overlay"` and the JSON snapshot.
 */
const LAYER_ATTRIBUTE = 'data-dal-layer';
/** Compact JSON snapshot of the runtime status, readable from the page / devtools. */
const MARKER_ATTRIBUTE = 'data-dal-status';

/** Elements whose background must stay opaque even if they are an ancestor of the video. */
const KEEP_OPAQUE = 'input,textarea,select,button,[role="dialog"]';

/** Marks an element whose background was darkened by the "pure black background" option. */
const INK_ATTRIBUTE = 'data-dal-ink';
/** Root marker published while the pure black background option is active (diagnostics). */
const BLACK_ATTRIBUTE = 'data-dal-black';

/** The exact colour written by the pure black option. */
const BLACK = '#000000';
/**
 * Every serialisation of "black" a browser may hand back for the value we wrote. Used on
 * restore to tell *our* override apart from a value the page wrote itself.
 */
const BLACK_VALUES = new Set(['#000', '#000000', 'black', 'rgb(0,0,0)', 'rgba(0,0,0,1)']);

/**
 * True only while `property` still carries the exact `!important` black that
 * `darkenElement` wrote. If the page replaced it in the meantime the extension must not
 * clobber that newer value with a stale snapshot.
 */
function holdsOwnedBlack(element, property) {
  if (element.style.getPropertyPriority(property) !== 'important') return false;
  const value = element.style.getPropertyValue(property).replace(/\s+/g, '').toLowerCase();
  return property === 'background-image' ? value === 'none' : BLACK_VALUES.has(value);
}

export class DouyinAmbientAdapter {
  constructor(dependencies) {
    this.controller = dependencies.controller;
    this.renderer = dependencies.renderer;
    this.settings = dependencies.settings;
    this.logger = dependencies.logger ?? createLogger('douyin');

    this.document = dependencies.document ?? globalThis.document;
    this.window = dependencies.window ?? this.document?.defaultView ?? globalThis;

    this.imageBackground = new ImageBackground(this.document);
    this.video = null;
    this.container = null;
    this.videoCount = 0;
    this.clearedElements = new Set();
    /**
     * `data-dal-ink` elements and the inline declarations they had before the pure black
     * option darkened them: `Map<Element, Map<property, { value, priority }>>`.
     */
    this.inkedElements = new Map();
    this.pageActive = false;
    this.mutationObserver = null;
    this.resizeObserver = null;
    this.pollTimer = 0;
    this.destroyed = false;

    this.scheduleUpdate = debounce(() => this.update('mutation'), MUTATION_DEBOUNCE_MS);
    this.scheduleMediaUpdate = debounce(() => this.update('media'), MEDIA_EVENT_DEBOUNCE_MS);
    this.handleScroll = throttle(() => {
      this.update('scroll');
      if (this.pageActive) this.controller.refreshGeometry();
    }, SCROLL_THROTTLE_MS);
  }

  // --------------------------------------------------------------- lifecycle

  init() {
    this.attachListeners();
    this.startObservers();
    this.pollTimer = setInterval(() => this.update('poll'), POLL_INTERVAL_MS);
    this.update('init');
    return this;
  }

  attachListeners() {
    // Media events do not bubble but do reach capture listeners on the document.
    for (const type of ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'loadeddata', 'emptied', 'waiting']) {
      this.document.addEventListener(type, this.scheduleMediaUpdate, true);
    }
    this.document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    this.document.addEventListener('webkitfullscreenchange', this.handleFullscreenChange);
    this.document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.window.addEventListener('popstate', this.handleNavigation);
    this.window.addEventListener('hashchange', this.handleNavigation);
    this.window.addEventListener('resize', this.handleResize, { passive: true });
    this.document.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });
  }

  detachListeners() {
    for (const type of ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'loadeddata', 'emptied', 'waiting']) {
      this.document.removeEventListener(type, this.scheduleMediaUpdate, true);
    }
    this.document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.document.removeEventListener('webkitfullscreenchange', this.handleFullscreenChange);
    this.document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.window.removeEventListener('popstate', this.handleNavigation);
    this.window.removeEventListener('hashchange', this.handleNavigation);
    this.window.removeEventListener('resize', this.handleResize);
    this.document.removeEventListener('scroll', this.handleScroll, true);
  }

  startObservers() {
    const target = this.document.documentElement;
    if (!target || typeof MutationObserver !== 'function') return;
    // Keep the global observation child-list-only. Image-specific attributes are
    // observed on the note subtree and its ancestors only while that option is on.
    this.mutationObserver = new MutationObserver((records) => {
      if (this.settings.imageBlackBackground) {
        this.observeImageRoots();
        this.imageBackground.sync(true);
      }
      if (records.some(record => record.type === 'childList')) this.scheduleUpdate();
    });
    this.observeImageRoots();

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.renderer.invalidate();
        this.controller.requestRender();
      });
      this.resizeObserver.observe(target);
    }
  }

  observeImageRoots() {
    if (!this.mutationObserver) return;
    const roots = this.settings.imageBlackBackground
      ? [...this.document.querySelectorAll(IMAGE_ROOT_SELECTOR)] : [];
    const targets = new Set();
    for (const root of roots) {
      for (let node = root; node && node !== this.document.documentElement; node = node.parentElement) targets.add(node);
    }
    const previous = this.imageObservationTargets;
    if (previous && previous.size === targets.size && [...targets].every(node => previous.has(node))) return;
    this.mutationObserver.disconnect();
    this.mutationObserver.observe(this.document.documentElement, { childList: true, subtree: true });
    for (const node of targets) {
      this.mutationObserver.observe(node, {
        attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'src'],
        subtree: roots.includes(node),
      });
    }
    this.imageObservationTargets = targets;
  }

  handleNavigation = () => this.update('navigation');

  handleResize = () => {
    this.renderer.invalidate();
    this.controller.requestRender();
    this.scheduleUpdate();
  };

  handleFullscreenChange = () => {
    this.reparentLayer();
    this.renderer.invalidate();
    this.controller.requestRender();
    this.scheduleUpdate();
  };

  handleVisibilityChange = () => {
    if (this.document.hidden) {
      this.controller.stop();
    } else if (this.video && this.settings.enabled && !this.video.paused) {
      this.controller.start();
      this.controller.requestRender();
    }
  };

  // --------------------------------------------------------------- detection

  /** Re-runs video detection and reconciles every bit of page state. */
  update(reason = 'manual') {
    if (this.destroyed) return;
    this.lastReason = reason;
    const settings = this.settings;
    this.observeImageRoots();
    this.imageBackground.sync(settings.imageBlackBackground);
    if (!settings.enabled && !settings.pureBlackBackground) {
      this.deactivate();
      return;
    }

    const viewportWidth = this.window.innerWidth || 1280;
    const viewportHeight = this.window.innerHeight || 720;
    const videos = findVideos(this.document);
    this.videoCount = videos.length;

    const best = selectBestVideo({
      root: this.document,
      videos,
      previous: this.video,
      viewportWidth,
      viewportHeight,
      fullscreenElement: this.fullscreenElement,
    });

    const video = best?.video ?? null;
    if (video !== this.video) {
      this.logger.debug('active video changed', reason, video ? describe(video) : 'none');
      this.video = video;
      this.container = video ? findContainer(video) : null;
      this.controller.setVideo(video);
      this.observeContainer();
    }
    // Re-run on every pass (not only when the video changes): Douyin reshuffles its wrappers
    // while the same <video> keeps playing, and a stale marker would either strand the page
    // in black or fail to cover a freshly inserted container.
    this.syncPageBackground();

    if (!video) {
      // Debug / force mode is also the smoke test for the renderer itself, so it has to
      // work on a page without any player: mount the layer around a synthetic rectangle.
      if (settings.debugForce) {
        this.controller.setVideo(null);
        this.activateDebugLayer();
        this.getStatus();
        return;
      }
      this.deactivate();
      return;
    }

    if (!settings.enabled) {
      this.stopGlow();
      this.syncPageBackground();
      return;
    }
    this.pageActive = true;
    this.applyRootState(true);
    this.reparentLayer();
    this.renderer.mount(this.layerHost());
    this.renderer.setVisible(true);
    // Profile detail overlays share a document with the header and grid. Bound the
    // composited layer (including CSS blur) to the actual video neighbourhood.
    const root = this.renderer.root;
    if (root) {
      if (this.isProfile && !this.fullscreenElement) {
        const rect = video.getBoundingClientRect();
        const margin = 24;
        root.style.setProperty('clip-path', `inset(${Math.max(0, rect.top - margin)}px ${Math.max(0, viewportWidth - rect.right - margin)}px ${Math.max(0, viewportHeight - rect.bottom - margin)}px ${Math.max(0, rect.left - margin)}px)`, 'important');
      } else root.style.removeProperty('clip-path');
    }

    if (video.paused || video.ended) {
      // The debug / force mode must keep painting even while the video is paused.
      if (settings.idleThrottle && !settings.debugForce) this.controller.stop();
      else this.controller.start();
      this.controller.requestRender();
    } else {
      this.controller.start();
    }

    // Mirror the status into the DOM so data-dal-status is always fresh (the probe and
    // the devtools inspector read it without opening the extension UI).
    this.getStatus();
  }

  observeContainer() {
    if (!this.resizeObserver) return;
    this.resizeObserver.disconnect();
    const target = this.document.documentElement;
    if (target) this.resizeObserver.observe(target);
    if (this.container && this.container !== this.document.documentElement) {
      this.resizeObserver.observe(this.container);
    }
  }

  /** Mounts the glow layer without a video (debug / force mode only). */
  activateDebugLayer() {
    this.pageActive = true;
    this.applyRootState(true);
    this.controller.setVirtualRect(this.debugRect());
    this.reparentLayer();
    this.renderer.mount(this.layerHost());
    this.renderer.setVisible(true);
    this.controller.start();
  }

  /** A centred rectangle used by the debug / force mode when no video exists. */
  debugRect() {
    const viewportWidth = this.window?.innerWidth || 1280;
    const viewportHeight = this.window?.innerHeight || 720;
    const width = Math.round(viewportWidth * 0.46);
    const height = Math.round(viewportHeight * 0.62);
    const left = Math.round((viewportWidth - width) / 2);
    const top = Math.round((viewportHeight - height) / 2);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  stopGlow() {
    this.pageActive = false;
    this.controller.stop();
    this.controller.setVirtualRect(null);
    this.renderer.setVisible(false);
    this.renderer.unmount();
    this.clearAncestors();
    this.applyRootState(false);
  }

  deactivate() {
    // Always empty the pure black overrides, even if the layer was never mounted: the option
    // can be flipped on a page that then loses its player, and the page must not stay black.
    this.clearBlackBackground();
    this.video = null;
    this.container = null;
    this.controller.setVideo(null);
    this.clearAncestors();
    this.applyRootState(false);
    if (!this.pageActive) return;
    this.pageActive = false;
    this.controller.setVirtualRect(null);
    this.controller.stop();
    this.renderer.setVisible(false);
    this.renderer.unmount();
    this.clearAncestors();
    this.applyRootState(false);
  }

  get fullscreenElement() {
    return this.document.fullscreenElement ?? this.document.webkitFullscreenElement ?? null;
  }

  /** `overlay` (paint above the page, video punched out) or `background` (z-index -1). */
  get layerMode() {
    return this.settings?.layerMode === 'background' ? 'background' : 'overlay';
  }

  /**
   * The element the glow layer is appended to.
   *
   * In overlay mode that is <html> itself: a `position: fixed` element stops being viewport
   * relative as soon as an ancestor has a transform / filter / will-change, and Douyin uses
   * such wrappers around its player. Fullscreen always wins, because only the fullscreen
   * element's subtree is painted in that mode.
   */
  layerHost() {
    const fullscreen = this.fullscreenElement;
    if (fullscreen && fullscreen !== this.document.body) return fullscreen;
    if (this.layerMode === 'overlay') return this.document.documentElement ?? this.document.body;
    return this.document.body ?? this.document.documentElement;
  }

  reparentLayer() {
    const host = this.layerHost();
    if (host) this.renderer.mount(host);
  }

  // --------------------------------------------------------------- page styling

  /**
   * Publishes the two markers the injected stylesheet reacts to. In overlay mode the page
   * itself is left completely alone (no background overrides at all); only the data
   * attributes are set, and they are removed again when the effect stops.
   */
  applyRootState(active) {
    const root = this.document.documentElement;
    if (!root) return;
    if (active) {
      root.setAttribute(ROOT_ATTRIBUTE, 'on');
      root.setAttribute(MODE_ATTRIBUTE, this.layerMode);
      root.setAttribute(LAYER_ATTRIBUTE, this.layerMode === 'overlay' ? 'overlay' : 'background');
      if (this.layerMode === 'background') {
        // The optional black background is scoped to the player separately.
        const background = this.settings.backgroundColor;
        root.style.setProperty('--dal-bg', background);
      } else {
        root.style.removeProperty('--dal-bg');
      }
    } else {
      root.removeAttribute(ROOT_ATTRIBUTE);
      root.removeAttribute(MODE_ATTRIBUTE);
      root.removeAttribute(LAYER_ATTRIBUTE);
      root.removeAttribute(MARKER_ATTRIBUTE);
      root.removeAttribute(BLACK_ATTRIBUTE);
      root.style.removeProperty('--dal-bg');
      this.clearAncestors();
    }
  }

  /**
   * Marks every ancestor of the video so the injected stylesheet can make it transparent.
   * Only ancestors up to <body> are touched, and only ones that would otherwise paint an
   * opaque background over the glow layer.
   */
  markAncestors() {
    const next = new Set();
    // Overlay mode paints on top of the page, so nothing has to be made transparent - and
    // nothing is modified either.
    if (this.layerMode !== 'background') {
      this.clearAncestors();
      return;
    }
    if (this.settings.transparentAncestors && this.video) {
      const stop = this.document.body ?? null;
      for (let node = this.video.parentElement; node && node !== stop; node = node.parentElement) {
        if (node.matches?.(KEEP_OPAQUE)) continue;
        next.add(node);
      }
    }
    for (const element of this.clearedElements) {
      if (!next.has(element)) element.removeAttribute(CLEAR_ATTRIBUTE);
    }
    for (const element of next) {
      if (!element.hasAttribute(CLEAR_ATTRIBUTE)) element.setAttribute(CLEAR_ATTRIBUTE, '1');
    }
    this.clearedElements = next;
  }

  clearAncestors() {
    for (const element of this.clearedElements) element.removeAttribute(CLEAR_ATTRIBUTE);
    this.clearedElements.clear();
  }

  /** Reconciles every page-background mechanism with the current video + settings. */
  get isProfile() {
    return /^\/user(?:\/|$)/.test(this.document.location?.pathname ?? '');
  }

  syncPageBackground() {
    if (this.isProfile || !this.settings.enabled || this.settings.pureBlackBackground) this.clearAncestors();
    else this.markAncestors();
    this.markBlackBackground();
  }

  // ------------------------------------------------------ pure black background

  /** Only the chain inside the bounded player; never the document or shared page wrappers. */
  blackTargets() {
    const targets = [];
    const boundary = findContainer(this.video);
    if (!boundary || boundary === this.video) return targets;
    for (let node = this.video.parentElement; node; node = node.parentElement) {
      if (!node.matches?.(KEEP_OPAQUE)) targets.push(node);
      if (node === boundary) break;
    }
    return targets;
  }

  /** Reconcile scoped black independently of the glow mode and full-page wash. */
  markBlackBackground() {
    if (!this.settings.pureBlackBackground || !this.video) {
      this.clearBlackBackground();
      return;
    }
    const targets = new Set(this.blackTargets());
    // Restore whatever dropped out of the chain first (SPA navigation, a rebuilt container),
    // then darken the current chain.
    for (const element of [...this.inkedElements.keys()]) {
      if (!targets.has(element)) this.restoreBackground(element);
    }
    for (const element of targets) {
      this.darkenElement(element);
      if (!element.hasAttribute(INK_ATTRIBUTE)) element.setAttribute(INK_ATTRIBUTE, '1');
    }
    const root = this.document.documentElement;
    if (root) root.setAttribute(BLACK_ATTRIBUTE, '1');
  }

  /** Applies the black override, capturing the page's inline value the first time only. */
  darkenElement(element) {
    let record = this.inkedElements.get(element);
    if (!record) {
      record = new Map();
      this.inkedElements.set(element, record);
    }
    for (const property of ['background-color', 'background-image']) {
      if (!record.has(property) || !holdsOwnedBlack(element, property)) {
        record.set(property, {
          value: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
        });
      }
      element.style.setProperty(property, property === 'background-color' ? BLACK : 'none', 'important');
    }
  }

  /**
   * Puts one element's recorded inline background back and forgets it. A recorded value is
   * only restored while our own `!important` black is still in place: if the page has written
   * its own value since, that newer value is left alone.
   */
  restoreBackground(element) {
    const record = this.inkedElements.get(element);
    if (!record) return;
    for (const [property, saved] of record) {
      if (!holdsOwnedBlack(element, property)) continue;
      if (saved.value) element.style.setProperty(property, saved.value, saved.priority);
      else element.style.removeProperty(property);
    }
    element.removeAttribute(INK_ATTRIBUTE);
    this.inkedElements.delete(element);
  }

  /** Removes every black override and restores the page's own backgrounds. */
  clearBlackBackground() {
    for (const element of [...this.inkedElements.keys()]) this.restoreBackground(element);
    this.document.documentElement?.removeAttribute(BLACK_ATTRIBUTE);
  }

  // --------------------------------------------------------------- settings

  applySettings(settings) {
    const previousMode = this.settings?.layerMode;
    this.settings = settings;
    // Switching between overlay and background rebuilds the layer at a different z-index
    // and in a different host element.
    if (previousMode && previousMode !== settings.layerMode) {
      // The host element and the z-index both change with the mode: drop the old DOM and
      // let the next update() rebuild it (the renderer already knows the new mode).
      this.renderer.destroy();
      this.pageActive = false;
    }
    this.update('settings');
  }

  // --------------------------------------------------------------- status

  /**
   * Everything the popup / options page needs to answer "why is there no light?".
   * The same snapshot is mirrored into `data-dal-status` on <html> so it can be inspected
   * from devtools or the probe script without opening the extension UI.
   */
  getStatus() {
    const video = this.video;
    const loop = this.controller.status ?? {};
    const playing = Boolean(video && !video.paused && !video.ended && video.readyState >= 2);
    const rendererActive = Boolean(this.pageActive && this.renderer?.visible);
    const status = {
      pageUrl: this.document.location?.href ?? '',
      enabled: Boolean(this.settings.enabled),
      layerMode: this.layerMode,
      videoCount: this.videoCount ?? 0,
      videoFound: Boolean(video),
      playing,
      paused: Boolean(video && video.paused),
      /** Instantaneous media resolution (`videoWidth` x `videoHeight`), 0x0 while a stream swaps. */
      videoSize: video ? `${video.videoWidth}x${video.videoHeight}` : null,
      /** Last media resolution the sampler could actually read (survives a transient 0x0). */
      mediaSize: loop.mediaSize ?? null,
      /** Sampling buffer, e.g. `96x54` - constant whatever the source resolution is. */
      sampleBuffer: loop.sampleBuffer ?? null,
      /** How often the media resolution changed on this page (Douyin quality switches). */
      resolutionChanges: loop.resolutionChanges ?? 0,
      videoRect: loop.videoRect ?? null,
      videoSrc: video ? String(video.currentSrc || video.src || '').slice(0, 120) : null,
      videoCrossOrigin: video ? video.crossOrigin ?? null : null,
      tainted: Boolean(loop.tainted),
      sampling: loop.sampling ?? 'idle',
      source: loop.source ?? 'video',
      currentColor: loop.currentColor ?? '#000000',
      zoneCount: loop.zoneCount ?? 0,
      zoneLit: loop.zoneLit ?? 0,
      zoneRows: loop.zoneRows ?? 0,
      zoneCols: loop.zoneCols ?? 0,
      samplingRate:
        rendererActive && (playing || this.settings.debugForce) ? this.settings.samplingFps : 0,
      heartbeat: loop.reason ?? 'idle',
      reason: this.lastReason ?? 'init',
      rendererActive,
      /** Whether the page backgrounds behind the player are currently forced to black. */
      pureBlackBackground: Boolean(this.settings.pureBlackBackground),
      /** How many elements currently carry the black override. */
      blackElements: this.inkedElements.size,
      rendererMount: this.layerHost()?.tagName ?? null,
      containerSelectors: PLAYER_CONTAINER_SELECTORS.length,
    };
    this.publishStatus(status);
    return status;
  }

  /** Mirrors a compact status snapshot into the DOM for devtools / the probe script. */
  publishStatus(status) {
    const root = this.document.documentElement;
    if (!root) return;
    const now = Date.now();
    if (now - (this.lastStatusPublish ?? 0) < 900) return;
    this.lastStatusPublish = now;
    const compact = {
      dal: status.enabled ? 'on' : 'off',
      mode: status.layerMode,
      videos: status.videoCount,
      picked: status.videoFound ? status.videoSize : null,
      media: status.mediaSize,
      sample: status.sampleBuffer,
      switches: status.resolutionChanges,
      playing: status.playing,
      rect: status.videoRect,
      sampling: status.sampling,
      source: status.source,
      colour: status.currentColor,
      zones: status.zoneRows ? `${status.zoneRows}x${status.zoneCols}:${status.zoneLit}/${status.zoneCount}` : null,
      fps: status.samplingRate,
      renderer: status.rendererActive ? 'active' : 'inactive',
      black: status.pureBlackBackground ? status.blackElements : 0,
    };
    try {
      root.setAttribute(MARKER_ATTRIBUTE, JSON.stringify(compact));
    } catch {
      /* attribute is a debugging aid only */
    }
  }

  destroy() {
    this.destroyed = true;
    this.imageBackground.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = 0;
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.mutationObserver = null;
    this.imageObservationTargets?.clear();
    this.resizeObserver = null;
    this.scheduleUpdate.cancel();
    this.scheduleMediaUpdate.cancel();
    this.handleScroll.cancel();
    this.detachListeners();
    this.deactivate();
  }
}

function describe(video) {
  const rect = video.getBoundingClientRect();
  return `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
}
