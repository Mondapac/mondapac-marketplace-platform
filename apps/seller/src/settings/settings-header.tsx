import { Tabs, type TabItem } from '@mondapac/ui';
import { STORE_SETTINGS_EDIT_PERMISSION } from '../delivery/types.ts';
import { PAYOUT_VIEW_PERMISSION } from '../payout/types.ts';
import { STOCK_VIEW_PERMISSION } from '../stock/types.ts';

export type SettingsTab = 'security' | 'payout' | 'locations' | 'delivery';

// Seller Settings (Jafar and Hadi, 2026-10-16): one menu item for the store's own configuration.
// Each tab keeps its page and address (Stripe returns to /payout-account), so a tab is a link.
const TABS: readonly { id: SettingsTab; href: string; permission?: string }[] = [
  { id: 'security', href: '/account/security' },
  { id: 'payout', href: '/payout-account', permission: PAYOUT_VIEW_PERMISSION },
  { id: 'locations', href: '/stock-locations', permission: STOCK_VIEW_PERMISSION },
  { id: 'delivery', href: '/delivery', permission: STORE_SETTINGS_EDIT_PERMISSION },
];

/** The tabs the caller may open, in order. Security is every approved seller's. */
export function settingsTabs(
  permissionKeys: readonly string[],
  t: (key: string) => string,
  /** The page being shown keeps its tab even without the permission (its no-access state). */
  current?: SettingsTab,
): readonly TabItem[] {
  return TABS.filter(
    (tab) =>
      tab.id === current || tab.permission === undefined || permissionKeys.includes(tab.permission),
  ).map((tab) => ({ id: tab.id, href: tab.href, label: t(`settings.tab.${tab.id}`) }));
}

/** The page heading and tab row on top of every Settings page. */
export function SettingsHeader({
  active,
  permissionKeys,
  t,
}: {
  readonly active: SettingsTab;
  readonly permissionKeys: readonly string[];
  readonly t: (key: string) => string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      <Tabs
        label={t('settings.tabs')}
        items={settingsTabs(permissionKeys, t, active)}
        activeId={active}
      />
    </div>
  );
}
