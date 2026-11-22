// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollFade } from './scroll-fade.tsx';

function setGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('ScrollFade', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not fade when the content fits', () => {
    const { container } = render(<ScrollFade>x</ScrollFade>);
    const el = container.firstElementChild as HTMLElement;
    setGeometry(el, 100, 100);
    el.dispatchEvent(new Event('scroll'));
    expect(el.dataset.fadeTop).toBeUndefined();
    expect(el.dataset.fadeBottom).toBeUndefined();
  });

  it('fades the bottom while more lies below, then the top once scrolled, and not the bottom at the end', async () => {
    const { container } = render(<ScrollFade>x</ScrollFade>);
    const el = container.firstElementChild as HTMLElement;
    setGeometry(el, 500, 200);
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(el.dataset.fadeBottom).toBe('true'));
    expect(el.dataset.fadeTop).toBeUndefined();
    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(el.dataset.fadeTop).toBe('true'));
    expect(el.dataset.fadeBottom).toBe('true');
    el.scrollTop = 300;
    el.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(el.dataset.fadeBottom).toBeUndefined());
    expect(el.dataset.fadeTop).toBe('true');
  });
});
