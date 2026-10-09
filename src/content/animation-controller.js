/**
 * Sampling / rendering loop.
 *
 * Performance rules implemented here:
 *  - exactly one loop exists at any time (starting a new one always cancels the previous),
 *  - the loop is driven by `requestVideoFrameCallback` when available, so a paused, stalled
 *    or hidden video costs literally zero CPU: the callback simply never fires,
 *  - the configured sampling FPS is enforced with a timestamp gate, so a 60 fps video is
 *    still only read 5-30 times per second,
 *  - sampling stops when the tab is hidden and when the ambient light is disabled,
 *  - geometry only (scroll, resize, fullscreen) re-renders the cached colours without
 *    reading a single pixel from the video.
 *
 * Resolution / quality switches: Douyin can change `videoWidth` / `videoHeight` (360p -> 720p ->
 * 1080p, or a whole new stream) on the very same element, sometimes without pausing. Nothing here
 * is rebuilt for that: the geometry is refreshed, the loop is restarted if it had gone idle, and
 * the sampler rebuilds its (resolution independent) mapping on the next sample. A transient
 * `videoWidth === 0` is treated as "no frame yet" - the last valid colours and media size are kept
 * and the loop is never stopped for it.
 */

import { blendEdgeAndGlobal, uniformState } from './color-smoother.js';
import { MAX_BLACK_CUT, hexToRgb, rgbToHex, zoneIntensity, zoneLevel } from '../shared/color.js';
import { clamp, createLogger, rafCoalesce, snapshotRect } from '../shared/utils.js';

/** Fallback timer period when `requestVideoFrameCallback` is unavailable. */
const MIN_TIMER_PERIOD = 16;

/**
 * How long to wait before trying to read pixels again after the browser refused to hand them
 * over. The video keeps playing normally - we simply do not hammer `getImageData` while the
 * frames are unreadable.
 */
const RETRY_INTERVAL_MS = 3000;

export class AnimationController {
  constructor(dependencies) {
    this.sampler = dependencies.sampler;
    this.smoother = dependencies.smoother;
    this.renderer = dependencies.renderer;
    this.logger = dependencies.logger ?? createLogger('loop');

    this.settings = null;
    this.video = null;
    this.running = false;
    this.visible = true;

    this.frameCallbackId = 0;
    this.timerId = 0;
    this.rectHandle = rafCoalesce(() => this.renderCached());

    this.lastSampleTime = 0;
    this.lastUpdateTime = 0;
    this.lastColors = null;
    this.lastRect = null;
    this.objectFit = 'contain';
    this.objectFitCheckedAt = 0;
    /** Last valid `videoWidth` / `videoHeight`, kept across a transient 0 during a stream swap. */
    this.lastVideoWidth = 0;
    this.lastVideoHeight = 0;
    /** Synthetic video rectangle used by the debug / force mode (no player on the page). */
    this.virtualRect = null;
    this.renderedFrames = 0;
    this.sampledFrames = 0;
    /** `video` | `poster` | `fallback` | `debug` - where the current colour comes from. */
    this.colorSource = 'video';
    this.samplerBlocked = false;
    this.lastRetryAt = 0;

    this.status = {
      active: false,
      samplesPerSecond: 0,
      tainted: false,
      reason: 'idle',
      /** `ok` | `cors-blocked` | `error` | `debug` | `idle` */
      sampling: 'idle',
      source: 'video',
      currentColor: '#000000',
      videoRect: null,
      lastSampleAt: 0,
      /** Zone diagnostics: how many independent sampling zones exist and how many carry light. */
      zoneCount: 0,
      zoneLit: 0,
      zoneRows: 0,
      zoneCols: 0,
      /** Media resolution the sampler last read (survives a transient videoWidth of 0). */
      mediaSize: null,
      /** Sampling buffer size, e.g. `96x54`. Constant whatever the source resolution is. */
      sampleBuffer: null,
      /** How often the media resolution changed on this page (quality switches). */
      resolutionChanges: 0,
    };
  }

  /** A uniform zone state for the fallback / debug paths (no frame to sample). */
  uniformFor(color) {
    const side = clamp(Math.round(this.settings?.zoneGrid ?? 3), 1, 8);
    return uniformState(color, side, side);
  }

  setSettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    this.smoother?.setSmoothness(settings.smoothness);
    this.sampler?.setOptions({ detectBars: settings.detectBars, zoneGrid: settings.zoneGrid });
    if (previous && previous.enabled && !settings.enabled) this.stop();
    if (previous && !previous.enabled && settings.enabled && this.video) this.start();
    // Turning the debug / force mode on must produce a glow immediately, even while paused.
    if (settings.debugForce && settings.enabled) {
      this.smoother?.reset();
      this.updateDebugFrame();
    }
  }

  /** Binds a new video element; cancels every loop that belonged to the previous one. */
  setVideo(video) {
    if (this.video === video) return;
    this.detachVideo();
    this.video = video ?? null;
    this.lastColors = null;
    this.lastRect = null;
    this.lastVideoWidth = 0;
    this.lastVideoHeight = 0;
    this.smoother?.reset();
    this.sampler?.reset();
    if (this.video) this.attachVideo(this.video);
  }

  attachVideo(video) {
    this.boundOnPlay = () => this.handlePlayStateChange();
    this.boundOnPause = () => this.handlePlayStateChange();
    this.boundOnMeta = () => this.handleMediaChange();
    this.boundOnResume = () => this.ensureRunning();
    this.boundOnEmptied = () => {
      // The stream is being swapped (quality switch / source reload). Nothing is rebuilt: the
      // last valid colours and geometry stay on screen so the halo cannot blink, the sampler
      // drops the per picture caches it can no longer trust, and the loop keeps its eyes open
      // for the new frames instead of stopping on one "no frame yet".
      this.sampler?.reset();
      this.ensureRunning();
    };
    video.addEventListener('play', this.boundOnPlay);
    video.addEventListener('playing', this.boundOnPlay);
    video.addEventListener('pause', this.boundOnPause);
    video.addEventListener('ended', this.boundOnPause);
    video.addEventListener('waiting', this.boundOnPause);
    video.addEventListener('loadedmetadata', this.boundOnMeta);
    video.addEventListener('durationchange', this.boundOnMeta);
    video.addEventListener('resize', this.boundOnMeta);
    video.addEventListener('seeked', this.boundOnMeta);
    video.addEventListener('loadeddata', this.boundOnResume);
    video.addEventListener('canplay', this.boundOnResume);
    video.addEventListener('progress', this.boundOnResume);
    video.addEventListener('emptied', this.boundOnEmptied);
  }

  detachVideo() {
    const video = this.video;
    if (!video || !this.boundOnPlay) return;
    video.removeEventListener('play', this.boundOnPlay);
    video.removeEventListener('playing', this.boundOnPlay);
    video.removeEventListener('pause', this.boundOnPause);
    video.removeEventListener('ended', this.boundOnPause);
    video.removeEventListener('waiting', this.boundOnPause);
    video.removeEventListener('loadedmetadata', this.boundOnMeta);
    video.removeEventListener('durationchange', this.boundOnMeta);
    video.removeEventListener('resize', this.boundOnMeta);
    video.removeEventListener('seeked', this.boundOnMeta);
    video.removeEventListener('loadeddata', this.boundOnResume);
    video.removeEventListener('canplay', this.boundOnResume);
    video.removeEventListener('progress', this.boundOnResume);
    video.removeEventListener('emptied', this.boundOnEmptied);
  }

  handlePlayStateChange() {
    if (!this.settings?.enabled || !this.video) return;
    if (this.settings.debugForce) {
      this.start();
      return;
    }
    if (this.video.paused || this.video.ended) {
      if (this.settings.idleThrottle) {
        this.stop();
        // Render once more so the halo matches the frozen frame, then stay idle.
        this.renderCached();
      }
    } else {
      this.start();
    }
  }

  invalidateGeometry() {
    this.renderer?.invalidate();
    this.requestRender();
  }

  /**
   * The picture changed while the play state did not: a quality switch, a fresh metadata block or
   * a resize. The cached colours are re-painted against the *new* media dimensions, and the loop
   * is woken up in case it had gone idle - a seamless switch (MediaSource, `load()`) does not
   * always fire `playing` again, so waiting for that event alone could leave the halo frozen.
   */
  handleMediaChange() {
    this.invalidateGeometry();
    this.ensureRunning();
  }

  /**
   * Restarts the sampling loop when it is *supposed* to run but is not.
   *
   * Deliberately conservative: it never overrides the idle throttle (a paused video stays
   * paused), and it never starts on a frame that is not there yet. It only recovers the case
   * "video is playing, ambient light is on, but the loop stopped" - the exact state a quality
   * switch can leave behind.
   */
  ensureRunning() {
    if (this.running || !this.settings?.enabled) return;
    if (this.settings.debugForce) {
      this.start();
      return;
    }
    const video = this.video;
    if (!video || video.paused || video.ended) return;
    if (video.readyState < 2) return;
    this.start();
  }

  /** Re-renders with the cached colours (scroll / resize / fullscreen / settings change). */
  requestRender() {
    this.rectHandle();
  }

  renderCached() {
    if (!this.lastColors || !this.settings?.enabled) return;
    if (!this.video && !this.settings.debugForce) return;
    this.renderFrame(this.lastColors);
  }

  start() {
    // The debug / force mode can run without any video on the page (renderer smoke test).
    if (!this.settings?.enabled || this.running) return;
    if (!this.video && !this.settings.debugForce) return;
    this.running = true;
    this.status.active = true;
    this.status.reason = 'sampling';
    this.lastSampleTime = 0;
    this.lastUpdateTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.scheduleNext();
  }

  stop() {
    this.running = false;
    this.status.active = false;
    this.status.reason = 'paused';
    this.cancelScheduled();
  }

  cancelScheduled() {
    if (this.frameCallbackId && typeof this.video?.cancelVideoFrameCallback === 'function') {
      try {
        this.video.cancelVideoFrameCallback(this.frameCallbackId);
      } catch {
        /* element already detached */
      }
    }
    this.frameCallbackId = 0;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = 0;
    }
  }

  /**
   * True when the loop can be driven by the video's own frame clock.
   * The debug / force mode always uses a timer: it has no video frames to wait for, and it
   * must keep painting while the video is paused.
   */
  get useVideoFrameCallback() {
    if (this.settings?.debugForce) return false;
    return typeof this.video?.requestVideoFrameCallback === 'function';
  }

  minInterval() {
    const fps = clamp(this.settings?.samplingFps ?? 12, 1, 60);
    return 1000 / fps;
  }

  scheduleNext() {
    if (!this.running) return;
    if (this.useVideoFrameCallback) {
      this.frameCallbackId = this.video.requestVideoFrameCallback((now) => {
        this.frameCallbackId = 0;
        if (!this.running) return;
        this.scheduleNext();
        if (now - this.lastSampleTime < this.minInterval()) return;
        this.lastSampleTime = now;
        this.sample();
      });
      return;
    }
    const delay = Math.max(MIN_TIMER_PERIOD, this.minInterval() - (Date.now() - this.lastSampleTime));
    this.timerId = setTimeout(() => {
      this.timerId = 0;
      if (!this.running) return;
      const video = this.video;
      if (video) {
        // Only a paused / ended video counts as idle. Buffering must NOT stop the loop: that is
        // exactly what a quality switch looks like (`readyState` drops, `videoWidth` may hit 0 for
        // a frame or two). The sample itself skips frames that are not ready, so keeping the timer
        // alive across a stall costs nothing and guarantees the halo resumes by itself.
        const idle = video.paused || video.ended;
        if (idle && this.settings?.idleThrottle && !this.settings?.debugForce) {
          this.stop();
          return;
        }
      } else if (!this.settings?.debugForce) {
        // No player on the page and no debug mode: nothing to do, stop the timer.
        this.stop();
        return;
      }
      this.lastSampleTime = Date.now();
      this.scheduleNext();
      this.sample();
    }, delay);
  }

  /**
   * Reads one frame from the video, smooths it and renders.
   *
   * This is the only place that touches pixels. It never disables the effect: when the
   * browser refuses to hand over the video pixels (cross-origin without CORS) the loop
   * keeps painting, first with the poster colour and finally with the configured fallback
   * colour, and retries the real frames once every few seconds.
   */
  sample() {
    const video = this.video;
    const settings = this.settings;
    if (!settings?.enabled) return;
    const doc = video?.ownerDocument ?? globalThis.document;
    if (doc?.hidden || !this.visible) return;

    // Debug / force mode: no pixels are read, the renderer gets a fixed colour. Works even
    // when the page has no <video> at all.
    if (settings.debugForce) {
      this.updateDebugFrame();
      return;
    }

    if (!video) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.samplerBlocked) {
      // A previously unreadable frame: pick up a poster colour as soon as it arrives and
      // otherwise stay on the fallback colour, retrying the real pixels every few seconds.
      const poster = this.sampler?.posterState;
      if (poster && this.colorSource !== 'poster') {
        this.colorSource = 'poster';
        this.applyColors(poster, video, 'poster');
      }
      if (now - this.lastRetryAt < RETRY_INTERVAL_MS) return;
    }

    const raw = this.sampler.sample(video, rect);
    if (!raw) {
      if (this.sampler.tainted) {
        this.lastRetryAt = now;
        this.enterFallback('cors-blocked');
      } else if (this.sampler.lastError) {
        this.lastRetryAt = now;
        this.enterFallback('error');
      }
      return;
    }

    this.samplerBlocked = false;
    this.colorSource = 'video';
    this.applyColors(raw, video, 'video');
  }

  /** Debug / force mode: paint `debugColor` without reading a single pixel. */
  updateDebugFrame() {
    if (!this.settings?.enabled) return;
    if (!this.videoRect()) return;
    this.status.tainted = false;
    this.status.reason = 'debug';
    this.status.sampling = 'debug';
    this.applyColors(this.uniformFor(hexToRgb(this.settings.debugColor)), this.video, 'debug');
  }

  /**
   * Rectangle the glow is drawn around: the live video element, or the synthetic rectangle
   * used by the debug / force mode when the page has no player at all.
   */
  videoRect() {
    if (this.video) {
      const rect = this.video.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1 ? snapshotRect(rect) : null;
    }
    return this.settings?.debugForce ? this.virtualRect ?? null : null;
  }

  /** Sets the synthetic rectangle used by `debugForce` when no video exists. */
  setVirtualRect(rect) {
    this.virtualRect = rect ?? null;
    if (this.settings?.debugForce) this.requestRender();
  }

  /**
   * Media resolution used for rendering.
   *
   * `video.videoWidth` / `videoHeight` is the only truth about how big the picture really is
   * (never the CSS box, never `clientWidth`), but it drops to 0 for a moment whenever the stream
   * is swapped. Falling back to the last valid pair keeps the letterbox maths - and therefore the
   * punched out video rectangle and the zone mapping - stable through a quality switch instead of
   * briefly treating the whole element box as the picture.
   */
  mediaSize() {
    const video = this.video;
    const width = video?.videoWidth ?? 0;
    const height = video?.videoHeight ?? 0;
    if (width > 0 && height > 0) {
      this.lastVideoWidth = width;
      this.lastVideoHeight = height;
      return { width, height };
    }
    return { width: this.lastVideoWidth ?? 0, height: this.lastVideoHeight ?? 0 };
  }

  /**
   * Pixel read back failed (usually CORS). Keep the effect alive with the best colour we can
   * still obtain, and report exactly what happened in the status object.
   */
  enterFallback(reason) {
    const first = !this.samplerBlocked;
    this.samplerBlocked = true;
    this.status.tainted = reason === 'cors-blocked';
    this.status.sampling = reason;
    this.status.reason = reason;
    this.status.source = 'fallback';
    this.colorSource = 'fallback';
    this.logger.warn?.(`pixel read back failed (${reason}) - falling back to the configured colour`);
    // Paint something immediately, then upgrade to the poster colour when it has loaded.
    this.sampler?.requestPosterSample?.(this.video);
    if (first || !this.lastColors) {
      this.applyColors(this.uniformFor(hexToRgb(this.settings.fallbackColor)), this.video, 'fallback');
    }
  }

  /** Smooths `raw` into the running colour state, paints it and refreshes the status. */
  applyColors(raw, video, source) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this.lastUpdateTime ? (now - this.lastUpdateTime) / 1000 : 0.1;
    this.lastUpdateTime = now;
    this.sampledFrames++;
    this.status.reason = source === 'video' ? 'ok' : source;
    this.status.sampling = source === 'debug' ? 'debug' : source === 'video' ? 'ok' : this.status.sampling;
    if (source === 'video') {
      this.status.tainted = false;
      this.status.samplesPerSecond = this.settings.samplingFps;
    }
    this.status.source = source;
    this.status.lastSampleAt = now;

    const colors = this.smoother.update(raw, dt);
    this.status.currentColor = rgbToHex(blendEdgeAndGlobal(colors, this.settings.edgeFocus));
    this.updateZoneStatus(colors);
    this.renderFrame(colors);
  }

  /** Number of independent zones and how many of them actually carry light right now. */
  updateZoneStatus(colors) {
    const zones = colors?.zones;
    if (!Array.isArray(zones)) return;
    const cut = (clamp(this.settings?.blackThreshold ?? 0, 0, 100) / 100) * MAX_BLACK_CUT;
    const contrast = clamp(this.settings?.edgeFocus ?? 100, 0, 100) / 100;
    let lit = 0;
    for (const zone of zones) {
      if (zoneIntensity(zoneLevel(zone), cut, contrast) > 0.03) lit++;
    }
    this.status.zoneCount = zones.length;
    this.status.zoneLit = lit;
    this.status.zoneRows = colors.grid?.rows ?? 0;
    this.status.zoneCols = colors.grid?.cols ?? 0;
  }

  renderFrame(colors) {
    const video = this.video;
    const rect = this.videoRect();
    if (!rect) return;
    this.lastRect = rect;
    this.lastColors = colors;
    this.status.videoRect = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    const media = this.mediaSize();
    // Diagnostics: the media resolution the sampler actually worked on, the (resolution
    // independent) buffer it used, and how often Douyin switched quality on this page.
    const sampler = this.sampler;
    this.status.mediaSize = sampler?.media ? `${sampler.media.width}x${sampler.media.height}` : null;
    this.status.sampleBuffer = sampler?.buffer ? `${sampler.buffer.width}x${sampler.buffer.height}` : null;
    this.status.resolutionChanges = sampler?.resolutionChanges ?? 0;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.objectFitCheckedAt > 2000) {
      this.objectFitCheckedAt = now;
      try {
        this.objectFit = video
          ? video.ownerDocument?.defaultView?.getComputedStyle?.(video)?.objectFit ?? 'contain'
          : 'contain';
      } catch {
        this.objectFit = 'contain';
      }
    }

    this.renderer.render({
      rect,
      videoWidth: media.width,
      videoHeight: media.height,
      objectFit: this.objectFit,
      colors,
    });
    this.renderedFrames++;
  }

  /** Refreshes the cached rect without reading the video (used by scroll handlers). */
  refreshGeometry() {
    this.lastRect = this.videoRect();
    if (!this.lastRect) return;
    this.requestRender();
  }

  destroy() {
    this.stop();
    this.rectHandle.cancel();
    this.detachVideo();
    this.video = null;
  }
}
