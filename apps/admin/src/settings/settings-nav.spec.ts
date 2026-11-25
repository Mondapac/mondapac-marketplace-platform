import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
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
        ['general', ['/settings/support', '/settings/service-areas', '/settings/lists']],
        ['delivery', ['/settings/delivery', '/settings/fleets']],
        ['catalogue', ['/settings/offer-review', '/settings/emergency-stop']],
        ['money', ['/settings/tax', '/settings/wallet', '/settings/refund-limits']],
        ['marketing', ['/settings/promotions']],
        ['ai', ['/settings/assistant', '/settings/ai']],
        ['privacy', ['/settings/account-deletion', '/settings/ship-to-retention']],
        ['people', ['/settings/admins', '/settings/roles', '/settings/review-policy']],
      ],
    );
  });

  it('keeps every group to at most five pages (a sixth splits the group)', () => {
    for (const group of settingsGroups) expect(group.links.length, group.id).toBeLessThanOrEqual(5);
  });

  it('gives each renamed page its former name as a search word', () => {
    const renamed = [
      'assistant',
      'ship-to-retention',
      'refund-limits',
      'lists',
      'ai',
      'promotions',
    ];
    for (const id of [...renamed, 'review-policy']) {
      expect(settingsLink(id)?.link.keywordsKey, id).toBe(`settings.hub.words.${id}`);
    }
    const words: Record<string, string> = messages.settings.hub.words;
    expect(words['review-policy']).toContain('Review policy');
    expect(words['assistant']).toContain('Smart assistant');
    for (const group of settingsGroups) {
      for (const link of group.links) {
        if (link.keywordsKey === undefined) continue;
        expect(words[link.keywordsKey.replace('settings.hub.words.', '')], link.id).toBeTruthy();
      }
    }
  });

  it('gives every page a one-line description that exists in the messages', () => {
    const about: Record<string, string> = messages.settings.hub.about;
    for (const group of settingsGroups) {
      for (const link of group.links) {
        expect(link.descriptionKey, link.id).toBe(`settings.hub.about.${link.id}`);
        expect(about[link.id], link.id).toBeTruthy();
      }
    }
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
    expect(keys('service-areas')).toEqual(['sellers.seller.view']);
    expect(keys('assistant')).toEqual(['assistant.settings.view']);
    expect(keys('delivery')).toEqual(['shipping.delivery-settings.view']);
    expect(keys('fleets')).toEqual(['shipping.fleet-selection.view']);
    expect(keys('account-deletion')).toEqual(['customers.account-deletion-settings.view']);
    expect(keys('ship-to-retention')).toEqual(['ordering.ship-to-retention.view']);
    expect(keys('lists')).toEqual(['settings.list-paging.view']);
    expect(keys('ai')).toEqual(['settings.ai.view']);
    expect(keys('wallet')).toEqual(['wallet.settings.view']);
    expect(keys('tax')).toEqual(['tax.strategy.view']);
    expect(keys('refund-limits')).toEqual(['ordering.refund-limits.view']);
    expect(keys('promotions')).toEqual(['promotions.settings.view']);
    expect(keys('admins')).toEqual(['identity.admin-account.view']);
    expect(keys('roles')).toEqual(['identity.platform-role.view']);
    expect(keys('review-policy')).toEqual(['system-requests.policy.view']);
    expect(keys('offer-review')).toEqual(['settings.offer-review.view']);
    expect(keys('emergency-stop')).toEqual([
      'settings.offer-review.view',
      'settings.offer-review.emergency-stop',
    ]);
    expect(settingsViewKeys).toHaveLength(19);
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
      ['general', ['support', 'service-areas', 'lists']],
      ['delivery', ['delivery', 'fleets']],
      ['catalogue', ['offer-review', 'emergency-stop']],
      ['money', ['tax', 'wallet', 'refund-limits']],
      ['marketing', ['promotions']],
      ['ai', ['assistant', 'ai']],
      ['privacy', ['account-deletion', 'ship-to-retention']],
      ['people', ['admins', 'roles', 'review-policy']],
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
    ).toEqual([
      ['general', ['support:view-only']],
      ['ai', ['assistant']],
    ]);
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
