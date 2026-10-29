import { Tabs } from '@mondapac/ui';
import { SETTINGS_HREF, SETTINGS_VIEW_PERMISSION } from '../account-deletion/types.ts';
import { ASSISTANT_VIEW_PERMISSION } from './assistant-types.ts';
import { SUPPORT_VIEW_PERMISSION } from './types.ts';

export type SettingsTab = 'general' | 'assistant' | 'account-deletion';

const HREF: Readonly<Record<SettingsTab, string>> = {
  general: '/settings',
  assistant: '/settings/assistant',
  'account-deletion': SETTINGS_HREF,
};

/** The tabs of Settings: links, with the current one marked. */
export function SettingsTabs({
  active,
  labels,
}: {
  readonly active: SettingsTab;
  /** Absent when the actor may see only one tab: the page then has no tab row. */
  readonly labels: {
    readonly nav: string;
    /** Only the tabs the actor may see, in display order. */
    readonly tabs: readonly { readonly id: SettingsTab; readonly label: string }[];
  } | null;
}) {
  if (labels === null) return null;
  return (
    <div className="mb-4">
      <Tabs
        label={labels.nav}
        activeId={active}
        items={labels.tabs.map((tab) => ({ id: tab.id, href: HREF[tab.id], label: tab.label }))}
      />
    </div>
  );
}

/** The tab labels from a translator (server pages), or null when only one tab is visible. */
export function settingsTabLabels(t: (key: string) => string, keys: readonly string[]) {
  const tabs: { id: SettingsTab; label: string }[] = [];
  if (keys.includes(SUPPORT_VIEW_PERMISSION))
    tabs.push({ id: 'general', label: t('settings.tabs.general') });
  if (keys.includes(ASSISTANT_VIEW_PERMISSION))
    tabs.push({ id: 'assistant', label: t('settings.tabs.assistant') });
  if (keys.includes(SETTINGS_VIEW_PERMISSION))
    tabs.push({ id: 'account-deletion', label: t('settings.tabs.account-deletion') });
  if (tabs.length < 2) return null;
  return { nav: t('settings.tabs.label'), tabs };
}
