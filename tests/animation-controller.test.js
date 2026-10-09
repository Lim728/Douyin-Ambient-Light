// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationController } from '../src/content/animation-controller.js';
import { ColorSmoother, uniformState } from '../src/content/color-smoother.js';
import { DEFAULTS, normalizeSettings } from '../src/shared/config.js';
import { hexToRgb } from '../src/shared/color.js';

/** Minimal stand-in for a playing <video> with a known on screen rectangle. */
function fakeVideo(rect = { left: 100, top: 50, width: 400, height: 600, right: 500, bottom: 650 }) {
  const video = document.createElement('video');
  video.getBoundingClientRect = () => ({ ...rect });
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  Object.defineProperty(video, 'ended', { value: false, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1080, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 1920, configurable: true });
  document.body.append(video);
  return video;
}

function makeController({ sampler, settings }) {
  const smoother = new ColorSmoother({ smoothness: settings.smoothness });
  const renderer = {
    visible: true,
    invalidate: vi.fn(),
    render: vi.fn(),
    setSettings: vi.fn(),
    mount: vi.fn(),
    setVisible: vi.fn(),
  };
  const controller = new AnimationController({
    sampler,
    smoother,
    renderer,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  controller.setSettings(settings);
  return { controller, renderer, smoother };
}

const lastColors = (renderer) => renderer.render.mock.calls.at(-1)?.[0]?.colors;

describe('AnimationController - CORS fallback', () => {
  let sampler;
  beforeEach(() => {
    document.body.innerHTML = '';
    sampler = {
      tainted: false,
      lastError: null,
      posterState: null,
      sample: vi.fn(() => null),
      requestPosterSample: vi.fn(),
      reset: vi.fn(),
      setOptions: vi.fn(),
    };
  });

  it('keeps rendering with the fallback colour when pixels cannot be read', () => {
    sampler.tainted = true;
    sampler.lastError = new Error('SecurityError');
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false, fallbackColor: '#3a5a8c' });
    const { controller, renderer } = makeController({ sampler, settings });

    controller.setVideo(fakeVideo());
    controller.sample();

    expect(controller.samplerBlocked).toBe(true);
    expect(controller.status.tainted).toBe(true);
    expect(controller.status.sampling).toBe('cors-blocked');
    expect(controller.status.source).toBe('fallback');
    // The important part: the renderer still painted something.
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(lastColors(renderer).edgeAverage).toEqual(hexToRgb('#3a5a8c'));
    // ... and the poster was requested as the next best colour source.
    expect(sampler.requestPosterSample).toHaveBeenCalled();
  });

  it('upgrades to the poster colour (smoothly) once it is available', () => {
    sampler.tainted = true;
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false, fallbackColor: '#3a5a8c' });
    const { controller, renderer } = makeController({ sampler, settings });
    controller.setVideo(fakeVideo());
    controller.sample();
    expect(controller.status.source).toBe('fallback');
    const fallback = lastColors(renderer).edgeAverage;

    sampler.posterState = {
      global: hexToRgb('#ff8800'),
      edgeAverage: hexToRgb('#ff8800'),
      edges: {
        top: hexToRgb('#ff8800'),
        bottom: hexToRgb('#ff8800'),
        left: hexToRgb('#ff8800'),
        right: hexToRgb('#ff8800'),
      },
      luma: 0.5,
    };
    controller.sample();
    const poster = hexToRgb('#ff8800');
    const blended = lastColors(renderer).edgeAverage;

    expect(controller.status.source).toBe('poster');
    // The new colour source is filtered in over time instead of snapping to it ...
    expect(blended).not.toEqual(poster);
    expect(blended.r).toBeGreaterThan(fallback.r);
    expect(blended.b).toBeLessThan(fallback.b);
    // ... and it moves straight towards the poster colour.
    expect(Math.abs(blended.r - poster.r)).toBeLessThan(Math.abs(fallback.r - poster.r));
  });

  it('does not retry a blocked frame on every tick', () => {
    sampler.tainted = true;
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false });
    const { controller } = makeController({ sampler, settings });
    controller.setVideo(fakeVideo());
    controller.sample();
    controller.sample();
    controller.sample();
    expect(sampler.sample).toHaveBeenCalledTimes(1);
  });
});

describe('AnimationController - debug / force mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('paints the debug colour without reading any pixel', () => {
    const sampler = {
      tainted: false,
      lastError: null,
      posterState: null,
      sample: vi.fn(() => null),
      requestPosterSample: vi.fn(),
      reset: vi.fn(),
      setOptions: vi.fn(),
    };
    const settings = normalizeSettings({ ...DEFAULTS, debugForce: true, debugColor: '#ff0000' });
    const { controller, renderer } = makeController({ sampler, settings });
    controller.setVideo(fakeVideo());
    controller.sample();

    expect(sampler.sample).not.toHaveBeenCalled();
    expect(controller.status.sampling).toBe('debug');
    expect(lastColors(renderer).edgeAverage).toEqual(hexToRgb('#ff0000'));
  });

  it('works on a page without any video (renderer smoke test)', () => {
    const sampler = {
      tainted: false,
      lastError: null,
      posterState: null,
      sample: vi.fn(() => null),
      requestPosterSample: vi.fn(),
      reset: vi.fn(),
      setOptions: vi.fn(),
    };
    const settings = normalizeSettings({ ...DEFAULTS, debugForce: true, debugColor: '#0064ff' });
    const { controller, renderer } = makeController({ sampler, settings });
    controller.setVideo(null);
    controller.setVirtualRect({ left: 100, top: 100, width: 400, height: 400, right: 500, bottom: 500 });
    controller.sample();

    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render.mock.calls[0][0].rect).toEqual({
      left: 100,
      top: 100,
      width: 400,
      height: 400,
      right: 500,
      bottom: 500,
    });
    expect(lastColors(renderer).edgeAverage).toEqual(hexToRgb('#0064ff'));
  });

  it('starts even when no video exists', () => {
    const sampler = {
      tainted: false,
      lastError: null,
      posterState: null,
      sample: vi.fn(),
      requestPosterSample: vi.fn(),
      reset: vi.fn(),
      setOptions: vi.fn(),
    };
    const settings = normalizeSettings({ ...DEFAULTS, debugForce: true });
    const { controller } = makeController({ sampler, settings });
    controller.setVideo(null);
    controller.start();
    expect(controller.running).toBe(true);
    controller.stop();
  });
});

/**
 * Resolution / quality switches.
 *
 * Douyin changes `videoWidth` / `videoHeight` (360p -> 720p -> 1080p, or a whole new stream) on
 * the same element, sometimes without any play state change and sometimes with `videoWidth` briefly
 * reading 0. None of that may rebuild the renderer, stop the loop or distort the halo geometry.
 */
describe('AnimationController - resolution adaptivity', () => {
  const samplerStub = (overrides = {}) => ({
    tainted: false,
    lastError: null,
    posterState: null,
    media: null,
    buffer: null,
    resolutionChanges: 0,
    sample: vi.fn(() => null),
    requestPosterSample: vi.fn(),
    reset: vi.fn(),
    setOptions: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the last valid media size while videoWidth reads 0', () => {
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false });
    const { controller, renderer } = makeController({ sampler: samplerStub(), settings });
    const video = fakeVideo(); // 1080 x 1920
    controller.setVideo(video);
    expect(controller.mediaSize()).toEqual({ width: 1080, height: 1920 });

    // The stream is being swapped: the element is still there, the picture is not.
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 0, configurable: true });
    expect(controller.mediaSize()).toEqual({ width: 1080, height: 1920 });

    controller.renderFrame(uniformState(hexToRgb('#00ff00'), 3, 3));
    const frame = renderer.render.mock.calls.at(-1)[0];
    // The halo keeps the portrait letterbox of the last real frame instead of the element box.
    expect(frame.videoWidth).toBe(1080);
    expect(frame.videoHeight).toBe(1920);
  });

  it('never stops the loop on a transient "no frame yet"', () => {
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: true });
    const { controller } = makeController({ sampler: samplerStub(), settings });
    controller.setVideo(fakeVideo());
    controller.start();
    for (let i = 0; i < 5; i++) controller.sample();
    expect(controller.running).toBe(true);
    expect(controller.status.sampling).not.toBe('error');
    controller.stop();
  });

  it('restarts the loop after a media change even without a playing event', () => {
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false });
    const { controller } = makeController({ sampler: samplerStub(), settings });
    const video = fakeVideo();
    controller.setVideo(video);
    expect(controller.running).toBe(false);

    // A seamless quality switch fires metadata / a size change, not necessarily `playing`.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(controller.running).toBe(true);
    expect(controller.status.active).toBe(true);
    controller.stop();
  });

  it('does not restart the loop while the video is paused', () => {
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: true });
    const { controller } = makeController({ sampler: samplerStub(), settings });
    const video = fakeVideo();
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    controller.setVideo(video);
    video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('progress'));
    expect(controller.running).toBe(false);
  });

  it('publishes the media resolution, the fixed buffer and the switch count', () => {
    const sampler = samplerStub({
      media: { width: 1920, height: 1080 },
      buffer: { width: 96, height: 54 },
      resolutionChanges: 2,
    });
    const settings = normalizeSettings({ ...DEFAULTS, idleThrottle: false });
    const { controller } = makeController({ sampler, settings });
    controller.setVideo(fakeVideo());
    controller.renderFrame(uniformState(hexToRgb('#ff0000'), 3, 3));
    expect(controller.status.mediaSize).toBe('1920x1080');
    expect(controller.status.sampleBuffer).toBe('96x54');
    expect(controller.status.resolutionChanges).toBe(2);
  });
});
