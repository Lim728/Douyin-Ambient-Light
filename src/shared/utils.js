/**
 * Small, dependency free helpers shared by the content script, the popup and the options
 * page. Nothing in here touches the page, so it stays trivially unit testable.
 */

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Rounds to `digits` decimals; used to avoid noisy floating point comparisons. */
export const round = (value, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Coalesces repeated calls into a single trailing invocation. */
export function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
  };
  return wrapped;
}

/** Runs `fn` at most once per `wait` ms (leading edge, with a trailing catch-up call). */
export function throttle(fn, wait) {
  let last = 0;
  let timer = 0;
  let pending = null;
  const invoke = () => {
    last = Date.now();
    timer = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      pending = args;
      invoke();
    } else {
      pending = args;
      if (!timer) timer = setTimeout(invoke, remaining);
    }
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  return wrapped;
}

/** `requestAnimationFrame` wrapper that collapses multiple calls in the same frame. */
export function rafCoalesce(fn) {
  let handle = 0;
  const wrapped = () => {
    if (handle) return;
    handle = requestAnimationFrame(() => {
      handle = 0;
      fn();
    });
  };
  wrapped.cancel = () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
  };
  return wrapped;
}

/** Namespaced logger so extension output is easy to filter in the devtools console. */
export function createLogger(scope, enabled = true) {
  const prefix = `[DouyinAmbient:${scope}]`;
  const guarded = (method) => (...args) => {
    if (!enabled) return;
    // eslint-disable-next-line no-console
    console[method](prefix, ...args);
  };
  return {
    debug: guarded('debug'),
    info: guarded('info'),
    warn: guarded('warn'),
    error: guarded('error'),
    setEnabled: (value) => {
      enabled = value;
    },
  };
}

/** Visible (clipped to the viewport) area of a DOMRect. */
export function visibleArea(rect, viewportWidth, viewportHeight) {
  const width = Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
  const height = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top));
  return width * height;
}

export function rectsAlmostEqual(a, b, tolerance = 0.5) {
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < tolerance &&
    Math.abs(a.top - b.top) < tolerance &&
    Math.abs(a.width - b.width) < tolerance &&
    Math.abs(a.height - b.height) < tolerance
  );
}

/** Normalises a DOMRect into a plain, serialisable object. */
export function snapshotRect(rect) {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

/**
 * Detects whether an element (or one of its close ancestors) is actually painted.
 * Prefers the native `checkVisibility` when available and falls back to computed styles,
 * which keeps the code working in jsdom (tests) and older Chromium builds.
 */
export function isElementVisible(element, maxAncestors = 6) {
  if (!element || !element.isConnected) return false;
  let node = element;
  for (let depth = 0; node && depth <= maxAncestors; depth++, node = node.parentElement) {
    if (typeof node.checkVisibility === 'function') {
      try {
        if (!node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
      } catch {
        /* Older signatures: fall through to the style based check. */
      }
    }
    const view = element.ownerDocument?.defaultView ?? globalThis;
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(node) : null;
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (node === element && Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
}

/** Reads `window` (or the element's window) safely in tests and workers. */
export function getView(element) {
  return element?.ownerDocument?.defaultView ?? globalThis;
}
