'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { useSalesExport, type ExportSelection } from '../../sales/sales-export.tsx';
import { API_BLOG_POSTS } from '../types.ts';
import { exportColumns, type OptionalColumn } from './posts-columns.ts';
import { SELECTION_MAX, type Query } from './posts-list-types.ts';
import { selectorParams } from './posts-query.ts';

/**
 * The query of the export. Ticked rows go by id alone (the API ignores a filter or a sort beside
 * `ids`, so none is sent); "Select all matching" sends the list's selector keys and its sort.
 * `columns` are the optional columns the file adds (mapped to the API's own ids).
 */
export function exportParams(input: {
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly format: string;
  readonly columns: readonly OptionalColumn[];
  readonly selection: ExportSelection;
  readonly now?: Date;
}): string {
  const { selection, query } = input;
  const params = new URLSearchParams();
  if (selection.allMatching) {
    for (const [key, value] of selectorParams(query, {
      paging: input.paging,
      zone: input.zone,
      now: input.now ?? new Date(),
    })) {
      params.set(key, value);
    }
    // Previous and next lists the newest created first only: the file keeps the order on screen.
    params.set('sort', input.paging === 'pages' ? query.sort : 'created');
    params.set('direction', input.paging === 'pages' ? query.direction : 'desc');
  } else {
    if (selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', selection.ids.slice(0, SELECTION_MAX).join(','));
  }
  params.set('format', input.format);
  const columns = exportColumns(input.columns);
  if (columns.length > 0) params.set('columns', columns.join(','));
  return params.toString();
}

/**
 * The Bulk action menu of the Blog posts list. A post is never changed in bulk (each change has
 * its own checks and its own page), so the one item is Export. The button is disabled until a row
 * is selected.
 */
export function PostsBulk({
  selection,
  query,
  paging,
  zone,
  columns,
  now,
}: {
  readonly selection: ExportSelection;
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly columns: readonly OptionalColumn[];
  /** When the rows on show were read; the date presets of "all matching" use this clock. */
  readonly now?: Date;
}) {
  const t = useTranslations('blog.list.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const { item, dialog, busy } = useSalesExport({
    path: `${API_BLOG_POSTS}/export`,
    fallbackName: 'blog-posts',
    listQuery: '',
    columns,
    zone,
    selection,
    buildQuery: (format) => exportParams({ query, paging, zone, format, columns, selection, now }),
  });
  return (
    <>
      <ActionMenu
        label={t('button')}
        title={
          selection.allMatching && selection.total === null
            ? t('all-open')
            : t('selected', { count })
        }
        items={[item]}
        disabled={!selected || busy}
      />
      {dialog}
    </>
  );
}
