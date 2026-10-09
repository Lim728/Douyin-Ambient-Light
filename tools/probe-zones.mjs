/**
 * Zone calibration probe.
 *
 * Loads the built extension into a real Chromium, serves the e2e harness at
 * https://www.douyin.com/ and, for a set of 3x3 scenes, prints
 *
 *   - the colour the *video frame itself* currently holds (is the harness stream alive?),
 *   - the colour + alpha the renderer painted next to every zone, and
 *   - the zone statistics reported by the extension.
 *
 * Used to verify "where it is bright, it is bright" and to tune the e2e thresholds.
 *
 * Usage: node tools/probe-zones.mjs   (requires `npm run build` first)
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');

const browsers = [
  process.env.DAL_CHROME,
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1223/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const executablePath = browsers.find((path) => path && existsSync(path));
if (!executablePath) throw new Error('no chromium based browser found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const harness = await readFile(join(root, 'tests/e2e/harness.html'), 'utf8');
const userDataDir = await mkdtemp(join(tmpdir(), 'dal-zones-'));

const SCENARIOS = [
  ['A all black', {}],
  ['B tl red', { tl: '#ff0000' }],
  ['C tr blue', { tr: '#0000ff' }],
  ['D left red / right blue', { ml: '#ff0000', bl: '#ff0000', mr: '#0000ff', br: '#0000ff' }],
  ['E top white', { tl: '#ffffff', tc: '#ffffff', tr: '#ffffff' }],
  ['F all white', { tl: '#ffffff', tc: '#ffffff', tr: '#ffffff', ml: '#ffffff', mr: '#ffffff', bl: '#ffffff', bc: '#ffffff', br: '#ffffff' }],
  ['G rgb top row', { tl: '#ff0000', tc: '#00ff00', tr: '#0000ff' }],
];

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

/** Reads one pixel of the rendered overlay next to the given zone. */
const HALO_PROBE = (target) => {
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
};

/** Reads the colour of the video frame the sampler itself would see. */
const FRAME_PROBE = () => {
  const video = document.querySelector('#player');
  if (!video || video.readyState < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 9;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 9, 9);
  const { data } = ctx.getImageData(0, 0, 9, 9);
  const cells = [];
  for (let row = 0; row < 3; row++) {
    const line = [];
    for (let col = 0; col < 3; col++) {
      const index = (row * 9 + col) * 4;
      line.push([data[index], data[index + 1], data[index + 2]].join(','));
    }
    cells.push(line.join(' | '));
  }
  return { paused: video.paused, currentTime: Number(video.currentTime.toFixed(2)), cells };
};

try {
  await context.route(/^https:\/\/www\.douyin\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harness })
  );
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[page error] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`[uncaught] ${error.message}\n${error.stack ?? ''}`));
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#player');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dal') === 'on', null, { timeout: 10_000 });
  await sleep(1500);

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
  const write = async (patch) => {
    if (!worker) return;
    await worker.evaluate(async (next) => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...(settings ?? {}), ...next } });
    }, patch);
  };
  await write({ smoothness: 0, samplingFps: 15 });
  await sleep(800);

  for (const [label, map] of SCENARIOS) {
    await page.evaluate((next) => window.__harness.setZones(next), map);
    await sleep(1200);
    const frame = await page.evaluate(FRAME_PROBE);
    const halo = {};
    for (const zone of ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br']) {
      halo[zone] = await page.evaluate(HALO_PROBE, zone);
    }
    const status = await page.evaluate(() => {
      try {
        return JSON.parse(document.documentElement.getAttribute('data-dal-status') ?? 'null');
      } catch {
        return null;
      }
    });
    console.log(`\n=== ${label} ===`);
    console.log(`  video frame : paused=${frame?.paused} t=${frame?.currentTime}`);
    for (const line of frame?.cells ?? []) console.log(`    ${line}`);
    console.log(
      '  halo        : ' +
        Object.entries(halo)
          .map(([zone, c]) => `${zone}=a${c ? c.a : '-'}(${c ? `${c.r},${c.g},${c.b}` : '-'})`)
          .join(' ')
    );
    console.log(`  extension   : ${JSON.stringify(status)}`);
  }
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
