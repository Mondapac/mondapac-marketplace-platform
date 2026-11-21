'use client';

import { Badge, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import {
  API_TOPICS,
  TOPIC_GROUPS,
  type TopicPage,
  type TopicRow,
  type TopicStatus,
} from './types.ts';

/** A row with what the API names the caller may do on it: `edit`. */
export type TagListRow = TopicRow & { readonly actions: readonly string[] };
export type TagDialog = { readonly kind: 'form'; readonly topic?: TopicRow };

const STATUS_TONE: Record<TopicStatus, 'success' | 'neutral'> = {
  active: 'success',
  archived: 'neutral',
};
/** Synonyms shown in a row before "+N". */
const SYNONYMS_SHOWN = 2;

/**
 * The product tags as a super list (super list phase 2, list 10): All, Active and Archived as
 * views, a Group filter, search by name, synonym or address, sort, column picker, selection, page
 * numbers or Previous and next and the row Actions menu (Edit…) as the API names it for the row.
 * The page owns the dialog it opens.
 */
export function TagsList({
  paging,
  accountId,
  marketId,
  csrfToken,
  locale,
  onOpen,
  onAnswered,
  refreshKey,
  headerAction,
  dialogs,
}: {
  readonly paging: ListPagingMode;
  /** For saving, renaming, moving and deleting saved filters. */
  readonly csrfToken: string;
  readonly accountId: string;
  readonly marketId: string;
  /** The Market's default locale (names are shown in it), once the first answer told it. */
  readonly locale: string;
  readonly onOpen: (dialog: TagDialog) => void;
  readonly onAnswered: (answer: TopicPage) => void;
  readonly refreshKey: number;
  readonly headerAction: React.ReactNode;
  readonly dialogs: React.ReactNode;
}) {
  const t = useTranslations('tags');
  const tl = useTranslations('tags.list');
  const nameOf = useCallback((row: TopicRow): string => row.names[locale] ?? row.slug, [locale]);

  const rowActions = useCallback(
    (row: TagListRow): readonly MenuItem[] =>
      row.actions.includes('edit')
        ? [
            {
              id: 'edit',
              label: tl('actions.edit'),
              onSelect: () => onOpen({ kind: 'form', topic: row }),
            },
          ]
        : [],
    [tl, onOpen],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<TagListRow> => {
      switch (id) {
        case 'name':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <div className="min-w-0">
                <p className="font-semibold wrap-anywhere text-fg">{nameOf(row)}</p>
                <p className="text-sm wrap-anywhere text-fg-muted">{row.slug}</p>
              </div>
            ),
          };
        case 'group':
          return { id, header, cell: (row) => t(`group.${row.group}`) };
        case 'synonyms':
          return {
            id,
            header,
            cell: (row) => {
              const synonyms = row.synonyms[locale] ?? [];
              const hidden = synonyms.length - SYNONYMS_SHOWN;
              return synonyms.length === 0 ? (
                <span aria-label={t('not-set')}>{'—'}</span>
              ) : (
                <span className="wrap-anywhere">
                  {synonyms.slice(0, SYNONYMS_SHOWN).join(', ')}
                  {hidden > 0 ? (
                    <>
                      {' '}
                      <span aria-hidden="true">{`+${hidden}`}</span>
                      <span className="sr-only">{t('and-more', { count: hidden })}</span>
                    </>
                  ) : null}
                </span>
              );
            },
          };
        default:
          return {
            id,
            header,
            corner: true,
            cell: (row) => (
              <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
            ),
          };
      }
    },
    [t, nameOf, locale],
  );

  const config: PagedListConfig<TagListRow> = useMemo(
    () => ({
      ns: 'tags.list',
      endpoint: API_TOPICS,
      rowId: (row) => row.id,
      rowName: (row) => nameOf(row),
      tabs: ['all', 'active', 'archived'],
      tabParam: 'status',
      search: { max: 100 },
      sorts: [
        {
          id: 'slug',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'group',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'status',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'created',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'desc',
        },
        {
          id: 'updated',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'desc',
        },
      ],
      defaultSort: 'slug',
      fixedColumns: ['name'],
      optionalColumns: ['group', 'synonyms', 'status'],
      defaultColumns: ['group', 'synonyms', 'status'],
      columnDefs,
      rowActions,
      icon: 'package',
      savedKey: 'admin.catalog.tags',
    }),
    [tl, columnDefs, rowActions, nameOf],
  );
  const fields: readonly PagedFilterField[] = useMemo(
    () => [
      {
        id: 'group',
        label: tl('filter.group'),
        options: TOPIC_GROUPS.map((value) => ({ value, label: t(`group.${value}`) })),
      },
    ],
    [t, tl],
  );

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      csrfToken={csrfToken}
      refreshKey={refreshKey}
      heading={headerAction}
      dialogs={dialogs}
      onAnswer={(answer: PagedAnswer<TagListRow>) => onAnswered(answer as unknown as TopicPage)}
    />
  );
}
