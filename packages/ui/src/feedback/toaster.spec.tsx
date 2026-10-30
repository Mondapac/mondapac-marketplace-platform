import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToastView } from './toast-store.ts';
import { ToastStack } from './toaster.tsx';

const labels = { region: 'Action notifications', close: 'Close notification' };
const view = (over: Partial<ToastView> & Pick<ToastView, 'type'>): ToastView => ({
  id: over.type,
  text: `A ${over.type} message`,
  duration: 5000,
  paused: false,
  exiting: false,
  revision: 0,
  ...over,
});
const stack = (items: ToastView[], aboveBottomBar = false) =>
  renderToStaticMarkup(
    <ToastStack items={items} labels={labels} aboveBottomBar={aboveBottomBar} />,
  );

describe('ToastStack', () => {
  it('is a named region, even when empty, and is not a live region itself', () => {
    const html = stack([]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Action notifications"');
    expect(html).not.toContain('aria-live="polite"');
  });

  it('gives an error role alert and the other types role status', () => {
    const html = stack([
      view({ type: 'success' }),
      view({ type: 'warning' }),
      view({ type: 'info' }),
      view({ type: 'loading', duration: Infinity }),
      view({ type: 'error', duration: Infinity }),
    ]);
    // The loading card has no role and is switched off, so only its result is announced.
    expect(html.match(/role="status"/g)).toHaveLength(3);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.match(/aria-live="off"/g)).toHaveLength(1);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
  });

  it('shows a still icon for the loading card under reduced motion', () => {
    const html = stack([view({ type: 'loading', duration: Infinity })]);
    expect(html).toContain('motion-reduce:hidden');
    expect(html).toContain('motion-reduce:flex');
  });

  it('marks a closing toast so it can play its exit animation', () => {
    expect(stack([view({ type: 'success', exiting: true })])).toContain('data-exiting=""');
    expect(stack([view({ type: 'success' })])).not.toContain('data-exiting=""');
  });

  it('sizes the close button and phone action targets from the control token', () => {
    const html = stack([
      view({
        type: 'error',
        duration: Infinity,
        action: { label: 'Try again', onClick: () => undefined },
      }),
    ]);
    expect(html).toContain('size-(--mp-size-control-sm)');
    expect(html).toContain('max-md:min-h-(--mp-size-control-sm)');
  });

  it('puts a labelled close button on every toast and never makes the toast itself focusable', () => {
    const html = stack([view({ type: 'success' }), view({ type: 'error', duration: Infinity })]);
    expect(html.match(/aria-label="Close notification"/g)).toHaveLength(2);
    expect(html).not.toContain('tabindex');
  });

  it('shows a progress bar only for a toast that ends, and pauses it when held', () => {
    expect(stack([view({ type: 'success' })])).toContain('animation-duration:5000ms');
    expect(stack([view({ type: 'success', paused: true })])).toContain(
      'animation-play-state:paused',
    );
    expect(stack([view({ type: 'error', duration: Infinity })])).not.toContain('data-toast-bar');
  });

  it('renders the title, text, description and action', () => {
    const html = stack([
      view({
        type: 'warning',
        title: 'Saved',
        text: '2 sellers are above the new maximum fee',
        description: 'Their fee is capped.',
        action: { label: 'Review sellers', onClick: () => undefined },
      }),
    ]);
    expect(html).toContain('Saved');
    expect(html).toContain('2 sellers are above the new maximum fee');
    expect(html).toContain('Their fee is capped.');
    expect(html).toContain('Review sellers</button>');
  });

  it('uses logical properties only and sits above the bottom bar when asked', () => {
    const plain = stack([]);
    expect(plain).toContain('md:end-4');
    expect(plain).toContain('inset-x-3');
    expect(plain).not.toMatch(/\b(?:md:)?(?:left|right)-/);
    expect(plain).not.toContain('--mp-size-bottom-bar');
    // Both placements read the save bar's offset and leave no stray character in the class.
    for (const html of [plain, stack([], true)]) {
      expect(html).toContain('var(--mp-savebar-offset,0px)');
      expect(html).not.toMatch(/class="[^"]*\}[ "]/);
    }
    expect(stack([], true)).toContain('--mp-size-bottom-bar');
  });
});
