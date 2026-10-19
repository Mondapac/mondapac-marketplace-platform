import { Tabs } from '@mondapac/ui';
import { ASSISTANT_VIEW_PERMISSION } from './assistant-types.ts';
import { SUPPORT_VIEW_PERMISSION } from './types.ts';

/** The tabs of Settings: links, with the current one marked. */
export function SettingsTabs({
  active,
  labels,
}: {
  readonly active: 'general' | 'assistant';
  /** Absent when the actor may see only one tab: the page then has no tab row. */
  readonly labels: {
    readonly nav: string;
    readonly general: string;
    readonly assistant: string;
  } | null;
}) {
  if (labels === null) return null;
  return (
    <div className="mb-4">
      <Tabs
        label={labels.nav}
        activeId={active}
        items={[
          { id: 'general', href: '/settings', label: labels.general },
          { id: 'assistant', href: '/settings/assistant', label: labels.assistant },
        ]}
      />
    </div>
  );
}

/** The tab labels from a translator (server pages), or null when only one tab is visible. */
export function settingsTabLabels(t: (key: string) => string, keys: readonly string[]) {
  const both = keys.includes(SUPPORT_VIEW_PERMISSION) && keys.includes(ASSISTANT_VIEW_PERMISSION);
  if (!both) return null;
  return {
    nav: t('settings.tabs.label'),
    general: t('settings.tabs.general'),
    assistant: t('settings.tabs.assistant'),
  };
}
