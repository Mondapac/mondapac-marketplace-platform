// @vitest-environment jsdom
import type { Crumb } from '@mondapac/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { SettingsShell } from './settings-shell.tsx';
import type { SellerSession } from './session.ts';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('./seller-shell.tsx', () => ({
  SellerShell: ({
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

const session = (permissionKeys: string[]): SellerSession => ({
  accountId: 'a',
  sellerId: 's',
  permissionKeys,
  sellerAccessState: 'approved',
  email: 'ada@example.test',
  secondFactorActive: true,
  lastSignInAt: null,
  displayName: 'Ada',
  timezone: null,
  locale: null,
  csrfToken: 'c',
});

const STAFF = ['inventory.stock.view', 'payments.payout-account.view'];

async function show(linkId: string, title: string, keys = STAFF) {
  render(
    await SettingsShell({
      session: session(keys),
      linkId,
      title,
      children: <h1>{title}</h1>,
    }),
  );
}
const LINK = 'stock-locations';
const TITLE = 'Stock locations';
afterEach(cleanup);

describe('seller SettingsShell', () => {
  it('keeps the sidebar Settings item active on every settings page', async () => {
    await show('stock-locations', 'Stock locations');
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('s_settings');
  });

  it('builds the breadcrumb Dashboard / Settings / Group (the shell adds the title)', async () => {
    await show('stock-locations', 'Stock locations');
    const crumbs = within(screen.getByRole('list', { name: 'trail' })).getAllByRole('listitem');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('data-href')])).toEqual([
      ['Dashboard', '/'],
      ['Settings', '/settings'],
      ['Store', ''],
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
