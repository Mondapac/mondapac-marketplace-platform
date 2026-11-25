'use client';

import { useTranslations } from 'next-intl';
import {
  BulkDecideDialog,
  type BulkResult,
  type BulkRow,
} from '../shared/paged-list/bulk-decide-dialog.tsx';
import { API_POST_REVIEWS } from './post-review-types.ts';

const SKIPPED: Readonly<Record<string, string>> = {
  'conflict.stale': 'stale',
  'conflict.retry': 'stale',
  'post-review.not-open': 'not-open',
  'post-review.not-found': 'not-found',
  'post-review.own-submission': 'own',
};

/**
 * Bulk Approve of the post-publication review (at most 50 ticked rows of the page): closes each
 * open row, as the caller, through the single Approve. There is no bulk take-down. The server
 * skips a row that changed, was decided, is unknown or was submitted by the deciding admin, and the
 * answer names each skipped row with why, so it can be opened one by one.
 */
export function PostReviewBulkDialog({
  rows,
  names,
  csrfToken,
  onClose,
  onFinished,
}: {
  readonly rows: readonly BulkRow[] | null;
  /** The product label of each ticked row, by id (a skipped row the answer names without one). */
  readonly names: ReadonlyMap<string, string>;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onFinished: () => void;
}) {
  const t = useTranslations('offer-review.post.bulk');
  if (rows === null) return null;
  const count = rows.length;
  const skippedLine = (entry: BulkResult): string | null => {
    const name = entry.name ?? names.get(entry.id) ?? entry.id;
    const why = entry.reason === undefined ? undefined : SKIPPED[entry.reason];
    return t(`skipped.${why ?? 'other'}`, { name });
  };
  return (
    <BulkDecideDialog
      endpoint={`${API_POST_REVIEWS}/bulk-approve`}
      action="approve"
      sendAction={false}
      rows={rows}
      title={t('title', { count })}
      body={t('body', { count })}
      confirm={t('confirm', { count })}
      confirmVariant="primary"
      describeSkipped={skippedLine}
      csrfToken={csrfToken}
      onClose={onClose}
      onFinished={onFinished}
    />
  );
}
