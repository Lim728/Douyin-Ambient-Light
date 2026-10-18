/**
 * End to end smoke test.
 *
 * Loads the built extension (dist/) into a real Chromium and serves a local stand-in for a
 * Douyin feed card at the real `https://www.douyin.com/` origin, so the shipped match
 * patterns and content scripts are exercised exactly as they would be on the site.
 *
 * The checks mirror what the extension has to survive on the real page: a query string, SPA
 * route changes, several players at once, a destroyed and recreated player, and the two
 * failure modes that used to make the effect invisible (an opaque page covering a z-index:-1
 * layer, and unreadable video pixels).
 *
 * Run with: npm run test:e2e   (requires `npm run build` first)
 */

import { chromium } from 'playwright-core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dist = join(root, 'dist');

const CANDIDATE_BROWSERS = [
  process.env.DAL_CHROME,
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1223/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error('dist/ not found - run `npm run build` first');
  }
  const executablePath = CANDIDATE_BROWSERS.find((path) => path && existsSync(path));
  if (!executablePath) throw new Error('no Chromium based browser found');

  const userDataDir = await mkdtemp(join(tmpdir(), 'dal-e2e-'));
  const harness = await readFile(join(here, 'harness.html'), 'utf8');

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-position=-3000,-3000',
      '--window-size=1300,900',
    ],
  });

  const consoleErrors = [];
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`${page.url()}: ${error.message}`));
  });

  try {
    // Serve the harness for the whole Douyin origin. A RegExp is used on purpose: it also
    // matches URLs that carry a query string (`/?recommend=1`, `/video/123?x=1`).
    await context.route(/^https:\/\/www\.douyin\.com\/.*/, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harness })
    );
    await context.route(/^https:\/\/live\.douyin\.com\/.*/, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harness })
    );

    const page = await context.newPage();
    // The exact URL from the bug report: a query string must not change anything.
    await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#player');

    // ---------------------------------------------------------------- activation
    await page.waitForFunction(() => document.documentElement.getAttribute('data-dal') === 'on', null, {
      timeout: 10_000,
    });
    const boot = await page.evaluate(() => ({
      href: location.href,
      search: location.search,
      dal: document.documentElement.getAttribute('data-dal'),
      mode: document.documentElement.getAttribute('data-dal-mode'),
    }));
    check(
      'content script activates on douyin.com?recommend=1',
      boot.dal === 'on' && boot.search === '?recommend=1',
      boot.href
    );
    check('default layer mode is the force visible overlay', boot.mode === 'overlay', String(boot.mode));

    // ---------------------------------------------------------------- SPA routing
    // Douyin is a single page app: the feed navigates with history.pushState and the player
    // is re-created in place. Nothing in the extension keys off the page URL.
    await page.evaluate(() => history.pushState({}, '', '/video/7300000000000000000?recommend=1'));
    await sleep(500);
    const routed = await page.evaluate(() => ({
      href: location.href,
      dal: document.documentElement.getAttribute('data-dal'),
      hasRoot: Boolean(document.querySelector('.dal-root')),
      videos: document.querySelectorAll('video').length,
    }));
    check(
      'SPA route change keeps the effect alive',
      routed.href.includes('/video/') && routed.dal === 'on' && routed.hasRoot && routed.videos >= 1,
      JSON.stringify(routed)
    );
    await page.evaluate(() => history.replaceState({}, '', '/?recommend=1'));

    // ---------------------------------------------------------------- layer
    await page
      .waitForFunction(
        () => {
          const root = document.querySelector('.dal-root');
          const canvas = root?.shadowRoot?.querySelector('.dal-canvas');
          return Boolean(canvas) && canvas.width !== 300 && canvas.height !== 150;
        },
        null,
        { timeout: 5000 }
      )
      .catch(() => {});

    const layer = await page.evaluate(() => {
      const root = document.querySelector('.dal-root');
      const canvas = root?.shadowRoot?.querySelector('.dal-canvas') ?? null;
      const style = root ? getComputedStyle(root) : null;
      return {
        hasRoot: Boolean(root),
        insideShadowRoot: Boolean(canvas),
        canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
        zIndex: style?.zIndex ?? null,
        position: style?.position ?? null,
        parent: root?.parentElement?.tagName ?? null,
        clearedAncestors: document.querySelectorAll('[data-dal-clear]').length,
        htmlBackground: document.documentElement.style.backgroundColor,
        rootBackground: style?.backgroundColor ?? null,
      };
    });
    check(
      'a high z-index overlay layer is mounted (inside a shadow root)',
      layer.hasRoot &&
        layer.insideShadowRoot &&
        layer.canvasSize !== '300x150' &&
        layer.position === 'fixed' &&
        Number(layer.zIndex) > 1_000_000 &&
        layer.parent === 'HTML',
      JSON.stringify({ ...layer, canvasSize: layer.canvasSize })
    );
    check(
      'the page itself is left untouched in overlay mode',
      layer.clearedAncestors === 0 && !layer.htmlBackground,
      JSON.stringify({ cleared: layer.clearedAncestors, background: layer.htmlBackground })
    );
    // The overlay is painted *on top* of the page, so it has to be transparent outside the
    // glow: an opaque root would hide the whole Douyin interface.
    const rootAlpha = Number(
      (String(layer.rootBackground ?? '').match(/rgba?\(([^)]+)\)/)?.[1] ?? '').split(',')[3]
    );
    check(
      'the overlay layer stays transparent (page stays visible under the glow)',
      layer.rootBackground === 'rgba(0, 0, 0, 0)' || rootAlpha === 0,
      String(layer.rootBackground)
    );

    const glowStats = () =>
      page.evaluate(() => {
        const root = document.querySelector('.dal-root');
        const canvas = root?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let lit = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue;
          lit++;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const mean = { r: r / Math.max(1, lit), g: g / Math.max(1, lit), b: b / Math.max(1, lit) };
        return {
          lit,
          ratio: lit / (data.length / 4),
          mean,
          signature: `${Math.round(mean.r)},${Math.round(mean.g)},${Math.round(mean.b)}`,
        };
      });

    const alphaAt = (where) =>
      page.evaluate((target) => {
        const root = document.querySelector('.dal-root');
        const canvas = root?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');
        const video = document.querySelector('#player');
        if (!canvas || !video) return null;
        const rect = video.getBoundingClientRect();
        const scale = canvas.width / window.innerWidth;
        const x = target === 'inside' ? rect.left + rect.width / 2 : rect.right + 30;
        const y = rect.top + rect.height / 2;
        const ctx = canvas.getContext('2d');
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
        return ctx.getImageData(px, py, 1, 1).data[3];
      }, where);

    // ---------------------------------------------------------------- blue scene
    await page.evaluate(() => window.__harness.setColor('#1240d8', '#4f8dff'));
    await sleep(2500);
    const blue = await glowStats();
    check('glow follows a blue scene', Boolean(blue) && blue.mean.b > blue.mean.r + 20, JSON.stringify(blue?.mean));
    check(
      'the glow is painted next to the player',
      Boolean(blue) && blue.ratio > 0.02 && blue.lit > 500,
      `lit=${blue?.lit} ratio=${blue?.ratio}`
    );
    const holeAlpha = await alphaAt('inside');
    const outsideAlpha = await alphaAt('outside');
    check(
      'the video area is punched out (layer never covers the player)',
      holeAlpha === 0 && outsideAlpha > 0,
      `inside=${holeAlpha} outside=${outsideAlpha}`
    );

    // ------------------------------------------------------- spatially independent zones
    // The acceptance criteria for the zoned renderer: the halo is not one averaged colour any
    // more, every zone lights (or stays dark) on its own. Each scenario paints an exact 3x3
    // grid into the harness video and the checks read the *rendered* canvas next to the zone.
    let zoneWorker = context.serviceWorkers()[0];
    if (!zoneWorker) zoneWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
    const writeSettings = (patch) => {
      if (!zoneWorker) return Promise.resolve();
      return zoneWorker.evaluate(async (next) => {
        const { settings } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(settings ?? {}), ...next } });
      }, patch);
    };
    // A short smoothing time constant keeps the seven scenarios quick and deterministic.
    await writeSettings({ smoothness: 0, samplingFps: 15, fullPageBackground: true });
    await sleep(600);

    const haloAt = (zone) =>
      page.evaluate((target) => {
        const root = document.querySelector('.dal-root');
        const canvas = root?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');
        const video = document.querySelector('#player');
        if (!canvas || !video) return null;
        const rect = video.getBoundingClientRect();
        const vw = video.videoWidth || 480;
        const vh = video.videoHeight || 270;
        const elAspect = rect.width / rect.height;
        const vAspect = vw / vh;
        let pw;
        let ph;
        if (vAspect > elAspect) {
          pw = rect.width;
          ph = rect.width / vAspect;
        } else {
          ph = rect.height;
          pw = rect.height * vAspect;
        }
        const left = rect.left + (rect.width - pw) / 2;
        const top = rect.top + (rect.height - ph) / 2;
        const cx = left + pw / 2;
        const cy = top + ph / 2;
        const d = 34;
        const points = {
          tl: [left - d, top - d],
          tc: [cx, top - d],
          tr: [left + pw + d, top - d],
          ml: [left - d, cy],
          mr: [left + pw + d, cy],
          bl: [left - d, top + ph + d],
          bc: [cx, top + ph + d],
          br: [left + pw + d, top + ph + d],
        };
        const [sx, sy] = points[target] ?? points.tl;
        const host = document.documentElement;
        const scaleX = canvas.width / (host.clientWidth || window.innerWidth);
        const scaleY = canvas.height / (host.clientHeight || window.innerHeight);
        const px = Math.max(0, Math.min(canvas.width - 1, Math.round(sx * scaleX)));
        const py = Math.max(0, Math.min(canvas.height - 1, Math.round(sy * scaleY)));
        const data = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
        return { r: data[0], g: data[1], b: data[2], a: data[3] };
      }, zone);

    const zones = (map) => page.evaluate((next) => window.__harness.setZones(next), map);
    const tint = (c) => (c ? `a${c.a}(${c.r},${c.g},${c.b})` : 'null');

    // A: a fully black frame must not light anything up.
    await zones({});
    await sleep(900);
    const dark = {
      tl: await haloAt('tl'), tc: await haloAt('tc'), tr: await haloAt('tr'),
      ml: await haloAt('ml'), mr: await haloAt('mr'),
      bl: await haloAt('bl'), bc: await haloAt('bc'), br: await haloAt('br'),
    };
    const darkMax = Math.max(...Object.values(dark).map((c) => c.a));
    check('A: an all black frame keeps every zone dark', darkMax < 12, `maxAlpha=${darkMax}`);

    // B: red top left only.
    await zones({ tl: '#ff0000' });
    await sleep(900);
    const b = { tl: await haloAt('tl'), tr: await haloAt('tr'), br: await haloAt('br') };
    check(
      'B: a red top left zone lights only the top left',
      b.tl.a > 25 && b.tl.r > b.tl.g + 25 && b.tl.r > b.tl.b + 25 && b.tr.a < 18 && b.br.a < 18,
      `tl=${tint(b.tl)} tr=${tint(b.tr)} br=${tint(b.br)}`
    );

    // C: blue top right only.
    await zones({ tr: '#0000ff' });
    await sleep(900);
    const c = { tr: await haloAt('tr'), tl: await haloAt('tl'), br: await haloAt('br') };
    check(
      'C: a blue top right zone lights only the top right',
      c.tr.a > 25 && c.tr.b > c.tr.r + 25 && c.tl.a < 18 && c.br.a < 18,
      `tr=${tint(c.tr)} tl=${tint(c.tl)} br=${tint(c.br)}`
    );

    // D: red left, blue right, black in the middle.
    await zones({ ml: '#ff0000', bl: '#ff0000', mr: '#0000ff', br: '#0000ff' });
    await sleep(900);
    const d = { ml: await haloAt('ml'), mr: await haloAt('mr'), bc: await haloAt('bc') };
    check(
      'D: left stays red and right stays blue without polluting the middle',
      d.ml.a > 25 && d.ml.r > d.ml.b + 25 && d.mr.a > 25 && d.mr.b > d.mr.r + 25 && d.bc.a < 18,
      `ml=${tint(d.ml)} mr=${tint(d.mr)} bc=${tint(d.bc)}`
    );

    // E: white top, black bottom.
    await zones({ tl: '#ffffff', tc: '#ffffff', tr: '#ffffff' });
    await sleep(900);
    const e = { tc: await haloAt('tc'), bc: await haloAt('bc') };
    check(
      'E: a white top row lights the top and leaves the bottom dark',
      e.tc.a > 30 && e.bc.a < 18,
      `tc=${tint(e.tc)} bc=${tint(e.bc)}`
    );

    // F: everything white -> even ring.
    await zones({ tl: '#ffffff', tc: '#ffffff', tr: '#ffffff', ml: '#ffffff', mr: '#ffffff', bl: '#ffffff', bc: '#ffffff', br: '#ffffff' });
    await sleep(900);
    const f = { tc: await haloAt('tc'), bc: await haloAt('bc'), ml: await haloAt('ml') };
    check(
      'F: a fully white frame lights the whole ring evenly',
      f.tc.a > 30 && f.bc.a > 30 && Math.abs(f.tc.a - f.bc.a) < 60,
      `tc=${tint(f.tc)} bc=${tint(f.bc)} ml=${tint(f.ml)}`
    );

    // G: red / green / blue in three different zones.
    await zones({ tl: '#ff0000', tc: '#00ff00', tr: '#0000ff' });
    await sleep(900);
    const g = { tl: await haloAt('tl'), tc: await haloAt('tc'), tr: await haloAt('tr') };
    check(
      'G: red / green / blue keep their own colour (no global average)',
      g.tl.r > g.tl.g + 25 && g.tl.r > g.tl.b + 25 &&
        g.tc.g > g.tc.r + 25 && g.tc.g > g.tc.b + 25 &&
        g.tr.b > g.tr.r + 25 && g.tr.b > g.tr.g + 25,
      `tl=${tint(g.tl)} tc=${tint(g.tc)} tr=${tint(g.tr)}`
    );

    // ------------------------------------------------- resolution / quality switch
    // Douyin swaps the stream behind the same <video> element (360p -> 720p -> 1080p, or back).
    // The sampling buffer must keep its fixed working size, the zones must stay independent, the
    // halo must follow the new picture, and the renderer must NOT be rebuilt for any of it.
    await page.evaluate(() => {
      window.__dalCanvas = document.querySelector('.dal-root')?.shadowRoot?.querySelector('.dal-canvas') ?? null;
    });
    check(
      'the overlay canvas is tagged before the quality switch',
      await page.evaluate(() => Boolean(window.__dalCanvas))
    );

    // A pattern that must survive every resolution change unchanged.
    await zones({ tl: '#ff0000', tr: '#0000ff' });
    await sleep(700);
    await page.evaluate(() => window.__harness.setResolution(640, 360));
    await sleep(1800);
    const up = await page.evaluate(() => ({
      media: window.__harness.resolution(),
      sameCanvas:
        window.__dalCanvas ===
        (document.querySelector('.dal-root')?.shadowRoot?.querySelector('.dal-canvas') ?? null),
      status: (() => {
        try {
          return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
        } catch {
          return null;
        }
      })(),
    }));
    check('the video reports the new media resolution', up.media.width === 640 && up.media.height === 360, JSON.stringify(up.media));
    check('the renderer is not rebuilt by a quality switch', up.sameCanvas === true);
    check(
      'the sampling buffer keeps its fixed working size',
      up.status?.sample === '96x54' && up.status?.media === '640x360',
      JSON.stringify({ sample: up.status?.sample, media: up.status?.media })
    );
    check('the quality switch is counted', (up.status?.switches ?? 0) >= 1, String(up.status?.switches));
    const upZones = { tl: await haloAt('tl'), tr: await haloAt('tr'), bc: await haloAt('bc') };
    check(
      'zones stay independent after the resolution change',
      upZones.tl.r > upZones.tl.b + 25 && upZones.tr.b > upZones.tr.r + 25 && upZones.bc.a < 18,
      `tl=${tint(upZones.tl)} tr=${tint(upZones.tr)} bc=${tint(upZones.bc)}`
    );

    // Same picture, 3x higher resolution: the zone colours must not move at all.
    await page.evaluate(() => window.__harness.setResolution(1920, 1080));
    await sleep(1800);
    const bigger = await page.evaluate(() => ({
      media: window.__harness.resolution(),
      status: (() => {
        try {
          return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
        } catch {
          return null;
        }
      })(),
    }));
    check('a 1080p stream is picked up', bigger.media.width === 1920 && bigger.media.height === 1080, JSON.stringify(bigger.media));
    check(
      'the sampling cost does not follow the source resolution',
      bigger.status?.sample === '96x54',
      JSON.stringify({ sample: bigger.status?.sample, media: bigger.status?.media })
    );
    const bigZones = { tl: await haloAt('tl'), tr: await haloAt('tr'), bc: await haloAt('bc') };
    check(
      'the same picture keeps the same zones at 1080p',
      bigZones.tl.r > bigZones.tl.b + 25 && bigZones.tr.b > bigZones.tr.r + 25 && bigZones.bc.a < 18,
      `tl=${tint(bigZones.tl)} tr=${tint(bigZones.tr)} bc=${tint(bigZones.bc)}`
    );

    // ... and down again (1080p -> 720p), which is the switch that used to drop frames.
    await page.evaluate(() => window.__harness.setResolution(1280, 720));
    await sleep(1800);
    const down = await page.evaluate(() => ({
      media: window.__harness.resolution(),
      paused: window.__harness.player.paused,
      status: (() => {
        try {
          return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
        } catch {
          return null;
        }
      })(),
    }));
    check('a shrink to 720p is picked up', down.media.width === 1280 && down.media.height === 720, JSON.stringify(down.media));
    check('the player keeps playing across the switch', down.paused === false, String(down.paused));
    const downZones = { tl: await haloAt('tl'), tr: await haloAt('tr'), bc: await haloAt('bc') };
    check(
      'the same picture keeps the same zones at 720p',
      downZones.tl.r > downZones.tl.b + 25 && downZones.tr.b > downZones.tr.r + 25 && downZones.bc.a < 18,
      `tl=${tint(downZones.tl)} tr=${tint(downZones.tr)} bc=${tint(downZones.bc)}`
    );
    await page.evaluate(() => window.__harness.setColor('#1b6bff', '#7fbcff'));
    await sleep(1500);
    const afterSwitches = await glowStats();
    check(
      'the halo keeps following the picture after three switches',
      afterSwitches && afterSwitches.mean.b > afterSwitches.mean.r + 20,
      JSON.stringify(afterSwitches?.mean)
    );

    // Restore the normal scene (while smoothing is still off, so it snaps back) and settings.
    await page.evaluate(() => window.__harness.setColor('#1b6bff', '#7fbcff'));
    await sleep(500);
    await writeSettings({ smoothness: 72 });
    await sleep(400);

    // ------------------------------------------------- off screen second player
    // The harness mounts a second, off screen <video> painted green behind a feed-video
    // marker. The detector must keep following the visible blue card instead.
    const ghostState = await page.evaluate(() => ({
      count: document.querySelectorAll('video').length,
      ghostPresent: Boolean(document.getElementById('ghost')),
    }));
    check(
      'two players coexist in the harness',
      ghostState.count >= 2 && ghostState.ghostPresent,
      `videos=${ghostState.count}`
    );
    check('the off screen player was ignored', blue && blue.mean.b > blue.mean.g + 20, JSON.stringify(blue?.mean));

    // ---------------------------------------------------------------- smoothing
    await page.evaluate(() => window.__harness.setColor('#d81a12', '#ff7a3d'));
    await sleep(250);
    const during = await glowStats();
    check(
      'colour transition is smoothed (still blue right after the cut)',
      during && during.mean.b > during.mean.r,
      JSON.stringify(during?.mean)
    );

    await sleep(3500);
    const red = await glowStats();
    check('glow settles on the red scene', red && red.mean.r > red.mean.b + 20, JSON.stringify(red?.mean));

    // ---------------------------------------------------------------- pause
    await page.evaluate(() => window.__harness.player.pause());
    await sleep(600);
    const pausedA = await glowStats();
    await sleep(1500);
    const pausedB = await glowStats();
    check(
      'sampling stops while paused',
      pausedA && pausedB && pausedA.signature === pausedB.signature,
      `${pausedA?.signature} -> ${pausedB?.signature}`
    );

    await page.evaluate(() => window.__harness.player.play());
    await page.evaluate(() => window.__harness.setColor('#0a8fd0', '#6fd0ff'));
    await sleep(2500);
    const resumed = await glowStats();
    check('sampling resumes on play', resumed && resumed.mean.b > resumed.mean.r + 20, JSON.stringify(resumed?.mean));

    // ---------------------------------------------------------------- SPA remount
    await page.evaluate(() => window.__harness.remount());
    await page.waitForSelector('#player');
    await sleep(1500);
    await page.evaluate(() => window.__harness.setColor('#12b45a', '#7dffb0'));
    await sleep(2500);
    const green = await glowStats();
    check('follows a recreated player element', green && green.mean.g > green.mean.r + 20, JSON.stringify(green?.mean));

    // ---------------------------------------------------------------- status
    const statusAttribute = await page.evaluate(() => {
      try {
        return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
      } catch {
        return null;
      }
    });
    check(
      'the diagnostics snapshot is published on <html>',
      Boolean(statusAttribute) &&
        statusAttribute.mode === 'overlay' &&
        statusAttribute.picked &&
        statusAttribute.sampling === 'ok' &&
        statusAttribute.renderer === 'active',
      JSON.stringify(statusAttribute)
    );

    // ---------------------------------------------------------------- popup
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    check('service worker registered', Boolean(extensionId), extensionId);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForSelector('[data-key="enabled"] .dal-switch-track');
    const popupStatus = await popup.textContent('#dal-popup-status');
    check('popup reports the Douyin tab status', /已开启|采样|等待视频/.test(popupStatus ?? ''), popupStatus ?? '');

    const matchedTabs = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: ['https://www.douyin.com/*', 'https://live.douyin.com/*'] });
      return tabs.map((tab) => tab.url);
    });
    check(
      'host permission matches a tab whose URL has a query string',
      matchedTabs.some((url) => url.includes('recommend=1')),
      JSON.stringify(matchedTabs)
    );

    // ---------------------------------------------------------------- popup chrome
    const popupChrome = await popup.evaluate(() => {
      const master = document.getElementById('dal-master');
      const tabs = [...document.querySelectorAll('.dal-tab')].map((tab) => ({
        name: tab.dataset.tab,
        active: tab.classList.contains('is-active'),
      }));
      const glowFields = [...document.querySelectorAll('[data-panel="glow"] .dal-field')].map(
        (field) => field.dataset.key
      );
      const morePanel = document.querySelector('[data-panel="more"]');
      const blur = document.querySelector('[data-key="blur"] input[type="range"]');
      return {
        hasMaster: Boolean(master) && master.dataset.key === 'enabled',
        masterChecked: document.getElementById('dal-master-toggle')?.checked ?? null,
        masterLabel: document.getElementById('dal-master-label')?.textContent ?? '',
        tabs,
        glowFields,
        moreHidden: Boolean(morePanel?.hidden),
        blurFill: blur?.style.getPropertyValue('--dal-fill') ?? '',
        dotClass: document.getElementById('dal-popup-dot')?.className ?? '',
      };
    });
    check(
      'popup has the master switch and the 光效 / 更多 tabs',
      popupChrome.hasMaster &&
        popupChrome.masterChecked === true &&
        popupChrome.masterLabel === '开启' &&
        popupChrome.tabs.length === 2 &&
        popupChrome.tabs[0].name === 'glow' &&
        popupChrome.tabs[0].active === true &&
        popupChrome.tabs[1].name === 'more' &&
        popupChrome.tabs[1].active === false,
      JSON.stringify(popupChrome.tabs)
    );
    check(
      'the 光效 tab shows the five glow sliders with a live track fill',
      popupChrome.glowFields.join(',') === 'blur,intensity,spread,smoothness,edgeFocus' &&
        popupChrome.blurFill !== '' &&
        popupChrome.moreHidden === true &&
        popupChrome.dotClass.includes('is-on'),
      JSON.stringify({ fields: popupChrome.glowFields, fill: popupChrome.blurFill, dot: popupChrome.dotClass })
    );

    await popup.click('.dal-tab[data-tab="more"]');
    await sleep(300);
    const moreTab = await popup.evaluate(() => ({
      moreHidden: Boolean(document.querySelector('[data-panel="more"]')?.hidden),
      glowHidden: Boolean(document.querySelector('[data-panel="glow"]')?.hidden),
      active: document.querySelector('.dal-tab[data-tab="more"]')?.classList.contains('is-active') ?? false,
      fields: [...document.querySelectorAll('[data-panel="more"] .dal-field')].map((field) => field.dataset.key),
    }));
    check(
      'the 更多 tab reveals the sampling and background switches',
      moreTab.moreHidden === false &&
        moreTab.glowHidden === true &&
        moreTab.active &&
        moreTab.fields.join(',') === 'samplingFps,fullPageBackground,pureBlackBackground',
      JSON.stringify(moreTab)
    );

    // ------------------------------------------------------ pure black background toggle
    const pureBlackField = await popup.evaluate(() => {
      const field = document.querySelector('[data-key="pureBlackBackground"]');
      const input = field?.querySelector('input[type="checkbox"]');
      return {
        present: Boolean(field),
        label: (field?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        checked: input?.checked ?? null,
      };
    });
    check(
      'popup exposes the pure black background toggle (off by default)',
      pureBlackField.present && pureBlackField.checked === false && pureBlackField.label.includes('纯黑背景'),
      JSON.stringify(pureBlackField)
    );

    await popup.click('[data-key="pureBlackBackground"] .dal-switch-track');
    await sleep(700);
    const pureBlackStored = await popup.evaluate(
      async () => (await chrome.storage.sync.get('settings')).settings?.pureBlackBackground
    );
    check('the popup toggle saves the pure black choice', pureBlackStored === true, String(pureBlackStored));

    await sleep(1200);
    const inkWhileOn = await page.evaluate(() => ({
      marker: document.documentElement.getAttribute('data-dal-black'),
      inked: document.querySelectorAll('[data-dal-ink]').length,
      html: getComputedStyle(document.documentElement).backgroundColor,
    }));
    check(
      'the popup toggle actually reaches the page (background turns black)',
      inkWhileOn.marker === '1' && inkWhileOn.inked === 1 && inkWhileOn.html === 'rgb(22, 24, 35)',
      JSON.stringify(inkWhileOn)
    );

    await popup.click('[data-key="pureBlackBackground"] .dal-switch-track');
    await sleep(1400);
    const inkAfterOff = await page.evaluate(() => ({
      marker: document.documentElement.getAttribute('data-dal-black'),
      inked: document.querySelectorAll('[data-dal-ink]').length,
      html: getComputedStyle(document.documentElement).backgroundColor,
    }));
    check(
      'turning the popup toggle off restores the page background',
      inkAfterOff.marker === null && inkAfterOff.inked === 0 && inkAfterOff.html === 'rgb(22, 24, 35)',
      JSON.stringify(inkAfterOff)
    );

    // ------------------------------------------------------- debug / force mode
    const setSettings = (patch) =>
      popup.evaluate(async (next) => {
        const { settings } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(settings ?? {}), ...next } });
      }, patch);

    await setSettings({ debugForce: true, debugColor: '#ff0000' });
    await sleep(2500);
    const forcedRed = await glowStats();
    check(
      'debug / force mode paints red without reading any pixel',
      forcedRed && forcedRed.mean.r > 150 && forcedRed.mean.r > forcedRed.mean.b + 60,
      JSON.stringify(forcedRed?.mean)
    );

    await setSettings({ debugForce: true, debugColor: '#0064ff' });
    await sleep(2000);
    const forcedBlue = await glowStats();
    check(
      'debug / force mode follows the configured colour',
      forcedBlue && forcedBlue.mean.b > 150 && forcedBlue.mean.b > forcedBlue.mean.r + 60,
      JSON.stringify(forcedBlue?.mean)
    );

    await setSettings({ debugForce: false });
    await sleep(1500);

    // ---------------------------------------------------------- pure black background
    // This is the only option that writes to the page's *own* backgrounds, so it gets a full
    // round trip on the real page: on -> the wall behind the player is #000; off -> the page's
    // original value comes back (not transparent, not white) and an unrelated element is
    // never touched.
    await page.evaluate(() => {
      if (document.getElementById('dal-unrelated')) return;
      const node = document.createElement('div');
      node.id = 'dal-unrelated';
      node.style.background = 'rgb(255, 0, 0)';
      node.style.width = '12px';
      node.style.height = '12px';
      document.body.append(node);
    });
    const beforeBlack = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      rootInline: document.querySelector('#root').style.getPropertyValue('background-color'),
    }));

    await setSettings({ pureBlackBackground: true });
    await sleep(1800);
    const blackOn = await page.evaluate(() => {
      const inked = Array.from(document.querySelectorAll('[data-dal-ink]'));
      const root = document.querySelector('#player').closest('.xgplayer');
      const status = JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? '{}');
      return {
        marker: document.documentElement.getAttribute('data-dal-black'),
        inked: inked.length,
        connected: inked.every((node) => node.isConnected),
        html: getComputedStyle(document.documentElement).backgroundColor,
        root: getComputedStyle(root).backgroundColor,
        rootPriority: root.style.getPropertyPriority('background-color'),
        videoUntouched: document.querySelector('#player').style.getPropertyValue('background-color'),
        unrelated: getComputedStyle(document.getElementById('dal-unrelated')).backgroundColor,
        black: status.black ?? 0,
      };
    });
    check(
      'pure black: the background behind the player turns solid black',
      blackOn.marker === '1' &&
        blackOn.html === 'rgb(22, 24, 35)' &&
        blackOn.root === 'rgb(0, 0, 0)' &&
        blackOn.rootPriority === 'important',
      JSON.stringify({ marker: blackOn.marker, html: blackOn.html, root: blackOn.root })
    );
    check(
      'pure black: only the video chain is inked and it is reported in the status',
      blackOn.inked === 1 && blackOn.connected && blackOn.black === 1,
      JSON.stringify({ inked: blackOn.inked, black: blackOn.black })
    );
    check(
      'pure black: the <video> and unrelated elements keep their own background',
      blackOn.videoUntouched === '' && blackOn.unrelated === 'rgb(255, 0, 0)',
      JSON.stringify({ video: blackOn.videoUntouched, unrelated: blackOn.unrelated })
    );

    // SPA / player swap: the old chain is restored, the new one is inked, no residue.
    await page.evaluate(() => window.__harness.remount());
    await sleep(1800);
    const blackAfterRemount = await page.evaluate(() => {
      const inked = Array.from(document.querySelectorAll('[data-dal-ink]'));
      return {
        inked: inked.length,
        connected: inked.every((node) => node.isConnected),
        cardInked: Boolean(document.querySelector('.xgplayer[data-dal-ink]')),
        root: getComputedStyle(document.querySelector('#root')).backgroundColor,
      };
    });
    check(
      'pure black: survives a recreated player without leftover markers',
      blackAfterRemount.connected &&
        blackAfterRemount.cardInked &&
        blackAfterRemount.inked === 1 &&
        blackAfterRemount.root !== 'rgb(0, 0, 0)',
      JSON.stringify(blackAfterRemount)
    );

    await setSettings({ enabled: false, fullPageBackground: false });
    await sleep(1800);
    const blackWithoutGlow = await page.evaluate(() => ({
      glow: Boolean(document.querySelector('.dal-root')),
      background: getComputedStyle(document.querySelector('#player').closest('.xgplayer')).backgroundColor,
    }));
    check('black remains scoped when glow and full-page wash are off',
      !blackWithoutGlow.glow && blackWithoutGlow.background === 'rgb(0, 0, 0)', JSON.stringify(blackWithoutGlow));
    await setSettings({ enabled: true, fullPageBackground: true });
    await sleep(1800);
    await setSettings({ pureBlackBackground: false });
    await sleep(1800);
    const blackOff = await page.evaluate(() => {
      const status = JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? '{}');
      return {
        marker: document.documentElement.getAttribute('data-dal-black'),
        inked: document.querySelectorAll('[data-dal-ink]').length,
        html: getComputedStyle(document.documentElement).backgroundColor,
        htmlPriority: document.documentElement.style.getPropertyPriority('background-color'),
        rootInline: document.querySelector('#root').style.getPropertyValue('background-color'),
        unrelated: getComputedStyle(document.getElementById('dal-unrelated')).backgroundColor,
        dal: document.documentElement.getAttribute('data-dal'),
        renderer: status.renderer,
      };
    });
    check(
      'pure black: switching off restores the original page background',
      blackOff.marker === null &&
        blackOff.inked === 0 &&
        blackOff.html === beforeBlack.html &&
        blackOff.htmlPriority === '' &&
        blackOff.rootInline === beforeBlack.rootInline,
      JSON.stringify({ html: blackOff.html, before: beforeBlack.html, rootInline: blackOff.rootInline })
    );
    check(
      'pure black: switching off does not disable the ambient light',
      blackOff.dal === 'on' && blackOff.renderer === 'active' && blackOff.unrelated === 'rgb(255, 0, 0)',
      JSON.stringify({ dal: blackOff.dal, renderer: blackOff.renderer })
    );
    await page.evaluate(() => document.getElementById('dal-unrelated')?.remove());

    // ---------------------------------------------------------------- disable
    await popup.click('[data-key="enabled"] .dal-switch-track');
    await sleep(1500);
    const storedEnabled = await popup.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      return settings?.enabled;
    });
    check('popup writes the settings to storage', storedEnabled === false, String(storedEnabled));

    const disabled = await page.evaluate(() => ({
      rootAttribute: document.documentElement.getAttribute('data-dal'),
      modeAttribute: document.documentElement.getAttribute('data-dal-mode'),
      hasRoot: Boolean(document.querySelector('.dal-root')),
      stillCleared: Boolean(document.querySelector('[data-dal-clear]')),
    }));
    check(
      'turning it off restores the page',
      disabled.rootAttribute === null && disabled.modeAttribute === null && !disabled.hasRoot && !disabled.stillCleared,
      JSON.stringify(disabled)
    );

    // Sliders hit the storage layer too; turn it back on for the options page check.
    await popup.click('[data-key="enabled"] .dal-switch-track');
    await sleep(1200);

    // ---------------------------------------------------------------- options page
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForSelector('#dal-settings [data-key="blur"] input');
    await sleep(1200);
    const previewPainted = await options.evaluate(() => {
      const root = document.querySelector('.dal-root');
      const canvas = root?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum > 0;
    });
    check('options preview renders through the real renderer', previewPainted === true);

    const sliderCount = await options.locator('#dal-settings .dal-field').count();
    check('options page exposes every setting', sliderCount >= 18, `${sliderCount} fields`);

    const diagnostics = await options.locator('#dal-status dt').count();
    check('options page shows the diagnostics panel', diagnostics >= 10, `${diagnostics} rows`);

    // ------------------------------------------------- destroyed player
    await page.evaluate(() => window.__harness.unmount());
    await sleep(2200);
    const gone = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      rootAttribute: document.documentElement.getAttribute('data-dal'),
      hasRoot: Boolean(document.querySelector('.dal-root')),
      cleared: document.querySelectorAll('[data-dal-clear]').length,
    }));
    check(
      'removing every player restores the page',
      gone.videos === 0 && gone.rootAttribute === null && !gone.hasRoot && gone.cleared === 0,
      JSON.stringify(gone)
    );

    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
