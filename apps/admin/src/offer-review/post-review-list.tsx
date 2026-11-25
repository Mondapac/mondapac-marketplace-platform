'use client';

import { Badge, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { shortInstantInZone } from '../shared/format.ts';
import type { BulkRow } from '../shared/paged-list/bulk-decide-dialog.tsx';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import { useCategoryOptions, useSellerOptions } from './filter-options.ts';
import { AGE_PRESETS, OpenName, SEARCH, Waiting, ageRange, sharedFields } from './lists.tsx';
import { PostReviewBulkDialog } from './post-review-bulk.tsx';
import { PostReviewChips } from './post-review-chips.tsx';
import {
  API_POST_REVIEWS,
  POST_REVIEW_REASONS,
  POST_REVIEW_VIEWS,
  postReviewName,
  type PostReviewRow,
  type PostReviewStatus,
} from './post-review-types.ts';

const STATUS_TONE: Readonly<Record<PostReviewStatus, 'attention' | 'success' | 'critical'>> = {
  open: 'attention',
  approved: 'success',
  'taken-down': 'critical',
};

/**
 * Published Offers an admin checks after they went live (risk-based Offer approval slice 6): a
 * super list over `catalog/admin/offer-post-reviews` with the views Open, Approved, Taken down and
 * All, search, the reason, store, category and age filters, the opened and decided sorts, saved
 * filters (registry list `admin.catalog.offer-post-reviews`), bulk Approve and the export. Selling
 * goes on while a row is open. The list carries no price, median or note.
 */
export function AfterPublicationList({
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
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly zone: string;
  /** The admin holds `catalog.product.approve` (bulk Approve). */
  readonly canDecide: boolean;
  readonly refreshKey: number;
  readonly onRows: (rows: readonly PostReviewRow[]) => void;
  /** The tab count: every open row, whatever the filters (`totalOpen`). */
  readonly onCount: (count: number) => void;
  readonly onOpen: (row: PostReviewRow) => void;
}) {
  const t = useTranslations('offer-review.post');
  const tr = useTranslations('offer-review.post.reason');
  const locale = useLocale();
  const [bulk, setBulk] = useState<readonly BulkRow[] | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: PostReviewRow): readonly MenuItem[] => [
      { id: 'open', label: t('actions.open'), onSelect: () => onOpen(row) },
      {
        id: 'seller',
        label: t('actions.seller'),
        onSelect: () => window.location.assign(`/sellers/${encodeURIComponent(row.sellerId)}`),
      },
    ],
    [t, onOpen],
  );
  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<PostReviewRow> => {
      switch (id) {
        case 'offer':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <OpenName
                name={postReviewName(row)}
                detail={row.offer.sellerSku}
                label={t('open-named', { name: postReviewName(row) })}
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
          return { id, header, corner: true, cell: (row) => <PostReviewChips row={row} /> };
        case 'status':
          return {
            id,
            header,
            cell: (row) => (
              <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                {t.has(`status.${row.status}`) ? t(`status.${row.status}`) : row.status}
              </Badge>
            ),
          };
        case 'decided':
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) =>
              row.decidedAt === null ? (
                '-'
              ) : (
                <span>
                  {shortInstantInZone(row.decidedAt, locale, zone, true)}
                  {row.decision?.misconduct ? (
                    <span className="block text-sm text-fg-muted">{t('misconduct-short')}</span>
                  ) : null}
                </span>
              ),
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <Waiting since={row.openedAt} zone={zone} />,
          };
      }
    },
    [t, onOpen, zone, locale],
  );
  const config: PagedListConfig<PostReviewRow> = useMemo(
    () => ({
      ns: 'offer-review.post',
      endpoint: API_POST_REVIEWS,
      rowId: (row) => row.id,
      rowName: (row) => postReviewName(row),
      tabs: POST_REVIEW_VIEWS,
      tabParams: (tab: string) => ({ status: tab }),
      search: SEARCH,
      exportEndpoint: `${API_POST_REVIEWS}/export`,
      exportName: 'offers-after-publication',
      sorts: [
        {
          id: 'opened',
          orders: [t('sort.opened.first'), t('sort.opened.second')] as [string, string],
          defaultDirection: 'asc' as const,
        },
        {
          id: 'decided',
          orders: [t('sort.decided.first'), t('sort.decided.second')] as [string, string],
          defaultDirection: 'desc' as const,
        },
      ],
      defaultSort: 'opened',
      fixedColumns: ['offer'],
      optionalColumns: ['seller', 'reasons', 'status', 'opened', 'decided'],
      defaultColumns: ['seller', 'reasons', 'status', 'opened', 'decided'],
      columnDefs,
      rowActions,
      ...(canDecide
        ? {
            bulk: [
              {
                id: 'approve',
                label: t('bulk.approve-menu'),
                run: (rows: readonly PostReviewRow[]) => {
                  setNames(new Map(rows.map((row) => [row.id, postReviewName(row)])));
                  setBulk(rows.map((row) => ({ id: row.id, version: row.version })));
                },
              },
            ],
          }
        : {}),
      icon: 'package' as const,
      savedKey: 'admin.catalog.offer-post-reviews',
    }),
    [t, columnDefs, rowActions, canDecide],
  );
  const sellers = useSellerOptions(t('seller-unnamed'));
  const categories = useCategoryOptions();
  const fields: readonly PagedFilterField[] = useMemo(
    () =>
      sharedFields(
        (key) => t(`filter.name.${key}`),
        POST_REVIEW_REASONS.map((code) => ({ value: code, label: tr(code) })),
        sellers.options,
        categories,
        [
          {
            id: 'age',
            label: t('filter.name.age'),
            range: { from: 'openedFrom', to: 'openedTo' },
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
      refreshKey={refresh + refreshKey}
      onAnswer={(answer: PagedAnswer<PostReviewRow>) => {
        onRows(answer.items);
        sellers.take(answer);
        const open = (answer as unknown as { totalOpen?: number }).totalOpen;
        if (typeof open === 'number') onCount(open);
      }}
      dialogs={
        <PostReviewBulkDialog
          rows={bulk}
          names={names}
          csrfToken={csrfToken}
          onClose={() => setBulk(null)}
          onFinished={() => setRefresh((value) => value + 1)}
        />
      }
    />
  );
}
