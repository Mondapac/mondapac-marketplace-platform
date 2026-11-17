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
    settingsLinkId,
    title,
    trail,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
    readonly settingsLinkId?: string;
    readonly title: string;
    readonly trail: readonly Crumb[];
  }) => (
    <main data-active={activeId} data-link={settingsLinkId} data-title={title}>
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
  marketTimezone: 'UTC',
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
const LINK = 'delivery';
const TITLE = 'Delivery rules';
afterEach(cleanup);

describe('SettingsShell', () => {
  it('keeps the sidebar Settings item active on every settings page', async () => {
    await show('fleets', 'Delivery fleets');
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('settings');
  });

  it('builds the breadcrumb Dashboard / Settings / Group, then the page (the shell adds the title)', async () => {
    await show('fleets', 'Delivery fleets');
    const crumbs = within(screen.getByRole('list', { name: 'trail' })).getAllByRole('listitem');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('data-href')])).toEqual([
      ['Dashboard', '/'],
      ['Settings', '/settings'],
      ['Delivery', ''],
    ]);
  });

  it('names the parent page too for a page below it', async () => {
    await show('roles', 'New role', true);
    const crumbs = within(screen.getByRole('list', { name: 'trail' })).getAllByRole('listitem');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('data-href')])).toEqual([
      ['Dashboard', '/'],
      ['Settings', '/settings'],
      ['People & access', ''],
      ['Roles & permissions', '/settings/roles'],
    ]);
  });

  it('passes the current page to the shell so the sidebar can mark it', async () => {
    await show(LINK, TITLE);
    expect(document.querySelector('main')?.getAttribute('data-link')).toBe(LINK);
  });

  it('has no second navigation column; the back link shows only below the sidebar breakpoint', async () => {
    await show(LINK, TITLE);
    expect(screen.queryByRole('navigation', { name: 'Settings pages' })).toBeNull();
    const back = screen.getByRole('link', { name: 'Back to Settings' });
    expect(back.getAttribute('href')).toBe('/settings');
    expect(back.closest('div')?.className).toContain('md:hidden');
    expect(back.compareDocumentPosition(screen.getByRole('heading', { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
