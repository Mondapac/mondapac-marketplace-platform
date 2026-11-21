import type { IconName } from '../icon/icon.tsx';
import type { PaletteSettingSpec } from '../palette/palette-index.ts';

/** One link of the Settings menu, text resolved; `words` are extra search words (setting labels). */
export interface SettingsMenuLink {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly words: readonly string[];
}

export interface SettingsMenuGroup {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly links: readonly SettingsMenuLink[];
}

/** What the app hands the sidebar to switch it to settings mode (every text already resolved). */
export interface SettingsMenu {
  readonly groups: readonly SettingsMenuGroup[];
  /** Id of the settings page being shown; absent on the hub. */
  readonly activeId?: string;
  readonly backHref: string;
  readonly backLabel: string;
  readonly searchLabel: string;
  readonly emptyLabel: string;
  /** Name of the menu landmark. */
  readonly navLabel: string;
}

interface VisibleGroup {
  readonly group: { readonly id: string; readonly labelKey: string; readonly icon: IconName };
  readonly links: readonly {
    readonly link: {
      readonly id: string;
      readonly labelKey: string;
      readonly href: string;
      /** Extra comma-separated search words for the page itself (a former name, synonyms). */
      readonly keywordsKey?: string;
    };
  }[];
}

/**
 * The groups of the Settings menu from the app's already-filtered settings map: a user without a
 * page's view key never gets its link. A setting's label (and its extra words) is searchable
 * under the page it lives on, and so are the page's own extra words.
 */
export function buildSettingsMenuGroups(
  visible: readonly VisibleGroup[],
  specs: readonly PaletteSettingSpec[],
  label: (key: string) => string,
): readonly SettingsMenuGroup[] {
  return visible.map(({ group, links }) => ({
    id: group.id,
    icon: group.icon,
    label: label(group.labelKey),
    links: links.map(({ link }) => ({
      id: link.id,
      href: link.href,
      label: label(link.labelKey),
      words: [
        ...(link.keywordsKey === undefined ? [] : label(link.keywordsKey).split(',')),
        ...specs
          .filter((spec) => spec.pageId === link.id)
          .flatMap((spec) => [
            label(spec.labelKey),
            ...(spec.keywordsKey === undefined ? [] : label(spec.keywordsKey).split(',')),
          ]),
      ]
        .map((word) => word.trim())
        .filter((word) => word !== ''),
    })),
  }));
}

/** The menu the query leaves: a group whose name matches keeps all its links; empty groups go. */
export function filterSettingsMenu(
  groups: readonly SettingsMenuGroup[],
  query: string,
): readonly SettingsMenuGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return groups;
  const hit = (text: string) => text.toLowerCase().includes(needle);
  return groups.flatMap((group) => {
    if (hit(group.label)) return [group];
    const links = group.links.filter((link) => hit(link.label) || link.words.some(hit));
    return links.length === 0 ? [] : [{ ...group, links }];
  });
}
