'use client';

import { Banner, EmptyState, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { AttributesTab } from './attributes-tab.tsx';
import { FeatureSetsTab } from './feature-sets-tab.tsx';
import { ATTRIBUTES_PATH, BRANDS_PATH, type Tab } from './types.ts';

/**
 * The Attributes page (attributes plan 16, package A1): four tabs. Attributes and Feature sets
 * are a list with the chosen row's details beside it (below it on a narrow screen); Brands is the
 * brands page; Waiting for you is empty until package A5. Read only: an admin without
 * `catalog.attribute.edit` sees the view-only notice, and no write exists yet for anyone.
 */
export function AttributesView({
  canEdit,
  canSeeBrands,
  initialTab,
  initialId,
}: {
  readonly canEdit: boolean;
  readonly canSeeBrands: boolean;
  readonly initialTab: Tab;
  readonly initialId: string | null;
}) {
  const t = useTranslations('attributes');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [counts, setCounts] = useState<{ attributes?: number; featureSets?: number }>({});

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

  const onAttributesCount = useCallback(
    (count: number) => setCounts((current) => ({ ...current, attributes: count })),
    [],
  );
  const onFeatureSetsCount = useCallback(
    (count: number) => setCounts((current) => ({ ...current, featureSets: count })),
    [],
  );

  const label = (id: Tab, count: number | undefined) =>
    count === undefined ? t(`tab.${id}`) : `${t(`tab.${id}`)} ${count}`;
  const items = [
    { id: 'attributes', label: label('attributes', counts.attributes) },
    { id: 'feature-sets', label: label('feature-sets', counts.featureSets) },
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
          onTotal={onAttributesCount}
          onFeatureSetCount={onFeatureSetsCount}
        />
      ) : null}
      {tab === 'feature-sets' ? (
        <FeatureSetsTab
          selectedId={selected}
          onSelect={setSelected}
          onTotal={onFeatureSetsCount}
          onOpenAttribute={(id) => {
            setTab('attributes');
            setSelected(id);
          }}
        />
      ) : null}
      {tab === 'waiting' ? (
        <EmptyState size="card" icon="inbox" title={t('waiting.empty')} />
      ) : null}
    </div>
  );
}
