// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { SettingsHub } from '@mondapac/ui';
import { visibleSettings } from './settings-nav.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;

function hub(keys: string[]) {
  render(
    <SettingsHub
      groups={visibleSettings(keys)}
      label={text}
      labels={{ viewOnly: text('settings.hub.view-only') }}
    />,
  );
}
afterEach(cleanup);

describe('SettingsHub', () => {
  it('draws a card per group with a link per page, for a holder of every key', () => {
    hub([
      'notifications.support-contact.view',
      'assistant.settings.view',
      'shipping.delivery-settings.view',
      'shipping.fleet-selection.view',
      'wallet.settings.view',
      'identity.admin-account.view',
      'identity.platform-role.view',
      'notifications.support-contact.manage',
      'assistant.settings.manage',
      'shipping.delivery-settings.manage',
      'shipping.fleet-selection.manage',
      'wallet.settings.manage',
      'identity.admin-account.invite',
      'identity.platform-role.create',
      'promotions.settings.view',
      'promotions.settings.manage',
      'customers.account-deletion-settings.view',
      'customers.account-deletion-settings.manage',
    ]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'General',
      'Delivery',
      'Money & tax',
      'Marketing',
      'AI',
      'Privacy & data',
      'Team & access',
    ]);
    const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Support contact', '/settings/support'],
      ['Delivery rules', '/settings/delivery'],
      ['Delivery fleets', '/settings/fleets'],
      ['Customer wallet', '/settings/wallet'],
      ['Promotion rules', '/settings/promotions'],
      ['Shopping assistant', '/settings/assistant'],
      ['Account deletion', '/settings/account-deletion'],
      ['Admins', '/settings/admins'],
      ['Roles & permissions', '/settings/roles'],
    ]);
    expect(screen.queryByText('View only')).toBeNull();
  });

  it('shows only the groups with a visible link', () => {
    hub(['shipping.delivery-settings.view', 'shipping.delivery-settings.manage']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Delivery',
    ]);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Delivery rules']);
  });

  it('puts a View only chip on a page the caller can see but not change', () => {
    hub(['wallet.settings.view', 'identity.platform-role.view', 'identity.platform-role.create']);
    const wallet = screen.getByRole('link', { name: /Customer wallet/ });
    expect(within(wallet).getByText('View only')).toBeTruthy();
    const roles = screen.getByRole('link', { name: /Roles & permissions/ });
    expect(within(roles).queryByText('View only')).toBeNull();
  });

  it('names each group card by its heading', () => {
    hub(['wallet.settings.view']);
    expect(screen.getByRole('region', { name: 'Money & tax' })).toBeTruthy();
  });
});
