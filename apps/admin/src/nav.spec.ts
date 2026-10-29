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

describe('admin nav: Wallet', () => {
  it('lists the switch for wallet.settings.view and the credit pages for wallet.credit.view', () => {
    expect(ids(['wallet.settings.view'])).toEqual(['home', 'wallet-settings']);
    expect(ids(['wallet.credit.view'])).toEqual(['home', 'wallet-credits', 'wallet-requests']);
  });

  it('is hidden without the keys, and the manage keys alone show nothing', () => {
    expect(ids([])).toEqual(['home']);
    expect(ids(['wallet.settings.manage', 'wallet.credit.issue', 'wallet.credit.approve'])).toEqual(
      ['home'],
    );
  });

  it('puts the three items in Money with their routes and icons', () => {
    const wallet = adminNav.items.filter((item) => item.id.startsWith('wallet-'));
    expect(wallet.map((item) => [item.id, item.href, item.icon, item.group])).toEqual([
      ['wallet-settings', '/wallet', 'wallet', 'money'],
      ['wallet-credits', '/wallet/credits', 'receipt', 'money'],
      ['wallet-requests', '/wallet/credit-requests', 'inbox', 'money'],
    ]);
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
