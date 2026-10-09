/**
 * Build script: bundles the five entry points with esbuild and copies the static assets
 * into `dist/`, which is the folder to load as an unpacked extension.
 *
 * Usage: node scripts/build.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = [
  { in: 'src/content/index.js', out: 'content.js', format: 'iife' },
  { in: 'src/main-world/cors-patcher.js', out: 'cors-patcher.js', format: 'iife' },
  { in: 'src/background/service-worker.js', out: 'background.js', format: 'esm' },
  { in: 'src/options/options.js', out: 'options.js', format: 'esm' },
  { in: 'src/popup/popup.js', out: 'popup.js', format: 'esm' },
];

const staticFiles = [
  ['src/manifest.json', 'manifest.json'],
  ['src/options/options.html', 'options.html'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/styles/ui.css', 'ui.css'],
  ['src/styles/content.css', 'content.css'],
];

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    await cp(resolve(root, from), resolve(dist, to));
  }
  await cp(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });

  // Fail loudly if an icon size is missing from the manifest/HTML contract.
  for (const size of [16, 32, 48, 128]) {
    await access(resolve(dist, `icons/icon-${size}.png`));
  }
}

/** Verifies the shipped manifest stays minimal and points at files that exist. */
async function verifyManifest() {
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  const permissions = manifest.permissions ?? [];
  if (permissions.length !== 1 || permissions[0] !== 'storage') {
    problems.push(`unexpected permissions: ${JSON.stringify(permissions)}`);
  }
  const hosts = manifest.host_permissions ?? [];
  const allowedHosts = ['https://www.douyin.com/*', 'https://live.douyin.com/*'];
  if (hosts.length !== allowedHosts.length || hosts.some((host) => !allowedHosts.includes(host))) {
    problems.push(`unexpected host_permissions: ${JSON.stringify(hosts)}`);
  }
  if ((manifest.content_scripts ?? []).some((script) => script.all_frames)) {
    problems.push('content scripts must not run in all frames');
  }
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.content_scripts ?? []).flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean);
  for (const file of new Set(referenced)) {
    try {
      await access(resolve(dist, file));
    } catch {
      problems.push(`missing file referenced by manifest: ${file}`);
    }
  }
  if (problems.length) {
    throw new Error(`manifest check failed:\n - ${problems.join('\n - ')}`);
  }
  return manifest;
}

async function run() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const options = entries.map((entry) => ({
    entryPoints: [resolve(root, entry.in)],
    outfile: resolve(dist, entry.out),
    bundle: true,
    format: entry.format,
    target: ['chrome111'],
    platform: 'browser',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    legalComments: 'none',
    logLevel: 'info',
  }));

  if (watch) {
    const contexts = await Promise.all(options.map((option) => context(option)));
    await copyStatic();
    await verifyManifest();
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build] watching…');
    return;
  }

  await Promise.all(options.map((option) => build(option)));
  await copyStatic();
  const manifest = await verifyManifest();
  await writeFile(resolve(dist, 'BUILD-INFO.json'), `${JSON.stringify({ version: manifest.version, builtAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`[build] dist ready - ${manifest.name} v${manifest.version}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
