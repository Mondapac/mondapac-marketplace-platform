import { settingsViewKeys } from './settings/settings-nav.ts';
import { visibleNavItems, type NavConfig, type NavItem } from '@mondapac/ui';

// Seller nav config (panels IA 3.2). The menu is daily work; what is set once and changed rarely
// lives under Settings, one item pinned to the sidebar footer (the hub, settings/settings-nav.ts).
// Personal account pages (profile, security, sessions) are in the account menu only. Items of a
// phase that has not shipped are absent, not disabled; each item is added with its screen. Items
// sit under topic groups; a group with one visible item shows that item flat (navSections).
export const sellerNav: NavConfig = {
  groups: [
    { id: 'orders', labelKey: 'nav.group.orders', icon: 'clipboard' },
    { id: 'catalogue', labelKey: 'nav.group.catalogue', icon: 'store' },
    { id: 'money', labelKey: 'nav.group.money', icon: 'wallet' },
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
      id: 's_import',
      icon: 'file',
      labelKey: 'nav.import',
      href: '/products/import',
      group: 'catalogue',
      // The menu takes any one key; the import needs both (see `IMPORT_KEYS`), checked in sellerNavItems.
      anyOf: ['catalog.own-import.run'],
    },
    {
      id: 's_suggestions',
      icon: 'inbox',
      labelKey: 'nav.suggestions',
      href: '/value-suggestions',
      group: 'catalogue',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_reviews',
      icon: 'star',
      labelKey: 'nav.reviews',
      href: '/reviews',
      group: 'catalogue',
      anyOf: ['reviews.seller.view'],
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
      id: 's_settings',
      icon: 'sliders',
      labelKey: 'nav.settings',
      href: '/settings',
      placement: 'footer',
      anyOf: settingsViewKeys,
    },
    // The only item before approval (sellerNavItems).
    { id: 's_setup', icon: 'briefcase', labelKey: 'nav.setup', href: '/account-setup' },
  ],
};

const SETUP_ID = 's_setup';

/** Importing needs both keys (catalog design 14c); the menu config only holds one, so the filter checks both. */
const IMPORT_ID = 's_import';
const IMPORT_KEYS = ['catalog.own-import.run', 'catalog.own-product.edit'] as const;

/**
 * The items the shell shows. Every page but the setup pages sends a seller who is not approved
 * yet to `/account-setup`, so before approval the setup item is the only one (a link that can
 * only bounce back is not shown); after approval it is the one item hidden.
 */
export function sellerNavItems(
  accessState: 'pending' | 'approved' | 'rejected',
  permissionKeys: readonly string[],
): readonly NavItem[] {
  const held = new Set(permissionKeys);
  return visibleNavItems(sellerNav, held)
    .filter((item) => (accessState === 'approved' ? item.id !== SETUP_ID : item.id === SETUP_ID))
    .filter((item) => item.id !== IMPORT_ID || IMPORT_KEYS.every((key) => held.has(key)));
}
