/**
 * Video detection.
 *
 * Douyin's web app is a single page application that mounts and unmounts the xgplayer
 * instance while the user scrolls the feed. There is therefore never a single "the" video
 * element: several <video> tags can coexist (already mounted neighbours, background preview
 * cards, ads) and the element that matters changes without a page navigation.
 *
 * The detector is deliberately independent from the DOM structure: it scores every visible
 * <video> by the area it actually occupies on screen, then adds bonuses for the markers that
 * Douyin itself uses for "this is the card the user is looking at" (data-e2e attributes) and
 * for playback state. Structure specific selectors are only used as *bonuses*, never as a
 * requirement, so a Douyin redesign degrades the accuracy instead of breaking the feature.
 */

import { isElementVisible, snapshotRect, visibleArea } from '../shared/utils.js';

/**
 * Douyin markers, ordered from "definitely the current card" to "some player".
 * `data-e2e` attributes are part of Douyin's end-to-end test contract and have been stable
 * for years; `.xgplayer` is the open source ByteDance player shell.
 */
export const ACTIVE_VIDEO_SELECTORS = Object.freeze([
  '[data-e2e="feed-active-video"]',
  '[data-e2e="feed-video"]',
  '#sliderVideo',
]);

export const PLAYER_CONTAINER_SELECTORS = Object.freeze([
  '[data-e2e="feed-active-video"]',
  '[data-e2e="feed-video"]',
  '#sliderVideo',
  '.xgplayer',
  '.xg-video-container',
  '[class*="basePlayerContainer"]',
]);

/** Candidate selectors used for the bounded shadow DOM scan. */
const SHADOW_HOST_HINT = '[class*="player" i],[class*="video" i],[class*="Player"]';

const MIN_VIDEO_SIDE = 96; // px, smaller elements are thumbnails / decorative
const MAX_SHADOW_HOSTS = 200;

export const DETECT_REASONS = Object.freeze({
  OK: 'ok',
  DETACHED: 'detached',
  TOO_SMALL: 'too-small',
  HIDDEN: 'hidden',
  NO_SOURCE: 'no-source',
});

/**
 * Collects every <video> reachable from `root`, including the ones living inside a shadow
 * root of a player-ish host. The shadow scan is bounded so it stays cheap on Douyin's very
 * large DOM.
 */
export function findVideos(root = document) {
  const found = new Set();
  try {
    for (const video of root.querySelectorAll('video')) found.add(video);
  } catch {
    /* ignore */
  }

  let hosts;
  try {
    hosts = root.querySelectorAll(SHADOW_HOST_HINT);
  } catch {
    hosts = [];
  }
  const limit = Math.min(hosts.length, MAX_SHADOW_HOSTS);
  for (let i = 0; i < limit; i++) {
    const host = hosts[i];
    const shadow = host.shadowRoot;
    if (!shadow) continue;
    try {
      for (const video of shadow.querySelectorAll('video')) found.add(video);
    } catch {
      /* ignore */
    }
  }
  return [...found];
}

/** True when the element has enough media data to be drawn onto a canvas. */
export function hasDrawableSource(video) {
  if (!video) return false;
  if (video.readyState >= 2 && video.videoWidth > 0) return true;
  return Boolean(video.currentSrc || video.src) && video.readyState >= 1;
}

export function isPlaying(video) {
  return Boolean(video) && !video.paused && !video.ended && video.readyState >= 2;
}

/** Last observed `currentTime` per element, used to detect a video that is really running. */
const timeCache = new WeakMap();

/**
 * `true` when `currentTime` moved forward since the previous detection pass.
 *
 * A Douyin feed keeps several players mounted at once and some of them report
 * `paused === false` while nothing moves (buffering, fade out, hidden preload). Watching the
 * clock is the most reliable "this is the video the user is watching" signal there is.
 */
export function isAdvancing(video, now = Date.now()) {
  if (!video) return false;
  const previous = timeCache.get(video);
  timeCache.set(video, { time: video.currentTime, at: now });
  if (!previous) return false;
  const wall = (now - previous.at) / 1000;
  if (wall <= 0.05 || wall > 6) return false;
  return video.currentTime - previous.time > wall * 0.25;
}

/** `true` when the rect covers the centre of the viewport. */
export function coversViewportCenter(rect, viewportWidth, viewportHeight) {
  const cx = viewportWidth / 2;
  const cy = viewportHeight / 2;
  return rect.left <= cx && rect.right >= cx && rect.top <= cy && rect.bottom >= cy;
}

/**
 * Scores a single <video>. Returns `null` when the element can never be a good source,
 * otherwise `{ score, area, rect, playing, reasons }`.
 */
export function evaluateVideo(video, options = {}) {
  const viewportWidth = options.viewportWidth ?? 1280;
  const viewportHeight = options.viewportHeight ?? 720;
  const reasons = [];

  if (!video || typeof video.getBoundingClientRect !== 'function') return null;
  if (!video.isConnected) return null;

  // Profile cards can autoplay at substantial sizes. Playback alone is not intent.
  // Only a dedicated detail route or actual fullscreen player is eligible there.
  const location = video.ownerDocument?.location;
  if (location && /^\/user(?:\/|$)/.test(location.pathname)) {
    const fullscreen = options.fullscreenElement;
    const inFullscreen = fullscreen && (fullscreen === video || fullscreen.contains(video));
    const detailId = new URLSearchParams(location.search).get('modal_id');
    const detailPlayer = video.closest('#sliderVideo, [data-e2e="feed-active-video"]');
    if (!inFullscreen && !(detailId && detailPlayer)) return null;
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < MIN_VIDEO_SIDE || rect.height < MIN_VIDEO_SIDE) {
    reasons.push(DETECT_REASONS.TOO_SMALL);
  }

  const area = visibleArea(rect, viewportWidth, viewportHeight);
  if (area <= 0) {
    reasons.push(DETECT_REASONS.HIDDEN);
    return null;
  }

  if (!isElementVisible(video)) {
    reasons.push(DETECT_REASONS.HIDDEN);
    return null;
  }

  if (reasons.includes(DETECT_REASONS.TOO_SMALL)) return null;

  const playing = isPlaying(video);
  const drawable = hasDrawableSource(video);
  if (!drawable && !playing) {
    reasons.push(DETECT_REASONS.NO_SOURCE);
    return null;
  }

  const advancing = isAdvancing(video, options.now ?? Date.now());

  let score = area;
  if (coversViewportCenter(rect, viewportWidth, viewportHeight)) score *= 2.4;
  if (playing) score *= 1.7;
  // A video whose clock is actually moving wins over a frozen / buffering neighbour.
  if (advancing) score *= 1.35;
  if (drawable) score *= 1.15;

  for (const selector of ACTIVE_VIDEO_SELECTORS) {
    if (video.closest(selector)) {
      score *= 1.45;
      break;
    }
  }
  if (video.closest('.xgplayer')) score *= 1.2;

  const fullscreenElement = options.fullscreenElement ?? null;
  if (fullscreenElement && (fullscreenElement === video || fullscreenElement.contains(video))) {
    score *= 4;
  }

  reasons.push(DETECT_REASONS.OK);
  return {
    score,
    area,
    rect: snapshotRect(rect),
    playing,
    advancing,
    drawable,
    readyState: video.readyState,
    currentTime: video.currentTime,
    reasons,
  };
}

/**
 * Returns the best video for the current viewport, or `null`.
 * `previous` receives a small bonus so the light does not flicker between two equally
 * scored elements while the feed animates.
 */
export function selectBestVideo(options = {}) {
  const root = options.root ?? document;
  const previous = options.previous ?? null;
  const videos = options.videos ?? findVideos(root);
  let best = null;

  for (const video of videos) {
    const result = evaluateVideo(video, options);
    if (!result) continue;
    let score = result.score;
    if (previous && video === previous) score *= 1.25;
    if (!best || score > best.score) best = { video, score, ...result };
  }

  return best;
}

/** Finds the closest player container, used for the ResizeObserver and the attribute hooks. */
export function findContainer(video) {
  if (!video) return null;
  // closest() over the combined selector respects DOM distance, not selector priority.
  const match = video.closest(PLAYER_CONTAINER_SELECTORS.join(','));
  const parent = match ?? video.parentElement;
  if (!parent || parent === video.ownerDocument.body || parent === video.ownerDocument.documentElement) return video;
  const bounds = parent.getBoundingClientRect();
  const rect = video.getBoundingClientRect();
  // A page-wide wrapper is not a player. Geometry remains anchored to the video.
  if (bounds.width > rect.width * 2 || bounds.height > rect.height * 2) return video;
  return parent;
}
