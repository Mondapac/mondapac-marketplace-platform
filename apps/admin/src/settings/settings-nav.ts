import type { IconName, PaletteSettingSpec } from '@mondapac/ui';
import {
  DELIVERY_MANAGE_PERMISSION,
  DELIVERY_VIEW_PERMISSION,
} from '../delivery-settings/types.ts';
import {
  SETTINGS_MANAGE_PERMISSION as DELETION_MANAGE_PERMISSION,
  SETTINGS_VIEW_PERMISSION as DELETION_VIEW_PERMISSION,
} from '../account-deletion/types.ts';
import { FLEET_MANAGE_PERMISSION, FLEET_VIEW_PERMISSION } from '../fleet-selection/types.ts';
import { SETTINGS_MANAGE, SETTINGS_VIEW } from '../wallet/types.ts';
import { ASSISTANT_MANAGE_PERMISSION, ASSISTANT_VIEW_PERMISSION } from './assistant-types.ts';
import {
  SETTINGS_MANAGE_PERMISSION as LISTS_MANAGE_PERMISSION,
  SETTINGS_VIEW_PERMISSION as LISTS_VIEW_PERMISSION,
} from '../lists-settings/types.ts';
import { SUPPORT_MANAGE_PERMISSION, SUPPORT_VIEW_PERMISSION } from './types.ts';

// The one map of the admin Settings pages (settings UX design, hub and roles sections). The hub,
// the settings sub-navigation and the sidebar's single Settings item all read it, so they can
// never disagree; the search of a later package reads it too. Pages of a phase that has not shipped
// are absent, not disabled. Filtering is presentation only: the server authorises every route.

export interface SettingsLink {
  readonly id: string;
  /** Message key of the link's label (also its entry in the sub-navigation). */
  readonly labelKey: string;
  readonly href: string;
  /** The page shows with any one of these. */
  readonly view: readonly string[];
  /** Holding a view key but none of these makes the page "View only". */
  readonly manage: readonly string[];
}

export interface SettingsGroup {
  readonly id: string;
  readonly labelKey: string;
  readonly icon: IconName;
  readonly links: readonly SettingsLink[];
}

export const settingsGroups: readonly SettingsGroup[] = [
  {
    id: 'marketplace',
    labelKey: 'settings.hub.group.marketplace',
    icon: 'store',
    links: [
      {
        id: 'support',
        labelKey: 'settings.hub.link.support',
        href: '/settings/support',
        view: [SUPPORT_VIEW_PERMISSION],
        manage: [SUPPORT_MANAGE_PERMISSION],
      },
      {
        id: 'assistant',
        labelKey: 'settings.hub.link.assistant',
        href: '/settings/assistant',
        view: [ASSISTANT_VIEW_PERMISSION],
        manage: [ASSISTANT_MANAGE_PERMISSION],
      },
      {
        id: 'account-deletion',
        labelKey: 'settings.hub.link.account-deletion',
        href: '/settings/account-deletion',
        view: [DELETION_VIEW_PERMISSION],
        manage: [DELETION_MANAGE_PERMISSION],
      },
      {
        id: 'lists',
        labelKey: 'settings.hub.link.lists',
        href: '/settings/lists',
        view: [LISTS_VIEW_PERMISSION],
        manage: [LISTS_MANAGE_PERMISSION],
      },
    ],
  },
  {
    id: 'delivery',
    labelKey: 'settings.hub.group.delivery',
    icon: 'package',
    links: [
      {
        id: 'delivery',
        labelKey: 'settings.hub.link.delivery',
        href: '/settings/delivery',
        view: [DELIVERY_VIEW_PERMISSION],
        manage: [DELIVERY_MANAGE_PERMISSION],
      },
      {
        id: 'fleets',
        labelKey: 'settings.hub.link.fleets',
        href: '/settings/fleets',
        view: [FLEET_VIEW_PERMISSION],
        manage: [FLEET_MANAGE_PERMISSION],
      },
    ],
  },
  {
    id: 'money',
    labelKey: 'settings.hub.group.money',
    icon: 'wallet',
    links: [
      {
        id: 'wallet',
        labelKey: 'settings.hub.link.wallet',
        href: '/settings/wallet',
        view: [SETTINGS_VIEW],
        manage: [SETTINGS_MANAGE],
      },
    ],
  },
  {
    id: 'people',
    labelKey: 'settings.hub.group.people',
    icon: 'users',
    links: [
      {
        id: 'admins',
        labelKey: 'settings.hub.link.admins',
        href: '/settings/admins',
        view: ['identity.admin-account.view'],
        manage: [
          'identity.admin-account.invite',
          'identity.admin-account.disable',
          'identity.admin-account.reset-second-factor',
          'identity.platform-role.assign',
        ],
      },
      {
        id: 'roles',
        labelKey: 'settings.hub.link.roles',
        href: '/settings/roles',
        view: ['identity.platform-role.view'],
        manage: [
          'identity.platform-role.create',
          'identity.platform-role.edit',
          'identity.platform-role.manage',
        ],
      },
    ],
  },
];

/** Every view key of every settings page: holding any one of them shows the sidebar's Settings. */
export const settingsViewKeys: readonly string[] = settingsGroups.flatMap((group) =>
  group.links.flatMap((link) => link.view),
);

export interface VisibleSettingsLink {
  readonly link: SettingsLink;
  /** The caller may open the page but change nothing on it. */
  readonly viewOnly: boolean;
}

export interface VisibleSettingsGroup {
  readonly group: SettingsGroup;
  readonly links: readonly VisibleSettingsLink[];
}

/** The groups and links the caller may open, in config order; a group without a link is left out. */
export function visibleSettings(keys: readonly string[]): readonly VisibleSettingsGroup[] {
  const held = new Set(keys);
  return settingsGroups.flatMap((group) => {
    const links = group.links
      .filter((link) => link.view.some((key) => held.has(key)))
      .map((link) => ({ link, viewOnly: !link.manage.some((key) => held.has(key)) }));
    return links.length === 0 ? [] : [{ group, links }];
  });
}

/** A link and the group it sits in, by link id. */
export function settingsLink(
  id: string,
): { readonly group: SettingsGroup; readonly link: SettingsLink } | undefined {
  for (const group of settingsGroups) {
    const link = group.links.find((candidate) => candidate.id === id);
    if (link !== undefined) return { group, link };
  }
  return undefined;
}

/**
 * The settings registry (command palette, package S5): one entry per findable setting, on a page
 * of the map above. An entry opens its page at `#setting-<id>`, and the page's `SettingRow` with
 * the same `settingId` scrolls to it, takes focus and is highlighted. An entry shows only when its
 * page does. A page that has not tagged the row yet still opens; only the highlight is missing.
 * Labels and search words live in the app's messages under `palette.setting`.
 */
export const settingEntries: readonly PaletteSettingSpec[] = [
  {
    id: 'support-email',
    pageId: 'support',
    labelKey: 'palette.setting.support-email',
    keywordsKey: 'palette.setting.support-email-words',
  },
  {
    id: 'assistant-enabled',
    pageId: 'assistant',
    labelKey: 'palette.setting.assistant-enabled',
    keywordsKey: 'palette.setting.assistant-enabled-words',
  },
  {
    id: 'assistant-audience',
    pageId: 'assistant',
    labelKey: 'palette.setting.assistant-audience',
    keywordsKey: 'palette.setting.assistant-audience-words',
  },
  {
    id: 'assistant-model',
    pageId: 'assistant',
    labelKey: 'palette.setting.assistant-model',
    keywordsKey: 'palette.setting.assistant-model-words',
  },
  {
    id: 'assistant-welcome',
    pageId: 'assistant',
    labelKey: 'palette.setting.assistant-welcome',
    keywordsKey: 'palette.setting.assistant-welcome-words',
  },
  { id: 'delivery-methods', pageId: 'delivery', labelKey: 'palette.setting.delivery-methods' },
  { id: 'delivery-cutoff', pageId: 'delivery', labelKey: 'palette.setting.delivery-cutoff' },
  {
    id: 'delivery-margin',
    pageId: 'delivery',
    labelKey: 'palette.setting.delivery-margin',
    keywordsKey: 'palette.setting.delivery-margin-words',
  },
  {
    id: 'wallet-state',
    pageId: 'wallet',
    labelKey: 'palette.setting.wallet-state',
    keywordsKey: 'palette.setting.wallet-state-words',
  },
  { id: 'two-step', pageId: 'account-security', labelKey: 'palette.setting.two-step' },
];
