'use client';

import type { MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { postPath } from '../types.ts';
import { ROW_ACTIONS, type PostListRow, type RowAction } from './posts-list-types.ts';

const REVIEWING: readonly RowAction[] = ['approve', 'request-changes', 'reviewer-edit'];
/** Publishing, pausing and the rest are done in the publishing panel of the review page. */
const PUBLISHING: readonly RowAction[] = [
  'publish',
  'schedule',
  'unschedule',
  'pause',
  'resume',
  'archive',
  'rename-slug',
  'feature',
];

/**
 * The Actions menu of a post row: what the row's `actions` array names (the API decides per
 * caller, state and owner), as at most two items with different destinations. Every item opens a
 * page and none acts here, so each label is plain; the page runs the action behind its own checks,
 * so no answer comes back to this list. An id this panel does not know is ignored.
 *   - Open: the post's editor, when the row names open, edit or submit.
 *   - Review and publish: the review page, when the caller may decide on the version in review or
 *     publish, schedule, pause, put back, archive or feature the post.
 */
export function usePostRowActions(): (row: PostListRow) => readonly MenuItem[] {
  const t = useTranslations('blog.list.actions');
  const router = useRouter();

  return (row) => {
    const named = ROW_ACTIONS.filter((action) => row.actions.includes(action));
    const has = (...ids: readonly RowAction[]) => ids.some((id) => named.includes(id));
    const items: MenuItem[] = [];
    const go = (id: string, label: string, href: string) =>
      items.push({ id, label, onSelect: () => router.push(href) });
    if (has('open', 'edit', 'submit')) go('open', t('open'), postPath(row.id));
    if (has(...REVIEWING, ...PUBLISHING)) {
      go('review', t('review'), `${postPath(row.id)}/review`);
    }
    return items;
  };
}
