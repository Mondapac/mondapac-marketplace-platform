// Typed navigation config and its filter (panels IA section 3 and 7). The sidebar, the
// drawer and the bottom bar all render the one filtered config; filtering is presentation
// only, the server authorises every route and call (ADR-0018).

import type { IconName } from '../icon/icon.tsx';

export interface NavItem {
  readonly id: string;
  /** Message key of the label (text lives in the app's catalogue, ADR-0033 decision 10). */
  readonly labelKey: string;
  readonly href: string;
  /** Every item has an icon from the shared set (Figma NavItem). */
  readonly icon: IconName;
  /** Id of the `NavConfig.groups` entry the item sits under; absent means it stays ungrouped. */
  readonly group?: string;
  /** Permission keys; the item shows with any one of them. Absent means always shown. */
  readonly anyOf?: readonly string[];
  /** Where the badge count comes from; the count itself is fetched by the app. */
  readonly badgeSource?: string;
}

/** A topic the sidebar folds its items under (a header that opens and closes the group). */
export interface NavGroup {
  readonly id: string;
  /** Message key of the group's label. */
  readonly labelKey: string;
  readonly icon: IconName;
}

export interface NavConfig {
  readonly items: readonly NavItem[];
  /** Ordered topics for `NavItem.group`. Absent means the sidebar is a flat list. */
  readonly groups?: readonly NavGroup[];
}

/** The items the caller may see, in config order. An item with no `anyOf` is always shown. */
export function visibleNavItems(
  config: NavConfig,
  permissionKeys: ReadonlySet<string>,
): readonly NavItem[] {
  return config.items.filter(
    (item) => item.anyOf === undefined || item.anyOf.some((key) => permissionKeys.has(key)),
  );
}

/** What the sidebar draws, top to bottom: a plain item, or a group header with its items. */
export type NavSection =
  | { readonly kind: 'item'; readonly item: NavItem }
  | { readonly kind: 'group'; readonly group: NavGroup; readonly items: readonly NavItem[] };

/**
 * Turns the visible items into sidebar sections. Ungrouped items keep their place; a group takes
 * the place of its first visible item and gathers all its visible items there. A group without
 * visible items is left out, and a group with one visible item shows that item flat, since a
 * header over a single link only adds a click.
 */
export function navSections(
  groups: readonly NavGroup[] | undefined,
  items: readonly NavItem[],
): readonly NavSection[] {
  const known = new Map((groups ?? []).map((group) => [group.id, group]));
  const members = new Map<string, NavItem[]>();
  for (const item of items) {
    if (item.group === undefined || !known.has(item.group)) continue;
    members.set(item.group, [...(members.get(item.group) ?? []), item]);
  }
  const sections: NavSection[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const group = item.group === undefined ? undefined : known.get(item.group);
    const inGroup = group === undefined ? undefined : members.get(group.id);
    if (group === undefined || inGroup === undefined || inGroup.length < 2) {
      sections.push({ kind: 'item', item });
    } else if (!placed.has(group.id)) {
      placed.add(group.id);
      sections.push({ kind: 'group', group, items: inGroup });
    }
  }
  return sections;
}

// Here, not in the client shell, so a server component reads the same names as values.
/** Cookie that keeps the sidebar narrowed to icons across pages and visits. */
export const SIDEBAR_COOKIE = 'mp-sidebar';
export const SIDEBAR_COLLAPSED = 'collapsed';

/** The saved sidebar choice from the cookie's value; anything else is the full sidebar. */
export function sidebarCollapsed(value: string | undefined): boolean {
  return value === SIDEBAR_COLLAPSED;
}

/** Cookie that keeps which sidebar groups are open, as a comma-separated list of group ids. */
export const NAV_OPEN_COOKIE = 'mp-nav-open';

/** The open group ids from the cookie's value; no cookie (a first visit) means every group closed. */
export function navOpenGroups(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  let text = value;
  try {
    text = decodeURIComponent(value);
  } catch {
    // A malformed value is read as typed.
  }
  return text.split(',').filter((id) => id !== '');
}

/**
 * The breadcrumb above a page: the panel's first item (its home) and the active item, each only
 * when it is not the page itself. `label` resolves a label key through the app's messages. When the
 * active item sits in a group the sidebar shows as a group (two or more visible items), the group's
 * label comes between them as a crumb without a link, since a group is not a page.
 */
export function navTrail(
  items: readonly NavItem[],
  activeId: string,
  pageTitle: string,
  label: (key: string) => string,
  groups?: readonly NavGroup[],
): readonly { label: string; href?: string }[] {
  const active = items.find((candidate) => candidate.id === activeId);
  const trail: { label: string; href?: string }[] = [];
  const group = groups?.find((candidate) => candidate.id === active?.group);
  const grouped = group !== undefined && items.filter((item) => item.group === group.id).length > 1;
  for (const item of [items[0], active]) {
    if (item === undefined || trail.some((crumb) => crumb.href === item.href)) continue;
    if (item === active && grouped && item !== items[0]) {
      trail.push({ label: label(group.labelKey) });
    }
    const text = label(item.labelKey);
    // The active item is the page itself when the page carries its name (a menu page, not a tab
    // under it); the home item is the page itself when it is active.
    const isPage = item === active && (item === items[0] || text === pageTitle);
    if (!isPage) trail.push({ label: text, href: item.href });
  }
  return trail;
}
