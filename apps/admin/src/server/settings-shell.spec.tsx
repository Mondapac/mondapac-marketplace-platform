// @vitest-environment jsdom
import type { Crumb } from '@mondapac/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { SettingsShell } from './settings-shell.tsx';
import type { AdminSession } from './session.ts';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('./admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
    title,
    trail,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
    readonly title: string;
    readonly trail: readonly Crumb[];
  }) => (
    <main data-active={activeId} data-title={title}>
      <ol aria-label="trail">
        {trail.map((crumb) => (
          <li key={crumb.label} data-href={crumb.href ?? ''}>
            {crumb.label}
          </li>
        ))}
      </ol>
      {children}
    </main>
  ),
}));

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});

const OPS = [
  'shipping.delivery-settings.view',
  'shipping.fleet-selection.view',
  'identity.platform-role.view',
];

async function show(linkId: string, title: string, nested = false, keys = OPS) {
  render(
    await SettingsShell({
      session: session(keys),
      linkId,
      title,
      nested,
      children: <h1>{title}</h1>,
    }),
  );
}
afterEach(cleanup);

describe('SettingsShell', () => {
  it('keeps the sidebar Settings item active on every settings page', async () => {
    await show('fleets', 'Delivery fleets');
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('settings');
  });

  it('builds the breadcrumb Settings / Group, then the page (the shell adds the title)', async () => {
    await show('fleets', 'Delivery fleets');
    const crumbs = within(screen.getByRole('list', { name: 'trail' })).getAllByRole('listitem');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('data-href')])).toEqual([
      ['Settings', '/settings'],
      ['Delivery', ''],
    ]);
  });

  it('names the parent page too for a page below it', async () => {
    await show('roles', 'New role', true);
    const crumbs = within(screen.getByRole('list', { name: 'trail' })).getAllByRole('listitem');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('data-href')])).toEqual([
      ['Settings', '/settings'],
      ['People & access', ''],
      ['Roles & permissions', '/settings/roles'],
    ]);
  });

  it('lists only the pages the caller may open and marks the current one', async () => {
    await show('delivery', 'Delivery rules');
    const nav = screen.getByRole('navigation', { name: 'Settings pages' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([
      ['Delivery rules', 'page'],
      ['Delivery fleets', null],
      ['Roles & permissions', null],
    ]);
    expect(within(nav).queryByText('Money')).toBeNull();
  });

  it('offers Back to Settings above the heading, and the sub-navigation only from 1180px', async () => {
    await show('delivery', 'Delivery rules');
    const back = screen.getByRole('link', { name: 'Back to Settings' });
    expect(back.getAttribute('href')).toBe('/settings');
    expect(back.closest('div')?.className).toContain('min-[1180px]:hidden');
    expect(back.compareDocumentPosition(screen.getByRole('heading', { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const column = screen.getByRole('navigation', { name: 'Settings pages' }).parentElement;
    expect(column?.className).toContain('hidden');
    expect(column?.className).toContain('min-[1180px]:block');
  });

  it('draws no sub-navigation when the caller may open no page, but keeps the back link', async () => {
    await show('delivery', 'No access', false, []);
    expect(screen.queryByRole('navigation', { name: 'Settings pages' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toBeTruthy();
  });
});
