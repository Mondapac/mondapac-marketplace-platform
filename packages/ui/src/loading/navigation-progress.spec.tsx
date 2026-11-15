// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NavigationProgress,
  PROGRESS_DELAY_MS,
  PROGRESS_GIVE_UP_MS,
} from './navigation-progress.tsx';

// Panel loading L1: the shared top bar. The panels pass no label (the page's own loading state
// carries the one role="status") and get the 2 px accent bar; navigation targets are covered by
// the buyer site's tests, which run the same function.

const view = (route: string, label?: string) => (
  <>
    <a href="/products">Products</a>
    <button type="button">Save</button>
    <NavigationProgress route={route} label={label} />
  </>
);

const bar = () => screen.queryByTestId('nav-progress');
const click = (name: string) => {
  const target = screen.getByText(name);
  act(() => {
    document.addEventListener('click', (e) => e.preventDefault(), { once: true });
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
};

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

describe('NavigationProgress in the panels', () => {
  it('shows the 2 px panel bar after the delay, with no status of its own', () => {
    render(view('/?'));
    click('Products');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS - 1);
    });
    expect(bar()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()?.className).toBe('mp-nav-progress');
    expect(bar()?.firstElementChild?.className).toBe('mp-nav-progress-bar');
    expect(bar()?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never starts for a button (a save shows its own spinner)', () => {
    render(view('/?'));
    click('Save');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS * 4);
    });
    expect(bar()).toBeNull();
  });

  it('ends when the route changes, and gives up after 15 s', () => {
    const { rerender } = render(view('/?'));
    click('Products');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS);
    });
    expect(bar()).not.toBeNull();
    rerender(view('/products?'));
    expect(bar()).toBeNull();

    click('Products');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_GIVE_UP_MS);
    });
    expect(bar()).toBeNull();
  });

  it('announces the label politely when one is given', () => {
    render(view('/?', 'Loading'));
    expect(screen.getByRole('status').textContent).toBe('');
    click('Products');
    act(() => {
      vi.advanceTimersByTime(PROGRESS_DELAY_MS);
    });
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });
});
