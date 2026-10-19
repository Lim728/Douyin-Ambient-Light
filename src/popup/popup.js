/**
 * Popup.
 *
 * Layout follows the reference mockups: header with the app mark and a live status dot, a
 * prominent master switch, a two tab strip (光效 / 更多) and a footer action bar. The tabs
 * only decide which settings are *visible*: both panels are built from the same
 * `OPTION_SCHEMA` driven renderer the options page uses, so a setting still has exactly one
 * definition. Everything is written straight to storage (debounced) and the content script
 * picks the change up through `chrome.storage.onChanged`.
 */

import { MSG } from '../shared/messages.js';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/storage.js';
import { debounce } from '../shared/utils.js';
import { createSettingsUI } from '../options/settings-ui.js';

/**
 * The controls shown in each tab. `enabled` is not listed here: it is the master switch and
 * is rendered by the popup markup itself.
 */
const POPUP_TABS = Object.freeze({
  glow: ['blur', 'intensity', 'spread', 'smoothness', 'edgeFocus'],
  more: ['samplingFps', 'fullPageBackground', 'pureBlackBackground', 'imageBlackBackground'],
});

async function main() {
  let settings = await loadSettings();

  const persist = debounce((next) => saveSettings(next), 250);

  const statusText = /** @type {HTMLElement} */ (document.getElementById('dal-popup-status-text'));
  const statusDot = /** @type {HTMLElement} */ (document.getElementById('dal-popup-dot'));
  const master = /** @type {HTMLElement} */ (document.getElementById('dal-master'));
  const masterLabel = /** @type {HTMLElement} */ (document.getElementById('dal-master-label'));
  /** @type {HTMLInputElement} */
  const masterToggle = /** @type {any} */ (document.getElementById('dal-master-toggle'));

  const tabs = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.dal-tab')]);
  const panels = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-panel]')]);

  /** @returns {HTMLInputElement[]} */
  const rangeInputs = () =>
    /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('.dal-popup input[type="range"]')]);

  /** Mirrors the slider position into a CSS variable so the track shows a filled portion. */
  function syncRangeFills() {
    for (const input of rangeInputs()) {
      const min = Number(input.min || 0);
      const max = Number(input.max || 100);
      const span = max - min;
      const percent = span > 0 ? ((Number(input.value) - min) / span) * 100 : 0;
      input.style.setProperty('--dal-fill', `${percent}%`);
    }
  }

  function selectTab(name) {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    syncRangeFills();
  }

  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  // One delegated listener keeps the fills in sync while a slider is dragged.
  document.body.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'range') syncRangeFills();
  });

  const applyChange = (patch) => {
    settings = { ...settings, ...patch };
    persist(settings);
    reflectState();
  };

  const glowUI = createSettingsUI({
    container: document.getElementById('dal-popup-glow'),
    settings,
    filter: (option) => POPUP_TABS.glow.includes(option.key),
    onChange: (next) => applyChange(next),
  });

  const moreUI = createSettingsUI({
    container: document.getElementById('dal-popup-more'),
    settings,
    filter: (option) => POPUP_TABS.more.includes(option.key),
    onChange: (next) => applyChange(next),
  });

  masterToggle.addEventListener('change', () => applyChange({ enabled: masterToggle.checked }));

  onSettingsChanged((next) => {
    settings = next;
    glowUI.update(next);
    moreUI.update(next);
    reflectState();
  });

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
  document.getElementById('dal-open-options').addEventListener('click', openOptions);
  document.getElementById('dal-popup-info').addEventListener('click', openOptions);

  /** Paints the master switch, the dimmed "off" look and the slider fills. */
  function reflectState() {
    const on = Boolean(settings.enabled);
    masterToggle.checked = on;
    master.classList.toggle('is-on', on);
    master.classList.toggle('is-off', !on);
    masterLabel.textContent = on ? '开启' : '关闭';
    document.body.classList.toggle('dal-popup--off', !on);
    syncRangeFills();
    updateStatusLine();
  }

  /** `on` / `off` / `warn` / `idle` drives the colour of the status dot. */
  function setStatus(kind, text) {
    statusText.textContent = text;
    for (const name of ['is-on', 'is-off', 'is-warn', 'is-idle']) statusDot.classList.toggle(name, name === `is-${kind}`);
  }

  async function activeTab() {
    const tabsInWindow = await chrome.tabs
      .query({ url: ['https://www.douyin.com/*', 'https://live.douyin.com/*'] })
      .catch(() => []);
    return tabsInWindow.find((tab) => tab.active) ?? tabsInWindow[0] ?? null;
  }

  async function updateStatusLine() {
    if (!settings.enabled) {
      setStatus('off', '已关闭 · 取色器已暂停');
      return;
    }
    const tab = await activeTab();
    if (!tab) {
      setStatus('idle', '未打开抖音页面');
      return;
    }
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS });
      const status = response?.status;
      if (!status) throw new Error('no status');
      if (status.sampling === 'debug') setStatus('on', '调试模式 · 固定颜色光晕');
      else if (status.tainted) setStatus('warn', '取色被跨域拦截 · 已改用底色光晕');
      else if (!status.videoFound) setStatus('on', '已开启 · 等待视频播放');
      else if (status.playing)
        setStatus('on', `已开启 · ${status.mediaSize ?? '—'} · 采样 ${status.samplingRate} fps · ${status.currentColor}`);
      else setStatus('on', '已开启 · 视频已暂停');
    } catch {
      setStatus('warn', '已开启 · 请刷新抖音页面以激活');
    }
  }

  reflectState();
}

main().catch((error) => console.error('[DouyinAmbient] popup failed', error));
