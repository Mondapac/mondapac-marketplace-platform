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
      'Team',
    ]);
    expect(screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
      [
        ['Store profile', '/settings/store-profile'],
        ['Stock locations', '/settings/stock-locations'],
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
    hub(['inventory.stock.view', 'identity.team-member.view', 'identity.team-member.invite']);
    const stock = screen.getByRole('link', { name: /Stock locations/ });
    expect(within(stock).getByText('View only')).toBeTruthy();
    const team = screen.getByRole('link', { name: /Members/ });
    expect(within(team).queryByText('View only')).toBeNull();
  });

  it('keeps the chip from shrinking and lets the row wrap', () => {
    hub(['inventory.stock.view']);
    const link = screen.getByRole('link', { name: /Stock locations/ });
    expect(link.className).toContain('flex-wrap');
    expect(screen.getByText('View only').parentElement?.className).toContain('shrink-0');
  });

  it('names each group card by its heading', () => {
    hub(['identity.team-member.view']);
    expect(screen.getByRole('region', { name: 'Team' })).toBeTruthy();
  });

  it('has no personal account card (profile, two-step, sessions live in the account menu)', () => {
    hub(OWNER);
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/account')),
    ).toBe(false);
    expect(screen.queryByText(/two-step|sessions|security/i)).toBeNull();
  });
});
