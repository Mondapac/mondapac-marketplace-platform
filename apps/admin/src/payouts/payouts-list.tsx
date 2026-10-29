'use client';

import { Banner, Button, EmptyState, LoadError, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../wallet/money.ts';
import { ApproveDialog } from './approve-dialog.tsx';
import { PayoutsTable } from './payouts-table.tsx';
import {
  PAGE_SIZE,
  TAB_STATES,
  type Approved,
  type PayoutPage,
  type PayoutRow,
  type Tab,
} from './types.ts';

type Notice = { readonly tone: 'success' | 'critical'; readonly text: string };

/** Newest change first, as the API lists each state; merged states interleave by that instant. */
const byChange = (a: PayoutRow, b: PayoutRow): number =>
  Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt);

/**
 * The payouts of one tab. The tab is a page (`?status=`), so this list is fresh for each tab. A
 * tab that covers several API states reads each state and merges the rows; "Load more" reads the
 * next page of every state that has one. Approving goes through the dialog; the response drives
 * the row and nothing is optimistic.
 */
export function PayoutsList({
  tab,
  canApprove,
  zone,
  csrfToken,
}: {
  readonly tab: Tab;
  readonly canApprove: boolean;
  readonly zone: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts');
  const locale = useLocale();
  const states = TAB_STATES[tab];
  const [rows, setRows] = useState<readonly PayoutRow[] | null>(null);
  const [cursors, setCursors] = useState<Readonly<Record<string, string>>>({});
  const [failed, setFailed] = useState<'first' | 'more' | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now] = useState(() => Date.now());
  const latest = useRef(0);
  const noticeRef = useRef<HTMLDivElement>(null);

  const fetchStates = useCallback(
    async (wanted: readonly string[], after: Readonly<Record<string, string>>) => {
      const pages = await Promise.all(
        wanted.map(async (state) => {
          const query = new URLSearchParams({ status: state, limit: String(PAGE_SIZE) });
          const cursor = after[state];
          if (cursor !== undefined) query.set('cursor', cursor);
          return {
            state,
            result: await callApi<PayoutPage>(
              'GET',
              `commission-payouts/admin/payouts?${query.toString()}`,
            ),
          };
        }),
      );
      return pages;
    },
    [],
  );

  // `quiet`: read again behind an open dialog without blanking the list.
  const load = useCallback(
    async (quiet = false) => {
      const ticket = ++latest.current;
      setFailed(null);
      if (!quiet) setRows(null);
      const pages = await fetchStates(states, {});
      if (ticket !== latest.current) return;
      if (pages.some((page) => !page.result.ok && page.result.failure.status === 401)) {
        window.location.assign('/session-ended');
        return;
      }
      const good: { state: string; body: PayoutPage }[] = [];
      for (const page of pages) {
        if (!page.result.ok) {
          if (!quiet) setFailed('first');
          return;
        }
        good.push({ state: page.state, body: page.result.body });
      }
      setRows(good.flatMap((page) => page.body.payouts).sort(byChange));
      setCursors(
        Object.fromEntries(
          good.flatMap((page) =>
            page.body.nextCursor === null ? [] : [[page.state, page.body.nextCursor] as const],
          ),
        ),
      );
    },
    [fetchStates, states],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  async function more() {
    if (loadingMore) return;
    setLoadingMore(true);
    setFailed(null);
    const wanted = Object.keys(cursors);
    const pages = await fetchStates(wanted, cursors);
    setLoadingMore(false);
    if (pages.some((page) => !page.result.ok && page.result.failure.status === 401)) {
      window.location.assign('/session-ended');
      return;
    }
    if (pages.some((page) => !page.result.ok)) {
      setFailed('more');
      return;
    }
    const next: Record<string, string> = {};
    const added: PayoutRow[] = [];
    for (const page of pages) {
      if (!page.result.ok) continue;
      added.push(...page.result.body.payouts);
      if (page.result.body.nextCursor !== null) next[page.state] = page.result.body.nextCursor;
    }
    setRows((current) => {
      const known = new Set((current ?? []).map((row) => row.payoutId));
      return [...(current ?? []), ...added.filter((row) => !known.has(row.payoutId))].sort(
        byChange,
      );
    });
    setCursors(next);
    setAnnounce(t('loaded-more', { count: added.length }));
  }

  function approved(done: Approved) {
    const row = rows?.find((entry) => entry.payoutId === done.payoutId);
    setTarget(null);
    // The approved payout leaves the Awaiting approval tab; it shows under Sending.
    setRows((current) => (current ?? []).filter((entry) => entry.payoutId !== done.payoutId));
    setNotice({
      tone: 'success',
      text: t('approved-notice', {
        amount: formatMinor(done.transfer.amountMinor, done.transfer.currency, locale),
        seller: row?.storeName ?? t('approved-notice-seller'),
      }),
    });
  }

  if (failed === 'first') {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('error.unavailable')}
        retryLabel={t('retry')}
        onRetry={() => void load()}
      />
    );
  }
  if (rows === null) return <SkeletonRows label={t('loading')} rows={4} />;

  const hasMore = Object.keys(cursors).length > 0;
  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          <Banner tone={notice.tone}>{notice.text}</Banner>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon="wallet" title={t(`empty.${tab}`)} />
      ) : (
        <PayoutsTable
          rows={rows}
          zone={zone}
          now={now}
          canApprove={canApprove}
          busy={target !== null}
          onApprove={(row) => {
            setNotice(null);
            setTarget(row.payoutId);
          }}
        />
      )}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {failed === 'more' ? <Banner tone="critical">{t('error.more')}</Banner> : null}
      {hasMore ? (
        <div>
          <Button variant="secondary" loading={loadingMore} onClick={() => void more()}>
            {t('more')}
          </Button>
        </div>
      ) : null}
      <ApproveDialog
        payoutId={target}
        csrfToken={csrfToken}
        zone={zone}
        onClose={() => setTarget(null)}
        onApproved={approved}
        onStale={() => void load(true)}
      />
    </div>
  );
}
