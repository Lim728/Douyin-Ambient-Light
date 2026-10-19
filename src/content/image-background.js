/** Conservative adapter for the observed Douyin note-detail image carousel.
 * Never walks beyond the image viewport, samples pixels, or edits foreground images.
 */
import { isElementVisible, visibleArea } from '../shared/utils.js';

// Both roots are observed in real note pages / profile modal diagnostics.
export const IMAGE_ROOT_SELECTOR = '.note-detail-container, .basePlayerContainer.modalPlayer';
const PANEL = '.focusPanel';
const SLIDE = '.dySwiperSlide';

export function findImagePanel(document) {
  const view = document.defaultView;
  const location = document.location;
  const detail = /^\/(note|video)\/[^/]+/.test(location.pathname) || Boolean(new URLSearchParams(location.search).get('modal_id'));
  if (!detail) return null;
  const candidates = new Set();
  for (const root of document.querySelectorAll(IMAGE_ROOT_SELECTOR)) {
    for (const panel of root.querySelectorAll(PANEL)) {
      if (!isElementVisible(panel) || panel.closest('[hidden], [aria-hidden="true"]')) continue;
      const rect = panel.getBoundingClientRect();
      // CSS geometry can exceed the integer viewport by a fractional pixel (691.3 vs 691).
      if (rect.width < 160 || rect.height < 160 || rect.width > view.innerWidth + 1 || rect.height > view.innerHeight * 1.1) continue;
      if (visibleArea(rect, view.innerWidth, view.innerHeight) < rect.width * rect.height * 0.5) continue;
      if (panel.querySelector('nav, header, aside, textarea, [data-e2e*="comment"], [data-e2e*="like"]')) continue;
      if (!panel.querySelector(`${SLIDE} img, ${SLIDE} [role="img"]`) &&
          ![...panel.querySelectorAll(SLIDE)].some(el => view.getComputedStyle(el).backgroundImage.includes('url('))) continue;
      candidates.add(panel);
    }
  }
  // Ambiguous overlapping viewers are safer left unchanged.
  return candidates.size === 1 ? [...candidates][0] : null;
}

export class ImageBackground {
  constructor(document) {
    this.document = document;
    this.records = new Map();
  }

  sync(enabled) {
    const panel = enabled ? findImagePanel(this.document) : null;
    const desired = new Map();
    const view = this.document.defaultView;
    if (panel) {
      desired.set(panel, ['background-color', '#000000']);
      for (const slide of panel.querySelectorAll(SLIDE)) {
        desired.set(slide, ['background-color', '#000000']);
        // Observed structure: original IMG and an absolute, negative-z backdrop DIV
        // containing a blurred duplicate. Hide only that decorative DIV, never the IMG.
        for (const img of slide.querySelectorAll('img')) {
          if (view.getComputedStyle(img).filter.includes('blur(')) continue;
          const wrapper = img.parentElement;
          if (!wrapper || wrapper === slide || !wrapper.matches('div')) continue;
          const foreground = [...wrapper.children].filter(el => el.tagName === 'IMG' && !view.getComputedStyle(el).filter.includes('blur('));
          if (!foreground.length || !foreground.some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })) continue;
          desired.set(wrapper, ['background-color', '#000000']);
          for (const backdrop of wrapper.children) {
            if (backdrop.tagName !== 'DIV') continue;
            const style = view.getComputedStyle(backdrop);
            if (style.position !== 'absolute' || !(Number(style.zIndex) < 0)) continue;
            const copies = [...backdrop.querySelectorAll('img')];
            const duplicate = copies.length === 1 && foreground.some(el => el.getAttribute('src') && el.getAttribute('src') === copies[0].getAttribute('src')) && view.getComputedStyle(copies[0]).filter.includes('blur(');
            if (duplicate && !backdrop.querySelector('button, a, input, textarea, select, [role="button"], [contenteditable="true"]')) desired.set(backdrop, ['visibility', 'hidden']);
          }
        }
      }
    }
    for (const el of this.records.keys()) if (!desired.has(el)) this.restore(el);
    for (const [el, [property, value]] of desired) {
      let record = this.records.get(el);
      if (record && record.property !== property) { this.restore(el); record = null; }
      if (!record || !this.owns(el, record)) {
        record = { property, value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property), applied: '', appliedPriority: '' };
        this.records.set(el, record);
      }
      if (record.applied && this.owns(el, record)) continue;
      el.style.setProperty(property, value, 'important');
      record.applied = el.style.getPropertyValue(property);
      record.appliedPriority = el.style.getPropertyPriority(property);
    }
  }

  owns(el, record) {
    return el.style.getPropertyPriority(record.property) === record.appliedPriority && el.style.getPropertyValue(record.property) === record.applied;
  }

  restore(el) {
    const record = this.records.get(el);
    if (record && this.owns(el, record)) {
      if (record.value) el.style.setProperty(record.property, record.value, record.priority);
      else el.style.removeProperty(record.property);
    }
    this.records.delete(el);
  }

  clear() {
    for (const el of this.records.keys()) this.restore(el);
  }
}
