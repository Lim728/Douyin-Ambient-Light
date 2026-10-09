/*
 * MAIN world helper: makes Douyin's video frames readable from a canvas.
 *
 * `canvas.getImageData()` throws a SecurityError as soon as a frame from another origin was
 * drawn into it. Douyin serves its media from `*.douyinvod.com`, which answers with
 *
 *     Access-Control-Allow-Origin: *
 *
 * (verified with a HEAD request carrying `Origin: https://www.douyin.com`), so requesting
 * the very same URL in CORS mode is safe and does not change what the player receives.
 *
 * The only thing that must be true is *timing*: `crossorigin` has to be present before the
 * media element starts loading, because changing it later restarts the load. This script
 * therefore runs at `document_start` in the page's own world and installs the attribute on
 * every video whose `src` is about to be assigned by Douyin's player.
 *
 * A watchdog removes the attribute again if the CORS load fails, so a CDN change can never
 * leave the user with an unplayable video.
 *
 * The feature can be switched off from the extension UI; the content script signals that by
 * setting `data-dal-cors="off"` on <html> (absent = enabled).
 */
(() => {
  'use strict';

  if (window.__dalCorsPatched) return;
  window.__dalCorsPatched = true;

  // Hosts known to serve Douyin media with permissive CORS headers.
  const ALLOWED_HOST =
    /(^|\.)(douyinvod\.com|douyin\.com|douyinpic\.com|douyinstatic\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com|ixigua\.com|bytedance\.com|byteimg\.com|zjcdn\.com|pstatp\.com)$/i;

  const isEnabled = () => document.documentElement?.getAttribute('data-dal-cors') !== 'off';

  const isMediaUrl = (value) => {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.startsWith('blob:') || value.startsWith('data:')) return false;
    try {
      return ALLOWED_HOST.test(new URL(value, location.href).hostname);
    } catch {
      return false;
    }
  };

  /** Adds `crossorigin="anonymous"` while the element has not started loading yet. */
  const prepare = (element, url) => {
    if (!isEnabled()) return;
    if (!(element instanceof HTMLVideoElement)) return;
    if (element.crossOrigin) return;
    // Never touch a media element that has already begun loading: changing `crossorigin`
    // at that point would abort the request and force the player to start over, which can
    // look like "the extension broke the video". `NETWORK_EMPTY` (0) means "not started".
    if (element.networkState && element.networkState !== 0) return;
    if (!isMediaUrl(url)) return;
    try {
      element.setAttribute('crossorigin', 'anonymous');
      element.__dalCorsPatched = true;
    } catch {
      /* ignore */
    }
  };

  // --- hook 1: `video.src = url` ------------------------------------------------
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor?.get && descriptor?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          prepare(this, value);
          descriptor.set.call(this, value);
        },
      });
    }
  } catch {
    /* ignore */
  }

  // --- hook 2: `video.setAttribute('src', url)` ---------------------------------
  try {
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if ((name === 'src' || name === 'SRC') && this instanceof HTMLVideoElement) prepare(this, value);
      return originalSetAttribute.call(this, name, value);
    };
  } catch {
    /* ignore */
  }

  // --- hook 3: <source src> inside a <video> ------------------------------------
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
    if (descriptor?.get && descriptor?.set) {
      Object.defineProperty(HTMLSourceElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          const parent = this.parentElement;
          if (parent instanceof HTMLVideoElement) prepare(parent, value);
          descriptor.set.call(this, value);
        },
      });
    }
  } catch {
    /* ignore */
  }

  // --- hook 4: markup inserted with a src attribute already present -------------
  const scan = (root) => {
    if (!isEnabled() || !(root instanceof Element)) return;
    if (root instanceof HTMLVideoElement) prepare(root, root.getAttribute('src') || root.currentSrc || '');
    if (root.firstElementChild) {
      for (const video of root.querySelectorAll('video')) {
        prepare(video, video.getAttribute('src') || video.currentSrc || '');
      }
      for (const source of root.querySelectorAll('source')) {
        const parent = source.parentElement;
        if (parent instanceof HTMLVideoElement) prepare(parent, source.getAttribute('src') || '');
      }
    }
  };

  const startObserver = () => {
    const target = document.documentElement;
    if (!target || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) scan(node);
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  };

  if (document.documentElement) startObserver();
  else document.addEventListener('readystatechange', startObserver, { once: true });

  // --- watchdog: never leave a video unplayable --------------------------------
  document.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement)) return;
      if (!target.__dalCorsPatched) return;
      target.__dalCorsPatched = false;
      try {
        target.removeAttribute('crossorigin');
      } catch {
        /* ignore */
      }
    },
    true
  );
})();
