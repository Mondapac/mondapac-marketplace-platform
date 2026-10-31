'use client';

import {
  ActivityTable,
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadError,
  SkeletonRows,
  type ActivityColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { CancelDeletionDialog, type CancelOutcome } from './cancel-dialog.tsx';
import type { DeletionRequestEntry, DeletionRequestPage } from './types.ts';

/** Rows per request; "Load more" asks for the next page with the API's own cursor. */
const PAGE_SIZE = 50;

type Notice = { readonly tone: 'success' | 'critical'; readonly text: string };

/**
 * The deletion requests that are waiting (customers package 5c), earliest date first. An admin
 * who holds `customers.buyer-account.delete` can cancel a waiting one; the API shows the account
 * id only (no name or email), so the id is the way to find the buyer.
 */
export function RequestsList({
  canCancel,
  csrfToken,
}: {
  readonly canCancel: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('account-deletion');
  const locale = useLocale();
  const [rows, setRows] = useState<readonly DeletionRequestEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback((cursor: string | null) => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor !== null) query.set('cursor', cursor);
    return callApi<DeletionRequestPage>(
      'GET',
      `customers/admin/deletion-requests?${query.toString()}`,
    );
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    setRows(null);
    const result = await fetchPage(null);
    if (result.ok) {
      setRows(result.body.entries);
      setNext(result.body.nextCursor);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setLoadFailed(true);
  }, [fetchPage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  async function loadMore() {
    if (loadingMore || next === null) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await fetchPage(next);
    setLoadingMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    setRows((current) => [...(current ?? []), ...result.body.entries]);
    setNext(result.body.nextCursor);
    setAnnounce(t('requests.loaded-more', { count: result.body.entries.length }));
  }

  function done(requestId: string, outcome: CancelOutcome) {
    const drop = () =>
      setRows((current) => (current ?? []).filter((row) => row.requestId !== requestId));
    if (outcome.kind === 'cancelled') {
      drop();
      setNotice({ tone: 'success', text: t('requests.cancelled') });
      return;
    }
    // A request the job already claimed stays in the list, as in progress and without a button;
    // one that is gone leaves it.
    if (outcome.problem === 'in-progress') {
      setRows((current) =>
        (current ?? []).map((row) =>
          row.requestId === requestId ? { ...row, status: 'executing' } : row,
        ),
      );
    } else if (outcome.problem === 'request-not-found') drop();
    setNotice({ tone: 'critical', text: t(`error.${outcome.problem}`) });
  }

  if (loadFailed) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('requests.load-failed')}
        retryLabel={t('retry')}
        onRetry={() => void load()}
      />
    );
  }
  if (rows === null) return <SkeletonRows label={t('requests.loading')} rows={4} />;
  if (rows.length === 0 && notice === null) {
    return (
      <EmptyState icon="inbox" title={t('requests.empty.title')} body={t('requests.empty.body')} />
    );
  }

  const columns: ActivityColumn<DeletionRequestEntry>[] = [
    {
      id: 'account',
      header: t('requests.col.account'),
      kind: 'title',
      cell: (row) => (
        <code className="font-mono text-sm wrap-anywhere select-all">{row.accountId}</code>
      ),
    },
    {
      id: 'requested-by',
      header: t('requests.col.requested-by'),
      kind: 'labelled',
      size: 'status',
      cell: (row) => (
        <Badge tone="neutral">
          {t(row.requestedBy === 'admin' ? 'requests.by.admin' : 'requests.by.customer')}
        </Badge>
      ),
    },
    {
      id: 'requested',
      header: t('requests.col.requested'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => formatInstant(row.requestedAt, locale),
    },
    {
      id: 'deletes-on',
      header: t('requests.col.deletes-on'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => formatInstant(row.scheduledFor, locale),
    },
    {
      id: 'status',
      header: t('requests.col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => (
        <Badge tone={row.status === 'pending' ? 'attention' : 'info'}>
          {t(row.status === 'pending' ? 'requests.status.waiting' : 'requests.status.in-progress')}
        </Badge>
      ),
    },
    ...(canCancel
      ? [
          {
            id: 'actions',
            header: t('requests.col.actions'),
            kind: 'labelled' as const,
            size: 'status' as const,
            cell: (row: DeletionRequestEntry) =>
              row.status === 'pending' ? (
                <Button
                  variant="secondary"
                  aria-label={t('requests.cancel-aria', { account: row.accountId })}
                  onClick={() => {
                    setNotice(null);
                    setCancelling(row.requestId);
                  }}
                >
                  {t('requests.cancel')}
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          <Banner tone={notice.tone}>{notice.text}</Banner>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={t('requests.empty.title')}
          body={t('requests.empty.body')}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <ActivityTable
            caption={t('requests.caption')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.requestId}
          />
        </div>
      )}
      <p role="status" className="sr-only">
        {announce}
      </p>
      {moreFailed ? <Banner tone="critical">{t('requests.more-failed')}</Banner> : null}
      {next === null ? null : (
        <div>
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            {t('requests.load-more')}
          </Button>
        </div>
      )}
      <CancelDeletionDialog
        requestId={cancelling}
        csrfToken={csrfToken}
        onClose={() => setCancelling(null)}
        onDone={done}
      />
    </div>
  );
}
