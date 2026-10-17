'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  EmptyState,
  FieldAction,
  Select,
  SkeletonRows,
  Tabs,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { SellersTable } from './sellers-table.tsx';
import {
  FILE_TABS,
  isStateTab,
  KINDS,
  PAGE_SIZE,
  SEARCH_MAX,
  SEARCH_MIN,
  STATE_TABS,
  type SellerListCounts,
  type SellerListPage,
  type SellerListStateCounts,
  type SellerRow,
  type Tab,
} from './types.ts';

type Failure = 'too-broad' | 'denied' | 'unavailable';

function countOf(
  counts: SellerListCounts | null,
  stateCounts: SellerListStateCounts | null,
  tab: Tab,
): number | null {
  switch (tab) {
    case 'awaiting-review':
      return counts === null
        ? null
        : counts.awaitingReview.onboarding + counts.awaitingReview.identityChange;
    case 'incomplete':
      return counts?.incomplete ?? null;
    case 'all':
      return counts?.all ?? null;
    case 'changes-needed':
      return stateCounts?.changesNeeded ?? null;
    case 'not-approved':
      return stateCounts?.notApproved ?? null;
    case 'approved':
      return stateCounts?.approved ?? null;
    case 'suspended':
      return stateCounts?.suspended ?? null;
  }
}

function failureOf(status: number, code: string): Failure {
  if (code === 'search.too-broad') return 'too-broad';
  return status === 401 || status === 403 ? 'denied' : 'unavailable';
}

/**
 * The admin seller list (SEL-14): three tabs from the seller files with a name or slug prefix
 * search, and, for an admin who may see identity's state, three state tabs (no search); paging
 * by cursor.
 */
export function SellersList({
  csrfToken,
  canReview,
}: {
  readonly csrfToken: string;
  readonly canReview: boolean;
}) {
  const t = useTranslations('sellers.list');
  const tl = useTranslations('load');
  const [tab, setTab] = useState<Tab>('awaiting-review');
  const [kind, setKind] = useState('');
  const [outsideArea, setOutsideArea] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<readonly SellerRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [counts, setCounts] = useState<SellerListCounts | null>(null);
  const [stateCounts, setStateCounts] = useState<SellerListStateCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      // A new first page replaces the list at once: the old tab's rows never show under a new tab.
      if (after === null) {
        setRows([]);
        setNext(null);
      }
      const result = await callApi<SellerListPage>(
        'POST',
        'sellers/admin/list',
        {
          tab,
          limit: PAGE_SIZE,
          ...(tab === 'awaiting-review' && kind !== '' ? { kind } : {}),
          ...(tab === 'incomplete' && outsideArea ? { outsideArea: true } : {}),
          ...(search === '' || isStateTab(tab) ? {} : { search }),
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
      // A later page of a file tab carries no state counts: keep the first page's.
      if (after === null) setStateCounts(result.body.stateCounts);
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

  // A tab starts unfiltered: a search or filter set under one tab never narrows the next one.
  function selectTab(id: Tab) {
    if (id === tab) return;
    setTab(id);
    setDraft('');
    setSearch('');
    setKind('');
    setOutsideArea(false);
  }

  const tooShort = draft.trim().length === 1;
  const stateTab = isStateTab(tab);
  const tabs: readonly Tab[] =
    stateCounts !== null || stateTab ? [...FILE_TABS, ...STATE_TABS] : FILE_TABS;

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        label={t('tabs')}
        activeId={tab}
        onSelect={(id) => selectTab(id as typeof tab)}
        items={tabs.map((id) => {
          const count = countOf(counts, stateCounts, id);
          return { id, label: `${t(`tab.${id}`)}${count === null ? '' : ` (${count})`}` };
        })}
      />
      {stateTab ? null : (
        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-start">
          <form
            onSubmit={submitSearch}
            role="search"
            className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-2"
          >
            <TextField
              label={t('search.label')}
              value={draft}
              maxLength={SEARCH_MAX}
              onChange={(event) => setDraft(event.target.value)}
              help={t('search.help')}
              error={tooShort ? t('search.too-short') : undefined}
            />
            <FieldAction>
              <Button type="submit" variant="secondary">
                {t('search.submit')}
              </Button>
            </FieldAction>
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
            <FieldAction from="lg">
              <CheckboxRow
                label={t('filter.outside-area')}
                checked={outsideArea}
                onChange={(event) => setOutsideArea(event.target.checked)}
              />
            </FieldAction>
          ) : null}
        </div>
      )}
      {failure === null ? null : <Banner tone="critical">{t(`error.${failure}`)}</Banner>}
      {failure === 'unavailable' ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {tl('retry')}
          </Button>
        </div>
      ) : null}
      {loading && rows.length === 0 ? <SkeletonRows label={t('loading')} /> : null}
      {rows.length > 0 || (!loading && failure === null) ? (
        <SellersTable
          rows={rows}
          canReview={canReview}
          showOwner={stateCounts !== null}
          empty={
            <EmptyState
              size="compact"
              icon={search === '' || stateTab ? 'store' : 'search'}
              title={t(search === '' || stateTab ? `empty.${tab}` : 'empty.search')}
            />
          }
        />
      ) : null}
      {loading && rows.length > 0 ? <SkeletonRows label={t('loading')} rows={1} /> : null}
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
