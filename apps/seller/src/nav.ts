import { PAYOUT_VIEW_PERMISSION } from './payout/types.ts';
import { STOCK_VIEW_PERMISSION } from './stock/types.ts';
import { visibleNavItems, type NavConfig, type NavItem } from '@mondapac/ui';

// Seller nav config (panels IA 3.2). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen. Items sit under topic groups; a group with one
// visible item shows that item flat (navSections).
export const sellerNav: NavConfig = {
  groups: [
    { id: 'orders', labelKey: 'nav.group.orders', icon: 'clipboard' },
    { id: 'catalogue', labelKey: 'nav.group.catalogue', icon: 'store' },
    { id: 'money', labelKey: 'nav.group.money', icon: 'wallet' },
    { id: 'team', labelKey: 'nav.group.team', icon: 'users' },
  ],
  items: [
    { id: 's_home', icon: 'home', labelKey: 'nav.home', href: '/' },
    {
      id: 's_orders',
      icon: 'clipboard',
      labelKey: 'nav.orders',
      href: '/orders',
      group: 'orders',
      anyOf: ['ordering.seller-order.view'],
    },
    {
      id: 's_products',
      icon: 'package',
      labelKey: 'nav.products',
      href: '/products',
      group: 'catalogue',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_offers',
      icon: 'tag',
      labelKey: 'nav.offers',
      href: '/offers',
      group: 'catalogue',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_stock',
      icon: 'map-pin',
      labelKey: 'nav.stock',
      href: '/stock-locations',
      group: 'catalogue',
      anyOf: [STOCK_VIEW_PERMISSION],
    },
    {
      id: 's_earnings',
      icon: 'receipt',
      labelKey: 'nav.earnings',
      href: '/earnings',
      group: 'money',
      anyOf: ['commission-payouts.earnings.view'],
    },
    {
      id: 's_payout',
      icon: 'lock',
      labelKey: 'nav.payout',
      href: '/payout-account',
      group: 'money',
      anyOf: [PAYOUT_VIEW_PERMISSION],
    },
    {
      id: 's_team',
      icon: 'users',
      labelKey: 'nav.team',
      href: '/team',
      group: 'team',
      anyOf: ['identity.team-member.view'],
    },
    // Security is the one page left of the old Settings tabs; every approved seller has it.
    {
      id: 's_settings',
      icon: 'shield-check',
      labelKey: 'nav.security',
      href: '/account/security',
      group: 'team',
    },
    // The only item before approval (sellerNavItems).
    { id: 's_setup', icon: 'briefcase', labelKey: 'nav.setup', href: '/account-setup' },
  ],
};

const SETUP_ID = 's_setup';

/**
 * The items the shell shows. Every page but the setup pages sends a seller who is not approved
 * yet to `/account-setup`, so before approval the setup item is the only one (a link that can
 * only bounce back is not shown); after approval it is the one item hidden.
 */
export function sellerNavItems(
  accessState: 'pending' | 'approved' | 'rejected',
  permissionKeys: readonly string[],
): readonly NavItem[] {
  return visibleNavItems(sellerNav, new Set(permissionKeys)).filter((item) =>
    accessState === 'approved' ? item.id !== SETUP_ID : item.id === SETUP_ID,
  );
}
