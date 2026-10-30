// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { SellerSession } from '../../../src/server/session.ts';
import SettingsHubPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn(), redirect: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/seller-shell.tsx', () => ({
  SellerShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <main data-active={activeId}>{children}</main>,
}));

const session = (
  permissionKeys: string[],
  sellerAccessState: SellerSession['sellerAccessState'] = 'approved',
): SellerSession => ({
  accountId: 'a',
  sellerId: 's',
  permissionKeys,
  sellerAccessState,
  email: 'ada@example.test',
  secondFactorActive: true,
  lastSignInAt: null,
  displayName: 'Ada',
  timezone: null,
  locale: null,
  csrfToken: 'c',
});

async function show(keys: string[], state: SellerSession['sellerAccessState'] = 'approved') {
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys, state) });
  render(await SettingsHubPage());
}
afterEach(() => {
  cleanup();
  mocks.redirect.mockReset();
});

const groups = () => screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent);

describe('seller settings hub page', () => {
  it('shows the title, the description and every group to the owner', async () => {
    await show([
      'sellers.store-profile.view',
      'sellers.store-profile.edit',
      'inventory.stock.view',
      'inventory.source.edit',
      'payments.payout-account.view',
      'payments.payout-account.manage',
      'identity.team-member.view',
      'identity.team-member.invite',
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(screen.getByText(messages.settings.hub.description)).toBeTruthy();
    expect(groups()).toEqual(['Store', 'Money', 'Team']);
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByText('View only')).toBeNull();
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('s_settings');
  });

  it('shows only the stock page to staff with only the stock view key', async () => {
    await show(['inventory.stock.view', 'inventory.source.edit', 'ordering.seller-order.view']);
    expect(groups()).toEqual(['Store']);
    const region = screen.getByRole('region', { name: 'Store' });
    expect(
      within(region)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Stock locations']);
  });

  it('shows the no-access state to staff with no settings key, with no group', async () => {
    await show(['ordering.seller-order.view', 'catalog.own-product.view']);
    expect(groups()).toEqual([]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      messages.settings.hub['no-access-title'],
    );
    expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(messages.settings.hub.description)).toBeNull();
  });

  it('marks a view-only page with the chip', async () => {
    await show(['payments.payout-account.view']);
    expect(screen.getByText('View only')).toBeTruthy();
  });

  it('sends a seller who is not approved to the setup pages', async () => {
    await expect(show(['inventory.stock.view'], 'pending')).rejects.toThrow('redirect:');
    expect(mocks.redirect).toHaveBeenCalledOnce();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await SettingsHubPage());
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
  });
});
