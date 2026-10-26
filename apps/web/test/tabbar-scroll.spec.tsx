// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dock } from '../src/shell/dock.tsx';
import { TabBarAutoHide, hidesTabBar } from '../src/shell/tabbar-autohide.tsx';
import {
  HIDE_AFTER,
  INITIAL_SCROLL,
  SHOW_AFTER,
  nextTabBar,
  type TabBarScroll,
} from '../src/shell/tabbar-scroll.ts';

const MAX = 2000;
const run = (ys: readonly number[], from: TabBarScroll = INITIAL_SCROLL) =>
  ys.reduce((state, y) => nextTabBar(state, y, MAX), from);

describe('nextTabBar', () => {
  it('shows at the top and hides after scrolling down 12px', () => {
    expect(run([0, 4, 8]).hidden).toBe(false);
    const at20 = { hidden: false, anchor: 20 };
    expect(run([20 + HIDE_AFTER - 1], at20).hidden).toBe(false);
    expect(run([20 + HIDE_AFTER], at20).hidden).toBe(true);
  });

  it('needs 32px up to show it again, measured from the lowest point', () => {
    const down = run([100, 300, 400]);
    expect(down.hidden).toBe(true);
    expect(run([400 - SHOW_AFTER + 1], down).hidden).toBe(true);
    expect(run([400 - SHOW_AFTER], down).hidden).toBe(false);
    // A flick back and then down again keeps the old low point.
    expect(run([380, 420, 400], down).hidden).toBe(true);
  });

  it('shows at the top whatever happened before', () => {
    expect(run([100, 300, 400, 6], run([100, 300, 400])).hidden).toBe(false);
    expect(run([0], run([100, 300, 400])).hidden).toBe(false);
  });

  it('ignores an iOS bounce above the top and below the end', () => {
    const hidden = run([100, 300, 400]);
    expect(nextTabBar(hidden, -40, MAX)).toBe(hidden);
    expect(nextTabBar(hidden, MAX + 60, MAX)).toBe(hidden);
    const shown = run([100]);
    expect(nextTabBar(shown, MAX + 30, MAX)).toBe(shown);
    expect(nextTabBar(shown, Number.NaN, MAX)).toBe(shown);
  });

  it('does not hide a page that cannot scroll', () => {
    expect(nextTabBar(INITIAL_SCROLL, 30, 0).hidden).toBe(false);
  });
});

let path = '/p/whole-chicken';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

const root = document.documentElement;
const hidden = () => root.getAttribute('data-tabbar');

function setScroll(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function stubScreen(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') && phone,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  path = '/p/whole-chicken';
  Object.defineProperty(root, 'scrollHeight', { value: 3000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 667, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  stubScreen(true);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('TabBarAutoHide', () => {
  it('only product paths hide the tab bar', () => {
    expect(hidesTabBar('/p/whole-chicken')).toBe(true);
    expect(hidesTabBar('/p/whole-chicken/')).toBe(true);
    for (const other of ['/', '/c/poultry', '/cart', '/search', '/checkout', '/p', '/account'])
      expect(hidesTabBar(other)).toBe(false);
    expect(hidesTabBar(null)).toBe(false);
  });

  it('hides while scrolling down, shows scrolling up and at the top, and cleans up', () => {
    const view = render(<TabBarAutoHide />);
    expect(hidden()).toBeNull();
    setScroll(200);
    setScroll(260);
    expect(hidden()).toBe('hidden');
    expect(root.getAttribute('data-tabbar-moving')).toBe('true');
    setScroll(240);
    expect(hidden()).toBe('hidden');
    setScroll(220);
    expect(hidden()).toBeNull();
    setScroll(300);
    expect(hidden()).toBe('hidden');
    setScroll(2100); // bounce at the end of the page
    setScroll(-30); // bounce at the top
    expect(hidden()).toBe('hidden');
    setScroll(0);
    expect(hidden()).toBeNull();
    setScroll(400);
    expect(hidden()).toBe('hidden');
    view.unmount();
    expect(hidden()).toBeNull();
    expect(root.getAttribute('data-tabbar-moving')).toBeNull();
  });

  it('keeps the tab bar on other routes, even when mounted there', () => {
    path = '/c/poultry';
    render(<TabBarAutoHide />);
    setScroll(200);
    setScroll(400);
    expect(hidden()).toBeNull();
  });

  it('keeps the tab bar off phone screens and while the cookie bar is open', () => {
    stubScreen(false);
    const wide = render(<TabBarAutoHide />);
    setScroll(200);
    setScroll(400);
    expect(hidden()).toBeNull();
    wide.unmount();
    stubScreen(true);
    document.body.innerHTML = '<div class="consent"></div>';
    render(<TabBarAutoHide />);
    setScroll(200);
    setScroll(400);
    expect(hidden()).toBeNull();
  });

  it('does not hide on arrival mid-page (a restored scroll position)', () => {
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    render(<TabBarAutoHide />);
    expect(hidden()).toBeNull();
  });

  it('ends the moving flag after the slide', () => {
    vi.useFakeTimers();
    render(<TabBarAutoHide />);
    setScroll(200);
    setScroll(260);
    expect(root.getAttribute('data-tabbar-moving')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(root.getAttribute('data-tabbar-moving')).toBeNull();
  });
});

describe('the dock inset with the tab bar away', () => {
  const inset = () => root.style.getPropertyValue('--sf-dock-inset');

  it('is 0 while the tab bar fills the dock, and the safe area once it is slid away', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 65,
    });
    render(
      <Dock>
        <nav className="tabbar" />
      </Dock>,
    );
    expect(inset()).toBe('0px');
    root.setAttribute('data-tabbar', 'hidden');
    await act(async () => {
      await Promise.resolve();
    });
    expect(inset()).toBe('env(safe-area-inset-bottom, 0px)');
    root.removeAttribute('data-tabbar');
    await act(async () => {
      await Promise.resolve();
    });
    expect(inset()).toBe('0px');
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });
});
