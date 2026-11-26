// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { SectionFailed } from '../src/home/section-failed.tsx';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh }),
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

function renderHome(section: { readonly title?: string; readonly href?: string }) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SectionFailed {...section} />
    </NextIntlClientProvider>,
  );
}

describe('home page: a section whose read failed', () => {
  it('keeps its heading and Show all link, and says it did not load', () => {
    renderHome({ title: 'Special prices this week', href: '/offers' });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Special prices this week' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Show all: Special prices this week' }).getAttribute('href'),
    ).toBe('/offers');
    expect(screen.getByRole('status').textContent).toContain("This section didn't load.");
  });

  it('shows the notice alone for a section without a title (categories, the whole layout)', () => {
    renderHome({});
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByRole('region', { name: "Section that didn't load" })).toBeTruthy();
  });

  it('reads the page again on Try again', () => {
    renderHome({ title: 'Best sellers', href: '/best-sellers' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
