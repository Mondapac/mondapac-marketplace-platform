// The command palette's static index (settings UX design, package S5). Phase 1 has no backend
// search: the index is built in code from the same sources that draw the menu and the settings
// hub, filtered by the same `permits` rule, so the three never disagree. Filtering is
// presentation only; the server stays the security boundary (ADR-0018).

import type { IconName } from '../icon/icon.tsx';
import { permits, type NavItem } from '../shell/nav.ts';

export type PaletteKind = 'page' | 'setting' | 'action';

/** One result row, with its text already resolved through the app's messages. */
export interface PaletteEntry {
  readonly id: string;
  readonly kind: PaletteKind;
  readonly label: string;
  /** Where it lives: the group of a page, the page of a setting. Searchable and shown under the label. */
  readonly context?: string;
  /** Extra words that find the entry without being shown. */
  readonly keywords?: string;
  readonly href: string;
  readonly icon: IconName;
}

/** A settings page as the app's settings map holds it. */
export interface PaletteSettingsPage {
  readonly id: string;
  readonly labelKey: string;
  readonly href: string;
  /** The page shows with any one of these; absent means always (account pages). */
  readonly view?: readonly string[] | undefined;
  readonly groupLabelKey: string;
  readonly groupIcon: IconName;
  /**
   * The first crumb of its path ("Settings" for a page of the Settings hub). Absent for a page that
   * is not under a hub (the account pages): its path starts at the group.
   */
  readonly rootLabelKey?: string;
}

/** One setting on a settings page ("Support email"). Its row anchor is `#setting-<id>`. */
export interface PaletteSettingSpec {
  readonly id: string;
  /** The `id` of the settings page the setting lives on. */
  readonly pageId: string;
  readonly labelKey: string;
  /** Message key of extra search words (comma-separated), if any. */
  readonly keywordsKey?: string;
}

/** A common action ("Create role"): a link to the screen where it starts. */
export interface PaletteActionSpec {
  readonly id: string;
  readonly labelKey: string;
  readonly href: string;
  readonly icon: IconName;
  readonly anyOf: readonly string[];
}

export interface PaletteSources {
  /** Resolves a message key through the app's catalogue. */
  readonly label: (key: string) => string;
  readonly permissionKeys: readonly string[];
  /** The menu items the shell shows. */
  readonly navItems: readonly NavItem[];
  readonly settingsPages: readonly PaletteSettingsPage[];
  readonly settings: readonly PaletteSettingSpec[];
  readonly actions: readonly PaletteActionSpec[];
  /** Label keys of the `NavConfig.groups` by group id, so a page can show the group it sits in. */
  readonly groupLabelKeys?: Readonly<Record<string, string>>;
}

/** Between the crumbs of a result's path: "Settings / Delivery / Delivery rules". */
export const CRUMB_SEPARATOR = ' / ';

/** The row anchor a setting is reached by. */
export const settingHash = (settingId: string): string => `#setting-${settingId}`;

export const pageEntryId = (navId: string): string => `page:${navId}`;
export const settingsPageEntryId = (pageId: string): string => `page:settings/${pageId}`;

/**
 * Where a settings page or one of its settings lives, as a path the reader can follow: the root
 * (Settings), the group, and for a setting the page too.
 */
function crumbs(
  page: PaletteSettingsPage,
  label: (key: string) => string,
  withPage: boolean,
): string {
  return [
    page.rootLabelKey === undefined ? undefined : label(page.rootLabelKey),
    label(page.groupLabelKey),
    withPage ? label(page.labelKey) : undefined,
  ]
    .filter((crumb): crumb is string => crumb !== undefined)
    .join(CRUMB_SEPARATOR);
}

/**
 * Every page, setting and action the caller may open, in a fixed order: menu pages, settings
 * pages, settings, actions. A setting shows only when its page does.
 */
export function buildPaletteEntries(sources: PaletteSources): readonly PaletteEntry[] {
  const held = new Set(sources.permissionKeys);
  const { label } = sources;
  const entries: PaletteEntry[] = [];
  for (const item of sources.navItems) {
    if (!permits(item.anyOf, held)) continue;
    const groupKey = item.group === undefined ? undefined : sources.groupLabelKeys?.[item.group];
    entries.push({
      id: pageEntryId(item.id),
      kind: 'page',
      label: label(item.labelKey),
      ...(groupKey === undefined ? {} : { context: label(groupKey) }),
      href: item.href,
      icon: item.icon,
    });
  }
  const pages = new Map<string, PaletteSettingsPage>();
  for (const page of sources.settingsPages) {
    if (!permits(page.view, held)) continue;
    pages.set(page.id, page);
    entries.push({
      id: settingsPageEntryId(page.id),
      kind: 'page',
      label: label(page.labelKey),
      context: crumbs(page, label, false),
      href: page.href,
      icon: page.groupIcon,
    });
  }
  for (const spec of sources.settings) {
    const page = pages.get(spec.pageId);
    if (page === undefined) continue;
    entries.push({
      id: `setting:${spec.id}`,
      kind: 'setting',
      label: label(spec.labelKey),
      context: crumbs(page, label, true),
      ...(spec.keywordsKey === undefined ? {} : { keywords: label(spec.keywordsKey) }),
      href: `${page.href}${settingHash(spec.id)}`,
      icon: 'sliders',
    });
  }
  for (const action of sources.actions) {
    if (!permits(action.anyOf, held)) continue;
    entries.push({
      id: `action:${action.id}`,
      kind: 'action',
      label: label(action.labelKey),
      href: action.href,
      icon: action.icon,
    });
  }
  return entries;
}

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Lower is better; -1 means the entry does not match every word of the query. */
function score(entry: PaletteEntry, words: readonly string[]): number {
  const label = normalise(entry.label);
  const rest = normalise(`${entry.context ?? ''} ${entry.keywords ?? ''}`);
  let total = 0;
  for (const word of words) {
    if (label.startsWith(word)) total += 0;
    else if (label.includes(` ${word}`)) total += 1;
    else if (label.includes(word)) total += 2;
    else if (rest.includes(word)) total += 3;
    else return -1;
  }
  return total;
}

/**
 * The entries matching every word of the query, best first; equal scores keep index order (pages,
 * then settings, then actions). An empty query matches nothing: the palette shows its own start
 * view then.
 */
export function searchPalette(
  entries: readonly PaletteEntry[],
  query: string,
): readonly PaletteEntry[] {
  const words = normalise(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return entries
    .map((entry, index) => ({ entry, index, rank: score(entry, words) }))
    .filter((hit) => hit.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((hit) => hit.entry);
}

const pathOf = (href: string): string => href.split('#')[0] ?? href;

/**
 * The page entry for a path: an exact match, else the longest entry whose path is a parent
 * segment of it (`/orders/42` is Orders). The home path matches only itself.
 */
export function matchPage(
  entries: readonly PaletteEntry[],
  pathname: string,
): PaletteEntry | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: PaletteEntry | undefined;
  for (const entry of entries) {
    if (entry.kind !== 'page') continue;
    const href = pathOf(entry.href);
    const matches = href === path || (href !== '/' && path.startsWith(`${href}/`));
    if (matches && (best === undefined || href.length > pathOf(best.href).length)) best = entry;
  }
  return best;
}
