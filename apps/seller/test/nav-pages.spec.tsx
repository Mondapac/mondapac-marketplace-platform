// @vitest-environment jsdom
// Regression (owner report 2026-10-15): every seller nav link opened /account-setup. A seller who
// is not approved yet is sent there by every other page, so the shell must not offer those links
// before approval; an approved seller's links must each open their own page.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '@mondapac/ui';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sellerNav, sellerNavItems } from '../src/nav.ts';
import { SETUP_ROOT } from '../src/setup/steps.ts';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../app/(shell)');
const ALL_KEYS = sellerNav.items.flatMap((item) => item.anyOf ?? []);

afterEach(cleanup);

/** The page file a nav href opens, and the sources its guard lives in (the page and its loader). */
function pageSources(href: string): readonly string[] {
  const file = join(APP, href, 'page.tsx');
  expect(existsSync(file), `no page for ${href}`).toBe(true);
  const page = readFileSync(file, 'utf8');
  const loaders = [...page.matchAll(/from '((?:\.\.\/)+src\/server\/[\w-]+\.tsx?)'/g)].map(
    (match) => readFileSync(resolve(dirname(file), match[1] as string), 'utf8'),
  );
  return [page, ...loaders];
}

/** Clicks every link of the rendered sidebar and returns the href each one opens. */
function clickEach(items: ReturnType<typeof sellerNavItems>): string[] {
  render(<Sidebar panelName="Seller" items={items} activeId="" label={(key) => key} />);
  const opened: string[] = [];
  for (const link of screen.getAllByRole('link')) {
    link.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    opened.push(link.getAttribute('href') as string);
  }
  return opened;
}

describe('seller nav: each main page opens', () => {
  it('an approved seller gets every page but setup, and no page sends them to setup', () => {
    const opened = clickEach(sellerNavItems('approved', ALL_KEYS));
    expect(opened).toEqual(
      sellerNav.items.filter((item) => item.href !== SETUP_ROOT).map((item) => item.href),
    );
    for (const href of opened) {
      for (const source of pageSources(href)) {
        // The only way to setup is the not-approved guard.
        const toSetup = source.match(/[^\n]*redirect\(SETUP_ROOT\)/g) ?? [];
        for (const line of toSetup) expect(line, href).toMatch(/sellerAccessState !== 'approved'/);
      }
    }
  });

  it.each(['pending', 'rejected'] as const)(
    'a %s seller is offered only setup, never a link that bounces there',
    (state) => {
      expect(clickEach(sellerNavItems(state, ALL_KEYS))).toEqual([SETUP_ROOT]);
    },
  );

  it('every page outside setup sends a seller who is not approved to setup', () => {
    for (const item of sellerNav.items.filter((entry) => entry.href !== SETUP_ROOT)) {
      const guarded = pageSources(item.href).some((source) =>
        /sellerAccessState !== 'approved'\) redirect\(SETUP_ROOT\)/.test(source),
      );
      expect(guarded, item.href).toBe(true);
    }
  });
});
