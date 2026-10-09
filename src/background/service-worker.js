/**
 * Background service worker.
 *
 * Deliberately tiny and stateless: it only forwards the keyboard shortcut to the Douyin
 * tabs and opens the options page. No network requests, no telemetry, no page data.
 */

import { MSG } from '../shared/messages.js';
import { loadSettings, saveSettings } from '../shared/storage.js';

const DOUYIN_MATCHES = ['https://www.douyin.com/*', 'https://live.douyin.com/*'];

async function broadcastToggle() {
  const current = await loadSettings();
  const next = !current.enabled;
  await saveSettings({ ...current, enabled: next });
  const tabs = await chrome.tabs.query({ url: DOUYIN_MATCHES });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE, enabled: next }).catch(() => undefined)
    )
  );
  await updateBadge(next);
}

async function updateBadge(enabled) {
  try {
    await chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#5b5b66' });
  } catch {
    /* action may not be available in every context */
  }
}

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'toggle-ambient-light') broadcastToggle().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.TOGGLE) {
    broadcastToggle().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  return undefined;
});

chrome.runtime.onInstalled?.addListener(async () => {
  const { enabled } = await loadSettings();
  await updateBadge(enabled);
});
