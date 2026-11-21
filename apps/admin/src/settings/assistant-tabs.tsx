'use client';

import { Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** The two pages of Settings > Shopping assistant: its settings and its insights. */
export function AssistantTabs({ active }: { readonly active: 'settings' | 'insights' }) {
  const t = useTranslations('settings.assistant.tabs');
  return (
    <Tabs
      label={t('label')}
      activeId={active}
      items={[
        { id: 'settings', label: t('settings'), href: '/settings/assistant' },
        { id: 'insights', label: t('insights'), href: '/settings/assistant/insights' },
      ]}
    />
  );
}
