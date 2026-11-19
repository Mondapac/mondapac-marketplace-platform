import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { SubmissionKind } from './seller-certificate';

// The admin certificates queue as a super list (phase 3, list 17; CLAUDE.md rule 14): the pending
// submissions of the Market with views, filters, sort, page numbers or Previous/Next, the row
// Actions menu and the export. The queue is bounded (tens to hundreds, design A5), so the filter,
// sort and page run over one capped read. Pure rules; no I/O.

/** A view is a shortcut for one kind of submission. */
export const CERTIFICATE_QUEUE_VIEWS = ['all', 'initial', 'resubmission', 'renewal'] as const;
export type CertificateQueueView = (typeof CERTIFICATE_QUEUE_VIEWS)[number];

/** `queue` is the review order: renewals first, then oldest submission first. */
export const CERTIFICATE_QUEUE_SORT_KEYS = ['queue', 'submitted', 'type'] as const;
export type CertificateQueueSortKey = (typeof CERTIFICATE_QUEUE_SORT_KEYS)[number];

export interface CertificateQueueSort {
  readonly key: CertificateQueueSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface CertificateQueueFilter {
  readonly kind: SubmissionKind | null;
  readonly typeCode: string | null;
  readonly sellerId: Id<'Seller'> | null;
  /** A certificate id or a submission id the admin pasted, exact. */
  readonly certificateOrSubmissionId: string | null;
  /** Submitted at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

export const EMPTY_CERTIFICATE_QUEUE_FILTER: CertificateQueueFilter = Object.freeze({
  kind: null,
  typeCode: null,
  sellerId: null,
  certificateOrSubmissionId: null,
  from: null,
  to: null,
});

export const CERTIFICATE_QUEUE_ROW_ACTIONS = ['open', 'decide'] as const;
export type CertificateQueueRowAction = (typeof CERTIFICATE_QUEUE_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const CERTIFICATE_QUEUE_EXPORT_COLUMNS = [
  'certificate-id',
  'submission-id',
  'seller-id',
  'submission-no',
] as const;
export type CertificateQueueExportColumn = (typeof CERTIFICATE_QUEUE_EXPORT_COLUMNS)[number];

export function viewKind(view: CertificateQueueView): SubmissionKind | null {
  return view === 'all' ? null : view;
}

/** What the filter and the sort read of one waiting submission. */
export interface CertificateQueueSubject {
  readonly certificateId: string;
  readonly submissionId: string;
  readonly sellerId: string;
  readonly typeCode: string;
  readonly kind: SubmissionKind;
  readonly submittedAt: Temporal.Instant;
}

export function certificateQueueMatches(
  row: CertificateQueueSubject,
  filter: CertificateQueueFilter,
): boolean {
  if (filter.kind !== null && row.kind !== filter.kind) return false;
  if (filter.typeCode !== null && row.typeCode !== filter.typeCode) return false;
  if (filter.sellerId !== null && row.sellerId !== filter.sellerId) return false;
  if (
    filter.certificateOrSubmissionId !== null &&
    row.certificateId !== filter.certificateOrSubmissionId &&
    row.submissionId !== filter.certificateOrSubmissionId
  ) {
    return false;
  }
  const at = row.submittedAt.epochMilliseconds;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  return true;
}

/**
 * Sorts two submissions. `queue` is the review order: renewals first whatever the direction, then
 * the submission time. The certificate id breaks every tie, so a page boundary never repeats a row.
 */
export function compareCertificateQueue(
  a: CertificateQueueSubject,
  b: CertificateQueueSubject,
  sort: CertificateQueueSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.key === 'queue') {
    const rank = (row: CertificateQueueSubject): number => (row.kind === 'renewal' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
  }
  const primary =
    sort.key === 'type'
      ? a.typeCode < b.typeCode
        ? -1
        : a.typeCode > b.typeCode
          ? 1
          : 0
      : a.submittedAt.epochMilliseconds - b.submittedAt.epochMilliseconds;
  if (primary !== 0) return sign * primary;
  return (
    sign * (a.certificateId < b.certificateId ? -1 : a.certificateId > b.certificateId ? 1 : 0)
  );
}
