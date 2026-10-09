/**
 * Live preview used on the options page.
 *
 * It does not fake anything: a small animated scene is rendered into a canvas which is then
 * fed through the *real* ColorSampler, ColorSmoother and AmbientRenderer used on Douyin.
 * Tuning a slider therefore behaves exactly like it will on the site.
 */

import { AmbientRenderer } from '../content/ambient-renderer.js';
import { ColorSampler } from '../content/color-sampler.js';
import { ColorSmoother } from '../content/color-smoother.js';

/** Scene definitions: a vertical gradient plus a couple of moving highlight blobs. */
const SCENES = [
  { label: '深海蓝', top: '#0b2a6b', bottom: '#04102c', accent: '#3aa0ff' },
  { label: '熔岩红', top: '#6d1a0c', bottom: '#2a0703', accent: '#ff5a2e' },
  { label: '森林绿', top: '#0d3a24', bottom: '#04160e', accent: '#37d17a' },
  { label: '午夜黑', top: '#0a0a0d', bottom: '#050506', accent: '#22262f' },
  { label: '暖阳橙', top: '#7a4a08', bottom: '#2a1802', accent: '#ffb347' },
  { label: '霓虹紫', top: '#3a0a6b', bottom: '#170330', accent: '#b06bff' },
];

const SCENE_DURATION_MS = 6000;
const FRAME_INTERVAL_MS = 1000 / 20;
const SOURCE_WIDTH = 480;
const SOURCE_HEIGHT = 270;

export function createPreview(options) {
  const { stage, player, canvas, label, document } = options;
  const context = canvas.getContext('2d', { alpha: false });

  const renderer = new AmbientRenderer({ document, mode: 'preview', measureTarget: stage });
  const sampler = new ColorSampler({ logger: { warn: () => {}, info: () => {} } });
  const smoother = new ColorSmoother();

  renderer.mount(stage);
  renderer.setVisible(true);

  let settings = options.settings;
  let timer = 0;
  let sceneIndex = 0;
  let sceneStartedAt = 0;
  let lastUpdate = 0;
  let source = null;

  const ensureSource = () => {
    if (!source) {
      source = document.createElement('canvas');
      source.width = SOURCE_WIDTH;
      source.height = SOURCE_HEIGHT;
    }
    return source;
  };

  function drawScene(ctx, time) {
    const scene = SCENES[sceneIndex];
    const gradient = ctx.createLinearGradient(0, 0, 0, SOURCE_HEIGHT);
    gradient.addColorStop(0, scene.top);
    gradient.addColorStop(1, scene.bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const phase = time / 1400 + i * 2.1;
      const x = SOURCE_WIDTH * (0.5 + 0.42 * Math.sin(phase));
      const y = SOURCE_HEIGHT * (0.5 + 0.38 * Math.cos(phase * 1.3 + i));
      const radius = 90 + 60 * Math.sin(phase * 0.7 + i * 1.7);
      const blob = ctx.createRadialGradient(x, y, 0, x, y, Math.max(20, radius));
      blob.addColorStop(0, `${scene.accent}bb`);
      blob.addColorStop(1, `${scene.accent}00`);
      ctx.fillStyle = blob;
      ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Vignette so the sampled edges are not uniformly bright.
    const vignette = ctx.createRadialGradient(
      SOURCE_WIDTH / 2,
      SOURCE_HEIGHT / 2,
      SOURCE_HEIGHT * 0.25,
      SOURCE_WIDTH / 2,
      SOURCE_HEIGHT / 2,
      SOURCE_WIDTH * 0.7
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  }

  function frame() {
    const now = performance.now();
    if (now - sceneStartedAt > SCENE_DURATION_MS) {
      sceneIndex = (sceneIndex + 1) % SCENES.length;
      sceneStartedAt = now;
      if (label) label.textContent = SCENES[sceneIndex].label;
    }

    const dt = lastUpdate ? (now - lastUpdate) / 1000 : 1 / 20;
    lastUpdate = now;

    const sourceCanvas = ensureSource();
    const sceneCtx = sourceCanvas.getContext('2d', { alpha: false });
    drawScene(sceneCtx, now - sceneStartedAt);
    context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);

    const raw = sampler.sample(sourceCanvas, {
      left: 0,
      top: 0,
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      right: SOURCE_WIDTH,
      bottom: SOURCE_HEIGHT,
    });
    if (raw) {
      const colors = smoother.update(raw, dt);
      const stageRect = stage.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      renderer.render({
        rect: {
          left: playerRect.left - stageRect.left,
          top: playerRect.top - stageRect.top,
          width: playerRect.width,
          height: playerRect.height,
          right: playerRect.right - stageRect.left,
          bottom: playerRect.bottom - stageRect.top,
        },
        videoWidth: SOURCE_WIDTH,
        videoHeight: SOURCE_HEIGHT,
        objectFit: 'contain',
        colors,
      });
    }
  }

  return {
    start() {
      if (timer) return;
      sceneStartedAt = performance.now();
      lastUpdate = 0;
      if (label) label.textContent = SCENES[sceneIndex].label;
      timer = setInterval(frame, FRAME_INTERVAL_MS);
      frame();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = 0;
    },
    setSettings(next) {
      settings = next;
      renderer.setSettings(next);
      smoother.setSmoothness(next.smoothness);
      sampler.setOptions({ detectBars: next.detectBars, zoneGrid: next.zoneGrid });
    },
    invalidate() {
      renderer.invalidate();
    },
    renderer,
    get settings() {
      return settings;
    },
  };
}
