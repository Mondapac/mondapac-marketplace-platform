import { visibleNavItems } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import { adminNav } from './nav.ts';

const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);

describe('admin nav: Content', () => {
  it('is there for storefront.slide.read, with the layout icon', () => {
    expect(ids(['storefront.slide.read'])).toContain('content');
    const item = adminNav.items.find((entry) => entry.id === 'content');
    expect(item).toMatchObject({ icon: 'layout', href: '/content', labelKey: 'nav.content' });
  });

  it('is hidden without it, also for the other slide keys', () => {
    expect(ids([])).not.toContain('content');
    expect(ids(['storefront.slide.edit', 'storefront.slide.publish'])).not.toContain('content');
  });
});

describe('admin nav: Catalogue', () => {
  it('shows Products for catalog.product.view, with the package icon, in the catalogue group', () => {
    expect(ids(['catalog.product.view'])).toEqual(['home', 'products', 'offer-reviews']);
    const item = adminNav.items.find((entry) => entry.id === 'products');
    expect(item).toMatchObject({
      icon: 'package',
      href: '/catalog/products',
      labelKey: 'nav.products',
      group: 'catalogue',
      anyOf: ['catalog.product.view'],
    });
    expect(adminNav.groups).toContainEqual({
      id: 'catalogue',
      labelKey: 'nav.group.catalogue',
      icon: 'package',
    });
  });

  it('is hidden without the key, and the Offer reviews item stays in Reviews', () => {
    expect(ids(['catalog.product.approve'])).not.toContain('products');
    expect(adminNav.items.find((entry) => entry.id === 'offer-reviews')?.group).toBe('reviews');
  });
});

describe('admin nav: Wallet', () => {
  it('lists the credit pages for wallet.credit.view; the switch is a settings page', () => {
    expect(ids(['wallet.credit.view'])).toEqual(['home', 'wallet-credits', 'wallet-requests']);
    expect(ids(['wallet.settings.view'])).toEqual(['home', 'settings']);
  });

  it('is hidden without the keys, and the manage keys alone show nothing', () => {
    expect(ids([])).toEqual(['home']);
    expect(ids(['wallet.settings.manage', 'wallet.credit.issue', 'wallet.credit.approve'])).toEqual(
      ['home'],
    );
  });

  it('puts the two credit items in Money with their routes and icons', () => {
    const wallet = adminNav.items.filter((item) => item.id.startsWith('wallet-'));
    expect(wallet.map((item) => [item.id, item.href, item.icon, item.group])).toEqual([
      ['wallet-credits', '/wallet/credits', 'receipt', 'money'],
      ['wallet-requests', '/wallet/credit-requests', 'inbox', 'money'],
    ]);
  });
});

describe('admin nav: daily work only', () => {
  it('keeps exactly the work items in the menu, in this order', () => {
    expect(
      adminNav.items.filter((item) => item.placement !== 'footer').map((item) => item.id),
    ).toEqual([
      'home',
      'products',
      'offer-reviews',
      'price-holds',
      'content',
      'sellers',
      'orders',
      'customers',
      'payouts',
      'payout-accounts',
      'disputes',
      'wallet-credits',
      'wallet-requests',
    ]);
  });

  it('holds no rarely-changed settings page, and no empty Platform group', () => {
    const all = new Set(adminNav.items.map((item) => item.id));
    for (const gone of ['delivery-settings', 'fleet-selection', 'wallet-settings', 'team']) {
      expect(all.has(gone), gone).toBe(false);
    }
    expect((adminNav.groups ?? []).map((group) => group.id)).not.toContain('platform');
    expect(adminNav.items.every((item) => item.group !== 'platform')).toBe(true);
  });
});

describe('admin nav: Settings', () => {
  const settings = adminNav.items.find((item) => item.id === 'settings');

  it('is one item pinned to the sidebar footer, with the sliders icon, to the hub', () => {
    expect(adminNav.items.filter((item) => item.placement === 'footer')).toHaveLength(1);
    expect(settings).toMatchObject({
      href: '/settings',
      icon: 'sliders',
      labelKey: 'nav.settings',
      placement: 'footer',
    });
    expect(settings?.group).toBeUndefined();
  });

  it('shows with the view key of any one settings page', () => {
    for (const key of [
      'notifications.support-contact.view',
      'assistant.settings.view',
      'shipping.delivery-settings.view',
      'shipping.fleet-selection.view',
      'wallet.settings.view',
      'identity.admin-account.view',
      'identity.platform-role.view',
    ]) {
      expect(ids([key]), key).toContain('settings');
    }
  });

  it('is hidden without a view key; manage keys and other pages alone do not show it', () => {
    expect(ids([])).not.toContain('settings');
    expect(
      ids([
        'notifications.support-contact.manage',
        'shipping.delivery-settings.manage',
        'storefront.slide.read',
        'ordering.order.view',
      ]),
    ).not.toContain('settings');
  });

  it('is the last visible item', () => {
    expect(ids(['ordering.order.view', 'wallet.settings.view']).at(-1)).toBe('settings');
  });
});

describe('admin nav: Disputes', () => {
  it('is there for commission-payouts.dispute.view, in Money after the connected accounts', () => {
    expect(ids(['commission-payouts.dispute.view'])).toEqual(['home', 'disputes']);
    const money = adminNav.items.filter((item) => item.group === 'money').map((item) => item.id);
    expect(money.indexOf('disputes')).toBe(money.indexOf('payout-accounts') + 1);
    expect(adminNav.items.find((item) => item.id === 'disputes')).toMatchObject({
      icon: 'shield-check',
      href: '/disputes',
      labelKey: 'nav.disputes',
      group: 'money',
    });
  });

  it('is hidden without it, also with the decision key alone', () => {
    expect(ids([])).not.toContain('disputes');
    expect(ids(['commission-payouts.dispute.attribute'])).not.toContain('disputes');
  });
});

describe('admin nav: Payouts', () => {
  it('sits in Money right before Connected accounts, for commission-payouts.payout.view', () => {
    expect(ids(['commission-payouts.payout.view'])).toEqual(['home', 'payouts']);
    expect(ids(['commission-payouts.payout.approve'])).toEqual(['home']);
    const order = adminNav.items.map((item) => item.id);
    expect(order.indexOf('payouts')).toBe(order.indexOf('payout-accounts') - 1);
    expect(adminNav.items.find((item) => item.id === 'payouts')).toMatchObject({
      icon: 'receipt',
      href: '/payouts',
      group: 'money',
      labelKey: 'nav.payouts',
    });
  });
});

describe('admin nav: Settings', () => {
  it('is there for the account deletion setting alone', () => {
    expect(ids(['customers.account-deletion-settings.view'])).toContain('settings');
    expect(ids(['customers.account-deletion-settings.manage'])).not.toContain('settings');
  });
});
