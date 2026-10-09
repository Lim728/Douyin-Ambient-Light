/**
 * Settings controls, shared by the popup and the options page.
 *
 * The markup is generated from `OPTION_SCHEMA`, so adding a setting in one place is enough.
 * Every change is reported through `onChange` immediately (so the live preview and the
 * content scripts update while dragging) - persistence is the caller's job, which lets it
 * debounce `chrome.storage` writes (the sync area has a write-per-minute quota).
 */

import { OPTION_SCHEMA } from '../shared/config.js';

const nextId = (() => {
  let counter = 0;
  return () => `dal-opt-${++counter}`;
})();

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {Record<string, any>} options.settings
 * @param {(settings: Record<string, any>, key?: string | null) => void} options.onChange
 * @param {(option: object) => boolean} [options.filter]
 */
export function createSettingsUI({ container, settings, onChange, filter }) {
  const document = container.ownerDocument;
  const controls = new Map();
  const schema = OPTION_SCHEMA.filter((option) => (filter ? filter(option) : true));

  container.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const option of schema) {
    const row = document.createElement('div');
    row.className = `dal-field dal-field--${option.type}`;
    row.dataset.key = option.key;

    const id = nextId();
    let input;

    if (option.type === 'toggle') {
      const label = document.createElement('label');
      label.className = 'dal-switch';
      label.htmlFor = id;

      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;

      const track = document.createElement('span');
      track.className = 'dal-switch-track';
      const thumb = document.createElement('span');
      thumb.className = 'dal-switch-thumb';
      track.append(thumb);

      const text = document.createElement('span');
      text.className = 'dal-switch-label';
      text.textContent = option.label;

      label.append(input, track, text);
      row.append(label);
    } else {
      const head = document.createElement('div');
      head.className = 'dal-field-head';

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = option.label;

      const value = document.createElement('output');
      value.className = 'dal-field-value';
      value.htmlFor = id;

      head.append(label, value);

      if (option.type === 'range') {
        input = document.createElement('input');
        input.type = 'range';
        input.id = id;
        input.min = String(option.min);
        input.max = String(option.max);
        input.step = String(option.step ?? 1);
        input.dataset.suffix = option.suffix ?? '';
        controls.set(`${option.key}:value`, value);
      } else if (option.type === 'select') {
        input = document.createElement('select');
        input.id = id;
        // A choice is either a plain number (sampling rate -> "12 fps") or
        // `{ value, label }` for selects with their own wording (layer mode).
        input.dataset.numeric = typeof option.options[0] === 'number' ? '1' : '0';
        for (const choice of option.options) {
          const item = document.createElement('option');
          const isObject = choice && typeof choice === 'object';
          item.value = String(isObject ? choice.value : choice);
          item.textContent = isObject ? choice.label : `${choice} fps`;
          input.append(item);
        }
      } else {
        input = document.createElement('input');
        input.type = 'color';
        input.id = id;
      }

      input.className = 'dal-input';
      row.append(head, input);
    }

    if (option.hint) {
      const hint = document.createElement('p');
      hint.className = 'dal-field-hint';
      hint.textContent = option.hint;
      row.append(hint);
    }

    controls.set(option.key, input);
    fragment.append(row);
  }

  container.append(fragment);

  const read = () => {
    const out = {};
    for (const [key, input] of controls) {
      if (!input) continue;
      if (input.type === 'checkbox') out[key] = input.checked;
      else if (input.type === 'number' || input.type === 'range' || input.dataset?.suffix !== undefined) {
        out[key] = Number(input.value);
      } else if (input.tagName === 'SELECT') out[key] = input.dataset.numeric === '1' ? Number(input.value) : input.value;
      else out[key] = input.value;
    }
    return out;
  };

  const handleInput = (event) => {
    const key = event.currentTarget?.dataset?.key ?? null;
    syncValueLabels();
    onChange(read(), key);
  };

  const listeners = [];
  for (const [key, input] of controls) {
    if (!input) continue;
    input.dataset.key = key;
    const handler = (event) => handleInput(event);
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
    listeners.push([input, handler]);
  }

  function syncValueLabels() {
    for (const option of schema) {
      const value = controls.get(`${option.key}:value`);
      if (!value) continue;
      const input = controls.get(option.key);
      value.textContent = `${input.value}${option.suffix ?? ''}`;
    }
  }

  const api = {
    update(next) {
      for (const [key, input] of controls) {
        if (!input) continue;
        const value = next[key];
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = String(value);
      }
      syncValueLabels();
    },
    read,
    destroy() {
      for (const [input, handler] of listeners) {
        input.removeEventListener('input', handler);
        input.removeEventListener('change', handler);
      }
      listeners.length = 0;
      controls.clear();
      container.textContent = '';
    },
  };

  api.update(settings);
  return api;
}
