import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/shared/config.js';
import {
  __resetMemoryStore,
  loadSettings,
  onSettingsChanged,
  patchSettings,
  resetSettings,
  saveSettings,
} from '../src/shared/storage.js';

beforeEach(() => {
  __resetMemoryStore();
  vi.unstubAllGlobals();
});

describe('storage without the extension APIs', () => {
  it('returns the defaults on a cold start', async () => {
    expect(await loadSettings()).toEqual(DEFAULTS);
  });

  it('round-trips a saved object', async () => {
    await saveSettings({ ...DEFAULTS, blur: 12, enabled: false });
    const loaded = await loadSettings();
    expect(loaded.blur).toBe(12);
    expect(loaded.enabled).toBe(false);
  });

  it('normalises broken input before storing', async () => {
    await saveSettings({ ...DEFAULTS, blur: 5000, backgroundColor: 'nope' });
    const loaded = await loadSettings();
    expect(loaded.blur).toBe(100);
    expect(loaded.backgroundColor).toBe(DEFAULTS.backgroundColor);
  });

  it('patches only the given keys', async () => {
    await saveSettings({ ...DEFAULTS, blur: 20, intensity: 150 });
    const { settings } = await patchSettings({ intensity: 50 });
    expect(settings.blur).toBe(20);
    expect(settings.intensity).toBe(50);
  });

  it('restores the defaults', async () => {
    await saveSettings({ ...DEFAULTS, blur: 3 });
    const { settings } = await resetSettings();
    expect(settings).toEqual(DEFAULTS);
  });

  it('returns a no-op unsubscribe without chrome.storage', () => {
    const unsubscribe = onSettingsChanged(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('storage with chrome.storage available', () => {
  function installChrome(store) {
    const listeners = [];
    const area = {
      get: (keys, callback) => callback(Object.fromEntries(keys.map((k) => [k, store[k]]))),
      set: (items, callback) => {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        listeners.forEach((listener) => listener(changes, 'sync'));
        callback?.();
      },
    };
    vi.stubGlobal('chrome', {
      storage: { sync: area, local: area, onChanged: { addListener: (l) => listeners.push(l), removeListener: () => {} } },
      runtime: { lastError: undefined },
    });
    return listeners;
  }

  it('persists through chrome.storage.sync', async () => {
    const store = {};
    installChrome(store);
    await saveSettings({ ...DEFAULTS, spread: 33 });
    expect(store.settings.spread).toBe(33);
    const loaded = await loadSettings();
    expect(loaded.spread).toBe(33);
  });

  it('notifies subscribers when another context writes', async () => {
    const store = {};
    installChrome(store);
    const seen = [];
    const unsubscribe = onSettingsChanged((settings) => seen.push(settings));
    await saveSettings({ ...DEFAULTS, blur: 44 });
    expect(seen).toHaveLength(1);
    expect(seen[0].blur).toBe(44);
    unsubscribe();
  });
});
