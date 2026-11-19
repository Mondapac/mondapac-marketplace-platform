'use client';

import { toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type { ListPagingMode, PagedListConfig } from '../shared/paged-list/types.ts';
import { When } from '../shared/when.tsx';
import { RequestDecisionDialog, type Decision } from './request-decision-dialog.tsx';
import { API_REQUESTS, describeOptions, type RequestItem } from './types.ts';

const ACTIONS: readonly Decision[] = ['approve', 'map', 'decline'];

/**
 * The Waiting for you tab as a super list (super list phase 2, list 4): sizes that sellers asked
 * for on a platform product, oldest first, searched by product code. Approve, Map to existing and
 * Decline are in the row's Actions menu (the server names what this admin may do on each row) and
 * open a confirmation dialog; the request holds option codes only, named from the Market's
 * catalogue, never a seller's words.
 */
export function RequestsList({
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
  const t = useTranslations('variants.requests');
  const [open, setOpen] = useState<{ item: RequestItem; decision: Decision } | null>(null);
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: RequestItem): readonly MenuItem[] =>
      ACTIONS.filter((id) => row.actions.includes(id)).map((id) => ({
        id,
        label: t(`actions.${id}`),
        // A request whose product already has the size is mapped, not approved; a product with no
        // variants has nothing to map to.
        disabled:
          (id === 'approve' && row.alreadyExists) || (id === 'map' && row.existing.length === 0),
        onSelect: () => setOpen({ item: row, decision: id }),
      })),
    [t],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<RequestItem> => {
      switch (id) {
        case 'request':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <>
                <span className="font-medium wrap-anywhere">{describeOptions(row.options)}</span>
                {row.alreadyExists ? (
                  <span className="block text-sm text-fg-muted">{t('already-exists-short')}</span>
                ) : null}
              </>
            ),
          };
        case 'product':
          return {
            id,
            header,
            cell: (row) =>
              row.productCode === null ? (
                <span className="text-fg-muted">{t('no-product-code')}</span>
              ) : (
                <a
                  className="font-mono text-link underline"
                  href={`/catalog/products/${encodeURIComponent(row.productId)}`}
                >
                  {row.productCode}
                </a>
              ),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) =>
              row.sellerName ?? <span className="text-fg-muted">{t('unnamed-seller')}</span>,
          };
        case 'requested':
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <When iso={row.createdAt} missing="" />,
          };
        default:
          return {
            id,
            header,
            cell: (row) =>
              row.existing.length === 0 ? (
                <span className="text-fg-muted">—</span>
              ) : (
                <span className="wrap-anywhere">
                  {row.existing.map((variant) => describeOptions(variant.options)).join('; ')}
                </span>
              ),
          };
      }
    },
    [t],
  );

  const config: PagedListConfig<RequestItem> = useMemo(
    () => ({
      ns: 'variants.requests.list',
      endpoint: API_REQUESTS,
      rowId: (row) => row.id,
      rowName: (row) => describeOptions(row.options),
      tabs: ['open'],
      search: { max: 100 },
      sorts: [
        {
          id: 'created',
          orders: [t('list.sort.created.first'), t('list.sort.created.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'created',
      fixedColumns: ['request'],
      optionalColumns: ['product', 'seller', 'requested', 'existing'],
      defaultColumns: ['product', 'seller', 'requested', 'existing'],
      columnDefs,
      rowActions,
      icon: 'columns',
    }),
    [t, columnDefs, rowActions],
  );

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      refreshKey={refresh}
      dialogs={
        <RequestDecisionDialog
          item={open?.item ?? null}
          decision={open?.decision ?? null}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onSettled={(why) => {
            setOpen(null);
            if (why !== undefined) toast.error(t(`error.${why}`));
            setRefresh((value) => value + 1);
          }}
        />
      }
    />
  );
}
