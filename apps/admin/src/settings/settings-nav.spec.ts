import { describe, expect, it } from 'vitest';
import { settingsGroups, settingsLink, settingsViewKeys, visibleSettings } from './settings-nav.ts';

const shape = (keys: string[]) =>
  visibleSettings(keys).map(({ group, links }) => [
    group.id,
    links.map(({ link, viewOnly }) => (viewOnly ? `${link.id}:view-only` : link.id)),
  ]);

describe('settings map', () => {
  it('lists the groups and pages that exist today, in design order', () => {
    expect(settingsGroups.map((group) => [group.id, group.links.map((link) => link.href)])).toEqual(
      [
        [
          'marketplace',
          [
            '/settings/support',
            '/settings/assistant',
            '/settings/account-deletion',
            '/settings/lists',
          ],
        ],
        ['delivery', ['/settings/delivery', '/settings/fleets']],
        ['money', ['/settings/wallet']],
        ['people', ['/settings/admins', '/settings/roles']],
      ],
    );
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
    const keys = (id: string) => settingsLink(id)?.link.view;
    expect(keys('support')).toEqual(['notifications.support-contact.view']);
    expect(keys('assistant')).toEqual(['assistant.settings.view']);
    expect(keys('delivery')).toEqual(['shipping.delivery-settings.view']);
    expect(keys('fleets')).toEqual(['shipping.fleet-selection.view']);
    expect(keys('account-deletion')).toEqual(['customers.account-deletion-settings.view']);
    expect(keys('lists')).toEqual(['settings.market-setting.view']);
    expect(keys('wallet')).toEqual(['wallet.settings.view']);
    expect(keys('admins')).toEqual(['identity.admin-account.view']);
    expect(keys('roles')).toEqual(['identity.platform-role.view']);
    expect(settingsViewKeys).toHaveLength(9);
  });

  it('finds a link with its group, and nothing for an unknown id', () => {
    expect(settingsLink('fleets')?.group.id).toBe('delivery');
    expect(settingsLink('nope')).toBeUndefined();
  });
});

describe('visibleSettings', () => {
  it('shows every group to a holder of every view and manage key (super admin)', () => {
    const all = settingsGroups.flatMap((group) =>
      group.links.flatMap((link) => [...link.view, ...link.manage]),
    );
    expect(shape(all)).toEqual([
      ['marketplace', ['support', 'assistant', 'account-deletion', 'lists']],
      ['delivery', ['delivery', 'fleets']],
      ['money', ['wallet']],
      ['people', ['admins', 'roles']],
    ]);
  });

  it('shows only the delivery group to an operations role', () => {
    expect(
      shape([
        'shipping.delivery-settings.view',
        'shipping.delivery-settings.manage',
        'shipping.fleet-selection.view',
        'shipping.fleet-selection.manage',
        'ordering.order.view',
      ]),
    ).toEqual([['delivery', ['delivery', 'fleets']]]);
  });

  it('shows nothing to a content editor', () => {
    expect(shape(['storefront.slide.read', 'storefront.slide.edit'])).toEqual([]);
    expect(visibleSettings([])).toEqual([]);
  });

  it('marks a page View only when the view key is held without a manage key', () => {
    expect(
      shape([
        'notifications.support-contact.view',
        'assistant.settings.view',
        'assistant.settings.manage',
      ]),
    ).toEqual([['marketplace', ['support:view-only', 'assistant']]]);
  });

  it('does not show a page for its manage key alone', () => {
    expect(shape(['wallet.settings.manage', 'identity.platform-role.create'])).toEqual([]);
  });

  it('leaves out a group with no visible link, and keeps the others in place', () => {
    expect(shape(['identity.platform-role.view', 'wallet.settings.view'])).toEqual([
      ['money', ['wallet:view-only']],
      ['people', ['roles:view-only']],
    ]);
  });

  it('treats any of several manage keys as manage', () => {
    expect(shape(['identity.admin-account.view', 'identity.admin-account.invite'])).toEqual([
      ['people', ['admins']],
    ]);
    expect(shape(['identity.admin-account.view', 'identity.platform-role.assign'])).toEqual([
      ['people', ['admins']],
    ]);
  });
});
