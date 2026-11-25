'use client';

import { Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { DecisionDrawer, drawerSubjectId, type DrawerSubject } from './drawer.tsx';
import { EditsList, FirstPublicationsList } from './lists.tsx';
import { AfterPublicationList } from './post-review-list.tsx';
import type { PostReviewRow } from './post-review-types.ts';
import { tabHref, type ChangeRow, type FirstRow, type QueueTab } from './types.ts';

const TABS: readonly QueueTab[] = ['first', 'edits', 'after'];

/**
 * The Offer review queue (risk-based Offer approval, slices 5 and 6): First publications, Edits and
 * After publication (the post-publication review of Offers already on sale) as three super lists,
 * each with its count, and the decision drawer all three open. A decision leaves the row and opens
 * the next one of the page.
 */
export function OfferReviewQueue({
  tab,
  paging,
  accountId,
  marketId,
  csrfToken,
  zone,
  permissionKeys,
  canDecide,
}: {
  readonly tab: QueueTab;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly zone: string;
  readonly permissionKeys: readonly string[];
  readonly canDecide: boolean;
}) {
  const t = useTranslations('offer-review.queue');
  const [counts, setCounts] = useState<Partial<Record<QueueTab, number>>>({});
  const [open, setOpen] = useState<DrawerSubject | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The rows the list last read, in order: the next row opens from them after a decision.
  const rows = useRef<readonly DrawerSubject[]>([]);

  const take = useCallback((read: readonly DrawerSubject[]) => {
    rows.current = read;
    // A row the drawer shows is replaced by its fresh read.
    setOpen((current) => {
      if (current === null) return current;
      const fresh = read.find((each) => drawerSubjectId(each) === drawerSubjectId(current));
      return fresh ?? current;
    });
  }, []);
  const onFirstRows = useCallback(
    (read: readonly FirstRow[]) => take(read.map((row) => ({ kind: 'first' as const, row }))),
    [take],
  );
  const onEditRows = useCallback(
    (read: readonly ChangeRow[]) => take(read.map((row) => ({ kind: 'edit' as const, row }))),
    [take],
  );
  const onAfterRows = useCallback(
    (read: readonly PostReviewRow[]) => take(read.map((row) => ({ kind: 'after' as const, row }))),
    [take],
  );
  const onFirstCount = useCallback(
    (count: number) => setCounts((c) => ({ ...c, first: count })),
    [],
  );
  const onEditCount = useCallback(
    (count: number) => setCounts((c) => ({ ...c, edits: count })),
    [],
  );
  const onAfterCount = useCallback(
    (count: number) => setCounts((c) => ({ ...c, after: count })),
    [],
  );
  const openFirst = useCallback((row: FirstRow) => setOpen({ kind: 'first', row }), []);
  const openEdit = useCallback((row: ChangeRow) => setOpen({ kind: 'edit', row }), []);
  const openAfter = useCallback((row: PostReviewRow) => setOpen({ kind: 'after', row }), []);

  const reload = useCallback(async (subject: DrawerSubject) => {
    // An edit and a post-publication row are read again by their id; a first publication by the list.
    if (subject.kind === 'edit') {
      const result = await callApi<ChangeRow>(
        'GET',
        `catalog/admin/offer-changes/${subject.row.changeId}`,
      );
      if (result.ok) setOpen({ kind: 'edit', row: result.body });
    } else if (subject.kind === 'after') {
      const result = await callApi<PostReviewRow>(
        'GET',
        `catalog/admin/offer-post-reviews/${subject.row.id}`,
      );
      if (result.ok) setOpen({ kind: 'after', row: result.body });
    }
    setRefresh((value) => value + 1);
  }, []);
  const decided = useCallback((subject: DrawerSubject) => {
    const list = rows.current;
    const at = list.findIndex((each) => drawerSubjectId(each) === drawerSubjectId(subject));
    const next = list[at + 1] ?? list[at - 1] ?? null;
    rows.current = list.filter((each) => drawerSubjectId(each) !== drawerSubjectId(subject));
    setOpen(next === null || at < 0 ? null : next);
    setRefresh((value) => value + 1);
  }, []);

  const label = (id: QueueTab) => {
    const count = counts[id];
    return count === undefined ? t(`tab.${id}`) : t('tab-count', { tab: t(`tab.${id}`), count });
  };
  const items = TABS.map((id) => ({ id, label: label(id), href: tabHref(id) }));
  const shared = { paging, accountId, marketId, csrfToken, zone, canDecide, refreshKey: refresh };
  return (
    <div className="flex flex-col gap-4">
      <Tabs label={t('tabs')} activeId={tab} items={items} />
      <div aria-live="polite" className="sr-only">
        {counts[tab] === undefined
          ? ''
          : t(tab === 'after' ? 'count-live-after' : 'count-live', { count: counts[tab] })}
      </div>
      {tab === 'first' ? (
        <FirstPublicationsList
          {...shared}
          onRows={onFirstRows}
          onCount={onFirstCount}
          onOpen={openFirst}
        />
      ) : tab === 'edits' ? (
        <EditsList {...shared} onRows={onEditRows} onCount={onEditCount} onOpen={openEdit} />
      ) : (
        <AfterPublicationList
          {...shared}
          onRows={onAfterRows}
          onCount={onAfterCount}
          onOpen={openAfter}
        />
      )}
      <DecisionDrawer
        subject={open}
        csrfToken={csrfToken}
        zone={zone}
        canDecide={canDecide}
        viewerKeys={permissionKeys}
        onClose={() => setOpen(null)}
        onDecided={decided}
        onReload={(subject) => void reload(subject)}
      />
    </div>
  );
}
