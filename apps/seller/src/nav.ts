import type { NavConfig } from '@mondapac/ui';

// Seller nav config (panels IA 3.2). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen.
export const sellerNav: NavConfig = {
  items: [
    { id: 's_home', labelKey: 'nav.home', href: '/' },
    {
      id: 's_products',
      labelKey: 'nav.products',
      href: '/products',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_offers',
      labelKey: 'nav.offers',
      href: '/offers',
      anyOf: ['catalog.own-product.view'],
    },
    {
      id: 's_stock',
      labelKey: 'nav.stock',
      href: '/stock-locations',
      anyOf: ['inventory.stock.view'],
    },
    // Shown only while the seller is not approved (SellerShell hides it after).
    { id: 's_setup', labelKey: 'nav.setup', href: '/account-setup' },
  ],
};
