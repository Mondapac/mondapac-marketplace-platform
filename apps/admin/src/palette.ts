import {
  buildPaletteEntries,
  visibleNavItems,
  type GoShortcut,
  type PaletteActionSpec,
  type PaletteEntry,
  type PaletteSettingsPage,
} from '@mondapac/ui';
import { adminNav } from './nav.ts';
import { settingEntries, settingsGroups } from './settings/settings-nav.ts';

// The admin panel's command palette: what it can find, which pages a role starts with pinned and
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

const settingsPages: readonly PaletteSettingsPage[] = [
  ...settingsGroups.flatMap((group) =>
    group.links.map((link) => ({
      id: link.id,
      labelKey: link.labelKey,
      href: link.href,
      view: link.view,
      groupLabelKey: group.labelKey,
      groupIcon: group.icon,
      rootLabelKey: 'nav.settings',
    })),
  ),
  ...accountPages,
];

export const adminActions: readonly PaletteActionSpec[] = [
  {
    id: 'invite-admin',
    labelKey: 'palette.action.invite-admin',
    href: '/settings/admins',
    icon: 'users',
    anyOf: ['identity.admin-account.invite'],
  },
  {
    id: 'create-role',
    labelKey: 'palette.action.create-role',
    href: '/settings/roles/new',
    icon: 'shield-check',
    anyOf: ['identity.platform-role.create'],
  },
];

/** Every page, setting and action the keys allow. */
export function adminPaletteEntries(
  permissionKeys: readonly string[],
  label: (key: string) => string,
): readonly PaletteEntry[] {
  return buildPaletteEntries({
    label,
    permissionKeys,
    navItems: visibleNavItems(adminNav, new Set(permissionKeys)),
    settingsPages,
    settings: settingEntries,
    actions: adminActions,
    groupLabelKeys: Object.fromEntries((adminNav.groups ?? []).map((g) => [g.id, g.labelKey])),
  });
}

/** G then S opens Settings, G then O opens Orders; each only when the account may open it. */
export function adminGoShortcuts(
  entries: readonly PaletteEntry[],
  label: (key: string) => string,
): readonly GoShortcut[] {
  const href = (id: string) => entries.find((entry) => entry.id === id)?.href;
  const shortcuts: GoShortcut[] = [];
  const settings = href('page:settings');
  if (settings !== undefined) {
    shortcuts.push({
      id: 'go-settings',
      keys: ['g', 's'],
      href: settings,
      label: label('palette.shortcuts.go-settings'),
    });
  }
  const orders = href('page:orders');
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
