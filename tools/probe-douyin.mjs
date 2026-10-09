/**
 * Live probe against the real https://www.douyin.com/ .
 *
 * Answers, with facts from the real page, the question "why is there no ambient light?":
 *
 *  1. how many <video> elements exist, which one is picked, and is its clock advancing,
 *  2. whether the browser lets us read that video's pixels (canvas CORS test per element),
 *  3. what the extension itself reports (`data-dal-status`) plus the state of the glow layer
 *     (mounted? which z-index? is the video area really punched out?),
 *  4. an optional force/debug round trip: the debug colour is written through the extension's
 *     own storage, so it also proves the renderer works on this page.
 *
 * Usage: node tools/probe-douyin.mjs [url] [--debug]
 *   --debug   also run the red / blue force test and save screenshots
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const args = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const url = args[0] ?? 'https://www.douyin.com/?recommend=1';
const withDebug = process.argv.includes('--debug');

const browsers = [
  process.env.DAL_CHROME,
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1223/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const executablePath = browsers.find((path) => path && existsSync(path));
if (!executablePath) throw new Error('no chromium based browser found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = await mkdtemp(join(tmpdir(), 'dal-probe-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: false,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-position=-3000,-3000',
    '--window-size=1460,1000',
  ],
});

/** Everything that can be learned about the player side of the page. */
const PAGE_PROBE = () => {
  const describe = (video, index) => {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    return {
      index,
      id: video.id || null,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      clientSize: `${video.clientWidth}x${video.clientHeight}`,
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      currentTime: Number(video.currentTime.toFixed(3)),
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
      videoSize: `${video.videoWidth}x${video.videoHeight}`,
      crossOrigin: video.crossOrigin,
      preload: video.preload,
      poster: (video.poster || '').slice(0, 140),
      src: String(video.currentSrc || video.src || '').slice(0, 140),
      objectFit: style.objectFit,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      insideXgPlayer: Boolean(video.closest('.xgplayer')),
      insideActiveCard: Boolean(video.closest('[data-e2e="feed-active-video"]')),
      markerChain: (() => {
        const chain = [];
        let node = video.parentElement;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          chain.push({
            tag: node.tagName.toLowerCase(),
            cls: String(node.className || '').slice(0, 60),
            e2e: node.getAttribute?.('data-e2e') ?? null,
            zIndex: getComputedStyle(node).zIndex,
            transform: getComputedStyle(node).transform === 'none' ? 'none' : 'has transform',
            overflow: getComputedStyle(node).overflow,
            background: getComputedStyle(node).backgroundColor,
            position: getComputedStyle(node).position,
          });
        }
        return chain;
      })(),
    };
  };

  /** Independent CORS test: draw the element into a throwaway canvas and read it back. */
  const readBackTest = (video) => {
    if (!video.videoWidth || video.readyState < 2) return { ok: false, reason: 'no-frame-yet' };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(video, 0, 0, 32, 18);
    } catch (error) {
      return { ok: false, reason: `drawImage: ${error}` };
    }
    try {
      const { data } = ctx.getImageData(0, 0, 32, 18);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const pixels = data.length / 4;
      return {
        ok: true,
        average: [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)],
      };
    } catch (error) {
      return { ok: false, reason: `getImageData: ${error.name}` };
    }
  };

  const videos = [...document.querySelectorAll('video')];
  const layer = document.querySelector('.dal-root');
  const shadowCanvas = layer?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');

  let canvasStats = null;
  if (shadowCanvas && shadowCanvas.width) {
    const ctx = shadowCanvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, shadowCanvas.width, shadowCanvas.height);
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
    canvasStats = {
      size: `${shadowCanvas.width}x${shadowCanvas.height}`,
      litRatio: Number((lit / (data.length / 4)).toFixed(3)),
      average: lit ? [Math.round(r / lit), Math.round(g / lit), Math.round(b / lit)] : null,
    };
  }

  // Is the layer really on top, and is the video area really free of glow?
  const activeVideo = videos.find((video) => !video.paused) ?? videos[0] ?? null;
  let hitTest = null;
  let holeTest = null;
  if (layer && activeVideo) {
    const rect = activeVideo.getBoundingClientRect();
    const outside = {
      x: Math.min(innerWidth - 8, Math.max(8, rect.right + 24)),
      y: Math.min(innerHeight - 8, Math.max(8, rect.top + rect.height / 2)),
    };
    if (outside.x >= rect.right) {
      const el = document.elementFromPoint(outside.x, outside.y);
      hitTest = { point: outside, topElement: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` : null };
    }
    if (shadowCanvas) {
      const scale = shadowCanvas.width / innerWidth;
      const context = shadowCanvas.getContext('2d');
      const cx = Math.round((rect.left + rect.width / 2) * scale);
      const cy = Math.round((rect.top + rect.height / 2) * scale);
      if (cx > 0 && cy > 0 && cx < shadowCanvas.width && cy < shadowCanvas.height) {
        const pixel = context.getImageData(cx, cy, 1, 1).data;
        holeTest = { alphaAtVideoCentre: pixel[3] };
      }
    }
  }

  return {
    title: document.title,
    href: location.href,
    videoCount: videos.length,
    videos: videos.slice(0, 6).map(describe),
    readBack: videos.slice(0, 6).map((video) => readBackTest(video)),
    layer: {
      present: Boolean(layer),
      classes: layer ? layer.className : null,
      zIndex: layer ? getComputedStyle(layer).zIndex : null,
      position: layer ? getComputedStyle(layer).position : null,
      display: layer ? getComputedStyle(layer).display : null,
      parent: layer?.parentElement?.tagName ?? null,
      canvas: canvasStats,
      hole: holeTest,
      topElementOutsideVideo: hitTest,
    },
    extension: {
      dalAttribute: document.documentElement.getAttribute('data-dal'),
      modeAttribute: document.documentElement.getAttribute('data-dal-mode'),
      clearedAncestors: document.querySelectorAll('[data-dal-clear]').length,
      status: (() => {
        try {
          return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
        } catch {
          return document.documentElement.getAttribute('data-dal-status');
        }
      })(),
    },
    playerMarkers: [...document.querySelectorAll('[data-e2e]')].slice(0, 12).map((n) => n.getAttribute('data-e2e')),
    xgPlayerCount: document.querySelectorAll('[class*="xgplayer"]').length,
  };
};

/** Runs the same probe twice, 1.5 s apart, so `currentTime` progress becomes visible. */
async function readTimeProgress(page) {
  const before = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentTime));
  await sleep(1500);
  const after = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentTime));
  return before.map((time, index) => Number((((after[index] ?? time) - time)).toFixed(3)));
}

let extensionId = null;
try {
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[page error] ${message.text()}`);
  });

  console.log(`navigating to ${url} …`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
    console.log(`navigation: ${error.message}`);
  });
  await page.waitForTimeout(12_000);

  const progress = await readTimeProgress(page);
  const report = await page.evaluate(PAGE_PROBE);
  report.currentTimeAdvanceInOneSecond = progress;

  console.log('\n===== real page probe =====');
  console.log(JSON.stringify(report, null, 2));

  if (withDebug) {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
    extensionId = worker ? new URL(worker.url()).host : null;
    console.log(`\n===== force / debug renderer test (extension ${extensionId ?? 'not found'}) =====`);
    if (worker) {
      for (const colour of ['#ff0000', '#0064ff']) {
        await worker.evaluate(async (patch) => {
          const { settings } = await chrome.storage.sync.get('settings');
          await chrome.storage.sync.set({ settings: { ...(settings ?? {}), ...patch } });
        }, { enabled: true, debugForce: true, debugColor: colour });
        await sleep(3000);
        const state = await page.evaluate(() => {
          const layer = document.querySelector('.dal-root');
          const canvas = layer?.shadowRoot?.querySelector('.dal-canvas') ?? document.querySelector('.dal-canvas');
          if (!canvas) return { layer: false };
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
          return {
            layer: true,
            status: document.documentElement.getAttribute('data-dal-status'),
            litRatio: Number((lit / (data.length / 4)).toFixed(3)),
            average: lit ? [Math.round(r / lit), Math.round(g / lit), Math.round(b / lit)] : null,
          };
        });
        console.log(`${colour} -> ${JSON.stringify(state)}`);
        await page.screenshot({ path: `probe-force-${colour.slice(1)}.png` }).catch(() => {});
      }
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(settings ?? {}), debugForce: false } });
      });
      console.log('debug mode disabled again (screenshots: probe-force-ff0000.png / probe-force-0064ff.png)');
    }
  }
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}