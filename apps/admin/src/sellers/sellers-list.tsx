'use client';

import { Banner, Button, CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { SellersTable } from './sellers-table.tsx';
import {
  KINDS,
  PAGE_SIZE,
  SEARCH_MAX,
  SEARCH_MIN,
  TABS,
  type SellerListCounts,
  type SellerListPage,
  type SellerRow,
  type Tab,
} from './types.ts';

type Failure = 'too-broad' | 'denied' | 'unavailable';

function countOf(counts: SellerListCounts | null, tab: Tab): number | null {
  if (counts === null) return null;
  if (tab === 'awaiting-review') {
    return counts.awaitingReview.onboarding + counts.awaitingReview.identityChange;
  }
  return tab === 'incomplete' ? counts.incomplete : counts.all;
}

function failureOf(status: number, code: string): Failure {
  if (code === 'search.too-broad') return 'too-broad';
  return status === 401 || status === 403 ? 'denied' : 'unavailable';
}

/** The admin seller list (SEL-14): three tabs, a name or slug prefix search, paging by cursor. */
export function SellersList({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('sellers.list');
  const [tab, setTab] = useState<Tab>('awaiting-review');
  const [kind, setKind] = useState('');
  const [outsideArea, setOutsideArea] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<readonly SellerRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [counts, setCounts] = useState<SellerListCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<SellerListPage>(
        'POST',
        'sellers/admin/list',
        {
          tab,
          limit: PAGE_SIZE,
          ...(tab === 'awaiting-review' && kind !== '' ? { kind } : {}),
          ...(tab === 'incomplete' && outsideArea ? { outsideArea: true } : {}),
          ...(search === '' ? {} : { search }),
          ...(after === null ? {} : { after }),
        },
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        setFailure(failureOf(result.failure.status, result.failure.code));
        if (after === null) {
          setRows([]);
          setNext(null);
        }
        return;
      }
      setRows((current) =>
        after === null ? result.body.items : [...current, ...result.body.items],
      );
      setNext(result.body.next);
      setCounts(result.body.counts);
    },
    [tab, kind, outsideArea, search, csrfToken],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const term = draft.trim();
    if (term === '') setSearch('');
    else if (term.length >= SEARCH_MIN && term.length <= SEARCH_MAX) setSearch(term);
  }

  const tooShort = draft.trim().length === 1;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t('tabs')} className="flex flex-wrap gap-4 border-b border-line">
        {TABS.map((id) => {
          const count = countOf(counts, id);
          return (
            <button
              key={id}
              type="button"
              aria-current={id === tab ? 'page' : undefined}
              onClick={() => setTab(id)}
              className={
                id === tab
                  ? 'border-b-2 border-link px-1 pb-2 font-medium text-fg'
                  : 'px-1 pb-2 text-fg-muted hover:text-fg'
              }
            >
              {t(`tab.${id}`)}
              {count === null ? '' : ` (${count})`}
            </button>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-end gap-4">
        <form onSubmit={submitSearch} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('search.label')}
            value={draft}
            maxLength={SEARCH_MAX}
            onChange={(event) => setDraft(event.target.value)}
            help={t('search.help')}
            error={tooShort ? t('search.too-short') : undefined}
          />
          <Button type="submit" variant="secondary">
            {t('search.submit')}
          </Button>
        </form>
        {tab === 'awaiting-review' ? (
          <Select
            label={t('filter.kind')}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            placeholder={t('filter.all-kinds')}
            options={KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))}
          />
        ) : null}
        {tab === 'incomplete' ? (
          <CheckboxRow
            label={t('filter.outside-area')}
            checked={outsideArea}
            onChange={(event) => setOutsideArea(event.target.checked)}
          />
        ) : null}
      </div>
      {failure === null ? null : <Banner tone="critical">{t(`error.${failure}`)}</Banner>}
      {rows.length > 0 ? <SellersTable rows={rows} /> : null}
      {!loading && failure === null && rows.length === 0 ? (
        <div className="rounded-lg border border-line p-6">
          <p className="font-medium">{t(search === '' ? `empty.${tab}` : 'empty.search')}</p>
        </div>
      ) : null}
      {loading ? <p className="text-fg-muted">{t('loading')}</p> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
