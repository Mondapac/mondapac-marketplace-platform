// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CARD_TABLE } from '../data/card-table.ts';
import { AppShell } from './app-shell.tsx';

afterEach(cleanup);

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const labels = {
  menu: 'Menu',
  close: 'Close',
  more: 'More',
  main: 'Main',
  collapse: 'Collapse',
  expand: 'Expand',
  toasts: { region: 'Notifications', close: 'Close' },
} as never;

const zOf = (classes: string): number => {
  const match = /(?:^|\s)(?:lg:)?z-(\d+)(?:\s|$)/.exec(classes);
  return match ? Number(match[1]) : 0;
};

describe('AppShell layers', () => {
  // The top bar is a sticky layer of its own. Its popovers (user menu, search, notifications)
  // hang below it over the page, so the layer must sit above everything that stacks inside the
  // page: the sticky Actions column of every super list, sticky save bars and headers.
  it('keeps the top bar above the sticky cells of a super list, and the sidebar above the top bar', () => {
    const { container } = render(
      <AppShell sidebar={<nav />} topbar={<header>bar</header>} labels={labels}>
        <p>page</p>
      </AppShell>,
    );
    const bar = container.querySelector('header')?.parentElement?.parentElement as HTMLElement;
    const aside = container.querySelector('aside') as HTMLElement;
    expect(bar.className).toContain('sticky');
    expect(zOf(bar.className)).toBeGreaterThan(zOf(CARD_TABLE.actionsHead));
    expect(zOf(bar.className)).toBeGreaterThan(zOf(CARD_TABLE.actions));
    expect(zOf(bar.className)).toBeGreaterThan(10);
    expect(zOf(aside.className)).toBeGreaterThan(zOf(bar.className));
  });
});
