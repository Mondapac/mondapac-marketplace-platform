import {
  buildPaletteEntries,
  defaultPins,
  type GoShortcut,
  type PaletteActionSpec,
  type PaletteEntry,
  type PaletteSettingsPage,
} from '@mondapac/ui';
import { sellerNav, sellerNavItems } from './nav.ts';
import { settingEntries, settingsGroups } from './settings/settings-nav.ts';
import { TEAM_INVITE_PERMISSION } from './team/types.ts';

// The seller panel's command palette: what it can find, which pages a role starts with pinned and
// the "go to" shortcuts. Everything is filtered by the same permission rule as the menu and the
// settings hub (`permits`), so the three always agree; the server authorises every route.

/** Personal account pages: always allowed (own resources), found under "Account". */
const accountPages: readonly PaletteSettingsPage[] = [
  {
    id: 'account-profile',
    labelKey: 'account-menu.profile',
    href: '/account/profile',
    groupLabelKey: 'palette.group.account',
    groupIcon: 'user',
  },
  {
    id: 'account-security',
    labelKey: 'account-menu.security',
    href: '/account/security',
    groupLabelKey: 'palette.group.account',
    groupIcon: 'user',
  },
  {
    id: 'account-sessions',
    labelKey: 'account-menu.sessions',
    href: '/account/sessions',
    groupLabelKey: 'palette.group.account',
    groupIcon: 'user',
  },
];

/** Before approval, Security is not offered (as in the account menu). */
const unapprovedAccountPages = accountPages.filter((page) => page.id !== 'account-security');

const settingsPages: readonly PaletteSettingsPage[] = [
  ...settingsGroups.flatMap((group) =>
    group.links.map((link) => ({
      id: link.id,
      labelKey: link.labelKey,
      href: link.href,
      view: link.view,
      groupLabelKey: group.labelKey,
      groupIcon: group.icon,
    })),
  ),
  ...accountPages,
];

export const sellerActions: readonly PaletteActionSpec[] = [
  {
    id: 'add-product',
    labelKey: 'palette.action.add-product',
    href: '/products/new',
    icon: 'package',
    anyOf: ['catalog.own-product.edit'],
  },
  {
    id: 'invite-member',
    labelKey: 'palette.action.invite-member',
    href: '/settings/team',
    icon: 'users',
    anyOf: [TEAM_INVITE_PERMISSION],
  },
];

/**
 * Every page, setting and action the keys allow. Before approval the menu holds only the setup
 * page (and the account pages), and so does the palette: settings need an approved seller.
 */
export function sellerPaletteEntries(
  accessState: 'pending' | 'approved' | 'rejected',
  permissionKeys: readonly string[],
  label: (key: string) => string,
): readonly PaletteEntry[] {
  const approved = accessState === 'approved';
  return buildPaletteEntries({
    label,
    permissionKeys,
    navItems: sellerNavItems(accessState, permissionKeys),
    settingsPages: approved ? settingsPages : unapprovedAccountPages,
    settings: approved ? settingEntries : [],
    actions: approved ? sellerActions : [],
    groupLabelKeys: Object.fromEntries((sellerNav.groups ?? []).map((g) => [g.id, g.labelKey])),
  });
}

// Three pages a role starts with, by the work its permissions point to (the first profile the
// account qualifies for), then a general tail so a small role still gets three. A user can change
// them; the choice is theirs from then on.
const PIN_PROFILES: readonly { readonly when: string; readonly pins: readonly string[] }[] = [
  {
    when: 'ordering.seller-order.view',
    pins: ['page:s_orders', 'page:s_offers', 'page:s_earnings'],
  },
  { when: 'catalog.own-product.view', pins: ['page:s_products', 'page:s_offers', 'page:s_orders'] },
  {
    when: 'commission-payouts.earnings.view',
    pins: ['page:s_earnings', 'page:settings/payout-account'],
  },
];
const PIN_FALLBACK: readonly string[] = ['page:s_orders', 'page:s_products', 'page:s_settings'];

export function sellerDefaultPinIds(
  entries: readonly PaletteEntry[],
  permissionKeys: readonly string[],
): readonly string[] {
  const held = new Set(permissionKeys);
  const profile = PIN_PROFILES.find((candidate) => held.has(candidate.when));
  return defaultPins(
    [...(profile?.pins ?? []), ...PIN_FALLBACK],
    new Set(entries.map((entry) => entry.id)),
  );
}

/** G then S opens Settings, G then O opens Orders; each only when the account may open it. */
export function sellerGoShortcuts(
  entries: readonly PaletteEntry[],
  label: (key: string) => string,
): readonly GoShortcut[] {
  const href = (id: string) => entries.find((entry) => entry.id === id)?.href;
  const shortcuts: GoShortcut[] = [];
  const settings = href('page:s_settings');
  if (settings !== undefined) {
    shortcuts.push({
      id: 'go-settings',
      keys: ['g', 's'],
      href: settings,
      label: label('palette.shortcuts.go-settings'),
    });
  }
  const orders = href('page:s_orders');
  if (orders !== undefined) {
    shortcuts.push({
      id: 'go-orders',
      keys: ['g', 'o'],
      href: orders,
      label: label('palette.shortcuts.go-orders'),
    });
  }
  return shortcuts;
}
