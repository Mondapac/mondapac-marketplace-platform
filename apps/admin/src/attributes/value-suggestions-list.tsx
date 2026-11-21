'use client';

import { Banner, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import { useDateFilter } from '../shared/paged-list/use-date-filter.ts';
import type { ListPagingMode, PagedAnswer, PagedListConfig } from '../shared/paged-list/types.ts';
import { When } from '../shared/when.tsx';
import { ValueSuggestionDialog, type ValueDecision } from './value-suggestion-dialog.tsx';
import { API_SUGGESTIONS, textIn, type SuggestionItem, type SuggestionList } from './types.ts';

/** A row with what the API names the caller may do on it: `approve`, `map`, `reject`. */
export type ValueSuggestionRow = SuggestionItem & { readonly actions: readonly string[] };
const ACTIONS: readonly ValueDecision[] = ['approve', 'map', 'reject'];

/**
 * The value suggestions from sellers as a super list (super list phase 2, list 7): the open queue,
 * oldest first, searched by the seller's words. Approve…, Map to existing value… and Reject… are
 * in the row's Actions menu (the server names what this admin may do on each row, and map is
 * offered only when the field has values) and open a confirmation dialog. The seller's words are
 * plain text, shown as a text node only.
 */
export function ValueSuggestionsList({
  paging,
  accountId,
  marketId,
  zone,
  csrfToken,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Requested presets (ADR-0005). */
  readonly zone: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('attributes.suggestions');
  const tl = useTranslations('attributes.suggestions.list');
  const [open, setOpen] = useState<{ item: ValueSuggestionRow; decision: ValueDecision } | null>(
    null,
  );
  const [context, setContext] = useState<Pick<
    SuggestionList,
    'requiredLocales' | 'locales'
  > | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const created = useDateFilter({
    id: 'created',
    label: tl('filter.name.created'),
    range: { from: 'createdFrom', to: 'createdTo' },
    zone,
  });
  const fields = useMemo(() => [created.field], [created.field]);
  const defaultLocale = context?.locales.default ?? 'en';
  // The columns read the language from a ref, so the list is not read again when it arrives.
  const localeRef = useRef('en');
  localeRef.current = defaultLocale;

  const rowActions = useCallback(
    (row: ValueSuggestionRow): readonly MenuItem[] =>
      ACTIONS.filter(
        (id) => row.actions.includes(id) && (id !== 'map' || row.attribute.options.length > 0),
      ).map((id) => ({
        id,
        label: tl(`actions.${id}`),
        onSelect: () => setOpen({ item: row, decision: id }),
      })),
    [tl],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<ValueSuggestionRow> => {
      switch (id) {
        case 'label':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <span className="font-semibold wrap-anywhere text-fg">“{row.label}”</span>
            ),
          };
        case 'attribute':
          return {
            id,
            header,
            cell: (row) => (
              <a
                className="text-link underline"
                href={`/catalog/attributes/${encodeURIComponent(row.attribute.id)}`}
              >
                {textIn(
                  row.attribute.names,
                  localeRef.current,
                  localeRef.current,
                  row.attribute.code,
                )}
              </a>
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
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <When iso={row.createdAt} missing="" />,
          };
      }
    },
    [t],
  );

  const config: PagedListConfig<ValueSuggestionRow> = useMemo(
    () => ({
      ns: 'attributes.suggestions.list',
      endpoint: API_SUGGESTIONS,
      rowId: (row) => row.id,
      rowName: (row) => row.label,
      tabs: ['open'],
      search: { max: 100 },
      sorts: [
        {
          id: 'created',
          orders: [tl('sort.date.second'), tl('sort.date.first')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'created',
      fixedColumns: ['label'],
      optionalColumns: ['attribute', 'product', 'requested'],
      defaultColumns: ['attribute', 'product', 'requested'],
      columnDefs,
      rowActions,
      icon: 'package',
      savedKey: 'admin.catalog.attribute-suggestions',
    }),
    [tl, columnDefs, rowActions],
  );

  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : (
        <div role="alert">
          <Banner tone="info">{t(`error.${notice}`)}</Banner>
        </div>
      )}
      <PagedSuperList
        config={config}
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        fields={fields}
        dateRange={created.dateRange}
        csrfToken={csrfToken}
        refreshKey={refresh}
        onAnswer={(answer: PagedAnswer<ValueSuggestionRow>) => {
          const { requiredLocales, locales } = answer as unknown as SuggestionList;
          setContext((current) =>
            current !== null && current.locales.default === locales.default
              ? current
              : { requiredLocales, locales },
          );
        }}
        dialogs={
          <ValueSuggestionDialog
            item={open?.item ?? null}
            decision={open?.decision ?? null}
            requiredLocales={context?.requiredLocales ?? []}
            defaultLocale={defaultLocale}
            supported={context?.locales.supported ?? [defaultLocale]}
            csrfToken={csrfToken}
            onClose={() => setOpen(null)}
            onSettled={(why) => {
              setOpen(null);
              setNotice(why ?? null);
              setRefresh((value) => value + 1);
            }}
          />
        }
      />
    </div>
  );
}
