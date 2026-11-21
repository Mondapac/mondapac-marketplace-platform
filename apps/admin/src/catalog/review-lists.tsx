'use client';

import { Badge, toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import { useDateFilter } from '../shared/paged-list/use-date-filter.ts';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import { shortInstant } from '../shared/format.ts';
import { ReviewBulkDialog, type ReviewBulk } from './review-bulk.tsx';
import { OfferDecisionDialog, type OfferDecision } from './offer-decision-dialog.tsx';
import { revisionHref } from './review-queue-params.ts';
import { REVISION_REASONS, type QueuePage, type ReviewRow, type RevisionRow } from './types.ts';

const API_QUEUE = 'catalog/admin/review-queue';
const KNOWN_REASONS: ReadonlySet<string> = new Set(REVISION_REASONS);

type Actions = { readonly actions: readonly string[] };
export type RevisionListRow = RevisionRow & Actions;
export type OfferListRow = ReviewRow & Actions;
type Totals = QueuePage<unknown>['totals'];

const SORTS = (t: (key: string) => string) =>
  [
    {
      id: 'submitted',
      orders: [t('sort.waiting.first'), t('sort.waiting.second')] as [string, string],
      defaultDirection: 'asc' as const,
    },
  ] as const;

/**
 * The pending product revisions as a super list (super list phase 2, list 14): oldest submitted
 * first, filtered by change (new or update) and photos, with page numbers or Previous and next.
 * The decision itself needs the named checks, so a row's Actions menu opens its version review.
 */
export function RevisionsList({
  paging,
  accountId,
  marketId,
  zone,
  csrfToken,
  onTotals,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Submitted presets (ADR-0005). */
  readonly zone: string;
  readonly csrfToken: string;
  readonly onTotals: (totals: Totals) => void;
}) {
  const t = useTranslations('catalog.queue');
  const tl = useTranslations('catalog.queue.list');
  const tb = useTranslations('catalog.queue.bulk');
  const locale = useLocale();
  const [bulk, setBulk] = useState<ReviewBulk | null>(null);
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: RevisionListRow): readonly MenuItem[] => [
      {
        id: 'open',
        label: tl('actions.open'),
        onSelect: () => window.location.assign(revisionHref(row)),
      },
    ],
    [tl],
  );
  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<RevisionListRow> => {
      switch (id) {
        case 'product':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <div className="min-w-0">
                <div className="font-medium wrap-anywhere text-fg">
                  {row.product.name ?? row.product.productCode ?? t('unnamed-product')}
                </div>
                <div className="text-sm text-fg-muted">
                  {t('revision-no', { number: row.revisionNo })}
                  {row.product.productCode === null ? null : ` · ${row.product.productCode}`}
                </div>
              </div>
            ),
          };
        case 'change':
          return {
            id,
            header,
            corner: true,
            cell: (row) => (
              <Badge tone={row.firstPublication ? 'info' : 'neutral'}>
                {t(row.firstPublication ? 'change.new' : 'change.update')}
              </Badge>
            ),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) => (
              <span className="wrap-anywhere">{row.storeName ?? t('filter.seller-unnamed')}</span>
            ),
          };
        case 'reasons':
          return {
            id,
            header,
            cell: (row) => (
              <ul className="flex flex-wrap gap-1">
                {row.reasons.map((reason) => (
                  <li key={reason}>
                    <Badge tone="neutral">
                      {KNOWN_REASONS.has(reason) ? t(`reason.${reason}`) : reason}
                    </Badge>
                  </li>
                ))}
              </ul>
            ),
          };
        case 'checks':
          return {
            id,
            header,
            numeric: true,
            cell: (row) => t('checks', { count: row.requiredChecks.length }),
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => shortInstant(row.submittedAt, locale),
          };
      }
    },
    [t, locale],
  );
  const config: PagedListConfig<RevisionListRow> = useMemo(
    () => ({
      ns: 'catalog.queue.list',
      endpoint: API_QUEUE,
      rowId: (row) => row.revisionId,
      rowName: (row) => row.product.name ?? row.product.productCode ?? t('unnamed-product'),
      tabs: ['revision'],
      tabParams: () => ({ kind: 'product-revision' }),
      exportEndpoint: `${API_QUEUE}/export`,
      exportName: 'product-revisions',
      sorts: SORTS(tl),
      defaultSort: 'submitted',
      fixedColumns: ['product'],
      optionalColumns: ['change', 'seller', 'reasons', 'checks', 'waiting'],
      defaultColumns: ['change', 'seller', 'reasons', 'checks', 'waiting'],
      columnDefs,
      rowActions,
      bulk: (['approve', 'request-changes'] as const).map((action) => ({
        id: action,
        label: tb(`${action}.menu`),
        run: (rows: readonly RevisionListRow[]) =>
          setBulk({
            kind: 'revision',
            action,
            rows: rows.map((row) => ({
              id: row.productId,
              revisionId: row.revisionId,
              version: row.version,
            })),
          }),
      })),
      icon: 'package',
      // The Product review queue and the Revision queue are one registry list, told apart by kind.
      savedKey: 'admin.catalog.review-queue',
      savedFits: (filters) => filters['kind'] === 'product-revision',
    }),
    [t, tl, tb, columnDefs, rowActions],
  );
  const submitted = useDateFilter({
    id: 'submitted',
    label: tl('filter.name.submitted'),
    range: { from: 'submittedFrom', to: 'submittedTo' },
    zone,
  });
  const fields: readonly PagedFilterField[] = useMemo(
    () => [
      {
        id: 'firstPublication',
        label: t('filter.change'),
        options: [
          { value: 'true', label: t('filter.change-new') },
          { value: 'false', label: t('filter.change-update') },
        ],
      },
      {
        id: 'hasImages',
        label: t('filter.photos'),
        options: [{ value: 'true', label: t('filter.photos-with') }],
      },
      submitted.field,
    ],
    [t, submitted.field],
  );
  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      dateRange={submitted.dateRange}
      csrfToken={csrfToken}
      refreshKey={refresh}
      onAnswer={(answer: PagedAnswer<RevisionListRow>) =>
        onTotals((answer as unknown as QueuePage<unknown>).totals)
      }
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
 * The Offers waiting for their first publication as a super list (list 13): oldest submitted
 * first. Approve… and Send back… are in the row's Actions menu (only for a holder of the approve
 * key, as the API names them for the row) and open a confirmation dialog that shows what the
 * seller wrote.
 */
export function OffersList({
  paging,
  accountId,
  marketId,
  zone,
  csrfToken,
  onTotals,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Submitted presets (ADR-0005). */
  readonly zone: string;
  readonly csrfToken: string;
  readonly onTotals: (totals: Totals) => void;
}) {
  const t = useTranslations('catalog.review');
  const tr = useTranslations();
  const tl = useTranslations('catalog.queue.offers');
  const tb = useTranslations('catalog.queue.bulk');
  const locale = useLocale();
  const [bulk, setBulk] = useState<ReviewBulk | null>(null);
  const [open, setOpen] = useState<{ row: OfferListRow; decision: OfferDecision } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const nameOf = useCallback(
    (row: ReviewRow) => row.product.name ?? row.product.productCode ?? row.sellerSku,
    [],
  );

  const rowActions = useCallback(
    (row: OfferListRow): readonly MenuItem[] =>
      (['approve', 'request-changes'] as const)
        .filter((id) => row.actions.includes(id))
        .map((id) => ({
          id,
          label: tl(`actions.${id}`),
          onSelect: () => setOpen({ row, decision: id }),
        })),
    [tl],
  );
  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<OfferListRow> => {
      switch (id) {
        case 'offer':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <div className="min-w-0">
                <div className="font-medium wrap-anywhere text-fg">{nameOf(row)}</div>
                <div className="text-sm text-fg-muted">{row.sellerSku}</div>
              </div>
            ),
          };
        case 'condition':
          return { id, header, cell: (row) => row.conditionCode };
        case 'handling':
          return {
            id,
            header,
            cell: (row) => row.handling ?? t('field.handling-missing'),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) => <span className="font-mono text-xs break-all">{row.sellerId}</span>,
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => shortInstant(row.submittedAt, locale),
          };
      }
    },
    [t, nameOf, locale],
  );
  const config: PagedListConfig<OfferListRow> = useMemo(
    () => ({
      ns: 'catalog.queue.offers',
      endpoint: API_QUEUE,
      rowId: (row) => row.offerId,
      rowName: (row) => nameOf(row),
      tabs: ['offer'],
      tabParams: () => ({ kind: 'offer-first-publication' }),
      exportEndpoint: `${API_QUEUE}/export`,
      exportName: 'offers-for-review',
      sorts: SORTS(tl),
      defaultSort: 'submitted',
      fixedColumns: ['offer'],
      optionalColumns: ['condition', 'handling', 'seller', 'waiting'],
      defaultColumns: ['condition', 'handling', 'seller', 'waiting'],
      columnDefs,
      rowActions,
      bulk: (['approve', 'request-changes'] as const).map((action) => ({
        id: action,
        label: tb(`${action}.menu`),
        run: (rows: readonly OfferListRow[]) =>
          setBulk({
            kind: 'offer',
            action,
            rows: rows.map((row) => ({ id: row.offerId, version: row.version })),
          }),
      })),
      icon: 'package',
      savedKey: 'admin.catalog.review-queue',
      savedFits: (filters) => filters['kind'] === 'offer-first-publication',
    }),
    [tl, tb, columnDefs, rowActions, nameOf],
  );
  const submitted = useDateFilter({
    id: 'submitted',
    label: tl('filter.name.submitted'),
    range: { from: 'submittedFrom', to: 'submittedTo' },
    zone,
  });
  const fields = useMemo(() => [submitted.field], [submitted.field]);
  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      dateRange={submitted.dateRange}
      csrfToken={csrfToken}
      refreshKey={refresh}
      onAnswer={(answer: PagedAnswer<OfferListRow>) =>
        onTotals((answer as unknown as QueuePage<unknown>).totals)
      }
      dialogs={
        <>
          <ReviewBulkDialog
            bulk={bulk}
            csrfToken={csrfToken}
            onClose={() => setBulk(null)}
            onFinished={() => setRefresh((value) => value + 1)}
          />
          <OfferDecisionDialog
            row={open?.row ?? null}
            decision={open?.decision ?? null}
            csrfToken={csrfToken}
            onClose={() => setOpen(null)}
            onSettled={(why) => {
              setOpen(null);
              if (why !== undefined) toast.error(tr(why));
              setRefresh((value) => value + 1);
            }}
          />
        </>
      }
    />
  );
}
