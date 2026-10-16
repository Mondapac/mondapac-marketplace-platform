import type { NavConfig } from '@mondapac/ui';

// Admin nav config (panels IA 3.1). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen.
export const adminNav: NavConfig = {
  items: [
    { id: 'home', icon: 'home', labelKey: 'nav.home', href: '/' },
    {
      id: 'customers',
      icon: 'users',
      labelKey: 'nav.customers',
      href: '/customers',
      anyOf: ['identity.customer-account.view'],
    },
    {
      id: 'sellers',
      icon: 'store',
      labelKey: 'nav.sellers',
      href: '/sellers',
      anyOf: ['sellers.seller.view'],
    },
    {
      id: 'price-holds',
      icon: 'clock',
      labelKey: 'nav.price-holds',
      href: '/price-holds',
      anyOf: ['pricing.price-hold.view'],
    },
    {
      id: 'offer-reviews',
      icon: 'inbox',
      labelKey: 'nav.offer-reviews',
      href: '/offer-reviews',
      anyOf: ['catalog.product.view'],
    },
    {
      id: 'payout-accounts',
      icon: 'wallet',
      labelKey: 'nav.payout-accounts',
      href: '/payout-accounts',
      anyOf: ['payments.connected-account.view'],
    },
    {
      id: 'settings',
      icon: 'sliders',
      labelKey: 'nav.settings',
      href: '/settings',
      anyOf: ['notifications.support-contact.view'],
    },
    {
      id: 'team',
      icon: 'key',
      labelKey: 'nav.team',
      href: '/team',
      anyOf: ['identity.admin-account.view'],
    },
  ],
};
