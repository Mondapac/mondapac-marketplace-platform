'use client';

import { Badge, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type { ListPagingMode, PagedListConfig } from '../shared/paged-list/types.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { formatMoney, percentChange } from './format.ts';
import { HoldDecisionDialog, type HoldDecision } from './hold-decision-dialog.tsx';
import {
  API_HOLDS,
  API_HOLDS_EXPORT,
  HOLD_VIEWS,
  HOLDS_SAVED_KEY,
  type HoldCounts,
  type PriceHoldListRow,
} from './types.ts';

const COLUMNS = {
  fixed: ['product'],
  optional: ['seller', 'price', 'reference', 'change', 'kind', 'submitted'],
} as const;

/**
 * The held prices as a super list (super list phase 3, list 19): oldest submission first, with
 * views for the stream and the direction, filters, sort, columns, export and the row Actions menu.
 * Approve… and Reject… are in the menu (the server names what this admin may do on each row) and
 * open a confirmation dialog; nothing in a row is a button. Product and store names are
 * seller-entered text, rendered as plain text.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function HoldsList({
  paging,
  accountId,
  marketId,
  csrfToken,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('pricing.holds.list');
  const locale = useLocale();
  const [open, setOpen] = useState<{ row: PriceHoldListRow; decision: HoldDecision } | null>(null);
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: PriceHoldListRow): readonly MenuItem[] => [
      ...(row.actions.includes('open')
        ? [
            {
              id: 'open',
              label: t('actions.open'),
              onSelect: () =>
                window.location.assign(`/sellers/${encodeURIComponent(row.sellerId)}`),
            } satisfies MenuItem,
          ]
        : []),
      ...(row.actions.includes('decide')
        ? (['approve', 'reject'] as const).map((decision) => ({
            id: decision,
            label: t(`actions.${decision}`),
            onSelect: () => setOpen({ row, decision }),
          }))
        : []),
    ],
    [t],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<PriceHoldListRow> => {
      switch (id) {
        case 'product':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <>
                <span className="font-medium wrap-anywhere" title={row.offerId}>
                  {row.productName ?? t('name-unavailable', { id: shortId(row.offerId) })}
                </span>
                {row.variantLabel === null ? null : (
                  <span className="block text-sm wrap-anywhere text-fg-muted" title={row.variantId}>
                    {row.variantLabel}
                  </span>
                )}
              </>
            ),
          };
        case 'price':
          return {
            id,
            header,
            numeric: true,
            cell: (row) => <span className="tabular-nums">{formatMoney(row.amount, locale)}</span>,
          };
        case 'reference':
          return {
            id,
            header,
            numeric: true,
            cell: (row) => (
              <span className="tabular-nums">{formatMoney(row.anchorAmount, locale)}</span>
            ),
          };
        case 'change':
          return {
            id,
            header,
            cell: (row) => {
              const change = percentChange(row.amount.amount, row.anchorAmount.amount, locale);
              return (
                <>
                  <Badge tone={row.direction === 'up' ? 'attention' : 'neutral'}>
                    {t(`direction.${row.direction}`)}
                  </Badge>
                  {change === null ? null : (
                    <span className="ms-2 text-xs tabular-nums text-fg-muted">{change}</span>
                  )}
                </>
              );
            },
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) => (
              <span className="wrap-anywhere" title={row.sellerId}>
                {row.storeName ?? t('seller-fallback', { id: shortId(row.sellerId) })}
              </span>
            ),
          };
        case 'kind':
          return { id, header, cell: (row) => t(`kind.${row.kind}`) };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <When iso={row.submittedAt} missing="—" />,
          };
      }
    },
    [t, locale],
  );

  const config: PagedListConfig<PriceHoldListRow> = useMemo(
    () => ({
      ns: 'pricing.holds.list',
      endpoint: API_HOLDS,
      exportEndpoint: API_HOLDS_EXPORT,
      exportName: 'price-holds',
      rowId: (row) => row.recordId,
      rowName: (row) => row.productName ?? shortId(row.offerId),
      tabs: [...HOLD_VIEWS],
      tabParam: 'view',
      // Saved personal and shared filters (`lists`, backend #1185): the payload keeps the tab as
      // its `view`, and kind, change and the other query keys as its filters.
      savedKey: HOLDS_SAVED_KEY,
      savedViews: true,
      // The route matches one record id or Offer id, exactly (a UUID).
      search: { max: 36, accepts: (text) => UUID.test(text) },
      sorts: [
        {
          id: 'submitted',
          orders: [t('sort.date.first'), t('sort.date.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'amount',
          orders: [t('sort.amount.first'), t('sort.amount.second')],
          defaultDirection: 'desc',
        },
      ],
      defaultSort: 'submitted',
      fixedColumns: COLUMNS.fixed,
      optionalColumns: COLUMNS.optional,
      defaultColumns: COLUMNS.optional,
      columnDefs,
      rowActions,
      icon: 'columns',
    }),
    [t, columnDefs, rowActions],
  );

  const fields = useMemo(
    () => [
      {
        id: 'kind',
        label: t('filter.kind'),
        options: (['regular', 'special'] as const).map((value) => ({
          value,
          label: t(`kind.${value}`),
        })),
      },
      {
        id: 'change',
        label: t('filter.change'),
        options: (['up', 'down'] as const).map((value) => ({
          value,
          label: t(`direction.${value}`),
        })),
      },
    ],
    [t],
  );

  const loadCounts = useCallback(async (filters: Readonly<Record<string, string>>) => {
    const params = new URLSearchParams({ ...filters, page: '1', pageSize: '1', paging: 'pages' });
    const result = await callApi<{ readonly counts: HoldCounts }>(
      'GET',
      `${API_HOLDS}?${params.toString()}`,
    );
    return result.ok ? result.body.counts : null;
  }, []);

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      loadCounts={loadCounts}
      refreshKey={refresh}
      csrfToken={csrfToken}
      dialogs={
        <HoldDecisionDialog
          row={open?.row ?? null}
          decision={open?.decision ?? null}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onSettled={() => {
            setOpen(null);
            setRefresh((value) => value + 1);
          }}
        />
      }
    />
  );
}
