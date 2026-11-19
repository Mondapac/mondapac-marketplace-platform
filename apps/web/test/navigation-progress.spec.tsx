// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import {
  NavigationProgress,
  PROGRESS_DELAY_MS,
  PROGRESS_GIVE_UP_MS,
  navigationTarget,
} from '../src/shell/navigation-progress.tsx';

// SEO package 5, follow-up 2: the thin top bar of a soft navigation. It shows only after a short
// delay, goes away when the new route renders, is announced politely, and stands still with
// reduced motion.

const route = vi.hoisted(() => ({ pathname: '/', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

const view = () => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <a href="/p/lamb-shoulder">Lamb</a>
    <a href="https://elsewhere.example/x">Away</a>
    <a href="/p/lamb-shoulder" target="_blank">
      New tab
    </a>
    <a href="#reviews">Reviews</a>
    <a href="/account" data-no-progress="">
      Panel
    </a>
    <NavigationProgress />
  </NextIntlClientProvider>
);

const bar = () => screen.queryByTestId('nav-progress');
const status = () => screen.getByRole('status');
const click = (name: string, init: MouseEventInit = {}) => {
  const link = screen.getByText(name);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  // The router cancels the browser's own navigation and runs it softly; so does this.
  act(() => {
    document.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.dispatchEvent(event);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  route.pathname = '/';
  route.search = '';
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('navigation progress bar', () => {
  it('shows nothing before the delay, then the bar and a polite status', () => {
    render(view());
    click('Lamb');
    expect(bar()).toBeNull();
    expect(status().textContent).toBe('');

    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS - 1);
    });
    expect(bar()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()?.getAttribute('data-motion')).toBe('full');
    expect(bar()?.getAttribute('aria-hidden')).toBe('true');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('Loading');
  });

  it('goes away when the new route renders', () => {
    const { rerender } = render(view());
    click('Lamb');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS);
    });
    expect(bar()).not.toBeNull();

    route.pathname = '/p/lamb-shoulder';
    rerender(view());
    expect(bar()).toBeNull();
    expect(status().textContent).toBe('');
  });

  it('never shows for a navigation faster than the delay', () => {
    const { rerender } = render(view());
    click('Lamb');
    route.pathname = '/p/lamb-shoulder';
    rerender(view());
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS * 4);
    });
    expect(bar()).toBeNull();
  });

  it('is a still bar with reduced motion', () => {
    setReducedMotion(true);
    render(view());
    click('Lamb');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS);
    });
    expect(bar()?.getAttribute('data-motion')).toBe('reduced');
  });

  it('gives up on a navigation that never renders', () => {
    render(view());
    click('Lamb');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_GIVE_UP_MS);
    });
    expect(bar()).toBeNull();
  });

  it('ignores another origin, a new tab, a hash link and a modified click', () => {
    render(view());
    click('Away');
    click('New tab');
    click('Reviews');
    click('Panel');
    click('Lamb', { metaKey: true });
    click('Lamb', { button: 1 });
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS * 2);
    });
    expect(bar()).toBeNull();
  });
});

describe('navigationTarget', () => {
  it("counts a click on a router link's inner text, which the router cancels to navigate softly", () => {
    const link = document.createElement('a');
    link.href = '/s/kedron';
    const label = document.createElement('span');
    link.append(label);
    document.body.append(link);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    event.preventDefault();
    Object.defineProperty(event, 'target', { value: label });

    expect(navigationTarget(event, new URL(window.location.href))?.pathname).toBe('/s/kedron');
    link.remove();
  });

  it('treats the same page with a trailing slash or a reordered query as no navigation', () => {
    const here = new URL('http://localhost:3000/search?q=lamb&page=2');
    const clickOn = (href: string) => {
      const link = document.createElement('a');
      link.href = href;
      document.body.append(link);
      const event = new MouseEvent('click', { bubbles: true, button: 0 });
      Object.defineProperty(event, 'target', { value: link });
      const target = navigationTarget(event, here);
      link.remove();
      return target;
    };

    expect(clickOn('/search/?page=2&q=lamb')).toBeNull();
    expect(clickOn('/search?q=lamb&page=3')?.search).toBe('?q=lamb&page=3');
  });
});
