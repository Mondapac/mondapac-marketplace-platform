import type { NavConfig } from '@mondapac/ui';

// Seller nav config (panels IA 3.2). Items of a phase that has not shipped are absent, not
// disabled; each item is added with its screen.
export const sellerNav: NavConfig = {
  items: [
    { id: 's_home', labelKey: 'nav.home', href: '/' },
    // Shown only while the seller is not approved (SellerShell hides it after).
    { id: 's_setup', labelKey: 'nav.setup', href: '/account-setup' },
  ],
};
