// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import SettingsHubPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <main data-active={activeId}>{children}</main>,
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

async function show(keys: string[]) {
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });
  render(await SettingsHubPage());
}
afterEach(cleanup);

const groups = () => screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent);

describe('settings hub page', () => {
  it('shows the title, the description and every group to a super admin', async () => {
    await show([
      'notifications.support-contact.view',
      'notifications.support-contact.manage',
      'assistant.settings.view',
      'assistant.settings.manage',
      'shipping.delivery-settings.view',
      'shipping.delivery-settings.manage',
      'shipping.fleet-selection.view',
      'shipping.fleet-selection.manage',
      'wallet.settings.view',
      'wallet.settings.manage',
      'identity.admin-account.view',
      'identity.admin-account.invite',
      'identity.platform-role.view',
      'identity.platform-role.create',
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(screen.getByText(messages.settings.hub.description)).toBeTruthy();
    expect(groups()).toEqual(['Marketplace', 'Delivery', 'Money', 'People & access']);
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(screen.queryByText('View only')).toBeNull();
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('settings');
  });

  it('shows the delivery group only to an operations role', async () => {
    await show([
      'shipping.delivery-settings.view',
      'shipping.delivery-settings.manage',
      'shipping.fleet-selection.view',
      'shipping.fleet-selection.manage',
      'ordering.order.view',
    ]);
    expect(groups()).toEqual(['Delivery']);
    const region = screen.getByRole('region', { name: 'Delivery' });
    expect(
      within(region)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Delivery rules', 'Delivery fleets']);
  });

  it('shows the no-access state to a content editor, with no group', async () => {
    await show(['storefront.slide.read', 'storefront.slide.edit']);
    expect(groups()).toEqual([]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      messages.settings.hub['no-access-title'],
    );
    expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(messages.settings.hub.description)).toBeNull();
  });

  it('marks a view-only page with the chip', async () => {
    await show(['wallet.settings.view']);
    expect(screen.getByText('View only')).toBeTruthy();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await SettingsHubPage());
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
  });
});
