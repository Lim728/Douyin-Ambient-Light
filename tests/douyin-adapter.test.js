// @vitest-environment jsdom
/**
 * The "pure black background" option is the only part of the extension that writes to the
 * page's own backgrounds, so it gets its own tests: it has to darken exactly the video's
 * ancestor chain, never re-record its own black as the "original", and put the page back
 * (including across a video / container swap and when the option is switched off).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DouyinAmbientAdapter } from '../src/content/douyin-adapter.js';
import { DEFAULTS } from '../src/shared/config.js';

const BLACK = 'rgb(0, 0, 0)';

function createAdapter(overrides = {}) {
  return new DouyinAmbientAdapter({
    controller: {
      setVideo() {},
      start() {},
      stop() {},
      requestRender() {},
      refreshGeometry() {},
      setVirtualRect() {},
    },
    renderer: { mount() {}, unmount() {}, setVisible() {}, invalidate() {}, destroy() {} },
    settings: { ...DEFAULTS, ...overrides },
    logger: { debug() {}, warn() {}, error() {} },
    document,
    window,
  });
}

/** Builds `body > #wrapper > #card > #player > video` with an inline card background. */
function buildPage({ cardColor = '#161823', id = 'one' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.id = `wrapper-${id}`;
  const card = document.createElement('div');
  card.id = `card-${id}`;
  card.style.setProperty('background-color', cardColor);
  card.style.setProperty('background-image', 'url(card.png)');
  const player = document.createElement('div');
  player.id = `player-${id}`;
  const video = document.createElement('video');
  video.id = `video-${id}`;
  player.append(video);
  card.append(player);
  wrapper.append(card);
  document.body.append(wrapper);
  return { wrapper, card, player, video };
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-dal-black');
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

describe('pure black background', () => {
  it('leaves the page untouched while the option is off', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter();
    adapter.video = video;
    adapter.syncPageBackground();

    expect(card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(card.style.getPropertyValue('background-image')).toBe('url("card.png")');
    expect(document.querySelectorAll('[data-dal-ink]').length).toBe(0);
    expect(document.documentElement.hasAttribute('data-dal-black')).toBe(false);
  });

  it('darkens the video ancestor chain, <body> and <html> when turned on', () => {
    const { wrapper, card, player, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();

    for (const element of [wrapper, card, player, document.body, document.documentElement]) {
      expect(element.style.getPropertyPriority('background-color')).toBe('important');
      expect(element.style.getPropertyValue('background-color')).toBe(BLACK);
      expect(element.style.getPropertyPriority('background-image')).toBe('important');
      expect(element.style.getPropertyValue('background-image')).toBe('none');
    }
    // The <video> itself is never painted over.
    expect(video.style.getPropertyValue('background-color')).toBe('');
    expect(video.hasAttribute('data-dal-ink')).toBe(false);
    expect(card.hasAttribute('data-dal-ink')).toBe(true);
    expect(document.documentElement.getAttribute('data-dal-black')).toBe('1');
  });

  it('never records its own black as the original across repeated passes', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();
    adapter.syncPageBackground();
    adapter.syncPageBackground();

    adapter.clearBlackBackground();

    expect(card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(card.style.getPropertyValue('background-image')).toBe('url("card.png")');
    expect(card.style.getPropertyPriority('background-color')).toBe('');
  });

  it('restores an element that had no inline background to no inline background', () => {
    const { wrapper, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();
    expect(wrapper.style.getPropertyValue('background-color')).toBe(BLACK);

    adapter.clearBlackBackground();

    expect(wrapper.style.getPropertyValue('background-color')).toBe('');
    expect(wrapper.style.getPropertyValue('background-image')).toBe('');
    expect(wrapper.hasAttribute('data-dal-ink')).toBe(false);
    expect(document.documentElement.hasAttribute('data-dal-black')).toBe(false);
  });

  it('leaves a value the page wrote itself in place instead of clobbering it', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();
    // The page reactively repaints its own card while the extension holds the black.
    card.style.setProperty('background-color', 'rgb(255, 0, 0)');

    adapter.clearBlackBackground();

    expect(card.style.getPropertyValue('background-color')).toBe('rgb(255, 0, 0)');
  });

  it('only touches the chain of the active video, never a second player', () => {
    const first = buildPage({ id: 'one' });
    const second = buildPage({ id: 'two' });
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = first.video;
    adapter.syncPageBackground();

    expect(first.card.style.getPropertyValue('background-color')).toBe(BLACK);
    // The second card is not an ancestor of the active video, so its background stays.
    expect(second.card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(second.card.hasAttribute('data-dal-ink')).toBe(false);
    // wrapper + card + player of the active video, plus <body> and <html>.
    expect(document.querySelectorAll('[data-dal-ink]').length).toBe(5);
  });

  it('restores the old chain and darkens the new one when the video is swapped', () => {
    const first = buildPage({ id: 'one' });
    const second = buildPage({ id: 'two' });
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = first.video;
    adapter.syncPageBackground();

    adapter.video = second.video;
    adapter.syncPageBackground();

    expect(first.card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(first.card.style.getPropertyValue('background-image')).toBe('url("card.png")');
    expect(first.card.hasAttribute('data-dal-ink')).toBe(false);
    expect(second.card.style.getPropertyValue('background-color')).toBe(BLACK);
    expect(second.card.hasAttribute('data-dal-ink')).toBe(true);
  });

  it('clears everything when the option is switched off', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();

    adapter.settings = { ...DEFAULTS, pureBlackBackground: false };
    adapter.syncPageBackground();

    expect(card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(document.querySelectorAll('[data-dal-ink]').length).toBe(0);
    expect(document.documentElement.hasAttribute('data-dal-black')).toBe(false);
  });

  it('clears the overrides on deactivate even if the layer never mounted', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true });
    adapter.video = video;
    adapter.syncPageBackground();

    adapter.deactivate();

    expect(card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
    expect(document.querySelectorAll('[data-dal-ink]').length).toBe(0);
  });

  it('does not darken the page in background layer mode', () => {
    const { card, video } = buildPage();
    const adapter = createAdapter({ pureBlackBackground: true, layerMode: 'background' });
    adapter.video = video;
    adapter.syncPageBackground();

    expect(document.querySelectorAll('[data-dal-ink]').length).toBe(0);
    expect(card.style.getPropertyValue('background-color')).toBe('rgb(22, 24, 35)');
  });
});
