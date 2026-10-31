// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { SettingsHub } from './settings-hub.tsx';
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

const OWNER = [
  'sellers.store-profile.view',
  'sellers.store-profile.edit',
  'inventory.stock.view',
  'inventory.source.edit',
  'payments.payout-account.view',
  'payments.payout-account.manage',
  'identity.team-member.view',
  'identity.team-member.invite',
];

describe('SettingsHub', () => {
  it('draws a card per group with a link per page, for the owner', () => {
    hub(OWNER);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Store',
      'Money',
      'Team',
    ]);
    expect(screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
      [
        ['Store profile', '/settings/store-profile'],
        ['Stock locations', '/settings/stock-locations'],
        ['Payout account', '/settings/payout-account'],
        ['Members', '/settings/team'],
      ],
    );
    expect(screen.queryByText('View only')).toBeNull();
  });

  it('shows only the groups with a visible link', () => {
    hub(['inventory.stock.view', 'inventory.source.edit']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Store',
    ]);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Stock locations']);
  });

  it('puts a View only chip on a page the caller can see but not change', () => {
    hub([
      'payments.payout-account.view',
      'identity.team-member.view',
      'identity.team-member.invite',
    ]);
    const payout = screen.getByRole('link', { name: /Payout account/ });
    expect(within(payout).getByText('View only')).toBeTruthy();
    const team = screen.getByRole('link', { name: /Members/ });
    expect(within(team).queryByText('View only')).toBeNull();
  });

  it('keeps the chip from shrinking and lets the row wrap', () => {
    hub(['payments.payout-account.view']);
    const link = screen.getByRole('link', { name: /Payout account/ });
    expect(link.className).toContain('flex-wrap');
    expect(screen.getByText('View only').parentElement?.className).toContain('shrink-0');
  });

  it('names each group card by its heading', () => {
    hub(['payments.payout-account.view']);
    expect(screen.getByRole('region', { name: 'Money' })).toBeTruthy();
  });

  it('has no personal account card (profile, two-step, sessions live in the account menu)', () => {
    hub(OWNER);
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/account')),
    ).toBe(false);
    expect(screen.queryByText(/two-step|sessions|security/i)).toBeNull();
  });
});

describe('SettingsSubNav', () => {
  const groups = [
    {
      id: 'store',
      label: 'Store',
      links: [
        { id: 'store-profile', href: '/settings/store-profile', label: 'Store profile' },
        { id: 'stock-locations', href: '/settings/stock-locations', label: 'Stock locations' },
      ],
    },
    {
      id: 'money',
      label: 'Money',
      links: [{ id: 'payout-account', href: '/settings/payout-account', label: 'Payout account' }],
    },
  ];

  it('lists the groups and links in a named landmark and marks only the current page', () => {
    render(<SettingsSubNav label="Settings pages" groups={groups} activeId="stock-locations" />);
    const nav = screen.getByRole('navigation', { name: 'Settings pages' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Store profile',
      'Stock locations',
      'Payout account',
    ]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(links[0]?.className).toContain('-outline-offset-2');
  });

  it('draws nothing when the caller may open no page', () => {
    const { container } = render(
      <SettingsSubNav label="Settings pages" groups={[]} activeId="x" />,
    );
    expect(container.innerHTML).toBe('');
  });
});
