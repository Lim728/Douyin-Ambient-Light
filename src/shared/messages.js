/**
 * Messaging contract between the background service worker / popup and the content script.
 * Only two tiny messages ever cross this boundary; no page or video data is involved.
 */

export const MSG = Object.freeze({
  /**
   * popup -> background: flip the stored master switch and relay the new value to every
   * Douyin tab. background -> content: apply the value that is already stored.
   */
  TOGGLE: 'dal:toggle',
  /** popup -> content: ask for the current status (video found, sampling active, ...). */
  GET_STATUS: 'dal:get-status',
});
