// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DETECT_REASONS,
  coversViewportCenter,
  evaluateVideo,
  findContainer,
  findVideos,
  isPlaying,
  selectBestVideo,
} from '../src/content/video-detector.js';

const VIEWPORT = { viewportWidth: 1280, viewportHeight: 720 };

beforeAll(() => {
  // jsdom has no layout engine, so the native checkVisibility() (when present) would report
  // every element as invisible. Force the computed-style based fallback path.
  if (typeof Element !== 'undefined' && 'checkVisibility' in Element.prototype) {
    delete Element.prototype.checkVisibility;
  }
});

/** Creates a <video> in the document with a stubbed rect and playback state. */
function createVideo({ rect, paused = true, readyState = 4, videoWidth = 1080, videoHeight = 1920, parent } = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  });
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => readyState });
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => videoWidth });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => videoHeight });
  Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => 'https://v3-web.douyinvod.com/x.mp4' });
  (parent ?? document.body).append(video);
  return video;
}

describe('coversViewportCenter', () => {
  it('is true only for rects containing the centre', () => {
    expect(coversViewportCenter({ left: 500, top: 200, right: 780, bottom: 520 }, 1280, 720)).toBe(true);
    expect(coversViewportCenter({ left: 0, top: 0, right: 100, bottom: 100 }, 1280, 720)).toBe(false);
  });
});

describe('evaluateVideo', () => {
  it('rejects hidden videos', () => {
    const video = createVideo({ rect: { left: -10_000, top: 0, width: 500, height: 500 } });
    expect(evaluateVideo(video, VIEWPORT)).toBeNull();
  });

  it('rejects thumbnails', () => {
    const video = createVideo({ rect: { left: 10, top: 10, width: 60, height: 60 } });
    expect(evaluateVideo(video, VIEWPORT)).toBeNull();
  });

  it('rejects elements without media data', () => {
    const video = createVideo({
      rect: { left: 100, top: 100, width: 400, height: 600 },
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
    });
    expect(evaluateVideo(video, VIEWPORT)).toBeNull();
  });

  it('accepts a large visible video and records the reason', () => {
    const video = createVideo({ rect: { left: 500, top: 60, width: 400, height: 600 } });
    const result = evaluateVideo(video, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result.reasons).toContain(DETECT_REASONS.OK);
    expect(result.playing).toBe(false);
  });

  it('scores a playing video above a paused one', () => {
    const paused = createVideo({ rect: { left: 500, top: 60, width: 400, height: 600 }, paused: true });
    const playing = createVideo({ rect: { left: 500, top: 60, width: 400, height: 600 }, paused: false });
    const pausedScore = evaluateVideo(paused, VIEWPORT).score;
    const playingScore = evaluateVideo(playing, VIEWPORT).score;
    expect(playingScore).toBeGreaterThan(pausedScore);
  });

  it('boosts a video inside an active feed card', () => {
    const card = document.createElement('div');
    card.setAttribute('data-e2e', 'feed-active-video');
    document.body.append(card);
    const plain = createVideo({ rect: { left: 100, top: 100, width: 400, height: 400 } });
    const featured = createVideo({ rect: { left: 100, top: 100, width: 400, height: 400 }, parent: card });
    expect(evaluateVideo(featured, VIEWPORT).score).toBeGreaterThan(evaluateVideo(plain, VIEWPORT).score);
  });
});

describe('selectBestVideo', () => {
  it('picks the largest visible playing video', () => {
    document.body.innerHTML = '';
    const small = createVideo({ rect: { left: 20, top: 20, width: 320, height: 320 } });
    const large = createVideo({ rect: { left: 440, top: 60, width: 400, height: 600 }, paused: false });
    const best = selectBestVideo({ root: document, ...VIEWPORT });
    expect(best.video).toBe(large);
    expect(best.video).not.toBe(small);
  });

  it('prefers the element it used before when scores are close', () => {
    document.body.innerHTML = '';
    const a = createVideo({ rect: { left: 400, top: 100, width: 400, height: 500 } });
    const b = createVideo({ rect: { left: 410, top: 110, width: 400, height: 500 } });
    const best = selectBestVideo({ root: document, previous: a, ...VIEWPORT });
    expect(best.video).toBe(a);
    void b;
  });

  it('returns null when nothing qualifies', () => {
    document.body.innerHTML = '';
    expect(selectBestVideo({ root: document, ...VIEWPORT })).toBeNull();
  });
});

describe('findVideos', () => {
  it('finds videos inside shadow roots of player hosts', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.className = 'xgplayer-shell';
    const shadow = host.attachShadow({ mode: 'open' });
    const video = document.createElement('video');
    shadow.append(video);
    document.body.append(host);
    expect(findVideos(document)).toContain(video);
  });
});

describe('findContainer / isPlaying', () => {
  it('returns the closest player container', () => {
    document.body.innerHTML = '';
    const player = document.createElement('div');
    player.className = 'xgplayer';
    const video = document.createElement('video');
    player.append(video);
    document.body.append(player);
    expect(findContainer(video)).toBe(player);
  });

  it('falls back to the parent element', () => {
    document.body.innerHTML = '';
    const wrapper = document.createElement('div');
    const video = document.createElement('video');
    wrapper.append(video);
    document.body.append(wrapper);
    expect(findContainer(video)).toBe(wrapper);
  });

  it('reports playback state', () => {
    const video = createVideo({ rect: { left: 0, top: 0, width: 300, height: 300 }, paused: true });
    expect(isPlaying(video)).toBe(false);
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    expect(isPlaying(video)).toBe(true);
  });
});


describe('profile preview eligibility', () => {
  it('rejects autoplay cards, follows detail playback and rejects them again on return', () => {
    document.body.innerHTML = '';
    history.replaceState({}, '', '/user/example');
    const rect = { left: 400, top: 100, width: 400, height: 500 };
    const preview = createVideo({ rect, paused: false });
    const second = createVideo({ rect, paused: false });
    expect(selectBestVideo({ ...VIEWPORT, videos: [preview, second] })).toBeNull();
    history.replaceState({}, '', '/video/123');
    expect(selectBestVideo({ ...VIEWPORT, videos: [preview] }).video).toBe(preview);
    Object.defineProperty(preview, 'paused', { configurable: true, value: true });
    expect(evaluateVideo(preview, VIEWPORT).playing).toBe(false);
    expect(selectBestVideo({ ...VIEWPORT, videos: [second] }).video).toBe(second);
    history.replaceState({}, '', '/user/example');
    expect(selectBestVideo({ ...VIEWPORT, videos: [preview, second], previous: second })).toBeNull();
    history.replaceState({}, '', '/');
  });

  it('requires a detail player as well as a modal route on a profile', () => {
    document.body.innerHTML = '';
    history.replaceState({}, '', '/user/example?modal_id=123');
    const video = createVideo({ rect: { left: 400, top: 100, width: 400, height: 500 }, paused: false });
    expect(evaluateVideo(video, VIEWPORT)).toBeNull();
    const detail = document.createElement('div');
    detail.id = 'sliderVideo';
    document.body.append(detail);
    detail.append(video);
    expect(evaluateVideo(video, VIEWPORT)).not.toBeNull();
    history.replaceState({}, '', '/');
  });
});
