import type { NavConfig } from '@mondapac/ui';

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
    // Approved sellers only (SellerShell hides it before).
    {
      id: 's_team',
      icon: 'users',
      labelKey: 'nav.team',
      href: '/team',
      anyOf: ['identity.team-member.view'],
    },
    // Settings holds Security, Payout account and Stock locations as tabs (settings-header.tsx).
    { id: 's_settings', icon: 'sliders', labelKey: 'nav.settings', href: '/account/security' },
    // Shown only while the seller is not approved (SellerShell hides it after).
    { id: 's_setup', icon: 'briefcase', labelKey: 'nav.setup', href: '/account-setup' },
  ],
};
