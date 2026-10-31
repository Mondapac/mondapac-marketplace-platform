import { describe, expect, it } from 'vitest';
import { settingsGroups, settingsLink, settingsViewKeys, visibleSettings } from './settings-nav.ts';

const shape = (keys: string[]) =>
  visibleSettings(keys).map(({ group, links }) => [
    group.id,
    links.map(({ link, viewOnly }) => (viewOnly ? `${link.id}:view-only` : link.id)),
  ]);

describe('seller settings map', () => {
  it('lists the groups and pages that exist today, in design order', () => {
    expect(settingsGroups.map((group) => [group.id, group.links.map((link) => link.href)])).toEqual(
      [
        ['store', ['/settings/store-profile', '/settings/stock-locations']],
        ['money', ['/settings/payout-account']],
        ['team', ['/settings/team']],
      ],
    );
  });

  it('holds no personal account page and no page of an unbuilt phase', () => {
    const hrefs = settingsGroups.flatMap((group) => group.links.map((link) => link.href));
    for (const gone of ['/account/security', '/account/profile', '/account/sessions']) {
      expect(hrefs).not.toContain(gone);
    }
    expect(hrefs).not.toContain('/settings/delivery');
    expect(hrefs).not.toContain('/settings/roles');
  });

  it('uses unique link ids, and every page has a view key and a manage key', () => {
    const ids = settingsGroups.flatMap((group) => group.links.map((link) => link.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of settingsGroups) {
      for (const link of group.links) {
        expect(link.view.length, link.id).toBeGreaterThan(0);
        expect(link.manage.length, link.id).toBeGreaterThan(0);
      }
    }
  });

  it('maps the pages to their permission keys', () => {
    const view = (id: string) => settingsLink(id)?.link.view;
    const manage = (id: string) => settingsLink(id)?.link.manage;
    expect(view('store-profile')).toEqual(['sellers.store-profile.view']);
    expect(manage('store-profile')).toEqual(['sellers.store-profile.edit']);
    expect(view('stock-locations')).toEqual(['inventory.stock.view']);
    expect(manage('stock-locations')).toEqual(['inventory.source.edit']);
    expect(view('payout-account')).toEqual(['payments.payout-account.view']);
    expect(manage('payout-account')).toEqual(['payments.payout-account.manage']);
    expect(view('team')).toEqual(['identity.team-member.view']);
    expect(manage('team')).toEqual([
      'identity.team-member.invite',
      'identity.team-member.assign-role',
    ]);
    expect(settingsViewKeys).toHaveLength(4);
  });

  it('finds a link with its group, and nothing for an unknown id', () => {
    expect(settingsLink('stock-locations')?.group.id).toBe('store');
    expect(settingsLink('nope')).toBeUndefined();
  });
});

describe('visibleSettings', () => {
  it('shows every group to the owner (all keys)', () => {
    expect(
      shape([
        'sellers.store-profile.view',
        'sellers.store-profile.edit',
        'inventory.stock.view',
        'inventory.source.edit',
        'payments.payout-account.view',
        'payments.payout-account.manage',
        'identity.team-member.view',
        'identity.team-member.invite',
      ]),
    ).toEqual([
      ['store', ['store-profile', 'stock-locations']],
      ['money', ['payout-account']],
      ['team', ['team']],
    ]);
  });

  it('shows only the stock page to a member with only the stock view key, as view only', () => {
    expect(shape(['inventory.stock.view'])).toEqual([['store', ['stock-locations:view-only']]]);
  });

  it('shows nothing without any view key (a manage key alone opens no page)', () => {
    expect(shape([])).toEqual([]);
    expect(shape(['inventory.source.edit', 'catalog.own-product.view'])).toEqual([]);
  });
});
