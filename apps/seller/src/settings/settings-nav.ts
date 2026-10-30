import type { IconName } from '@mondapac/ui';
import { PAYOUT_MANAGE_PERMISSION, PAYOUT_VIEW_PERMISSION } from '../payout/types.ts';
import { SOURCE_EDIT_PERMISSION, STOCK_VIEW_PERMISSION } from '../stock/types.ts';
import {
  STORE_PROFILE_EDIT_PERMISSION,
  STORE_PROFILE_VIEW_PERMISSION,
} from '../store-profile/types.ts';
import {
  TEAM_ASSIGN_PERMISSION,
  TEAM_INVITE_PERMISSION,
  TEAM_VIEW_PERMISSION,
} from '../team/types.ts';

// The one map of the seller Settings pages (settings UX design, hub section). The hub, the
// settings sub-navigation and the sidebar's single Settings item all read it, so they can never
// disagree. Pages of a phase that has not shipped are absent, not disabled (Delivery & hours,
// Roles, Order alerts). Personal account pages (profile, two-step sign-in, sessions) are not
// settings cards: they live only in the account menu. Filtering is presentation only: the server
// authorises every route.

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
    id: 'store',
    labelKey: 'settings.hub.group.store',
    icon: 'store',
    links: [
      {
        id: 'store-profile',
        labelKey: 'settings.hub.link.store-profile',
        href: '/settings/store-profile',
        view: [STORE_PROFILE_VIEW_PERMISSION],
        manage: [STORE_PROFILE_EDIT_PERMISSION],
      },
      {
        id: 'stock-locations',
        labelKey: 'settings.hub.link.stock-locations',
        href: '/settings/stock-locations',
        view: [STOCK_VIEW_PERMISSION],
        manage: [SOURCE_EDIT_PERMISSION],
      },
    ],
  },
  {
    id: 'money',
    labelKey: 'settings.hub.group.money',
    icon: 'wallet',
    links: [
      {
        id: 'payout-account',
        labelKey: 'settings.hub.link.payout-account',
        href: '/settings/payout-account',
        view: [PAYOUT_VIEW_PERMISSION],
        manage: [PAYOUT_MANAGE_PERMISSION],
      },
    ],
  },
  {
    id: 'team',
    labelKey: 'settings.hub.group.team',
    icon: 'users',
    links: [
      {
        id: 'team',
        labelKey: 'settings.hub.link.team',
        href: '/settings/team',
        view: [TEAM_VIEW_PERMISSION],
        manage: [TEAM_INVITE_PERMISSION, TEAM_ASSIGN_PERMISSION],
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
