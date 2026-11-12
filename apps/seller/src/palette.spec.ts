import { visibleNavItems } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { sellerNav, sellerNavItems } from './nav.ts';
import { sellerGoShortcuts, sellerPaletteEntries } from './palette.ts';
import { settingEntries, settingsGroups, visibleSettings } from './settings/settings-nav.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;

const ALL_KEYS = [
  ...sellerNav.items.flatMap((item) => item.anyOf ?? []),
  ...settingsGroups.flatMap((group) => group.links.flatMap((l) => [...l.view, ...l.manage])),
  'identity.team-member.invite',
];

describe('seller palette index', () => {
  const hrefs = (state: 'pending' | 'approved' | 'rejected', keys: string[]) =>
    sellerPaletteEntries(state, keys, text)
      .filter((entry) => entry.kind === 'page')
      .map((entry) => entry.href);

  it('lists the same pages as the menu, the settings hub and the account menu', () => {
    for (const keys of [
      [],
      ['ordering.seller-order.view'],
      ['identity.team-member.view'],
      ALL_KEYS,
    ]) {
      const menu = sellerNavItems('approved', keys).map((item) => item.href);
      const hub = visibleSettings(keys).flatMap(({ links }) => links.map(({ link }) => link.href));
      const account = ['/account/profile', '/account/security', '/account/sessions'];
      expect(hrefs('approved', keys).sort()).toEqual([...menu, ...hub, ...account].sort());
    }
  });

  it('offers only the setup page and the account pages before approval', () => {
    expect(hrefs('pending', ALL_KEYS).sort()).toEqual(
      ['/account-setup', '/account/profile', '/account/sessions'].sort(),
    );
    const kinds = sellerPaletteEntries('pending', ALL_KEYS, text).map((entry) => entry.kind);
    expect(kinds).not.toContain('setting');
    expect(kinds).not.toContain('action');
  });

  it('shows a setting and an action only with the permission behind them', () => {
    const labels = (keys: string[]) =>
      sellerPaletteEntries('approved', keys, text).map((entry) => entry.label);
    expect(labels([])).not.toContain('Payout bank account');
    expect(labels([])).not.toContain('Add product');
    expect(labels(ALL_KEYS)).toContain('Payout bank account');
    expect(labels(['catalog.own-product.edit'])).toContain('Add product');
  });

  it('offers Invite member and Add stock location, each only with its permission, and puts the path on a setting', () => {
    const entries = (keys: string[]) => sellerPaletteEntries('approved', keys, text);
    const actions = (keys: string[]) =>
      entries(keys)
        .filter((entry) => entry.kind === 'action')
        .map((entry) => `${entry.label} ${entry.href}`);
    expect(actions(['identity.team-member.invite', 'inventory.source.edit'])).toEqual([
      'Invite member /settings/team',
      'Add stock location /settings/stock-locations',
    ]);
    expect(actions(['inventory.source.edit'])).toEqual([
      'Add stock location /settings/stock-locations',
    ]);
    expect(actions([])).toEqual([]);
    const context = (id: string) => entries(ALL_KEYS).find((entry) => entry.id === id)?.context;
    expect(context('page:settings/store-profile')).toBe('Settings / Store');
    expect(context('setting:store-logo')).toBe('Settings / Store / Store profile');
  });

  it('has unique setting ids, each on a page of the settings map', () => {
    const ids = settingEntries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pages = new Set(settingsGroups.flatMap((g) => g.links.map((link) => link.id)));
    for (const entry of settingEntries) expect(pages.has(entry.pageId), entry.id).toBe(true);
  });

  it('offers go-to shortcuts only for pages the keys allow', () => {
    const entries = sellerPaletteEntries('approved', ALL_KEYS, text);
    expect(sellerGoShortcuts(entries, text).map((s) => s.id)).toEqual(['go-settings', 'go-orders']);
    expect(visibleNavItems(sellerNav, new Set()).length).toBeGreaterThan(0);
  });
});
