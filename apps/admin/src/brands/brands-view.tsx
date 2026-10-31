'use client';

import {
  Badge,
  Banner,
  Button,
  CARD_TABLE,
  EmptyState,
  LoadError,
  SkeletonRows,
  Tabs,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { BrandConfirmDialog, type ConfirmKind } from './brand-confirm-dialog.tsx';
import { BrandFormDialog } from './brand-form-dialog.tsx';
import { BrandMergeDialog } from './brand-merge-dialog.tsx';
import { MergeQueue } from './merge-queue.tsx';
import {
  API_BRANDS,
  API_QUEUE,
  PAGE_SIZE,
  STATUS_OF,
  TABS,
  type BrandPage,
  type BrandRow,
  type BrandStatus,
  type MergeBody,
  type QueueBody,
  type QueueGroup,
  type Tab,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
type Dialogs =
  | { readonly kind: 'none' }
  | { readonly kind: 'form'; readonly brand?: BrandRow }
  | { readonly kind: 'confirm'; readonly action: ConfirmKind; readonly brand: BrandRow }
  | { readonly kind: 'merge'; readonly brand: BrandRow };

const COUNT_LIMIT = 100;
const STATUS_TONE: Record<BrandStatus, 'success' | 'attention' | 'neutral'> = {
  active: 'success',
  draft: 'attention',
  archived: 'neutral',
};

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => (Array.from(word.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '').toUpperCase())
    .join('');

/**
 * The brands of the platform (shared by every Market): the live ones, the proposals of sellers
 * waiting for approval, the possible duplicates (the merge queue) and the archived. A holder of
 * `catalog.brand.edit` also gets the writes; a reader gets the lists and no buttons. Every
 * decision is confirmed in a dialog and checked again by the API.
 */
export function BrandsView({
  canEdit,
  csrfToken,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('brands');
  const tl = useTranslations('load');
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [rows, setRows] = useState<readonly BrandRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [groups, setGroups] = useState<readonly QueueGroup[]>([]);
  const [queueLoad, setQueueLoad] = useState<Load>('loading');
  const [proposed, setProposed] = useState<{ count: number; capped: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>({ kind: 'none' });
  const latest = useRef(0);

  // The search term acts after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const toSignIn = (status: number): boolean => {
    if (status !== 401) return false;
    window.location.assign('/session-ended');
    return true;
  };

  const fetchRows = useCallback(async () => {
    if (tab === 'duplicates') return;
    const ticket = ++latest.current;
    setLoad('loading');
    const query = new URLSearchParams({ status: STATUS_OF[tab], limit: String(PAGE_SIZE) });
    if (search !== '') query.set('search', search);
    const result = await callApi<BrandPage>('GET', `${API_BRANDS}?${query.toString()}`);
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      setRows([]);
      setLoad('failed');
      return;
    }
    setRows(result.body.items);
    setNext(result.body.nextAfterId);
    setLoad('ready');
  }, [tab, search]);

  const fetchQueue = useCallback(async () => {
    setQueueLoad('loading');
    const result = await callApi<QueueBody>('GET', API_QUEUE);
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      setQueueLoad('failed');
      return;
    }
    setGroups(result.body.groups);
    setQueueLoad('ready');
  }, []);

  const fetchProposed = useCallback(async () => {
    const result = await callApi<BrandPage>(
      'GET',
      `${API_BRANDS}?status=draft&limit=${COUNT_LIMIT}`,
    );
    if (!result.ok) {
      toSignIn(result.failure.status);
      return;
    }
    setProposed({ count: result.body.items.length, capped: result.body.nextAfterId !== null });
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);
  useEffect(() => {
    void fetchQueue();
    void fetchProposed();
  }, [fetchQueue, fetchProposed]);

  const refreshAll = useCallback(() => {
    void fetchRows();
    void fetchQueue();
    void fetchProposed();
  }, [fetchRows, fetchQueue, fetchProposed]);

  async function loadMore() {
    if (next === null || more) return;
    setMore(true);
    const query = new URLSearchParams({
      status: STATUS_OF[tab as Exclude<Tab, 'duplicates'>],
      limit: String(PAGE_SIZE),
      afterId: next,
    });
    if (search !== '') query.set('search', search);
    const result = await callApi<BrandPage>('GET', `${API_BRANDS}?${query.toString()}`);
    setMore(false);
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      toast.error(t('more-error'));
      return;
    }
    setRows((previous) => [...previous, ...result.body.items]);
    setNext(result.body.nextAfterId);
  }

  const close = () => setDialog({ kind: 'none' });
  // The brand changed or vanished meanwhile: close, say so, and read the lists again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    refreshAll();
  };
  const done = (message: string) => {
    close();
    setNotice(null);
    toast.success(message);
    refreshAll();
  };

  const countOf = (id: Tab): number | null => {
    if (id === 'duplicates') return queueLoad === 'ready' ? groups.length : null;
    if (id === 'draft') return proposed?.count ?? null;
    return null;
  };
  const tabs = TABS.map((id) => {
    const count = countOf(id);
    const shown =
      count === null ? '' : ` ${id === 'draft' && proposed?.capped === true ? `${count}+` : count}`;
    return { id, label: `${t(`tab.${id}`)}${shown}` };
  });

  const filtered = search !== '';
  const emptyKey = filtered ? 'empty-search' : `empty-${tab}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-fg-muted">{t('intro')}</p>
        {canEdit ? <Button onClick={() => setDialog({ kind: 'form' })}>{t('new')}</Button> : null}
      </div>
      <Tabs
        label={t('tabs')}
        items={tabs}
        activeId={tab}
        onSelect={(id) => {
          setTab(id as Tab);
          setNotice(null);
        }}
      />
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}
      {tab === 'duplicates' ? (
        queueLoad === 'loading' ? (
          <SkeletonRows label={t('loading')} rows={3} />
        ) : queueLoad === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
            message={t('queue.error')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchQueue()}
          />
        ) : (
          <MergeQueue
            groups={groups}
            canEdit={canEdit}
            csrfToken={csrfToken}
            onSettled={() => refreshAll()}
          />
        )
      ) : (
        <>
          <div role="search" aria-label={t('search-label')} className="w-full sm:w-80">
            <TextField
              name="search"
              type="search"
              label={t('search')}
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {load === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
          {load === 'failed' ? (
            <LoadError
              className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
              message={t('load-error')}
              retryLabel={tl('retry')}
              onRetry={() => void fetchRows()}
            />
          ) : null}
          {load === 'ready' && rows.length === 0 ? (
            <EmptyState icon="tag" title={t(emptyKey)} />
          ) : null}
          {load === 'ready' && rows.length > 0 ? (
            <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
              <table className={CARD_TABLE.table}>
                <caption className="sr-only">{t(`tab.${tab}`)}</caption>
                <thead className={CARD_TABLE.head}>
                  <tr>
                    {['brand', 'origin', 'status', 'updated', ...(canEdit ? ['actions'] : [])].map(
                      (col) => (
                        <th
                          key={col}
                          scope="col"
                          className="whitespace-nowrap px-4 py-3 font-medium"
                        >
                          {col === 'actions' ? (
                            <span className="sr-only">{t('col.actions')}</span>
                          ) : (
                            t(`col.${col}`)
                          )}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className={CARD_TABLE.body}>
                  {rows.map((row) => (
                    <BrandLine
                      key={row.id}
                      row={row}
                      canEdit={canEdit}
                      onAct={(next) => setDialog(next)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {load === 'ready' && next !== null ? (
            <p>
              <Button
                variant="secondary"
                loading={more}
                disabled={more}
                onClick={() => void loadMore()}
              >
                {t('more')}
              </Button>
            </p>
          ) : null}
        </>
      )}
      {dialog.kind === 'form' ? (
        <BrandFormDialog
          {...(dialog.brand === undefined ? {} : { brand: dialog.brand })}
          csrfToken={csrfToken}
          onClose={close}
          onStale={stale}
          onSaved={(brand) =>
            done(
              t(dialog.brand === undefined ? 'done.created' : 'done.saved', { name: brand.name }),
            )
          }
        />
      ) : null}
      {dialog.kind === 'confirm' ? (
        <BrandConfirmDialog
          kind={dialog.action}
          brand={dialog.brand}
          csrfToken={csrfToken}
          onClose={close}
          onStale={stale}
          onDone={(brand) => done(t(`done.${dialog.action}`, { name: brand.name }))}
        />
      ) : null}
      {dialog.kind === 'merge' ? (
        <BrandMergeDialog
          target={dialog.brand}
          csrfToken={csrfToken}
          onClose={close}
          onStale={stale}
          onMerged={(result: MergeBody) =>
            done(
              t('done.merged', {
                count: result.merged.length,
                name: result.brand.name,
                moved: result.merged.reduce((sum, entry) => sum + entry.productsMoved, 0),
              }),
            )
          }
        />
      ) : null}
    </div>
  );
}

function BrandLine({
  row,
  canEdit,
  onAct,
}: {
  readonly row: BrandRow;
  readonly canEdit: boolean;
  readonly onAct: (dialog: Dialogs) => void;
}) {
  const t = useTranslations('brands');
  return (
    <tr className={CARD_TABLE.row}>
      <td className={`${CARD_TABLE.cell} min-w-0`}>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-fg-muted"
          >
            {initialsOf(row.name)}
          </span>
          <div className="min-w-0">
            <p className="font-semibold wrap-anywhere text-fg">{row.name}</p>
            <p className="text-sm wrap-anywhere text-fg-muted">/brands/{row.slug}</p>
            {row.status === 'draft' && row.proposedBySellerId !== null ? (
              <p className="text-sm text-fg-muted">
                {t('proposed-by')}{' '}
                <a
                  className="whitespace-nowrap text-link underline"
                  href={`/sellers/${row.proposedBySellerId}`}
                  title={row.proposedBySellerId}
                >
                  {t('seller-fallback', { id: shortId(row.proposedBySellerId) })}
                </a>
              </p>
            ) : null}
            {row.status === 'archived' && row.mergedIntoId !== null ? (
              <p className="text-sm text-fg-muted" title={row.mergedIntoId}>
                {t('merged-into', { id: shortId(row.mergedIntoId) })}
              </p>
            ) : null}
          </div>
        </div>
      </td>
      <td className={CARD_TABLE.labelled} data-label={t('col.origin')}>
        {row.originCountry === null ? (
          <span aria-label={t('not-set')}>{'\u2014'}</span>
        ) : (
          <span>{row.originCountry}</span>
        )}
      </td>
      <td className={CARD_TABLE.corner}>
        <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
      </td>
      <td className={CARD_TABLE.labelled} data-label={t('col.updated')}>
        <When iso={row.updatedAt} missing="-" />
      </td>
      {canEdit ? (
        <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-2`}>
          <div className="flex flex-wrap gap-3">
            {row.status === 'draft' ? (
              <Button
                aria-label={t('action.approve-name', { name: row.name })}
                onClick={() => onAct({ kind: 'confirm', action: 'approve', brand: row })}
              >
                {t('action.approve')}
              </Button>
            ) : null}
            {row.status !== 'archived' ? (
              <Button
                variant="secondary"
                aria-label={t('action.edit-name', { name: row.name })}
                onClick={() => onAct({ kind: 'form', brand: row })}
              >
                {t('action.edit')}
              </Button>
            ) : null}
            {row.status === 'active' ? (
              <Button
                variant="secondary"
                aria-label={t('action.merge-name', { name: row.name })}
                onClick={() => onAct({ kind: 'merge', brand: row })}
              >
                {t('action.merge')}
              </Button>
            ) : null}
            {row.status !== 'archived' ? (
              <Button
                variant="destructive"
                aria-label={t(
                  row.status === 'draft' ? 'action.reject-name' : 'action.archive-name',
                  {
                    name: row.name,
                  },
                )}
                onClick={() =>
                  onAct({
                    kind: 'confirm',
                    action: row.status === 'draft' ? 'reject' : 'archive',
                    brand: row,
                  })
                }
              >
                {t(row.status === 'draft' ? 'action.reject' : 'action.archive')}
              </Button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
