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
  revision: 0,
  ...over,
});
const stack = (items: ToastView[], aboveBottomBar = false) =>
  renderToStaticMarkup(
    <ToastStack items={items} labels={labels} aboveBottomBar={aboveBottomBar} />,
  );

describe('ToastStack', () => {
  it('is a polite region named by its label, even when empty', () => {
    const html = stack([]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Action notifications"');
    expect(html).toContain('aria-live="polite"');
  });

  it('gives an error role alert and the other types role status', () => {
    const html = stack([
      view({ type: 'success' }),
      view({ type: 'warning' }),
      view({ type: 'info' }),
      view({ type: 'loading', duration: Infinity }),
      view({ type: 'error', duration: Infinity }),
    ]);
    expect(html.match(/role="status"/g)).toHaveLength(4);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
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
    expect(stack([], true)).toContain('--mp-size-bottom-bar');
  });
});
