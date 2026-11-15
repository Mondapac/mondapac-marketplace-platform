// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelNavigationProgress } from './navigation-progress.tsx';

// Panel loading L1: the shell's top bar reads the route from the router and shows the 2 px bar
// for a page navigation, with no status of its own.

const route = vi.hoisted(() => ({ pathname: '/', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = () => (
  <>
    <a href="/orders">Orders</a>
    <PanelNavigationProgress />
  </>
);

describe('PanelNavigationProgress', () => {
  it('shows the panel bar for a page navigation and ends when the route renders', () => {
    const { rerender } = render(view());
    act(() => {
      document.addEventListener('click', (e) => e.preventDefault(), { once: true });
      screen.getByText('Orders').click();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByTestId('nav-progress').className).toBe('mp-nav-progress');
    expect(screen.queryByRole('status')).toBeNull();

    route.pathname = '/orders';
    rerender(view());
    expect(screen.queryByTestId('nav-progress')).toBeNull();
  });
});
