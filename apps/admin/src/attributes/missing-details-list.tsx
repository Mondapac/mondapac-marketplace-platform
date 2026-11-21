'use client';

import { Badge, Banner, toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { formatInstant } from '../shared/format.ts';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type { ListPagingMode, PagedAnswer, PagedListConfig } from '../shared/paged-list/types.ts';
import { EmailSellersDialog, emailable } from './email-sellers-dialog.tsx';
import { API_MISSING_DETAILS, type MissingDetailsItem } from './types.ts';

/** A row with what the API names the caller may do on it: `open-product`, `email-seller`. */
export type MissingDetailsRow = MissingDetailsItem & { readonly actions: readonly string[] };

/** What the answer carries beside the rows. */
interface Extras {
  readonly complete: boolean;
  readonly unreadableFeatureSets: readonly string[];
}

/** One CSV cell: quoted, and a leading formula character is neutralised. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** The rows as CSV text (product code, name, seller, feature set, missing codes). */
export function csvOf(rows: readonly MissingDetailsItem[]): string {
  const head = ['Product code', 'Name', 'Seller id', 'Feature set', 'Missing'];
  const lines = rows.map((row) =>
    [row.productCode, row.name ?? '', row.sellerId ?? '', row.featureSetCode, row.missing.join(' ')]
      .map(csvCell)
      .join(','),
  );
  return [head.map(csvCell).join(','), ...lines].join('\r\n');
}

function downloadCsv(rows: readonly MissingDetailsItem[]) {
  const blob = new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'products-missing-details.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Products missing required details as a super list (super list phase 2, list 6; attributes A4).
 * Published products whose values leave a required attribute empty stay on sale; the seller is
 * refused at the next submit. Email sellers… is a bulk action (the ticked rows of the page) and a
 * row action; both open the preview-then-send dialog. The API judges the gaps in memory, so a page
 * read covers at most the first 10,000 products: then the answer says `complete: false` and a
 * banner says the total and the order cover that part only.
 */
export function MissingDetailsList({
  paging,
  accountId,
  marketId,
  canEdit,
  csrfToken,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** `catalog.attribute.edit`: shows Email sellers…. */
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('attributes.missing-details');
  const tl = useTranslations('attributes.missing-details.list');
  const locale = useLocale();
  const [extras, setExtras] = useState<Extras>({ complete: true, unreadableFeatureSets: [] });
  const [emailing, setEmailing] = useState<readonly MissingDetailsRow[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: MissingDetailsRow): readonly MenuItem[] => {
      const items: MenuItem[] = [];
      if (row.actions.includes('open-product')) {
        items.push({
          id: 'open-product',
          label: tl('actions.open-product'),
          onSelect: () =>
            window.location.assign(`/catalog/products/${encodeURIComponent(row.productId)}`),
        });
      }
      if (canEdit && row.actions.includes('email-seller')) {
        items.push({
          id: 'email-seller',
          label: tl('actions.email-seller'),
          onSelect: () => setEmailing([row]),
        });
      }
      return items;
    },
    [tl, canEdit],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<MissingDetailsRow> => {
      switch (id) {
        case 'product':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <span className="wrap-anywhere">
                <span className="font-medium text-fg">{row.name ?? t('unnamed')}</span>
                <span className="ms-2 font-mono text-sm text-fg-muted">{row.productCode}</span>
              </span>
            ),
          };
        case 'seller':
          return {
            id,
            header,
            cell: (row) =>
              row.sellerId === null ? (
                <span className="text-fg-muted">{t('platform-product')}</span>
              ) : (
                <a className="text-link underline" href={`/sellers/${row.sellerId}`}>
                  {row.sellerId.slice(0, 8)}
                </a>
              ),
          };
        case 'family':
          return { id, header, cell: (row) => <span>{row.featureSetCode}</span> };
        case 'missing':
          return {
            id,
            header,
            cell: (row) => (
              <ul role="list" aria-label={t('missing')} className="flex flex-wrap gap-1.5">
                {row.missing.map((code) => (
                  <li key={code}>
                    <Badge tone="attention">{code}</Badge>
                  </li>
                ))}
              </ul>
            ),
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => (
              <span className="text-fg-muted">
                {row.lastEmailedAt === null
                  ? t('never-emailed')
                  : formatInstant(row.lastEmailedAt, locale)}
              </span>
            ),
          };
      }
    },
    [t, locale],
  );

  const config: PagedListConfig<MissingDetailsRow> = useMemo(
    () => ({
      ns: 'attributes.missing-details.list',
      endpoint: API_MISSING_DETAILS,
      exportEndpoint: `${API_MISSING_DETAILS}/export`,
      exportName: 'products-missing-details',
      exportKeepsSort: true,
      rowId: (row) => row.productId,
      rowName: (row) => row.name ?? row.productCode,
      tabs: ['all'],
      search: { max: 80 },
      sorts: [
        {
          id: 'missing',
          orders: [tl('sort.count.first'), tl('sort.count.second')],
          defaultDirection: 'desc',
        },
        {
          id: 'code',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'name',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'family',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'missing',
      fixedColumns: ['product'],
      optionalColumns: ['seller', 'family', 'missing', 'emailed'],
      defaultColumns: ['seller', 'family', 'missing', 'emailed'],
      columnDefs,
      rowActions,
      bulk: [
        ...(canEdit
          ? [
              {
                id: 'email',
                label: tl('bulk.email'),
                run: (rows: readonly MissingDetailsRow[]) => {
                  if (emailable(rows).length === 0) toast.info(tl('bulk.email-none'));
                  else setEmailing(rows);
                },
              },
            ]
          : []),
        {
          id: 'export-selected',
          label: tl('bulk.export-selected'),
          run: (rows: readonly MissingDetailsRow[]) => downloadCsv(rows),
        },
      ],
      icon: 'package',
    }),
    [tl, columnDefs, rowActions, canEdit],
  );

  return (
    <section aria-label={t('label')} className="flex flex-col gap-4">
      <Banner tone="info" title={t('info.title')}>
        {t('info.body')}
      </Banner>
      {extras.unreadableFeatureSets.length > 0 ? (
        <Banner tone="attention" title={t('unreadable.title')}>
          {t('unreadable.body', { codes: extras.unreadableFeatureSets.join(', ') })}
        </Banner>
      ) : null}
      {extras.complete ? null : (
        <Banner tone="attention" title={tl('partial.title')}>
          {tl('partial.body')}
        </Banner>
      )}
      <PagedSuperList
        config={config}
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        refreshKey={refresh}
        onAnswer={(answer: PagedAnswer<MissingDetailsRow>) => {
          const whole = answer as unknown as Partial<Extras>;
          setExtras({
            complete: whole.complete !== false,
            unreadableFeatureSets: whole.unreadableFeatureSets ?? [],
          });
        }}
      />
      {emailing === null ? null : (
        <EmailSellersDialog
          rows={emailing}
          csrfToken={csrfToken}
          onClose={() => setEmailing(null)}
          onSent={(sellers) => {
            setEmailing(null);
            toast.success(t('email.sent', { count: sellers }));
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
