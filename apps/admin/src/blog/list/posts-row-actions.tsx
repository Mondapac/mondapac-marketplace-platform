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
 * caller, state and owner), in a fixed order. Every item opens a page (the post, or its review
 * page) and none acts here, so each label is plain; the page runs the action behind its own
 * checks, so no answer comes back to this list. An id this panel does not know is ignored.
 *   - Open: the post's page (always named).
 *   - Edit: the editor, for a post the caller may change.
 *   - Review: when the caller may decide on the version in review.
 *   - Publishing: when the caller may publish, schedule, pause, put back, archive or feature it.
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
    if (has('open')) go('open', t('open'), postPath(row.id));
    if (has('edit')) go('edit', t('edit'), postPath(row.id));
    if (has(...REVIEWING)) {
      go('review', t('review'), `${postPath(row.id)}/review`);
    }
    if (has(...PUBLISHING)) go('publishing', t('publishing'), `${postPath(row.id)}/review`);
    return items;
  };
}
