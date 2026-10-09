/**
 * Popup: the four controls people change most often, plus a status line and a shortcut to
 * the full options page. It talks to the content script through `chrome.tabs.sendMessage`
 * and falls back to storage-only editing when no Douyin tab is open.
 */

import { MSG } from '../shared/messages.js';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/storage.js';
import { debounce } from '../shared/utils.js';
import { createSettingsUI } from '../options/settings-ui.js';

const POPUP_KEYS = new Set([
  'enabled',
  'intensity',
  'blur',
  'spread',
  'edgeFocus',
  'smoothness',
  'samplingFps',
  'fullPageBackground',
]);

async function main() {
  let settings = await loadSettings();

  const persist = debounce((next) => saveSettings(next), 250);

  const ui = createSettingsUI({
    container: document.getElementById('dal-popup-settings'),
    settings,
    filter: (option) => POPUP_KEYS.has(option.key),
    onChange: (next) => {
      settings = next;
      persist(next);
      updateStatusLine();
    },
  });

  onSettingsChanged((next) => {
    settings = next;
    ui.update(next);
    updateStatusLine();
  });

  document.getElementById('dal-open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  const statusLine = document.getElementById('dal-popup-status');

  async function activeTab() {
    const tabs = await chrome.tabs
      .query({ url: ['https://www.douyin.com/*', 'https://live.douyin.com/*'] })
      .catch(() => []);
    return tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
  }

  async function updateStatusLine() {
    if (!settings.enabled) {
      statusLine.textContent = '已关闭 · 采样完全停止';
      return;
    }
    const tab = await activeTab();
    if (!tab) {
      statusLine.textContent = '未打开抖音页面';
      return;
    }
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS });
      const status = response?.status;
      if (!status) throw new Error('no status');
      if (status.sampling === 'debug') statusLine.textContent = '调试模式 · 固定颜色光晕';
      else if (status.tainted) statusLine.textContent = '取色被跨域拦截 · 已改用底色光晕';
      else if (!status.videoFound) statusLine.textContent = '已开启 · 等待视频播放';
      else if (status.playing)
        statusLine.textContent = `已开启 · ${status.mediaSize ?? '—'} · 采样 ${status.samplingRate} fps · ${status.currentColor}`;
      else statusLine.textContent = '已开启 · 视频已暂停';
    } catch {
      statusLine.textContent = '已开启 · 请刷新抖音页面以激活';
    }
  }

  updateStatusLine();
}

main().catch((error) => console.error('[DouyinAmbient] popup failed', error));
