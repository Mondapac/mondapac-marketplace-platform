import { visibleNavItems, type NavConfig, type NavItem } from '@mondapac/ui';

// Seller nav config (panels IA 3.2). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen.
export const sellerNav: NavConfig = {
  items: [
    { id: 's_home', icon: 'home', labelKey: 'nav.home', href: '/' },
    {
      id: 's_products',
      icon: 'package',
      labelKey: 'nav.products',
      href: '/products',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_offers',
      icon: 'tag',
      labelKey: 'nav.offers',
      href: '/offers',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_orders',
      icon: 'clipboard',
      labelKey: 'nav.orders',
      href: '/orders',
      anyOf: ['ordering.seller-order.view'],
    },
    {
      id: 's_earnings',
      icon: 'receipt',
      labelKey: 'nav.earnings',
      href: '/earnings',
      anyOf: ['commission-payouts.earnings.view'],
    },
    {
      id: 's_stock',
      icon: 'map-pin',
      labelKey: 'nav.stock',
      href: '/stock-locations',
      anyOf: ['inventory.stock.view'],
    },
    {
      id: 's_payout',
      icon: 'wallet',
      labelKey: 'nav.payout',
      href: '/payout-account',
      anyOf: ['payments.payout-account.view'],
    },
    {
      id: 's_team',
      icon: 'users',
      labelKey: 'nav.team',
      href: '/team',
      anyOf: ['identity.team-member.view'],
    },
    { id: 's_security', icon: 'lock', labelKey: 'nav.security', href: '/account/security' },
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
