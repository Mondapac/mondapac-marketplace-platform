// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { SettingsHub } from '@mondapac/ui';
import { visibleSettings } from './settings-nav.ts';
import { SettingsSubNav } from './settings-sub-nav.tsx';

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
    ]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Marketplace',
      'Delivery',
      'Money',
      'People & access',
    ]);
    const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Support contact', '/settings/support'],
      ['Smart assistant', '/settings/assistant'],
      ['Delivery rules', '/settings/delivery'],
      ['Delivery fleets', '/settings/fleets'],
      ['Customer wallet', '/settings/wallet'],
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
    expect(screen.getByRole('region', { name: 'Money' })).toBeTruthy();
  });
});

describe('SettingsSubNav', () => {
  const groups = [
    {
      id: 'delivery',
      label: 'Delivery',
      links: [
        { id: 'delivery', href: '/settings/delivery', label: 'Delivery rules' },
        { id: 'fleets', href: '/settings/fleets', label: 'Delivery fleets' },
      ],
    },
    {
      id: 'money',
      label: 'Money',
      links: [{ id: 'wallet', href: '/settings/wallet', label: 'Customer wallet' }],
    },
  ];

  it('lists the groups and links in a named landmark and marks only the current page', () => {
    render(<SettingsSubNav label="Settings pages" groups={groups} activeId="fleets" />);
    const nav = screen.getByRole('navigation', { name: 'Settings pages' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Delivery rules',
      'Delivery fleets',
      'Customer wallet',
    ]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(within(nav).getByText('Money')).toBeTruthy();
  });

  it('draws nothing when the caller may open no page', () => {
    const { container } = render(
      <SettingsSubNav label="Settings pages" groups={[]} activeId="x" />,
    );
    expect(container.innerHTML).toBe('');
  });
});
