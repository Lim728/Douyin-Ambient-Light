/**
 * Options page controller.
 *
 * Keeps three things in sync: the stored settings, the live preview and the Douyin tab
 * (through a status poll). Slider drags update the preview immediately but only hit
 * `chrome.storage` after the user stops moving (sync area has a write quota).
 */

import { PRESETS, normalizeSettings } from '../shared/config.js';
import { MSG } from '../shared/messages.js';
import { loadSettings, onSettingsChanged, resetSettings, saveSettings } from '../shared/storage.js';
import { debounce } from '../shared/utils.js';
import { createSettingsUI } from './settings-ui.js';
import { createPreview } from './preview-stage.js';

const el = (id) => document.getElementById(id);

async function main() {
  let settings = await loadSettings();

  const preview = createPreview({
    document,
    stage: el('dal-preview-stage'),
    player: document.querySelector('.dal-preview-player'),
    canvas: el('dal-preview-canvas'),
    label: el('dal-preview-scene'),
    settings,
  });
  preview.setSettings(settings);

  const storageNote = el('dal-storage-note');
  let writeErrorShown = false;

  const persist = debounce(async (next) => {
    const { ok } = await saveSettings(next);
    if (ok) {
      if (writeErrorShown) {
        storageNote.textContent = '';
        writeErrorShown = false;
      }
      return;
    }
    writeErrorShown = true;
    storageNote.textContent = '设置保存失败（可能是 synced storage 写入配额已满）。参数仍然生效，但关闭浏览器后不会保留。';
  }, 350);

  let ui = null;
  const apply = (next, { persist: shouldPersist = true } = {}) => {
    settings = normalizeSettings(next);
    preview.setSettings(settings);
    ui?.update(settings);
    if (shouldPersist) persist(settings);
  };

  ui = createSettingsUI({
    container: el('dal-settings'),
    settings,
    onChange: (next) => apply(next),
  });

  // --- presets ---------------------------------------------------------------
  const presetHost = el('dal-presets');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dal-preset';
    button.dataset.preset = key;
    const title = document.createElement('b');
    title.textContent = preset.label;
    const description = document.createElement('span');
    description.textContent = preset.description;
    button.append(title, description);
    button.addEventListener('click', () => apply({ ...settings, ...preset.values }));
    presetHost.append(button);
  }

  el('dal-reset').addEventListener('click', async () => {
    const restored = await resetSettings();
    apply(restored.settings, { persist: false });
  });

  onSettingsChanged((next) => {
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    apply(next, { persist: false });
  });

  // --- preview lifecycle ------------------------------------------------------
  const startPreview = () => preview.start();
  const stopPreview = () => preview.stop();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPreview();
    else startPreview();
  });
  new ResizeObserver(() => preview.invalidate()).observe(el('dal-preview'));
  startPreview();

  // --- diagnostics -------------------------------------------------------------
  el('dal-test-red').addEventListener('click', () =>
    apply({ ...settings, debugForce: true, debugColor: '#ff0000' })
  );
  el('dal-test-blue').addEventListener('click', () =>
    apply({ ...settings, debugForce: true, debugColor: '#0064ff' })
  );
  el('dal-test-off').addEventListener('click', () => apply({ ...settings, debugForce: false }));
  el('dal-open-douyin').addEventListener('click', () => {
    // A fresh tab (not a reload) is what makes the content script run on a page that was
    // already open before the extension was installed.
    chrome.tabs.create({ url: 'https://www.douyin.com/?recommend=1' });
  });

  await refreshStatus();
  setInterval(refreshStatus, 2000);

  /** One `label -> value` row of the diagnostics list. */
  function row(label, value, variant = '') {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (variant) dd.className = `dal-${variant}`;
    dd.textContent = value;
    el('dal-status').append(dt, dd);
    return dd;
  }

  /** Same, but with a colour swatch in front of the value. */
  function colourRow(label, hex) {
    const dd = row(label, hex);
    const swatch = document.createElement('span');
    swatch.className = 'dal-swatch';
    swatch.style.background = hex;
    dd.prepend(swatch);
    return dd;
  }

  async function refreshStatus() {
    const host = el('dal-status');
    const updated = el('dal-status-updated');
    const tabs = await chrome.tabs
      .query({ url: ['https://www.douyin.com/*', 'https://live.douyin.com/*'] })
      .catch(() => []);
    const active = tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
    updated.textContent = active ? `标签页 ${active.id}` : '未打开抖音';
    host.textContent = '';

    if (!active) {
      row('抖音页面 Douyin detected', 'NO', 'warn');
      row('下一步', '打开 https://www.douyin.com/ 并播放视频');
      return;
    }

    let response = null;
    try {
      response = await chrome.tabs.sendMessage(active.id, { type: MSG.GET_STATUS });
    } catch {
      response = null;
    }
    const status = response?.status;
    if (!status) {
      row('抖音页面 Douyin detected', 'YES');
      row('内容脚本 Content script', '未响应 · 请刷新抖音页面', 'warn');
      return;
    }

    const samplingLabel = {
      ok: 'OK',
      'cors-blocked': 'CORS BLOCKED',
      error: 'ERROR',
      debug: 'DEBUG (固定颜色)',
      idle: 'IDLE',
    }[status.sampling] ?? String(status.sampling ?? '-');
    const samplingVariant = status.sampling === 'ok' ? 'ok' : status.sampling === 'idle' ? '' : 'warn';

    row('抖音页面 Douyin detected', 'YES', 'ok');
    row('视频 Video detected', status.videoFound ? 'YES' : 'NO', status.videoFound ? 'ok' : 'warn');
    row('正在播放 Playing', status.playing ? 'YES' : 'NO', status.playing ? 'ok' : 'warn');
    row('视频数量 Videos on page', String(status.videoCount ?? 0));
    row('视频尺寸 Video size', status.videoSize ? status.videoSize.replace('x', ' × ') : '—');
    row(
      '视频位置 Video rect',
      status.videoRect
        ? `${status.videoRect.left},${status.videoRect.top} ${status.videoRect.width}×${status.videoRect.height}`
        : '—'
    );
    row('取色 Canvas sampling', samplingLabel, samplingVariant);
    row('取色来源 Colour source', status.source ?? '-');
    row(
      '采样分辨率 Sampling resolution',
      status.mediaSize
        ? `媒体 ${status.mediaSize.replace('x', ' × ')} → 采样缓冲 ${status.sampleBuffer ?? '—'}（画质切换 ${
            status.resolutionChanges ?? 0
          } 次）`
        : '—'
    );
    row(
      '独立分区 Zones',
      status.zoneRows
        ? `${status.zoneRows} × ${status.zoneCols}（${status.zoneLit}/${status.zoneCount} 个分区在发光）`
        : '—'
    );
    row('渲染器 Ambient renderer', status.rendererActive ? 'ACTIVE' : 'INACTIVE', status.rendererActive ? 'ok' : 'warn');
    row(
      '图层模式 Layer mode',
      `${status.layerMode === 'overlay' ? '强制覆盖 overlay' : '页面背景 background'} → ${status.rendererMount ?? '-'}`
    );
    row(
      '纯黑背景 Pure black background',
      status.pureBlackBackground ? `ON（${status.blackElements ?? 0} 个元素已涂黑）` : 'OFF',
      status.pureBlackBackground ? 'ok' : ''
    );
    colourRow('当前颜色 Current colour', status.currentColor ?? '#000000');
    row('采样帧率 Sampling FPS', `${status.samplingRate ?? 0} fps`);
    if (status.videoSrc) row('视频地址 Source', status.videoSrc);
    row('最近事件 Last event', `${status.heartbeat ?? '-'} (${status.reason ?? '-'})`);
    if (status.enabled && !status.rendererActive) {
      row('提示', '渲染层未挂载 · 请刷新抖音页面后重试', 'warn');
    }
    if (status.tainted) {
      row('警告', '视频像素被跨域保护拦住 · 已自动改用底色光晕', 'warn');
    }
  }
}

main().catch((error) => {
  console.error('[DouyinAmbient] options failed to start', error);
});
