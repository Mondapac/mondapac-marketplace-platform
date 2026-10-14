'use client';

import { Banner, Button, LoadError } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { InviteOwnerDialog, type InviteWait } from './invite-owner-dialog.tsx';
import { OrphanedTable } from './orphaned-table.tsx';
import { ORPHANED_PAGE_SIZE, type OrphanPage, type OrphanRow } from './orphaned-types.ts';

type Failure = 'first' | 'more' | 'denied' | null;

/**
 * Sellers that have no owner account yet (identity design 8.6 row 8), oldest first, paged by
 * cursor with "Show more". "Invite owner" opens the dialog for one seller.
 */
export function OrphanedList({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('sellers.orphaned');
  const tl = useTranslations('load');
  const [rows, setRows] = useState<readonly OrphanRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<Failure>(null);
  const [inviting, setInviting] = useState<OrphanRow | null>(null);
  // The wait after a throttled invitation outlives the dialog for this page load.
  const [wait, setWait] = useState<InviteWait | null>(null);
  const latest = useRef(0);

  const load = useCallback(async (after: string | null) => {
    const ticket = ++latest.current;
    setLoading(true);
    setFailed(null);
    const query = new URLSearchParams({ state: 'orphaned', limit: String(ORPHANED_PAGE_SIZE) });
    if (after !== null) query.set('after', after);
    const result = await callApi<OrphanPage>('GET', `identity/admin/sellers?${query.toString()}`);
    if (ticket !== latest.current) return;
    setLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      if (result.failure.status === 403) {
        setFailed('denied');
        setRows([]);
        setNext(null);
        return;
      }
      setFailed(after === null ? 'first' : 'more');
      return;
    }
    setRows((current) => {
      if (after === null) return result.body.items;
      const known = new Set(current.map((row) => row.sellerId));
      return [...current, ...result.body.items.filter((row) => !known.has(row.sellerId))];
    });
    setNext(result.body.next);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  if (failed === 'denied') {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
        <p className="font-medium">{t('no-access.title')}</p>
        <p className="text-fg-muted">{t('no-access.body')}</p>
        <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
          {t('no-access.action')}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? <OrphanedTable rows={rows} onInvite={setInviting} /> : null}
      {!loading && failed === null && rows.length === 0 ? (
        <div className="rounded-lg border border-line p-6">
          <p className="font-medium">{t('empty.title')}</p>
          <p className="mt-1 text-fg-muted">{t('empty.body')}</p>
        </div>
      ) : null}
      {loading ? <p className="text-fg-muted">{t('loading')}</p> : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
      <InviteOwnerDialog
        open={inviting !== null}
        sellerId={inviting?.sellerId ?? null}
        csrfToken={csrfToken}
        wait={wait}
        onThrottled={setWait}
        onClose={() => setInviting(null)}
        onInvited={(sellerId) =>
          setRows((current) => current.filter((r) => r.sellerId !== sellerId))
        }
        onStale={() => void load(null)}
      />
    </div>
  );
}
