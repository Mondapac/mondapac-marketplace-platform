// Typed navigation config and its filter (panels IA section 3 and 7). The sidebar, the
// drawer and the bottom bar all render the one filtered config; filtering is presentation
// only, the server authorises every route and call (ADR-0018).

export interface NavItem {
  readonly id: string;
  /** Message key of the label (text lives in the app's catalogue, ADR-0033 decision 10). */
  readonly labelKey: string;
  readonly href: string;
  readonly group?: string;
  /** Permission keys; the item shows with any one of them. Absent means always shown. */
  readonly anyOf?: readonly string[];
  /** Where the badge count comes from; the count itself is fetched by the app. */
  readonly badgeSource?: string;
}

export interface NavConfig {
  readonly items: readonly NavItem[];
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
