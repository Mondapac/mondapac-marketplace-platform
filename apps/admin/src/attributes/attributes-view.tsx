'use client';

import { Banner, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AttributesTab } from './attributes-tab.tsx';
import { FeatureSetsTab } from './feature-sets-tab.tsx';
import { WaitingTab } from './waiting-tab.tsx';
import { ATTRIBUTES_PATH, BRANDS_PATH, type Tab } from './types.ts';

/**
 * The Attributes page (attributes plan 16, package A1): four tabs. Attributes and Feature sets
 * are a list with the chosen row's details beside it (below it on a narrow screen); Brands is the
 * brands page; Waiting for you lists the requests to turn off Material (A2 part 3). An admin with `catalog.attribute.edit`
 * adds and edits attributes (package A2); any other admin sees the view-only notice.
 */
export function AttributesView({
  canEdit,
  csrfToken,
  canSeeBrands,
  initialTab,
  initialId,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly canSeeBrands: boolean;
  readonly initialTab: Tab;
  readonly initialId: string | null;
}) {
  const t = useTranslations('attributes');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<string | null>(initialId);

  // The address names the tab and the open row, so a link or a reload opens the same view.
  useEffect(() => {
    const query = new URLSearchParams();
    if (tab !== 'attributes') query.set('tab', tab);
    if (selected !== null) query.set('id', selected);
    const next = query.size === 0 ? ATTRIBUTES_PATH : `${ATTRIBUTES_PATH}?${query.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [tab, selected]);

  const items = [
    { id: 'attributes', label: t('tab.attributes') },
    { id: 'feature-sets', label: t('tab.feature-sets') },
    ...(canSeeBrands ? [{ id: 'brands', label: t('tab.brands'), href: BRANDS_PATH }] : []),
    { id: 'waiting', label: t('tab.waiting') },
  ];

  return (
    <div className="mt-1 flex flex-col gap-4">
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      <Tabs
        label={t('tabs')}
        items={items}
        activeId={tab}
        onSelect={(id) => {
          setTab(id as Tab);
          setSelected(null);
        }}
      />
      {canEdit ? null : (
        <Banner tone="info" title={t('view-only.title')}>
          {t('view-only.body')}
        </Banner>
      )}
      {tab === 'attributes' ? (
        <AttributesTab
          selectedId={selected}
          onSelect={setSelected}
          canEdit={canEdit}
          csrfToken={csrfToken}
        />
      ) : null}
      {tab === 'feature-sets' ? (
        <FeatureSetsTab
          selectedId={selected}
          onSelect={setSelected}
          onOpenAttribute={(id) => {
            setTab('attributes');
            setSelected(id);
          }}
        />
      ) : null}
      {tab === 'waiting' ? (
        <WaitingTab
          canEdit={canEdit}
          csrfToken={csrfToken}
          onOpenAttribute={(id) => {
            setTab('attributes');
            setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
}
