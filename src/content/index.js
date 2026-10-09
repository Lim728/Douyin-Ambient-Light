/**
 * Content script entry point.
 *
 * Wires the sampler, the smoother, the renderer and the Douyin adapter together, keeps them
 * in sync with `chrome.storage`, and answers the two messages the popup sends.
 * A single controller instance is created per document (guarded below), which is what
 * guarantees that only one sampling loop can ever run.
 */

import { AmbientRenderer } from './ambient-renderer.js';
import { AnimationController } from './animation-controller.js';
import { ColorSampler } from './color-sampler.js';
import { ColorSmoother } from './color-smoother.js';
import { DouyinAmbientAdapter } from './douyin-adapter.js';
import { MSG } from '../shared/messages.js';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/storage.js';
import { createLogger } from '../shared/utils.js';

const GLOBAL_FLAG = '__douyinAmbientLightInstalled';

async function main() {
  if (globalThis[GLOBAL_FLAG]) return;
  globalThis[GLOBAL_FLAG] = true;

  const logger = createLogger('content');
  let settings = await loadSettings();

  const sampler = new ColorSampler({ logger: createLogger('sampler') });
  const smoother = new ColorSmoother({ smoothness: settings.smoothness });
  const renderer = new AmbientRenderer({ logger: createLogger('renderer') });
  const controller = new AnimationController({ sampler, smoother, renderer, logger: createLogger('loop') });

  // The layer is only inserted into the DOM once a playable video has been found, so a
  // Douyin page without a player is left completely untouched.
  const adapter = new DouyinAmbientAdapter({ controller, renderer, settings, logger: createLogger('douyin') });

  applyCorsFlag(settings);
  controller.setSettings(settings);
  renderer.setSettings(settings);
  adapter.init();

  const unsubscribe = onSettingsChanged((next) => {
    settings = next;
    applyCorsFlag(next);
    controller.setSettings(next);
    renderer.setSettings(next);
    adapter.applySettings(next);
  });

  chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === MSG.GET_STATUS) {
      sendResponse({ ok: true, status: adapter.getStatus(), settings });
      return undefined;
    }
    if (message.type === MSG.TOGGLE) {
      const enabled = typeof message.enabled === 'boolean' ? message.enabled : !settings.enabled;
      saveSettings({ ...settings, enabled }).then(({ settings: saved }) => {
        settings = saved;
        applyCorsFlag(saved);
        controller.setSettings(saved);
        renderer.setSettings(saved);
        adapter.applySettings(saved);
        sendResponse({ ok: true, status: adapter.getStatus(), settings: saved });
      });
      return true; // async response
    }
    return undefined;
  });

  window.addEventListener(
    'pagehide',
    () => {
      unsubscribe?.();
      adapter.destroy();
      controller.destroy();
      renderer.destroy();
      delete globalThis[GLOBAL_FLAG];
    },
    { once: true }
  );

  logger.debug('ready', settings);
}

/**
 * Publishes the CORS compatibility flag to the MAIN world helper. The attribute is read
 * lazily by that script, so ordering between the two content scripts does not matter; the
 * default (attribute absent) is "enabled".
 */
function applyCorsFlag(settings) {
  const root = document.documentElement;
  if (!root) return;
  const value = settings.corsCompat ? null : 'off';
  if (value === null) root.removeAttribute('data-dal-cors');
  else root.setAttribute('data-dal-cors', value);
}

// `document_start` can run before <body> exists; the adapter mounts the layer lazily and
// re-runs detection on mutations, so a missing body is not a problem.
main().catch((error) => console.error('[DouyinAmbient] failed to start', error));
