/**
 * Settings persistence.
 *
 * Uses `chrome.storage.sync` so the tuning follows the user across Chrome / Edge profiles,
 * with a transparent fallback to `local` (and to an in-memory object when the extension
 * APIs are missing, e.g. when the module is loaded from a plain page for previewing).
 *
 * No network requests are made anywhere: the storage API is purely local to the browser
 * (the `sync` area is only mirrored by the browser itself when the user is signed in).
 */

import { DEFAULTS, SETTINGS_VERSION, STORAGE_KEY, normalizeSettings } from './config.js';

const VERSION_KEY = 'settingsVersion';

/** In-memory fallback, also used by unit tests. */
const memoryStore = new Map();

function area(name) {
  const api = globalThis.chrome?.storage;
  if (!api) return null;
  const target = api[name];
  return target && typeof target.get === 'function' ? target : null;
}

function preferredArea() {
  return area('sync') ?? area('local');
}

function readRaw(storage) {
  return new Promise((resolve) => {
    if (!storage) {
      resolve({ [STORAGE_KEY]: memoryStore.get(STORAGE_KEY), [VERSION_KEY]: memoryStore.get(VERSION_KEY) });
      return;
    }
    try {
      storage.get([STORAGE_KEY, VERSION_KEY], (result) => {
        if (globalThis.chrome?.runtime?.lastError) {
          resolve({});
          return;
        }
        resolve(result ?? {});
      });
    } catch {
      resolve({});
    }
  });
}

function writeRaw(storage, payload) {
  return new Promise((resolve) => {
    if (!storage) {
      for (const [key, value] of Object.entries(payload)) memoryStore.set(key, value);
      resolve(true);
      return;
    }
    try {
      storage.set(payload, () => resolve(!globalThis.chrome?.runtime?.lastError));
    } catch {
      resolve(false);
    }
  });
}

/** Loads, validates and migrates the stored settings. */
export async function loadSettings() {
  const storage = preferredArea();
  const raw = await readRaw(storage);
  const version = Number(raw?.[VERSION_KEY] ?? 0);
  const settings = normalizeSettings(raw?.[STORAGE_KEY]);

  if (version !== SETTINGS_VERSION) {
    // Version 0 simply means "nothing stored yet"; persist the normalised snapshot so the
    // defaults become explicit and future migrations have a baseline.
    await writeRaw(storage, { [STORAGE_KEY]: settings, [VERSION_KEY]: SETTINGS_VERSION });
  }
  return settings;
}

/** Persists a settings object (already normalised). */
export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  const ok = await writeRaw(preferredArea(), {
    [STORAGE_KEY]: normalized,
    [VERSION_KEY]: SETTINGS_VERSION,
  });
  return { ok, settings: normalized };
}

/** Shallow-merges `patch` into the stored settings and returns the result. */
export async function patchSettings(patch) {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}

/** Restores the factory defaults. */
export async function resetSettings() {
  return saveSettings({ ...DEFAULTS });
}

/**
 * Subscribes to settings changes coming from any other extension context
 * (popup <-> options page <-> content script).
 */
export function onSettingsChanged(callback) {
  const api = globalThis.chrome?.storage;
  if (!api?.onChanged?.addListener) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') return;
    const change = changes?.[STORAGE_KEY];
    if (!change) return;
    callback(normalizeSettings(change.newValue));
  };
  api.onChanged.addListener(listener);
  return () => api.onChanged.removeListener(listener);
}

/** Test helper: clears the in-memory fallback store. */
export function __resetMemoryStore() {
  memoryStore.clear();
}
