'use client';

import {
  Badge,
  SuperTable,
  type BadgeTone,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { TimeCell } from '../../sales/cells.tsx';
import { postPath, POST_STATUSES, type PostStatus } from '../types.ts';
import type { OptionalColumn } from './posts-columns.ts';
import type { PostListRow } from './posts-list-types.ts';

const STATUS_TONE: Readonly<Record<PostStatus, BadgeTone>> = {
  draft: 'neutral',
  in_review: 'info',
  changes_requested: 'attention',
  approved: 'info',
  scheduled: 'info',
  published: 'success',
  unpublished: 'neutral',
  archived: 'neutral',
};

const isStatus = (value: string): value is PostStatus =>
  (POST_STATUSES as readonly string[]).includes(value);

/** What the line under the title says about the version being worked on, if anything. */
function openNote(row: PostListRow): 'in_review' | 'returned' | 'draft' | 'approved' | null {
  // A post that is itself a draft, in review or sent back is already described by its status.
  if (row.status === 'draft' || row.status === 'in_review' || row.status === 'changes_requested') {
    return null;
  }
  switch (row.openState) {
    case 'in_review':
    case 'returned':
    case 'draft':
    case 'approved':
      return row.openState;
    default:
      return null;
  }
}

/**
 * The posts of one page, from one column definition (`SuperTable`): a box to select the row, the
 * post (its title links to the post, its web address, whether it is featured and the state of a
 * newer version under it), the status, when it last changed, then the optional columns the admin
 * chose, and the row Actions menu last. From 1024 px a table; below it each post is a card with
 * labelled lines (the title on top, the status in its corner). No button stands in a row.
 */
export function PostsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly PostListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: PostListRow) => readonly MenuItem[];
}) {
  const tl = useTranslations('blog.list');
  const tb = useTranslations('blog');
  const none = tl('none');

  const optional = (column: OptionalColumn, row: PostListRow): ReactNode => {
    switch (column) {
      case 'kind':
        return tb(`kind.${row.kind}`);
      case 'author':
        return row.ownerType === 'platform' ? tl('author.platform') : tl('author.seller');
      case 'scheduled':
        return <TimeCell at={row.scheduledAt} zone={zone} empty={none} />;
      case 'published':
        return <TimeCell at={row.publishedAt} zone={zone} empty={none} />;
    }
  };

  const defs: SuperColumn<PostListRow>[] = [
    {
      id: 'post',
      header: tl('col.post'),
      primary: true,
      cell: (row) => {
        const note = openNote(row);
        return (
          <span className="flex flex-col gap-0.5">
            <a className="font-semibold text-link underline wrap-anywhere" href={postPath(row.id)}>
              {row.title}
            </a>
            <span className="text-sm wrap-anywhere text-fg-muted">{`/blog/${row.slug}`}</span>
            {note === null ? null : (
              <span className="text-sm text-fg-muted">{tl(`open-note.${note}`)}</span>
            )}
            {row.featured ? <span className="text-sm text-fg-muted">{tl('featured')}</span> : null}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: tl('col.status'),
      corner: true,
      cell: (row) => (
        <Badge tone={isStatus(row.status) ? STATUS_TONE[row.status] : 'neutral'}>
          {isStatus(row.status) ? tb(`state.${row.status}`) : row.status}
        </Badge>
      ),
    },
    ...columns.map((column): SuperColumn<PostListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      ...(column === 'scheduled' || column === 'published' ? { skeleton: 'date' as const } : {}),
      cell: (row) => optional(column, row),
    })),
    {
      id: 'updated',
      header: tl('col.updated'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.updatedAt} zone={zone} />,
    },
  ];

  return (
    <SuperTable<PostListRow>
      caption={tl('caption')}
      rows={rows}
      rowId={(row) => row.id}
      rowName={(row) => row.title}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: tl('select.page'),
          pageShort: tl('select.page-short'),
          row: (name) => tl('select.row', { name }),
        },
      }}
      actions={{
        header: tl('col.actions'),
        label: (name) => tl('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={defs.length > 6 ? 'lg:min-w-300' : 'lg:min-w-240'}
    />
  );
}
