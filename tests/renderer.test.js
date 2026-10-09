import { describe, expect, it } from 'vitest';
import { pictureRect } from '../src/content/ambient-renderer.js';

describe('pictureRect', () => {
  const box = { left: 100, top: 50, width: 400, height: 400, right: 500, bottom: 450 };

  it('returns the element box unchanged for cover / fill / none', () => {
    expect(pictureRect(box, 1080, 1920, 'cover')).toEqual({ ...box });
    expect(pictureRect(box, 1080, 1920, 'fill')).toEqual({ ...box });
  });

  it('letterboxes a wide video inside a square box (object-fit: contain)', () => {
    const rect = pictureRect(box, 1920, 1080, 'contain');
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(225);
    expect(rect.top).toBe(50 + (400 - 225) / 2);
    expect(rect.left).toBe(100);
  });

  it('pillarboxes a tall video inside a wide box', () => {
    const wide = { left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200 };
    const rect = pictureRect(wide, 1080, 1920, 'contain');
    expect(rect.height).toBe(200);
    expect(rect.width).toBeCloseTo(112.5, 5);
  });

  it('falls back to the box when the video size is unknown', () => {
    expect(pictureRect(box, 0, 0, 'contain')).toEqual({ ...box });
  });

  it('handles a missing rect', () => {
    expect(pictureRect(null, 1920, 1080, 'contain')).toBeNull();
  });
});
