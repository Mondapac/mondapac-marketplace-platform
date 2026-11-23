'use client';

import { Banner, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { RequestsList } from './requests-list.tsx';
import { VariantTypesTab } from './variant-types-tab.tsx';
import { VariantsList } from './variants-list.tsx';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { VARIANTS_PATH, type Tab } from './types.ts';

/**
 * The Variants page (variants V6, plan section 9): two tabs (three with the review key). Variant types lists the types with
 * the chosen one's settings beside it (below it on a narrow screen); Variants lists every variant
 * of the live products with its issues. An admin with both `catalog.variant-type.edit` and
 * `catalog.attribute.edit` changes how buyers choose; any other admin sees the view-only notice.
 * Waiting for you (variants V7) is the third tab, for an admin with `catalog.variant-request.review`.
 */
export function VariantsView({
  canEdit,
  canOpenAttributes,
  canReview,
  csrfToken,
  initialTab,
  initialId,
  paging,
  accountId,
  marketId,
  zone,
}: {
  readonly canEdit: boolean;
  readonly canOpenAttributes: boolean;
  /** May answer the size requests of sellers (`catalog.variant-request.review`). */
  readonly canReview: boolean;
  readonly csrfToken: string;
  readonly initialTab: Tab;
  readonly initialId: string | null;
  /** The Market's "List paging" setting (Previous and next when it could not be read). */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Requested presets. */
  readonly zone: string;
}) {
  const t = useTranslations('variants');
  // A link to the Waiting for you tab opens the first tab for an admin who may not answer.
  const [tab, setTab] = useState<Tab>(
    initialTab === 'waiting' && !canReview ? 'types' : initialTab,
  );
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
      <Tabs
        label={t('tabs')}
        items={[
          { id: 'types', label: t('tab.types'), help: 'Variant types' },
          { id: 'variants', label: t('tab.variants'), help: 'Variants' },
          ...(canReview
            ? [{ id: 'waiting', label: t('tab.waiting'), help: 'Waiting for you' }]
            : []),
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
      ) : null}
      {tab === 'variants' ? (
        <VariantsList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          csrfToken={csrfToken}
        />
      ) : null}
      {tab === 'waiting' ? (
        <RequestsList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          zone={zone}
          csrfToken={csrfToken}
        />
      ) : null}
    </div>
  );
}
