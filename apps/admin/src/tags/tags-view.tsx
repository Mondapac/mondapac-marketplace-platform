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
import { TagFormDialog } from './tag-form-dialog.tsx';
import {
  API_TOPICS,
  PAGE_SIZE,
  SYNONYMS_MAX,
  TOPIC_GROUPS,
  type GroupFilter,
  type Locales,
  type StatusFilter,
  type TopicPage,
  type TopicRow,
  type TopicStatus,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
type Dialog = { readonly kind: 'none' } | { readonly kind: 'form'; readonly topic?: TopicRow };

const STATUS_TONE: Record<TopicStatus, 'success' | 'neutral'> = {
  active: 'success',
  archived: 'neutral',
};
/** Synonyms shown in a row before "+N". */
const SYNONYMS_SHOWN = 2;

/**
 * The product tags of the Market (catalog topics: Ramadan, BBQ, ...): a table with status and group
 * filters, a server-side search and keyset paging. A holder of `catalog.topic.manage` also gets
 * the create and edit dialog; a reader gets the list and no buttons.
 */
export function TagsView({
  canManage,
  csrfToken,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('tags');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [rows, setRows] = useState<readonly TopicRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [locales, setLocales] = useState<Locales | null>(null);
  const [maxSynonyms, setMaxSynonyms] = useState(SYNONYMS_MAX);
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
      if (group !== 'all') query.set('group', group);
      if (search !== '') query.set('search', search);
      if (afterId !== undefined) query.set('afterId', afterId);
      return `${API_TOPICS}?${query.toString()}`;
    },
    [status, group, search],
  );

  const fetchRows = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<TopicPage>('GET', queryOf());
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
    setMaxSynonyms(result.body.maxSynonyms);
    setLoad('ready');
  }, [queryOf]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  async function loadMore() {
    if (next === null || more) return;
    setMore(true);
    const result = await callApi<TopicPage>('GET', queryOf(next));
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
  // The tag changed or vanished meanwhile: close, say so, and read the list again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    void fetchRows();
  };
  const defaultLocale = locales?.default ?? 'en';
  const nameOf = (row: TopicRow): string => row.names[defaultLocale] ?? row.slug;
  const filtered = search !== '' || status !== 'all' || group !== 'all';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-fg-muted">{t('intro')}</p>
        {canManage && locales !== null ? (
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
              { value: 'archived', label: t('status.archived') },
            ]}
            onChange={(event) => {
              setStatus(event.target.value as StatusFilter);
              setNotice(null);
            }}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            label={t('group-filter')}
            value={group}
            options={[
              { value: 'all', label: t('group.all') },
              ...TOPIC_GROUPS.map((value) => ({ value, label: t(`group.${value}`) })),
            ]}
            onChange={(event) => {
              setGroup(event.target.value as GroupFilter);
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
          retryLabel={t('retry')}
          onRetry={() => void fetchRows()}
        />
      ) : null}
      {load === 'ready' && rows.length === 0 ? (
        <EmptyState
          icon="star"
          title={t(filtered ? 'empty-filtered' : canManage ? 'empty' : 'empty-reader')}
        />
      ) : null}
      {load === 'ready' && rows.length > 0 ? (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {['name', 'group', 'synonyms', 'status', ...(canManage ? ['actions'] : [])].map(
                  (col) => (
                    <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
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
              {rows.map((row) => {
                const synonyms = row.synonyms[defaultLocale] ?? [];
                const hidden = synonyms.length - SYNONYMS_SHOWN;
                return (
                  <tr key={row.id} className={CARD_TABLE.row}>
                    <td className={`${CARD_TABLE.cell} min-w-0`}>
                      <p className="font-semibold wrap-anywhere text-fg">{nameOf(row)}</p>
                      <p className="text-sm wrap-anywhere text-fg-muted">{row.slug}</p>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('col.group')}>
                      {t(`group.${row.group}`)}
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('col.synonyms')}>
                      {synonyms.length === 0 ? (
                        <span aria-label={t('not-set')}>{'—'}</span>
                      ) : (
                        <span className="wrap-anywhere">
                          {synonyms.slice(0, SYNONYMS_SHOWN).join(', ')}
                          {hidden > 0 ? (
                            <>
                              {' '}
                              <span aria-hidden="true">{`+${hidden}`}</span>
                              <span className="sr-only">{t('and-more', { count: hidden })}</span>
                            </>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className={CARD_TABLE.corner}>
                      <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
                    </td>
                    {canManage ? (
                      <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-2`}>
                        <Button
                          variant="secondary"
                          aria-label={t('action.edit-name', { name: nameOf(row) })}
                          onClick={() => setDialog({ kind: 'form', topic: row })}
                        >
                          {t('action.edit')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
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
        <TagFormDialog
          {...(dialog.topic === undefined ? {} : { topic: dialog.topic })}
          locales={locales}
          maxSynonyms={maxSynonyms}
          csrfToken={csrfToken}
          onClose={close}
          onStale={stale}
          onSaved={(topic) => {
            close();
            setNotice(null);
            toast.success(
              t(dialog.topic === undefined ? 'done.created' : 'done.saved', {
                name: topic.names[locales.default] ?? topic.slug,
              }),
            );
            void fetchRows();
          }}
        />
      ) : null}
    </div>
  );
}
