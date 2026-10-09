import type { NavConfig } from '@mondapac/ui';

// Admin nav config (panels IA 3.1). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen.
export const adminNav: NavConfig = {
  items: [
    { id: 'home', labelKey: 'nav.home', href: '/' },
    {
      id: 'sellers',
      labelKey: 'nav.sellers',
      href: '/sellers',
      anyOf: ['sellers.seller.view'],
    },
    {
      id: 'team',
      labelKey: 'nav.team',
      href: '/team',
      anyOf: ['identity.admin-account.view'],
    },
  ],
};
