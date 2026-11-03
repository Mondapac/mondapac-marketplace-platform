'use client';

import {
  Badge,
  Banner,
  Button,
  CARD_TABLE,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { ActivityFormDialog } from './activity-form-dialog.tsx';
import {
  API_ACTIVITIES,
  PAGE_SIZE,
  type ActivityPage,
  type ActivityRow,
  type ActivityStatus,
  type Locales,
  type StatusFilter,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
type Dialog =
  { readonly kind: 'none' } | { readonly kind: 'form'; readonly activity?: ActivityRow };

const STATUS_TONE: Record<ActivityStatus, 'success' | 'neutral'> = {
  active: 'success',
  inactive: 'neutral',
};

/**
 * The business activities of the Market (Grocery, Butcher, ...): a table with a status filter, a
 * server-side search and keyset paging. A holder of `catalog.business-activity.edit` also gets the
 * create and edit dialog; a reader gets the list and no buttons.
 */
export function BusinessActivitiesView({
  canEdit,
  csrfToken,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('business-activities');
  const tl = useTranslations('load');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [rows, setRows] = useState<readonly ActivityRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [locales, setLocales] = useState<Locales | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const latest = useRef(0);

  // The search term acts after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const toSignIn = (code: number): boolean => {
    if (code !== 401) return false;
    window.location.assign('/session-ended');
    return true;
  };

  const queryOf = useCallback(
    (afterId?: string) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (status !== 'all') query.set('status', status);
      if (search !== '') query.set('search', search);
      if (afterId !== undefined) query.set('afterId', afterId);
      return `${API_ACTIVITIES}?${query.toString()}`;
    },
    [status, search],
  );

  const fetchRows = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<ActivityPage>('GET', queryOf());
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      setRows([]);
      setLoad('failed');
      return;
    }
    setRows(result.body.items);
    setNext(result.body.nextAfterId);
    setLocales(result.body.locales);
    setLoad('ready');
  }, [queryOf]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  async function loadMore() {
    if (next === null || more) return;
    setMore(true);
    const result = await callApi<ActivityPage>('GET', queryOf(next));
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
  // The activity changed or vanished meanwhile: close, say so, and read the list again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    void fetchRows();
  };
  const defaultLocale = locales?.default ?? 'en';
  const nameOf = (row: ActivityRow): string => row.names[defaultLocale] ?? row.code;
  const filtered = search !== '' || status !== 'all';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-fg-muted">{t('intro')}</p>
        {canEdit && locales !== null ? (
          <Button onClick={() => setDialog({ kind: 'form' })}>{t('new')}</Button>
        ) : null}
      </div>
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}
      <div role="search" aria-label={t('search-label')} className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-80">
          <TextField
            name="search"
            type="search"
            label={t('search')}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            label={t('status-filter')}
            value={status}
            options={[
              { value: 'all', label: t('status.all') },
              { value: 'active', label: t('status.active') },
              { value: 'inactive', label: t('status.inactive') },
            ]}
            onChange={(event) => {
              setStatus(event.target.value as StatusFilter);
              setNotice(null);
            }}
          />
        </div>
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
        <EmptyState icon="tag" title={t(filtered ? 'empty-filtered' : 'empty')} />
      ) : null}
      {load === 'ready' && rows.length > 0 ? (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {[
                  'name',
                  'code',
                  'description',
                  'categories',
                  'status',
                  ...(canEdit ? ['actions'] : []),
                ].map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {col === 'actions' ? (
                      <span className="sr-only">{t('col.actions')}</span>
                    ) : (
                      t(`col.${col}`)
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {rows.map((row) => (
                <tr key={row.id} className={CARD_TABLE.row}>
                  <td className={`${CARD_TABLE.cell} min-w-0`}>
                    <p className="font-semibold wrap-anywhere text-fg">{nameOf(row)}</p>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.code')}>
                    <span className="wrap-anywhere">{row.code}</span>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.description')}>
                    {row.description === null ? (
                      <span aria-label={t('not-set')}>{'—'}</span>
                    ) : (
                      <span className="line-clamp-2 wrap-anywhere">{row.description}</span>
                    )}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.categories')}>
                    {row.categoryIds.length}
                  </td>
                  <td className={CARD_TABLE.corner}>
                    <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
                  </td>
                  {canEdit ? (
                    <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-2`}>
                      <Button
                        variant="secondary"
                        aria-label={t('action.edit-name', { name: nameOf(row) })}
                        onClick={() => setDialog({ kind: 'form', activity: row })}
                      >
                        {t('action.edit')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
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
      {dialog.kind === 'form' && locales !== null ? (
        <ActivityFormDialog
          {...(dialog.activity === undefined ? {} : { activity: dialog.activity })}
          locales={locales}
          csrfToken={csrfToken}
          onClose={close}
          onStale={stale}
          onSaved={(activity) => {
            close();
            setNotice(null);
            toast.success(
              t(dialog.activity === undefined ? 'done.created' : 'done.saved', {
                name: activity.names[locales.default] ?? activity.code,
              }),
            );
            void fetchRows();
          }}
        />
      ) : null}
    </div>
  );
}
