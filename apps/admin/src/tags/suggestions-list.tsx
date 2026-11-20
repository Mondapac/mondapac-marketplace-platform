'use client';

import { toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type { ListPagingMode, PagedAnswer, PagedListConfig } from '../shared/paged-list/types.ts';
import { When } from '../shared/when.tsx';
import { SuggestionDialog, type Decision } from './suggestion-dialog.tsx';
import type { SuggestionItem, SuggestionList } from './suggestion-types.ts';
import { API_TOPIC_SUGGESTIONS } from './suggestion-types.ts';

/** A row with what the API names the caller may do on it: `approve`, `map`, `reject`. */
export type SuggestionRow = SuggestionItem & { readonly actions: readonly string[] };
const ACTIONS: readonly Decision[] = ['approve', 'map', 'reject'];

/** The language in words, with the code as the fallback. */
function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/**
 * The tag suggestions from sellers as a super list (super list phase 2, list 11): the open queue,
 * oldest first, searched by the seller's words. Approve…, Map to existing tag… and Reject… are in
 * the row's Actions menu (the server names what this admin may do on each row) and open a
 * confirmation dialog. The seller's words are plain text, shown as a text node only.
 */
export function SuggestionsList({
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
  const t = useTranslations('tags.suggestions');
  const tl = useTranslations('tags.suggestions.list');
  const [open, setOpen] = useState<{ item: SuggestionRow; decision: Decision } | null>(null);
  const [locale, setLocale] = useState('en');
  const [refresh, setRefresh] = useState(0);

  const rowActions = useCallback(
    (row: SuggestionRow): readonly MenuItem[] =>
      ACTIONS.filter((id) => row.actions.includes(id)).map((id) => ({
        id,
        label: t(`actions.${id}`),
        onSelect: () => setOpen({ item: row, decision: id }),
      })),
    [t],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<SuggestionRow> => {
      switch (id) {
        case 'label':
          return {
            id,
            header,
            primary: true,
            cell: (row) => <span className="font-semibold wrap-anywhere text-fg">{row.label}</span>,
          };
        case 'product':
          return {
            id,
            header,
            cell: (row) =>
              row.productCode === null ? (
                <span className="text-fg-muted">{t('unknown-product')}</span>
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
            cell: (row) => (
              <a className="text-link underline" href={`/sellers/${row.sellerId}`}>
                {row.sellerId.slice(0, 8)}
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

  const config: PagedListConfig<SuggestionRow> = useMemo(
    () => ({
      ns: 'tags.suggestions.list',
      endpoint: API_TOPIC_SUGGESTIONS,
      rowId: (row) => row.id,
      rowName: (row) => row.label,
      tabs: ['open'],
      search: { max: 100 },
      sorts: [
        {
          id: 'created',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'created',
      fixedColumns: ['label'],
      optionalColumns: ['product', 'seller', 'requested'],
      defaultColumns: ['product', 'seller', 'requested'],
      columnDefs,
      rowActions,
      icon: 'package',
    }),
    [tl, columnDefs, rowActions],
  );

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      refreshKey={refresh}
      onAnswer={(answer: PagedAnswer<SuggestionRow>) =>
        setLocale((answer as unknown as SuggestionList).locales.default)
      }
      dialogs={
        <SuggestionDialog
          item={open?.item ?? null}
          decision={open?.decision ?? null}
          defaultLocale={locale}
          languageLabel={languageName(locale)}
          csrfToken={csrfToken}
          onSwitch={(decision) => setOpen((now) => (now === null ? null : { ...now, decision }))}
          onClose={() => setOpen(null)}
          onSettled={(why) => {
            setOpen(null);
            if (why !== undefined) toast.error(t(`notice.${why}`));
            setRefresh((value) => value + 1);
          }}
        />
      }
    />
  );
}
