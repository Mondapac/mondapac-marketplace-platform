'use client';

import { Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { DecisionDrawer } from './drawer.tsx';
import { subjectId, type Subject } from './detail.tsx';
import { EditsList, FirstPublicationsList } from './lists.tsx';
import { tabHref, type ChangeRow, type FirstRow, type QueueTab } from './types.ts';

/**
 * The Offer review queue (risk-based Offer approval, slice 5): First publications and Edits as two
 * super lists, each with its count, and the decision drawer both open. A decision leaves the row
 * and opens the next one of the page.
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
  const [open, setOpen] = useState<Subject | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The rows the list last read, in order: the next row opens from them after a decision.
  const rows = useRef<readonly Subject[]>([]);

  const onFirstRows = useCallback((read: readonly FirstRow[]) => {
    rows.current = read.map((row) => ({ kind: 'first' as const, row }));
    // A row the drawer shows is replaced by its fresh read.
    setOpen((current) => {
      if (current === null) return current;
      const fresh = rows.current.find((each) => subjectId(each) === subjectId(current));
      return fresh ?? current;
    });
  }, []);
  const onEditRows = useCallback((read: readonly ChangeRow[]) => {
    rows.current = read.map((row) => ({ kind: 'edit' as const, row }));
    setOpen((current) => {
      if (current === null) return current;
      const fresh = rows.current.find((each) => subjectId(each) === subjectId(current));
      return fresh ?? current;
    });
  }, []);
  const onFirstCount = useCallback(
    (count: number) => setCounts((c) => ({ ...c, first: count })),
    [],
  );
  const onEditCount = useCallback(
    (count: number) => setCounts((c) => ({ ...c, edits: count })),
    [],
  );
  const openFirst = useCallback((row: FirstRow) => setOpen({ kind: 'first', row }), []);
  const openEdit = useCallback((row: ChangeRow) => setOpen({ kind: 'edit', row }), []);

  const reload = useCallback(async (subject: Subject) => {
    // An edit is read again by its id (fresh live values); a first publication by the list.
    if (subject.kind === 'edit') {
      const result = await callApi<ChangeRow>(
        'GET',
        `catalog/admin/offer-changes/${subject.row.changeId}`,
      );
      if (result.ok) setOpen({ kind: 'edit', row: result.body });
    }
    setRefresh((value) => value + 1);
  }, []);
  const decided = useCallback((subject: Subject) => {
    const list = rows.current;
    const at = list.findIndex((each) => subjectId(each) === subjectId(subject));
    const next = list[at + 1] ?? list[at - 1] ?? null;
    rows.current = list.filter((each) => subjectId(each) !== subjectId(subject));
    setOpen(next === null || at < 0 ? null : next);
    setRefresh((value) => value + 1);
  }, []);

  const label = (id: QueueTab) => {
    const count = counts[id];
    return count === undefined ? t(`tab.${id}`) : t('tab-count', { tab: t(`tab.${id}`), count });
  };
  const items = (['first', 'edits'] as const).map((id) => ({
    id,
    label: label(id),
    href: tabHref(id),
  }));
  const shared = { paging, accountId, marketId, csrfToken, zone, canDecide, refreshKey: refresh };
  return (
    <div className="flex flex-col gap-4">
      <Tabs label={t('tabs')} activeId={tab} items={items} />
      <div aria-live="polite" className="sr-only">
        {counts[tab] === undefined ? '' : t('count-live', { count: counts[tab] })}
      </div>
      {tab === 'first' ? (
        <FirstPublicationsList
          {...shared}
          onRows={onFirstRows}
          onCount={onFirstCount}
          onOpen={openFirst}
        />
      ) : (
        <EditsList {...shared} onRows={onEditRows} onCount={onEditCount} onOpen={openEdit} />
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
