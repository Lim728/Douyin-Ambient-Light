// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it } from 'vitest';
import { ImageBackground, findImagePanel } from '../src/content/image-background.js';
import { DouyinAmbientAdapter } from '../src/content/douyin-adapter.js';
import { DEFAULTS, normalizeSettings } from '../src/shared/config.js';

function box(el, width = 600, height = 500) {
  el.getBoundingClientRect = () => ({ left: 0, top: 60, right: width, bottom: height + 60, width, height });
}
function fixture() {
  const root = document.createElement('div');
  root.className = 'note-detail-container';
  root.innerHTML = `<div class="focusPanel" style="background-color:rgb(20, 20, 20)"><div class="dySwiperSlide"><div class="picture"><img src="photo.webp"><div class="backdrop" style="position:absolute;z-index:-1"><img src="photo.webp" style="filter:blur(60px)"></div></div></div></div><aside>comments</aside><button>like</button>`;
  document.body.append(root);
  const panel = root.querySelector('.focusPanel');
  box(panel);
  for (const el of root.querySelectorAll('img')) box(el, 300, 500);
  return { root, panel, slide: root.querySelector('.dySwiperSlide'), image: root.querySelector('img'), backdrop: root.querySelector('.backdrop') };
}
beforeEach(() => {
  document.body.innerHTML = '<header>navigation</header>';
  history.replaceState({}, '', '/note/123');
});
it('adds a default-off setting without losing the existing video preference', () => {
  expect(normalizeSettings({ pureBlackBackground: true })).toMatchObject({ pureBlackBackground: true, imageBlackBackground: false });
});
it.each([200, 500, 900])('handles image width %s without changing image content or surrounding UI', width => {
  const f = fixture(); box(f.image, width, 400);
  const before = f.image.outerHTML;
  const b = new ImageBackground(document); b.sync(true);
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  expect(f.backdrop.style.visibility).toBe('hidden');
  expect(f.image.outerHTML).toBe(before);
  for (const el of document.querySelectorAll('html,body,header,aside,button')) expect(el.getAttribute('style')).toBeNull();
  b.clear(); expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
  expect(f.backdrop.style.visibility).toBe('');
});
it('supports CSS image slides without removing their background-image', () => {
  const f = fixture(); f.slide.innerHTML = ''; f.slide.style.backgroundImage = 'url(photo.webp)';
  const b = new ImageBackground(document); b.sync(true);
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  expect(f.slide.style.backgroundImage).toBe('url("photo.webp")');
  b.clear();
});
it('reconciles carousel replacement and work switches, and releases detached nodes', () => {
  const f = fixture(); const b = new ImageBackground(document); b.sync(true);
  const next = f.slide.cloneNode(true); f.slide.replaceWith(next); b.sync(true);
  expect(b.records.has(f.slide)).toBe(false);
  f.root.remove(); const g = fixture(); b.sync(true);
  expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
  expect(g.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  g.root.remove(); b.sync(true); expect(b.records.size).toBe(0);
});
it('skips profile thumbnails, hidden viewers, ambiguous viewers and oversized ancestors', () => {
  const f = fixture(); history.replaceState({}, '', '/user/example');
  expect(findImagePanel(document)).toBeNull();
  history.replaceState({}, '', '/user/example?modal_id=123');
  expect(findImagePanel(document)).toBe(f.panel);
  f.root.hidden = true; expect(findImagePanel(document)).toBeNull(); f.root.hidden = false;
  const g = fixture(); expect(findImagePanel(document)).toBeNull(); g.root.remove();
  box(f.panel, 2000, 2000); expect(findImagePanel(document)).toBeNull();
});
it('preserves page updates both before restoration and across reapplication', () => {
  const f = fixture(); const b = new ImageBackground(document); b.sync(true);
  f.panel.style.backgroundColor = 'red'; b.sync(true); b.sync(false);
  expect(f.panel.style.backgroundColor).toBe('red');
  b.sync(true); f.panel.style.backgroundColor = 'blue'; b.clear();
  expect(f.panel.style.backgroundColor).toBe('blue');
});
it('does not accumulate nodes or records across toggles', () => {
  fixture(); const count = document.querySelectorAll('*').length; const b = new ImageBackground(document);
  for (let i = 0; i < 20; i++) { b.sync(true); b.sync(false); }
  expect(b.records.size).toBe(0); expect(document.querySelectorAll('*').length).toBe(count);
});
it('uses the existing observer to restore on close while glow is off, and cleans up on destroy', async () => {
  const f = fixture();
  const adapter = new DouyinAmbientAdapter({ document, window,
    settings: { ...DEFAULTS, enabled: false, pureBlackBackground: false, imageBlackBackground: true },
    controller: { setVideo() {}, stop() {}, setVirtualRect() {} },
    renderer: { setVisible() {}, unmount() {} }, logger: { debug() {} } });
  adapter.init(); const observer = adapter.mutationObserver;
  for (let i = 0; i < 5; i++) adapter.update();
  expect(adapter.mutationObserver).toBe(observer);
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  f.root.hidden = true; await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
  f.root.hidden = false; await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  adapter.destroy(); expect(adapter.imageBackground.records.size).toBe(0);
});

it.each([
  [false, false, false], [false, true, true], [true, false, true], [true, true, false],
])('keeps image background independent of glow=%s video=%s fullPage=%s', (enabled, pureBlackBackground, fullPageBackground) => {
  const f = fixture();
  const adapter = new DouyinAmbientAdapter({ document, window,
    settings: { ...DEFAULTS, enabled, pureBlackBackground, fullPageBackground, imageBlackBackground: true },
    controller: { setVideo() {}, stop() {}, setVirtualRect() {} },
    renderer: { setVisible() {}, unmount() {} }, logger: { debug() {} } });
  adapter.update();
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  history.replaceState({}, '', '/user/example'); adapter.handleNavigation();
  expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
  history.replaceState({}, '', '/note/456'); adapter.handleNavigation();
  expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
  adapter.applySettings({ ...adapter.settings, imageBlackBackground: false });
  expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
  expect(adapter.settings.pureBlackBackground).toBe(pureBlackBackground);
  adapter.destroy();
});

// Reproduces the supplied profile-modal JSON: no note-detail root, fractional
// panel width, slide button, original IMG + scaled negative-z blurred duplicate.
function modalFixture() {
  history.replaceState({}, '', '/user/example?modal_id=123');
  const f = fixture();
  f.root.className = 'basePlayerContainer modalPlayer';
  const button = document.createElement('button');
  button.textContent = 'next image'; f.slide.prepend(button);
  f.backdrop.style.transform = 'matrix(1.2, 0, 0, 1.2, 0, 0)';
  f.backdrop.append(document.createElement('div'));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 691 });
  box(f.panel, 691.3, 684);
  const preview = document.createElement('ul');
  preview.innerHTML = '<li><a><img src="photo.webp" style="filter:blur(60px)"></a></li>';
  document.body.prepend(preview);
  return { ...f, button, preview };
}
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});
it.each([[477, 636], [270, 480], [640, 360], [400, 400]])(
  'accepts the observed modal and preserves the original %sx%s image and controls', (width, height) => {
    const f = modalFixture(); box(f.image, width, height);
    const original = f.image.outerHTML, preview = f.preview.outerHTML, button = f.button.outerHTML;
    const b = new ImageBackground(document); b.sync(true);
    expect(findImagePanel(document)).toBe(f.panel);
    expect(f.panel.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(f.backdrop.style.visibility).toBe('hidden');
    expect(f.image.outerHTML).toBe(original);
    expect(f.preview.outerHTML).toBe(preview); expect(f.button.outerHTML).toBe(button);
    // A responsive resize changes geometry, never image styling or mask coordinates.
    box(f.panel, 500.5, 500); b.sync(true);
    expect(f.image.outerHTML).toBe(original);
    b.sync(false);
    expect(f.panel.style.backgroundColor).toBe('rgb(20, 20, 20)');
    expect(f.backdrop.style.visibility).toBe('');
    expect(f.backdrop.style.transform).toBe('matrix(1.2, 0, 0, 1.2, 0, 0)');
  });
it('does not double-count nested supported roots or accept oversized modal regions', () => {
  const f = modalFixture();
  const outer = document.createElement('div'); outer.className = 'note-detail-container';
  f.root.replaceWith(outer); outer.append(f.root);
  expect(findImagePanel(document)).toBe(f.panel);
  box(f.panel, 700, 684); expect(findImagePanel(document)).toBeNull();
});
it('only hides the structurally confirmed duplicate without interactive descendants', () => {
  const f = modalFixture(); const b = new ImageBackground(document);
  const copy = f.backdrop.querySelector('img'); copy.src = 'other.webp';
  b.sync(true); expect(f.backdrop.style.visibility).toBe('');
  copy.src = 'photo.webp';
  const action = document.createElement('div'); action.setAttribute('role', 'button'); f.backdrop.append(action);
  b.sync(true); expect(f.backdrop.style.visibility).toBe('');
  action.remove(); b.sync(true); expect(f.backdrop.style.visibility).toBe('hidden');
  f.backdrop.style.visibility = 'collapse'; b.clear();
  expect(f.backdrop.style.visibility).toBe('collapse');
});
it('observes modal carousel changes and restores immediately on close with glow off', async () => {
  const f = modalFixture();
  const adapter = new DouyinAmbientAdapter({ document, window,
    settings: { ...DEFAULTS, enabled: false, imageBlackBackground: true },
    controller: { setVideo() {}, stop() {}, setVirtualRect() {} },
    renderer: { setVisible() {}, unmount() {} }, logger: { debug() {} } });
  adapter.init(); const observer = adapter.mutationObserver;
  try {
    expect(f.backdrop.style.visibility).toBe('hidden');
    // Resource changes must re-evaluate the relationship, then accept the next slide image.
    f.image.src = 'next.webp'; await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.backdrop.style.visibility).toBe('');
    f.backdrop.querySelector('img').src = 'next.webp';
    box(f.image, 640, 360); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.backdrop.style.visibility).toBe('hidden');
    f.root.hidden = true; await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.backdrop.style.visibility).toBe('');
    expect(adapter.imageBackground.records.size).toBe(0);
    f.root.hidden = false; await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.backdrop.style.visibility).toBe('hidden');
    history.replaceState({}, '', '/user/example'); adapter.handleNavigation();
    expect(f.backdrop.style.visibility).toBe('');
    expect(adapter.imageBackground.records.size).toBe(0);
    expect(adapter.mutationObserver).toBe(observer);
  } finally { adapter.destroy(); }
});
