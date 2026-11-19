'use client';

import { Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CategoriesView } from '../categories-view.tsx';
import { CATEGORIES_PATH } from '../types.ts';
import { ProposalsTab } from './proposals-tab.tsx';

type Tab = 'tree' | 'proposals';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Categories page: the tree and, for an admin who may decide proposals, the Category
 * proposals tab (categories C9b). The tab is kept in the address (`?tab=proposals`), and
 * `?seller=<id>` opens that seller's shelves below the queue.
 */
export function CategoriesTabs({
  canDecide,
  canPromote,
  csrfToken,
  ...tree
}: {
  readonly canDecide: boolean;
  readonly canPromote: boolean;
  readonly csrfToken: string;
  readonly canEdit: boolean;
  readonly canRestructure?: boolean;
  readonly canImport?: boolean;
}) {
  const t = useTranslations('categories.proposals');
  const [tab, setTab] = useState<Tab>('tree');
  const [seller, setSeller] = useState<string | null>(null);

  // Read the address once after mount (the server render cannot know the query).
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (canDecide && query.get('tab') === 'proposals') {
      setTab('proposals');
      const wanted = query.get('seller');
      if (wanted !== null && UUID_SHAPE.test(wanted)) setSeller(wanted);
    }
  }, [canDecide]);

  if (!canDecide) return <CategoriesView {...tree} csrfToken={csrfToken} />;
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        label={t('tabs')}
        items={[
          { id: 'tree', label: t('tab.tree') },
          { id: 'proposals', label: t('tab.proposals') },
        ]}
        activeId={tab}
        onSelect={(id) => {
          setTab(id as Tab);
          const next = id === 'proposals' ? `${CATEGORIES_PATH}?tab=proposals` : CATEGORIES_PATH;
          window.history.replaceState(null, '', next);
        }}
      />
      {tab === 'tree' ? <CategoriesView {...tree} csrfToken={csrfToken} /> : null}
      {tab === 'proposals' ? (
        <ProposalsTab csrfToken={csrfToken} canPromote={canPromote} initialSellerId={seller} />
      ) : null}
    </div>
  );
}
