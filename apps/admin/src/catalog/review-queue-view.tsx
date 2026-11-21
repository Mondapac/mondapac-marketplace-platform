'use client';

import { Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { OffersList, RevisionsList } from './review-lists.tsx';
import { queueHref, type QueueTab } from './review-queue-params.ts';
import type { QueuePage } from './types.ts';

type Totals = QueuePage<unknown>['totals'];

/**
 * The review queue (panels IA 3.1): a tab for pending product revisions and one for Offers waiting
 * for their first publication, each a super list and each with its whole-queue count (the counts
 * come with the list's own answer, so a tab shows its count once its list has been read).
 */
export function ReviewQueueView({
  tab,
  paging,
  accountId,
  marketId,
  csrfToken,
}: {
  readonly tab: QueueTab;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.queue');
  const [totals, setTotals] = useState<Totals | null>(null);
  const items = (['revision', 'offer'] as const).map((id) => {
    const count = totals?.[id === 'offer' ? 'offer-first-publication' : 'product-revision'];
    return {
      id,
      label: count === undefined ? t(`tab.${id}`) : t('tab-count', { tab: t(`tab.${id}`), count }),
      href: queueHref(id),
    };
  });
  return (
    <div className="flex flex-col gap-4">
      <Tabs label={t('tabs')} activeId={tab} items={items} />
      {tab === 'revision' ? (
        <RevisionsList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          csrfToken={csrfToken}
          onTotals={setTotals}
        />
      ) : (
        <OffersList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          csrfToken={csrfToken}
          onTotals={setTotals}
        />
      )}
    </div>
  );
}
