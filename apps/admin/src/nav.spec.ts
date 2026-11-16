import { navSections, visibleNavItems } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import { adminNav } from './nav.ts';

const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);

describe('admin nav: CMS', () => {
  it('shows Pages for storefront.page.read, with Menus beside it', () => {
    expect(ids(['storefront.page.read'])).toEqual(['home', 'content', 'menus']);
    expect(adminNav.items.find((entry) => entry.id === 'content')).toMatchObject({
      icon: 'file',
      href: '/content',
      labelKey: 'nav.content',
      group: 'cms',
    });
    expect(adminNav.items.find((entry) => entry.id === 'menus')).toMatchObject({
      href: '/content/navigation',
      labelKey: 'nav.menus',
      group: 'cms',
    });
  });

  it('shows Slides for storefront.slide.read alone, with the layout icon', () => {
    expect(ids(['storefront.slide.read'])).toEqual(['home', 'slides']);
    expect(adminNav.items.find((entry) => entry.id === 'slides')).toMatchObject({
      icon: 'layout',
      href: '/content/slides',
      labelKey: 'nav.slides',
      group: 'cms',
    });
  });

  it('is hidden without the read keys', () => {
    expect(ids([])).toEqual(['home']);
    expect(ids(['storefront.slide.edit', 'storefront.slide.publish'])).toEqual(['home']);
  });

  it('holds Pages, Blog, Slides and Menus in this order', () => {
    expect(adminNav.items.filter((item) => item.group === 'cms').map((item) => item.id)).toEqual([
      'content',
      'blog',
      'slides',
      'menus',
    ]);
  });
});

describe('admin nav: Inbox', () => {
  it('is the first group, holding every queue that waits on an admin, in this order', () => {
    expect((adminNav.groups ?? [])[0]).toEqual({
      id: 'inbox',
      labelKey: 'nav.group.inbox',
      icon: 'inbox',
    });
    expect(adminNav.items.filter((item) => item.group === 'inbox').map((item) => item.id)).toEqual([
      'seller-requests',
      'certificates',
      'review-queue',
      'price-holds',
    ]);
  });

  it('opens Seller requests on the review tab of the sellers list, for sellers.seller.view', () => {
    expect(ids(['sellers.seller.view']).slice(0, 3)).toEqual([
      'home',
      'seller-requests',
      'sellers',
    ]);
    expect(adminNav.items.find((item) => item.id === 'seller-requests')).toMatchObject({
      href: '/sellers?tab=awaiting-review',
      labelKey: 'nav.seller-requests',
    });
  });
});

describe('admin nav: Blog', () => {
  it('is there for blog.post.read, in the CMS group, beside Pages', () => {
    expect(ids(['blog.post.read'])).toContain('blog');
    const item = adminNav.items.find((entry) => entry.id === 'blog');
    expect(item).toMatchObject({
      icon: 'file',
      href: '/content/blog',
      labelKey: 'nav.blog',
      group: 'cms',
    });
  });

  it('is hidden without it, also for the other blog keys', () => {
    expect(ids([])).not.toContain('blog');
    expect(ids(['blog.post.edit', 'blog.post.publish'])).not.toContain('blog');
  });
});

describe('admin nav: Catalogue', () => {
  it('shows Products for catalog.product.view, with the package icon, in the catalogue group', () => {
    expect(ids(['catalog.product.view'])).toEqual(['home', 'review-queue', 'products']);
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

  it('is one group holding every catalogue page, in the menu design order', () => {
    const everyKey = new Set(adminNav.items.flatMap((item) => item.anyOf ?? []));
    const sections = navSections(adminNav.groups, visibleNavItems(adminNav, everyKey));
    const catalogue = sections.filter(
      (section) => section.kind === 'group' && section.group.icon === 'package',
    );
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]?.kind === 'group' && catalogue[0].group.id).toBe('catalogue');
    expect(catalogue[0]?.kind === 'group' && catalogue[0].items.map((item) => item.id)).toEqual([
      'products',
      'categories',
      'attributes',
      'variants',
      'brands',
      'tags',
      'business-activities',
    ]);
  });

  it('is hidden without the key, and the Review queue item stays in Inbox', () => {
    expect(ids(['catalog.product.approve'])).not.toContain('products');
    expect(adminNav.items.find((entry) => entry.id === 'review-queue')?.group).toBe('inbox');
  });
});

describe('admin nav: Buyer reviews', () => {
  it('shows the queue for reviews.moderation.queue, in the Customers group', () => {
    expect(ids(['reviews.moderation.queue'])).toEqual(['home', 'review-moderation']);
    expect(adminNav.items.find((entry) => entry.id === 'review-moderation')).toMatchObject({
      href: '/reviews/moderation',
      group: 'customers',
      anyOf: ['reviews.moderation.queue'],
    });
  });

  it('is hidden with only the moderate or remove key', () => {
    expect(ids(['reviews.moderation.moderate', 'reviews.moderation.remove'])).toEqual(['home']);
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

  it('puts the two credit items in Accounting with their routes and icons', () => {
    const wallet = adminNav.items.filter((item) => item.id.startsWith('wallet-'));
    expect(wallet.map((item) => [item.id, item.href, item.icon, item.group])).toEqual([
      ['wallet-credits', '/wallet/credits', 'receipt', 'accounting'],
      ['wallet-requests', '/wallet/credit-requests', 'inbox', 'accounting'],
    ]);
  });
});

describe('admin nav: daily work only', () => {
  it('keeps exactly the work items in the menu, in this order', () => {
    expect(
      adminNav.items.filter((item) => item.placement !== 'footer').map((item) => item.id),
    ).toEqual([
      'home',
      'seller-requests',
      'certificates',
      'review-queue',
      'price-holds',
      'orders',
      'shipments',
      'products',
      'categories',
      'attributes',
      'variants',
      'brands',
      'tags',
      'business-activities',
      'sellers',
      'customers',
      'review-moderation',
      'payouts',
      'payout-accounts',
      'disputes',
      'wallet-credits',
      'wallet-requests',
      'content',
      'blog',
      'slides',
      'menus',
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
  it('is there for commission-payouts.dispute.view, in Accounting after the seller accounts', () => {
    expect(ids(['commission-payouts.dispute.view'])).toEqual(['home', 'disputes']);
    const money = adminNav.items
      .filter((item) => item.group === 'accounting')
      .map((item) => item.id);
    expect(money.indexOf('disputes')).toBe(money.indexOf('payout-accounts') + 1);
    expect(adminNav.items.find((item) => item.id === 'disputes')).toMatchObject({
      icon: 'shield-check',
      href: '/disputes',
      labelKey: 'nav.disputes',
      group: 'accounting',
    });
  });

  it('is hidden without it, also with the decision key alone', () => {
    expect(ids([])).not.toContain('disputes');
    expect(ids(['commission-payouts.dispute.attribute'])).not.toContain('disputes');
  });
});

describe('admin nav: Payouts', () => {
  it('sits in Accounting right before Seller accounts, for commission-payouts.payout.view', () => {
    expect(ids(['commission-payouts.payout.view'])).toEqual(['home', 'payouts']);
    expect(ids(['commission-payouts.payout.approve'])).toEqual(['home']);
    const order = adminNav.items.map((item) => item.id);
    expect(order.indexOf('payouts')).toBe(order.indexOf('payout-accounts') - 1);
    expect(adminNav.items.find((item) => item.id === 'payouts')).toMatchObject({
      icon: 'receipt',
      href: '/payouts',
      group: 'accounting',
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

describe('admin nav: Brands', () => {
  it('is there for catalog.brand.read, in the Catalogue group, with the tag icon', () => {
    expect(ids(['catalog.brand.read'])).toEqual(['home', 'brands']);
    expect(adminNav.items.find((item) => item.id === 'brands')).toMatchObject({
      icon: 'tag',
      href: '/catalog/brands',
      labelKey: 'nav.brands',
      group: 'catalogue',
    });
  });

  it('is hidden without it, also with the edit key alone', () => {
    expect(ids([])).not.toContain('brands');
    expect(ids(['catalog.brand.edit'])).not.toContain('brands');
  });
});

describe('admin nav: Attributes', () => {
  it('is there for catalog.attribute.view, in the Catalogue group before Brands', () => {
    expect(ids(['catalog.attribute.view'])).toEqual(['home', 'attributes']);
    expect(ids(['catalog.attribute.view', 'catalog.brand.read'])).toEqual([
      'home',
      'attributes',
      'brands',
    ]);
    expect(adminNav.items.find((item) => item.id === 'attributes')).toMatchObject({
      icon: 'sliders',
      href: '/catalog/attributes',
      labelKey: 'nav.attributes',
      group: 'catalogue',
    });
  });

  it('is hidden without it, also with the protected edit key alone', () => {
    expect(ids([])).not.toContain('attributes');
    expect(ids(['catalog.attribute.edit'])).not.toContain('attributes');
  });
});

describe('admin nav: Variants', () => {
  it('is there for catalog.variant.view, in the Catalogue group', () => {
    expect(ids(['catalog.variant.view'])).toEqual(['home', 'variants']);
    expect(adminNav.items.find((item) => item.id === 'variants')).toMatchObject({
      href: '/catalog/variants',
      labelKey: 'nav.variants',
      group: 'catalogue',
    });
  });

  it('is hidden without it, also with the edit keys alone', () => {
    expect(ids([])).not.toContain('variants');
    expect(ids(['catalog.variant-type.edit', 'catalog.attribute.edit'])).not.toContain('variants');
  });
});

describe('admin nav: Business activities', () => {
  it('is there for catalog.business-activity.read, in the Catalogue group', () => {
    expect(ids(['catalog.business-activity.read'])).toEqual(['home', 'business-activities']);
    expect(adminNav.items.find((item) => item.id === 'business-activities')).toMatchObject({
      href: '/catalog/business-activities',
      labelKey: 'nav.business-activities',
      group: 'catalogue',
    });
  });

  it('is hidden without it, also with the edit key alone', () => {
    expect(ids([])).not.toContain('business-activities');
    expect(ids(['catalog.business-activity.edit'])).not.toContain('business-activities');
  });
});

describe('admin nav: Tags', () => {
  it('is there for catalog.topic.read, in the Catalogue group', () => {
    expect(ids(['catalog.topic.read'])).toEqual(['home', 'tags']);
    expect(adminNav.items.find((item) => item.id === 'tags')).toMatchObject({
      href: '/catalog/tags',
      labelKey: 'nav.tags',
      group: 'catalogue',
      icon: 'star',
    });
  });

  it('is hidden without it, also with the manage key alone', () => {
    expect(ids([])).not.toContain('tags');
    expect(ids(['catalog.topic.manage'])).not.toContain('tags');
  });
});

describe('admin nav: Marketing', () => {
  it('is a group between Customers and Accounting with the tag icon, shown only once it holds an item', () => {
    const order = (adminNav.groups ?? []).map((group) => group.id);
    expect(order.indexOf('marketing')).toBe(order.indexOf('customers') + 1);
    expect(order.indexOf('accounting')).toBe(order.indexOf('marketing') + 1);
    expect(adminNav.groups).toContainEqual({
      id: 'marketing',
      labelKey: 'nav.group.marketing',
      icon: 'tag',
    });
    const everyKey = new Set(adminNav.items.flatMap((item) => item.anyOf ?? []));
    const sections = navSections(adminNav.groups, visibleNavItems(adminNav, everyKey));
    expect(
      sections.some((section) => section.kind === 'group' && section.group.id === 'marketing'),
    ).toBe(false);
  });
});
