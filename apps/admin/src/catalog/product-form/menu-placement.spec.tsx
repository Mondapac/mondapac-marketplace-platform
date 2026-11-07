// @vitest-environment jsdom
// The library Menu's placement (packages/ui has no DOM test setup), checked where the images card
// first uses `align="start"`.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '@mondapac/ui';

// The list is placed with fixed coordinates from the trigger's box. jsdom has no layout, so the
// trigger's box and the list's width are given here.
const TRIGGER = { left: 40, right: 88, top: 100, bottom: 148 };
const LIST_WIDTH = 256;

function open(align?: 'start' | 'end') {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...TRIGGER,
    width: 48,
    height: 48,
    x: TRIGGER.left,
    y: TRIGGER.top,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(LIST_WIDTH);
  render(
    <Menu
      label="Image 2 options"
      items={[{ id: 'a', label: 'Make main', onSelect: () => {} }]}
      {...(align === undefined ? {} : { align })}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Image 2 options' }));
  return screen.getByRole('menu');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Menu placement', () => {
  it('lines up with the start edge of its trigger when asked', () => {
    expect(open('start').style.left).toBe('40px');
  });

  it('keeps the end edge by default, held 8 px inside the viewport', () => {
    // 88 - 256 is off screen, so the list stops at the 8 px edge.
    expect(open().style.left).toBe('8px');
  });
});
