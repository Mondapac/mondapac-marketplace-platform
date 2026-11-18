'use client';

import {
  Badge,
  Button,
  CheckboxRow,
  EmptyState,
  ListColumnsPanel,
  ListSortPanel,
  SuperList,
  SuperTable,
  TextField,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useSuperListQuery,
  writeIds,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { startOfDay } from '../sales/day-start.ts';
import { timeOf } from './format.ts';
import { ACTIVITY_MAX_ROWS } from './groups-types.ts';
import {
  RevealConfirm,
  RevealNote,
  RevealedTag,
  deviceText,
  useReveals,
} from './security-shared.tsx';
import {
  SIGN_IN_RESULTS,
  SIGN_IN_REVEAL,
  type SignIn,
  type SignInResult,
  type SignInReveal,
  type SignInsPage,
} from './security-types.ts';

const PAGE_SIZES = [25, 50, 100] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type View = 'all' | 'failed';
const VIEWS: readonly View[] = ['all', 'failed'];

const OPTIONAL = ['device', 'city'] as const;
type Optional = (typeof OPTIONAL)[number];
const DEFAULT_OPTIONAL: readonly Optional[] = ['device', 'city'];

interface Query {
  readonly results: readonly SignInResult[];
  readonly from: string;
  readonly to: string;
  readonly direction: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
}

const DEFAULT_QUERY: Query = {
  results: [],
  from: '',
  to: '',
  direction: 'desc',
  page: 1,
  pageSize: 25,
};

const viewOf = (query: Query): View =>
  query.results.length === 1 && query.results[0] === 'failure' ? 'failed' : 'all';

/**
 * The list's `filters`. The admin's days become instants on the admin's clock (the API's `to` is
 * the first instant after the last day).
 */
function filtersOf(query: Query, zone: string): Record<string, unknown> {
  const from = query.from === '' ? null : startOfDay(query.from, zone);
  const to = query.to === '' ? null : startOfDay(query.to, zone, 1);
  return {
    ...(query.results.length === 0 ? {} : { result: query.results }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
  };
}

/**
 * A customer's sign-ins of the last 90 days as a super list (customers management phase 2b,
 * Account & security): the All and Failed views, the result and day range filters with chips, the
 * sort by time, the column picker, and the footer of the Market's List paging setting. The full IP
 * address is never a column: "Show IP…" in the row Actions menu reveals one row's address in
 * place, recorded, for five minutes (the reveal rule). Owner decision: NO export here, though the
 * API has one. The API has no search, no saved filters and no row selection for this list: the PR
 * records these as rule 14 exceptions.
 */
export function CustomerSignIns({
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
  onHidden,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.security.sign-ins');
  const ts = useTranslations('customers.security');
  const tl = useTranslations('customers.list');
  const tload = useTranslations('load');
  const locale = useLocale();
  const [answer, setAnswer] = useState<SignInsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'invalid' | 'unavailable' | null>(null);
  const [columns, setColumns] = useState<readonly Optional[]>(DEFAULT_OPTIONAL);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const reveals = useReveals<string>(ts('reveal.hidden-ip'));
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, adminAccountId, 'customer-sign-ins-columns');
  const canReveal = keys.has(SIGN_IN_REVEAL);

  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: (view) => ({ ...DEFAULT_QUERY, results: view === 'failed' ? ['failure'] : [] }),
    withView: (current, view) => ({ ...current, results: view === 'failed' ? ['failure'] : [] }),
    searchOf: () => '',
    withSearch: (current) => current,
  });
  const { query } = list;

  useEffect(() => {
    const stored = readIds(browserStorage(), storageKey);
    if (stored !== null && stored !== undefined) {
      setColumns(
        stored.filter((id): id is Optional => (OPTIONAL as readonly string[]).includes(id)),
      );
    }
  }, [storageKey]);

  const load = useCallback(
    async (next: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const filters = filtersOf(next, zone);
      const result = await callApi<SignInsPage>(
        'POST',
        `customers/admin/customers/${encodeURIComponent(accountId)}/sign-ins`,
        {
          ...(Object.keys(filters).length === 0 ? {} : { filters }),
          direction: next.direction,
          page: next.page,
          pageSize: next.pageSize,
          paging,
        },
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (result.failure.status === 403) {
          onHidden();
          return;
        }
        setFailure(result.failure.code === 'validation.failed' ? 'invalid' : 'unavailable');
        return;
      }
      setAnswer(result.body);
    },
    [accountId, csrfToken, paging, zone, onHidden],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  const skeleton = status.skeleton && failure === null;

  const resultText = (row: SignIn) =>
    (SIGN_IN_RESULTS as readonly string[]).includes(row.result)
      ? t(`result.${row.result}`)
      : t('result.other');
  const timeName = (row: SignIn) => t('row.name', { time: timeOf(row.occurredAt, locale, zone) });

  const filtered = query.results.length > 0 || query.from !== '' || query.to !== '';
  const chips = [
    ...query.results.map((result) => ({
      key: `result-${result}`,
      label: t('chip.result', { result: t(`result.${result}`) }),
      patch: { results: query.results.filter((other) => other !== result) },
    })),
    ...(query.from === ''
      ? []
      : [{ key: 'from', label: t('chip.from', { day: query.from }), patch: { from: '' } }]),
    ...(query.to === ''
      ? []
      : [{ key: 'to', label: t('chip.to', { day: query.to }), patch: { to: '' } }]),
  ];
  const clear: Partial<Query> = { results: [], from: '', to: '' };
  const numberOf = (value: number) => numberFormat(locale, {}).format(value);
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.page - 1) * answer.pageSize + answer.items.length + (answer.hasNext ? 1 : 0));
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;

  const optional = (id: Optional): SuperColumn<SignIn> =>
    id === 'device'
      ? { id, header: t('col.device'), cell: (row) => deviceText(row.device, ts) }
      : {
          id,
          header: t('col.city'),
          cell: (row) =>
            row.city === null ? <span className="text-fg-muted">—</span> : <span>{row.city}</span>,
        };
  const tableColumns: SuperColumn<SignIn>[] = [
    {
      id: 'time',
      header: t('col.time'),
      primary: true,
      headClassName: 'min-w-48',
      cell: (row) => {
        const address = reveals.shown.get(row.signInId);
        return (
          <span className="flex min-w-0 flex-col gap-1">
            <span>{timeOf(row.occurredAt, locale, zone)}</span>
            {address === undefined ? null : (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm wrap-anywhere">{address}</span>
                <RevealedTag />
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: 'result',
      header: t('col.result'),
      cell: (row) => (
        <Badge tone={row.result === 'success' ? 'success' : 'neutral'}>{resultText(row)}</Badge>
      ),
    },
    ...columns.map(optional),
  ];
  const rowItems = (row: SignIn): MenuItem[] => {
    if (!canReveal) {
      return [{ id: 'none', label: t('row.nothing'), disabled: true, onSelect: () => undefined }];
    }
    return reveals.shown.has(row.signInId)
      ? [{ id: 'hide-ip', label: t('row.hide-ip'), onSelect: () => reveals.hide(row.signInId) }]
      : [{ id: 'show-ip', label: t('row.show-ip'), onSelect: () => setRevealTarget(row.signInId) }];
  };

  return (
    <>
      <SuperList
        heading={{ subtitle: t('subtitle'), note: t('zone', { zone }) }}
        views={{
          label: t('views'),
          activeId: viewOf(query),
          onSelect: (id) => list.openView(id),
          items: VIEWS.map((view) => ({ id: view, label: t(`view.${view}`) })),
          manage: null,
        }}
        filter={{
          label: t('filter.button'),
          count: chips.length,
          panel: (close) => (
            <SignInsFilterPanel
              results={query.results}
              from={query.from}
              to={query.to}
              onApply={(patch) => list.change(patch)}
              close={close}
            />
          ),
        }}
        sort={{
          label: tl('sort.button'),
          panel: () => (
            <ListSortPanel
              name="customer-sign-ins-sort"
              sort="time"
              direction={query.direction}
              fields={[{ id: 'time', label: t('col.time') }]}
              defaultDirection={() => 'desc'}
              orderLabels={() => [tl('sort.date.first'), tl('sort.date.second')]}
              labels={{ by: tl('sort.by'), order: tl('sort.order') }}
              onChange={(_sort, direction) => list.change({ direction })}
            />
          ),
        }}
        columns={{
          label: tl('columns.button'),
          panel: (close) => (
            <ListColumnsPanel
              columns={columns}
              optional={OPTIONAL}
              defaults={DEFAULT_OPTIONAL}
              fixed={[
                { id: 'time', label: t('col.time') },
                { id: 'result', label: t('col.result') },
              ]}
              optionalLabel={(column) => t(`col.${column}`)}
              labels={{
                title: tl('columns.title'),
                help: tl('columns.help'),
                always: tl('columns.always'),
                up: (column) => tl('columns.up', { column }),
                down: (column) => tl('columns.down', { column }),
                reset: tl('columns.reset'),
                save: tl('columns.save'),
              }}
              onSave={(next) => {
                const clean = next.filter((id): id is Optional =>
                  (OPTIONAL as readonly string[]).includes(id),
                );
                setColumns(clean);
                writeIds(browserStorage(), storageKey, clean);
              }}
              close={close}
            />
          ),
        }}
        sortedLine={t('sorted', {
          order: query.direction === 'desc' ? tl('sort.date.first') : tl('sort.date.second'),
        })}
        chips={
          filtered
            ? {
                chips: chips.map((chip) => ({
                  key: chip.key,
                  label: chip.label,
                  removeLabel: tl('chip-remove', { filter: chip.label }),
                  onRemove: () => list.change(chip.patch),
                })),
                clearAll: { label: tl('clear-all'), onClick: () => list.change(clear) },
                status:
                  answer === null || failure !== null || answer.total === null
                    ? ''
                    : t('match', { count: answer.total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : {
                message: t(`error.${failure}`),
                ...(failure === 'unavailable'
                  ? { retry: { label: ts('retry'), onClick: () => void load(query) } }
                  : {}),
              }
        }
        firstLoadError={answer === null && failure === 'unavailable'}
        loading={loading}
        status={status}
        loadingLabel={t('loading')}
        slowLabel={tload('slow')}
        ready={answer !== null}
        table={
          <SuperTable
            caption={t('caption')}
            rows={answer?.items ?? []}
            rowId={(row) => row.signInId}
            rowName={timeName}
            columns={tableColumns}
            actions={{
              header: tl('col.actions'),
              label: (name) => t('row.menu', { name }),
              items: rowItems,
            }}
            empty={
              <EmptyState
                size="compact"
                icon={filtered ? 'search' : 'clock'}
                title={filtered ? t('empty-filtered') : t('empty')}
                action={
                  filtered ? (
                    <Button variant="secondary" onClick={() => list.change(clear)}>
                      {tl('clear-filters')}
                    </Button>
                  ) : undefined
                }
              />
            }
            skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
            minWidthClass="lg:min-w-160"
          />
        }
        pagination={
          answer === null || total === 0
            ? null
            : {
                mode: paging,
                page: answer.page,
                pageSize: answer.pageSize,
                pageSizes: PAGE_SIZES,
                total,
                maxRows: ACTIVITY_MAX_ROWS,
                range:
                  answer.total === null
                    ? t('range-open', {
                        from: numberOf(start + 1),
                        to: numberOf(start + answer.items.length),
                      })
                    : tl('range', {
                        from: numberOf(start + 1),
                        to: numberOf(start + answer.items.length),
                        total: numberOf(answer.total),
                      }),
                labels: {
                  rowsPerPage: tl('paging.rows-per-page'),
                  previous: tl('paging.previous'),
                  next: tl('paging.next'),
                  pages: tl('paging.pages'),
                  page: (page) => tl('paging.page', { page }),
                  narrowTitle: tl('paging.narrow-title'),
                  narrowBody: tl('paging.narrow-body'),
                },
                disabled: loading,
                onPage: list.goToPage,
                onPageSize: (size) => list.change({ pageSize: size }),
              }
        }
      />
      <RevealNote note={reveals.note} />
      <RevealConfirm<SignInReveal>
        target={revealTarget}
        title={t('reveal.title')}
        body={t('reveal.body')}
        confirmLabel={t('reveal.confirm')}
        run={(signInId) =>
          callApi<SignInReveal>(
            'POST',
            `customers/admin/customers/${encodeURIComponent(accountId)}/sign-ins/${encodeURIComponent(signInId)}/reveal`,
            {},
            csrfToken,
          )
        }
        onRevealed={(signInId, value) => {
          reveals.show(signInId, value.address);
          setRevealTarget(null);
        }}
        onCancel={() => setRevealTarget(null)}
      />
    </>
  );
}

/** The result and day range of the sign-ins filter (days in the admin's zone, both included). */
function SignInsFilterPanel({
  results,
  from,
  to,
  onApply,
  close,
}: {
  readonly results: readonly SignInResult[];
  readonly from: string;
  readonly to: string;
  readonly onApply: (patch: Partial<Query>) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers.security.sign-ins');
  const [draft, setDraft] = useState({ results, from, to });
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({});

  function apply(event: FormEvent) {
    event.preventDefault();
    const next = { from: draft.from.trim(), to: draft.to.trim() };
    const problems: { from?: string; to?: string } = {};
    if (next.from !== '' && !DAY.test(next.from)) problems.from = t('filter.error.day');
    if (next.to !== '' && !DAY.test(next.to)) problems.to = t('filter.error.day');
    if (problems.to === undefined && next.from !== '' && next.to !== '' && next.to < next.from) {
      problems.to = t('filter.error.range');
    }
    if (problems.from !== undefined || problems.to !== undefined) {
      setErrors(problems);
      return;
    }
    onApply({ results: draft.results, ...next });
    close();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('filter.title')}</h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-fg">{t('filter.result')}</legend>
        {SIGN_IN_RESULTS.map((result) => (
          <CheckboxRow
            key={result}
            label={t(`result.${result}`)}
            checked={draft.results.includes(result)}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                results: event.target.checked
                  ? SIGN_IN_RESULTS.filter(
                      (other) => other === result || current.results.includes(other),
                    )
                  : current.results.filter((other) => other !== result),
              }))
            }
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('filter.when')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t('filter.from')}
            type="date"
            value={draft.from}
            error={errors.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
          <TextField
            label={t('filter.to')}
            type="date"
            value={draft.to}
            error={errors.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('filter.cancel')}
        </Button>
        <Button type="submit">{t('filter.apply')}</Button>
      </div>
    </form>
  );
}
