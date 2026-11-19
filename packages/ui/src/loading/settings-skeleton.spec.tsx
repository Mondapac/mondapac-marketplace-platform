// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRouteLoading } from './settings-route-loading.tsx';
import { SettingsSkeleton } from './settings-skeleton.tsx';
import {
  LOADING_SHOW_DELAY_MS,
  LOADING_SLOW_MS,
  LOADING_STALLED_MS,
} from './use-delayed-loading.ts';

// Panel loading L3: the settings form skeleton takes the page's shape (a card per section, a
// label/field pair per setting), has one status and no save bar, and the settings route's
// loading.tsx shows it after 200 ms, adds "Still loading…" at 10 s and gives up at 30 s.

afterEach(cleanup);

const sections = [{ fields: 2 }, { fields: 3, description: true }];
const count = (name: string) => document.querySelectorAll(`[data-skeleton="${name}"]`).length;

describe('SettingsSkeleton', () => {
  it('draws one card per section and one row per field, with one status and hidden bars', () => {
    render(<SettingsSkeleton label="Loading Delivery settings" sections={sections} />);
    expect(count('header')).toBe(1);
    expect(count('section')).toBe(2);
    expect(count('row')).toBe(5);
    const cards = document.querySelectorAll('[data-skeleton="section"]');
    expect(cards[0]?.querySelectorAll('[data-skeleton="row"]')).toHaveLength(2);
    expect(cards[1]?.querySelectorAll('[data-skeleton="row"]')).toHaveLength(3);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Loading Delivery settings');
    expect(cards[0]?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('lays rows out like SettingRow and does not pulse with reduced motion', () => {
    render(<SettingsSkeleton label="Loading" sections={sections} />);
    const row = document.querySelector('[data-skeleton="row"]');
    expect(row?.className).toContain('@[39rem]:grid-cols-[minmax(0,1fr)_22.5rem]');
    expect(row?.lastElementChild?.className).toContain('h-(--mp-size-control)');
    const bars = document.querySelector('[aria-hidden="true"]');
    expect(bars?.className).toContain('motion-safe:animate-pulse');
    expect(bars?.className).not.toMatch(/(^| )animate-pulse/u);
  });

  it('leaves the header out when the real one is on the page, and draws nothing before the delay', () => {
    const { rerender } = render(
      <SettingsSkeleton label="Loading" sections={sections} header={false} />,
    );
    expect(count('header')).toBe(0);
    expect(count('section')).toBe(2);
    rerender(<SettingsSkeleton label="Loading" sections={sections} visible={false} />);
    expect(count('section')).toBe(0);
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  it('adds the slow line inside the status', () => {
    render(
      <SettingsSkeleton label="Loading" sections={sections} slow slowLabel="Still loading…" />,
    );
    expect(screen.getByRole('status').textContent).toBe('LoadingStill loading…');
  });
});

describe('SettingsRouteLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const view = (subNav?: boolean) => (
    <SettingsRouteLoading
      label="Loading Tax"
      subNav={subNav}
      sections={sections}
      slowLabel="Still loading…"
      stalled={{ title: 'Too long', message: 'Try again.', retryLabel: 'Try again' }}
    />
  );

  it('shows the frame at once, the skeleton after 200 ms, the slow line at 10 s, the error at 30 s', () => {
    render(view());
    expect(document.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading Tax');
    expect(count('section')).toBe(0);
    expect(count('sub-nav')).toBe(1);
    act(() => {
      vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS);
    });
    expect(count('section')).toBe(2);
    expect(screen.queryByText('Still loading…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LOADING_SLOW_MS);
    });
    expect(screen.getByText('Still loading…')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(LOADING_STALLED_MS);
    });
    expect(count('section')).toBe(0);
    expect(screen.getByText('Try again.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(document.querySelector('main')?.getAttribute('aria-busy')).toBe('false');
  });

  it('leaves the sub-navigation column out for a page outside /settings', () => {
    render(view(false));
    expect(count('sub-nav')).toBe(0);
  });
});
