'use client';

import { type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { ReviewBulkDialog, type ReviewBulk } from '../catalog/review-bulk.tsx';
import { formatInstantInZone, shortInstantInZone } from '../shared/format.ts';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import { useDateFilter } from '../shared/paged-list/use-date-filter.ts';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import { useCategoryOptions, useSellerOptions, type FilterOption } from './filter-options.ts';
import { ReasonChips } from './reason-chips.tsx';
import { waitingAge } from './waiting-age.ts';
import {
  API_CHANGES,
  API_QUEUE,
  REVIEW_REASONS,
  bulkApprovalCheck,
  changeName,
  firstName,
  typeLabel,
  type ChangeRow,
  type FirstRow,
} from './types.ts';

// The routes search product name, product code and store name by 2 to 100 characters.
const SEARCH = { max: 100, accepts: (text: string) => [...text].length >= 2 };

const AGE_PRESETS = ['older-24h', 'older-48h', 'older-7d'] as const;
const AGE_HOURS: Readonly<Record<string, number>> = {
  'older-24h': 24,
  'older-48h': 48,
  'older-7d': 168,
};

/** "Waiting longer than N hours" is a window that ends N hours ago; read at each load. */
function ageRange(preset: string): { readonly from: string; readonly to: string } | null {
  const hours = AGE_HOURS[preset];
  return hours === undefined
    ? null
    : {
        from: '1970-01-01T00:00:00.000Z',
        to: new Date(Date.now() - hours * 3_600_000).toISOString(),
      };
}

interface ListProps<Row> {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  /** The IANA zone of the Waiting since times and of the age filters (ADR-0005). */
  readonly zone: string;
  readonly canDecide: boolean;
  /** Bumped by the page after a decision, so the list reads again. */
  readonly refreshKey: number;
  /** The rows of the page just read (the drawer opens the next one from them). */
  readonly onRows: (rows: readonly Row[]) => void;
  /** The tab count: every row that waits, whatever the filters. */
  readonly onCount: (count: number) => void;
  readonly onOpen: (row: Row) => void;
}

const SORTS = (t: (key: string) => string) =>
  [
    {
      id: 'submitted',
      orders: [t('sort.waiting.first'), t('sort.waiting.second')] as [string, string],
      defaultDirection: 'asc' as const,
    },
  ] as const;

/**
 * The filters both lists share: the review reasons, then `between` (a list's own fields), the store
 * (the stores with rows in the queue) and the platform category. A field with no options yet is
 * left out, as on the Products list.
 */
function sharedFields(
  label: (key: string) => string,
  reasons: readonly FilterOption[],
  sellers: readonly FilterOption[],
  categories: readonly FilterOption[],
  between: readonly PagedFilterField[] = [],
): PagedFilterField[] {
  return [
    { id: 'reasons', label: label('reasons'), options: reasons },
    ...between,
    ...(sellers.length === 0
      ? []
      : [{ id: 'sellerId', label: label('sellerId'), options: sellers }]),
    ...(categories.length === 0
      ? []
      : [{ id: 'categoryId', label: label('categoryId'), options: categories }]),
  ];
}

/**
 * Waiting since: how long it has waited ("3d 4h") first, the moment it was submitted after it, and
 * the full date and time as the hover text.
 */
function Waiting({ since, zone }: { readonly since: string; readonly zone: string }) {
  const t = useTranslations('offer-review.age');
  const locale = useLocale();
  const age = waitingAge(since, new Date());
  const words =
    age === null
      ? null
      : age.key === 'days'
        ? t('days', { days: age.days, hours: age.hours })
        : age.key === 'hours'
          ? t('hours', { hours: age.hours, minutes: age.minutes })
          : t('minutes', { minutes: age.minutes });
  return (
    <span title={formatInstantInZone(since, locale, zone)}>
      {words === null ? null : <span className="font-medium">{words}</span>}
      {words === null ? null : <span className="text-fg-muted"> · </span>}
      <span className={words === null ? '' : 'text-fg-muted'}>
        {shortInstantInZone(since, locale, zone, true)}
      </span>
    </span>
  );
}

/** A name that opens the decision drawer: a real button, so the keyboard reaches it. */
function OpenName({
  name,
  detail,
  label,
  onOpen,
}: {
  readonly name: string;
  readonly detail: string;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-label={label}
        onClick={onOpen}
        className="text-start font-medium wrap-anywhere text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      >
        {name}
      </button>
      <div className="text-sm text-fg-muted wrap-anywhere">{detail}</div>
    </div>
  );
}

/**
 * Offers waiting for their first publication (R1 to R7 reasons as chips): a super list over
 * `catalog/admin/review-queue?kind=offer-first-publication`. Bulk approve is allowed for new and
 * watched sellers and for one seller's one certificate type; the list says why before it asks and
 * the server skips what it refuses, naming each row.
 */
export function FirstPublicationsList({
  paging,
  accountId,
  marketId,
  csrfToken,
  zone,
  canDecide,
  refreshKey,
  onRows,
  onCount,
  onOpen,
}: ListProps<FirstRow>) {
  const t = useTranslations('offer-review.first');
  const tq = useTranslations('catalog.queue.bulk');
  const tr = useTranslations('offer-review.reason');
  const [bulk, setBulk] = useState<ReviewBulk | null>(null);
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: FirstRow): readonly MenuItem[] => [
      { id: 'open', label: t('actions.open'), onSelect: () => onOpen(row) },
    ],
    [t, onOpen],
  );
  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<FirstRow> => {
      switch (id) {
        case 'offer':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <OpenName
                name={firstName(row)}
                detail={`${row.sellerSku} · ${row.conditionCode}`}
                label={t('open-named', { name: firstName(row) })}
                onOpen={() => onOpen(row)}
              />
            ),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) => (
              <span className="wrap-anywhere">{row.storeName ?? t('seller-unnamed')}</span>
            ),
          };
        case 'reasons':
          return { id, header, corner: true, cell: (row) => <ReasonChips reasons={row.reasons} /> };
        case 'tags':
          return {
            id,
            header,
            cell: (row) =>
              row.tagTypes.length === 0
                ? '-'
                : row.tagTypes.map((code) => typeLabel(code)).join(', '),
          };
        case 'handling':
          return { id, header, cell: (row) => row.handling ?? t('handling-missing') };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) =>
              row.submittedAt === null ? '-' : <Waiting since={row.submittedAt} zone={zone} />,
          };
      }
    },
    [t, onOpen, zone],
  );
  const config: PagedListConfig<FirstRow> = useMemo(
    () => ({
      ns: 'offer-review.first',
      endpoint: API_QUEUE,
      rowId: (row) => row.offerId,
      rowName: (row) => firstName(row),
      tabs: ['first'],
      search: SEARCH,
      tabParams: () => ({ kind: 'offer-first-publication' }),
      exportEndpoint: `${API_QUEUE}/export`,
      exportName: 'offers-first-publication',
      sorts: SORTS(t),
      defaultSort: 'submitted',
      fixedColumns: ['offer'],
      optionalColumns: ['seller', 'reasons', 'tags', 'handling', 'waiting'],
      defaultColumns: ['seller', 'reasons', 'waiting'],
      columnDefs,
      rowActions,
      ...(canDecide
        ? {
            bulk: (['approve', 'request-changes'] as const).map((action) => ({
              id: action,
              label: tq(`${action}.menu`),
              run: (rows: readonly FirstRow[]) => {
                const base = {
                  kind: 'offer' as const,
                  action,
                  rows: rows.map((row) => ({ id: row.offerId, version: row.version })),
                };
                if (action !== 'approve') return setBulk(base);
                const check = bulkApprovalCheck(rows);
                if (!check.ok) {
                  return setBulk({
                    ...base,
                    blocked: {
                      why: check.why,
                      rows: check.rows.map((row) => firstName(row)),
                    },
                  });
                }
                const named = rows.find((row) => row.sellerId === check.sellerId);
                return setBulk({
                  ...base,
                  ...(check.certificate === null
                    ? {}
                    : {
                        certificate: {
                          seller: named?.storeName ?? t('seller-unnamed'),
                          type: typeLabel(check.certificate),
                        },
                      }),
                });
              },
            })),
          }
        : {}),
      icon: 'package' as const,
      // The Offers list and the Product review queue share one registry list, told apart by kind.
      savedKey: 'admin.catalog.review-queue',
      savedFits: (filters: Readonly<Record<string, string>>) =>
        filters['kind'] === 'offer-first-publication',
    }),
    [t, tq, tr, columnDefs, rowActions, canDecide],
  );
  const submitted = useDateFilter({
    id: 'submitted',
    label: t('filter.name.submitted'),
    range: { from: 'submittedFrom', to: 'submittedTo' },
    zone,
  });
  const sellers = useSellerOptions(t('seller-unnamed'));
  const categories = useCategoryOptions();
  const dateOf = submitted.dateRange;
  const firstRange = useCallback((preset: string) => ageRange(preset) ?? dateOf(preset), [dateOf]);
  // One field holds both ways to say when: a date preset, or "waiting longer than N" (the same two
  // query keys, so the two can never disagree).
  const fields = useMemo(
    () => [
      {
        ...submitted.field,
        options: [
          ...submitted.field.options,
          ...AGE_PRESETS.map((value) => ({ value, label: t(`filter.age.${value}`) })),
        ],
      },
      ...sharedFields(
        (key) => t(`filter.name.${key}`),
        REVIEW_REASONS.map((code) => ({ value: code, label: tr(code) })),
        sellers.options,
        categories,
      ),
    ],
    [submitted.field, t, tr, sellers.options, categories],
  );
  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      dateRange={firstRange}
      csrfToken={csrfToken}
      refreshKey={refresh + refreshKey}
      onAnswer={(answer: PagedAnswer<FirstRow>) => {
        onRows(answer.items);
        sellers.take(answer);
        const totals = (answer as unknown as { totals?: Record<string, number> }).totals;
        const count = totals?.['offer-first-publication'];
        if (typeof count === 'number') onCount(count);
      }}
      dialogs={
        <ReviewBulkDialog
          bulk={bulk}
          csrfToken={csrfToken}
          onClose={() => setBulk(null)}
          onFinished={() => setRefresh((value) => value + 1)}
        />
      }
    />
  );
}

/**
 * Held edits of live Offers: a super list over `catalog/admin/offer-changes` with the reason, age,
 * store and category filters and the search of the route, and saved filters (registry list
 * `admin.catalog.offer-changes`). No bulk decision (Hadi's decision 3): each edit is opened and
 * decided with its Live | Proposed diff.
 */
export function EditsList({
  paging,
  accountId,
  marketId,
  csrfToken,
  zone,
  refreshKey,
  onRows,
  onCount,
  onOpen,
}: ListProps<ChangeRow>) {
  const t = useTranslations('offer-review.edits');
  const tr = useTranslations('offer-review.reason');

  const rowActions = useCallback(
    (row: ChangeRow): readonly MenuItem[] => [
      { id: 'open', label: t('actions.open'), onSelect: () => onOpen(row) },
      {
        id: 'page',
        label: t('actions.open-page'),
        onSelect: () => window.location.assign(`/offer-reviews/${row.changeId}`),
      },
    ],
    [t, onOpen],
  );
  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<ChangeRow> => {
      switch (id) {
        case 'offer':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <OpenName
                name={changeName(row)}
                detail={`${row.offer?.sellerSku ?? ''}${row.offer === null ? '' : ' · '}${row.offer?.conditionCode ?? ''}`}
                label={t('open-named', { name: changeName(row) })}
                onOpen={() => onOpen(row)}
              />
            ),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) => (
              <span className="wrap-anywhere">{row.storeName ?? t('seller-unnamed')}</span>
            ),
          };
        case 'reasons':
          return { id, header, corner: true, cell: (row) => <ReasonChips reasons={row.reasons} /> };
        case 'fields':
          return {
            id,
            header,
            cell: (row) => row.fields.map((field) => t(`field.${field}`)).join(', '),
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <Waiting since={row.submittedAt} zone={zone} />,
          };
      }
    },
    [t, onOpen, zone],
  );
  const config: PagedListConfig<ChangeRow> = useMemo(
    () => ({
      ns: 'offer-review.edits',
      endpoint: API_CHANGES,
      rowId: (row) => row.changeId,
      rowName: (row) => changeName(row),
      tabs: ['edits'],
      search: SEARCH,
      exportEndpoint: `${API_CHANGES}/export`,
      exportName: 'offer-edits',
      sorts: SORTS(t),
      defaultSort: 'submitted',
      fixedColumns: ['offer'],
      optionalColumns: ['seller', 'reasons', 'fields', 'waiting'],
      defaultColumns: ['seller', 'reasons', 'fields', 'waiting'],
      columnDefs,
      rowActions,
      icon: 'package',
      savedKey: 'admin.catalog.offer-changes',
    }),
    [t, columnDefs, rowActions],
  );
  const sellers = useSellerOptions(t('seller-unnamed'));
  const categories = useCategoryOptions();
  const fields: readonly PagedFilterField[] = useMemo(
    () =>
      sharedFields(
        (key) => t(`filter.name.${key}`),
        REVIEW_REASONS.map((code) => ({ value: code, label: tr(code) })),
        sellers.options,
        categories,
        [
          {
            id: 'age',
            label: t('filter.name.age'),
            range: { from: 'submittedFrom', to: 'submittedTo' },
            options: AGE_PRESETS.map((value) => ({ value, label: t(`filter.age.${value}`) })),
          },
        ],
      ),
    [t, tr, sellers.options, categories],
  );
  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      dateRange={ageRange}
      csrfToken={csrfToken}
      refreshKey={refreshKey}
      onAnswer={(answer: PagedAnswer<ChangeRow>) => {
        onRows(answer.items);
        sellers.take(answer);
        const pending = (answer as unknown as { totalPending?: number }).totalPending;
        if (typeof pending === 'number') onCount(pending);
      }}
    />
  );
}
