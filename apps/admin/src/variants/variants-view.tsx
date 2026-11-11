'use client';

import { Banner, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { VariantTypesTab } from './variant-types-tab.tsx';
import { VariantsTab } from './variants-tab.tsx';
import { VARIANTS_PATH, type Tab } from './types.ts';

/**
 * The Variants page (variants V6, plan section 9): two tabs. Variant types lists the types with
 * the chosen one's settings beside it (below it on a narrow screen); Variants lists every variant
 * of the live products with its issues. An admin with both `catalog.variant-type.edit` and
 * `catalog.attribute.edit` changes how buyers choose; any other admin sees the view-only notice.
 */
export function VariantsView({
  canEdit,
  canOpenAttributes,
  csrfToken,
  initialTab,
  initialId,
}: {
  readonly canEdit: boolean;
  readonly canOpenAttributes: boolean;
  readonly csrfToken: string;
  readonly initialTab: Tab;
  readonly initialId: string | null;
}) {
  const t = useTranslations('variants');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<string | null>(initialId);

  // The address names the tab and the open type, so a link or a reload opens the same view.
  useEffect(() => {
    const query = new URLSearchParams();
    if (tab !== 'types') query.set('tab', tab);
    if (tab === 'types' && selected !== null) query.set('id', selected);
    const next = query.size === 0 ? VARIANTS_PATH : `${VARIANTS_PATH}?${query.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [tab, selected]);

  return (
    <div className="mt-1 flex flex-col gap-4">
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      <Tabs
        label={t('tabs')}
        items={[
          { id: 'types', label: t('tab.types') },
          { id: 'variants', label: t('tab.variants') },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
      />
      {canEdit ? null : (
        <Banner tone="info" title={t('view-only.title')}>
          {t('view-only.body')}
        </Banner>
      )}
      {tab === 'types' ? (
        <VariantTypesTab
          selectedId={selected}
          onSelect={setSelected}
          canEdit={canEdit}
          canOpenAttributes={canOpenAttributes}
          csrfToken={csrfToken}
        />
      ) : (
        <VariantsTab />
      )}
    </div>
  );
}
