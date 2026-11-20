'use client';

import { Banner, DetailSkeleton, LoadError } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../../api/client.ts';
import type { ListPagingMode } from '../../shared/paged-list/types.ts';
import { API_CATEGORIES, type TreeBody } from '../types.ts';
import { ProposalsList } from './proposals-list.tsx';
import { ShelvesPanel } from './shelves-panel.tsx';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly tree: TreeBody }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/**
 * The Category proposals tab (categories C9b; CAT-52, ux FP8 row 4): the proposals sellers made
 * and nobody decided yet, as a super list. Approve makes a shelf of the seller's shop, never a
 * platform category. Reject takes one prepared reason. A seller's shelves open below the list,
 * where an admin with the promote-merge key can promote or merge them.
 */
export function ProposalsTab({
  csrfToken,
  canPromote,
  paging,
  accountId,
  marketId,
  initialSellerId = null,
}: {
  readonly csrfToken: string;
  readonly canPromote: boolean;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly initialSellerId?: string | null;
}) {
  const t = useTranslations('categories.proposals');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [shelfOf, setShelfOf] = useState<{ id: string; name: string | null } | null>(
    initialSellerId === null ? null : { id: initialSellerId, name: null },
  );

  // The category tree names the platform category a proposal sits under.
  const fetchTree = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: 'loading' });
    const tree = await callApi<TreeBody>('GET', API_CATEGORIES);
    if (tree.ok) {
      setLoad({ state: 'ready', tree: tree.body });
      return;
    }
    if (tree.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (quiet) return;
    setLoad({ state: tree.failure.status === 403 ? 'denied' : 'failed' });
  }, []);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree]);

  if (load.state === 'denied') return <Banner tone="info">{t('denied')}</Banner>;
  if (load.state === 'loading') {
    return <DetailSkeleton label={t('loading')} slowLabel={tl('slow')} rows={3} />;
  }
  if (load.state === 'failed') {
    return (
      <LoadError
        message={t('load-failed')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchTree()}
      />
    );
  }
  const { tree } = load;
  return (
    <div className="flex flex-col gap-6">
      <ProposalsList
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        csrfToken={csrfToken}
        tree={tree}
        onShelves={(id, name) => setShelfOf({ id, name })}
      />
      {shelfOf === null ? null : (
        <ShelvesPanel
          key={shelfOf.id}
          sellerId={shelfOf.id}
          storeName={shelfOf.name}
          tree={tree}
          canPromote={canPromote}
          csrfToken={csrfToken}
          onClose={() => setShelfOf(null)}
          onTreeChanged={() => void fetchTree(true)}
        />
      )}
    </div>
  );
}
