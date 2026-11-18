'use client';

import { Badge, type BadgeTone, type MenuItem } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { Stars } from '../reviews/stars.tsx';
import { VIEW_PERMISSION as MODERATION_QUEUE } from '../reviews/types.ts';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from '../shared/short-id.ts';
import { SectionList, type SectionColumn } from './customer-section-list.tsx';
import type { SectionContext } from './customer-shopping.tsx';
import { timeOf } from './format.ts';
import { REVIEWS_VIEW } from './page-types.ts';

// The Reviews tab of the customer page (customers management phase 2b): the reviews the customer
// wrote, the seller ratings they gave, the helpful votes they cast and the reports by and about
// them. Read only: moderating stays in the moderation queue. The API sends ids, ratings, codes and
// instants, never the title or text of a review and never a reporter. Messages (a customer's
// notices) has no API yet, so this tab is named "Reviews" until it exists.

const REVIEW_STATUSES = ['published', 'held', 'hidden', 'removed', 'deleted-by-author'] as const;
const RATING_STATUSES = ['published', 'hidden', 'removed'] as const;
const REPORT_ROLES = ['by', 'about'] as const;

const TONE: Readonly<Record<string, BadgeTone>> = {
  published: 'success',
  held: 'attention',
  hidden: 'neutral',
  removed: 'critical',
  'deleted-by-author': 'neutral',
  open: 'attention',
  dismissed: 'neutral',
  upheld: 'info',
};

interface ReviewRow {
  readonly reviewId: string;
  readonly productId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly rating: number;
  readonly anonymous: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly publishedAt: string | null;
  readonly helpfulCount: number;
  readonly openReports: number;
  readonly lastModeration: {
    readonly action: string;
    readonly reasonCode: string;
    readonly byModerator: boolean;
    readonly at: string;
  } | null;
}
interface RatingRow {
  readonly ratingId: string;
  readonly sellerId: string;
  readonly sellerOrderId: string | null;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: string | null;
  readonly status: string;
  readonly createdAt: string;
}
interface VoteRow {
  readonly reviewId: string;
  readonly productId: string;
  readonly votedAt: string;
}
interface ReportRow {
  readonly reportId: string;
  readonly reviewId: string;
  readonly role: 'by' | 'about';
  readonly reasonCode: string;
  readonly status: string;
  readonly createdAt: string;
}

const Reference = ({ id }: { readonly id: string }) => (
  <span className="font-mono text-xs wrap-anywhere" title={id}>
    {shortId(id)}
  </span>
);

const none = <span className="text-fg-muted">—</span>;

/** The Reviews tab: four sections under the one reviews key, each loaded on its own. */
export function CustomerReviews(context: SectionContext) {
  const t = useTranslations('customers.reviews');
  const tm = useTranslations('reviews-moderation');
  const locale = useLocale();
  const time = (iso: string | null) => (iso === null ? none : timeOf(iso, locale, context.zone));

  if (!context.keys.has(REVIEWS_VIEW)) return null;

  const status = (value: string) => (
    <Badge tone={TONE[value] ?? 'neutral'}>
      {tm.has(`status.${value}`) ? tm(`status.${value}`) : value}
    </Badge>
  );
  /** A reason code in the moderation queue's words; an unknown code reads as its own text. */
  const reason = (code: string) =>
    tm.has(`reason.${code}`) ? tm(`reason.${code}`) : code.replace(/-/g, ' ');
  const yesNo = (value: boolean) => (value ? t('yes') : t('no'));

  const reviews: SectionColumn<ReviewRow>[] = [
    {
      id: 'review',
      primary: true,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <Stars rating={row.rating} />
          <Reference id={row.reviewId} />
        </span>
      ),
    },
    { id: 'status', cell: (row) => status(row.status) },
    { id: 'product', cell: (row) => <Reference id={row.productId} /> },
    { id: 'seller', cell: (row) => <Reference id={row.sellerId} /> },
    { id: 'anonymous', cell: (row) => yesNo(row.anonymous) },
    {
      id: 'helpful',
      numeric: true,
      cell: (row) => numberFormat(locale, {}).format(row.helpfulCount),
    },
    {
      id: 'reports',
      numeric: true,
      cell: (row) => numberFormat(locale, {}).format(row.openReports),
    },
    {
      id: 'moderation',
      cell: (row) =>
        row.lastModeration === null
          ? none
          : t('moderation-line', {
              action: tm.has(`history-action.${row.lastModeration.action}`)
                ? tm(`history-action.${row.lastModeration.action}`)
                : row.lastModeration.action,
              reason: reason(row.lastModeration.reasonCode),
              by: row.lastModeration.byModerator ? t('by-moderator') : t('by-system'),
            }),
    },
    { id: 'edited', cell: (row) => time(row.editedAt) },
    { id: 'created', cell: (row) => time(row.createdAt) },
  ];
  const ratings: SectionColumn<RatingRow>[] = [
    {
      id: 'satisfaction',
      primary: true,
      cell: (row) => <Stars rating={row.satisfaction} />,
    },
    { id: 'status', cell: (row) => status(row.status) },
    { id: 'seller', cell: (row) => <Reference id={row.sellerId} /> },
    {
      id: 'order',
      cell: (row) => (row.sellerOrderId === null ? none : <Reference id={row.sellerOrderId} />),
    },
    { id: 'described', cell: (row) => yesNo(row.asDescribed) },
    { id: 'arrived', cell: (row) => yesNo(row.arrivedOk) },
    { id: 'reason', cell: (row) => (row.reasonCode === null ? none : reason(row.reasonCode)) },
    { id: 'created', cell: (row) => time(row.createdAt) },
  ];
  const votes: SectionColumn<VoteRow>[] = [
    { id: 'review', primary: true, cell: (row) => <Reference id={row.reviewId} /> },
    { id: 'product', cell: (row) => <Reference id={row.productId} /> },
    { id: 'voted', cell: (row) => time(row.votedAt) },
  ];
  const reports: SectionColumn<ReportRow>[] = [
    {
      id: 'role',
      primary: true,
      cell: (row) => <Badge tone="info">{t(`role.${row.role}`)}</Badge>,
    },
    { id: 'review', cell: (row) => <Reference id={row.reviewId} /> },
    {
      id: 'reason',
      cell: (row) =>
        tm.has(`report-reason.${row.reasonCode}`)
          ? tm(`report-reason.${row.reasonCode}`)
          : reason(row.reasonCode),
    },
    { id: 'status', cell: (row) => status(row.status) },
    { id: 'created', cell: (row) => time(row.createdAt) },
  ];

  // The queue has no link to one review, so "Open in moderation" opens the queue itself; it is
  // offered only to an admin who may open the queue.
  const openQueue = (): readonly MenuItem[] =>
    context.keys.has(MODERATION_QUEUE)
      ? [
          {
            id: 'moderation',
            label: t('open-moderation'),
            onSelect: () => window.location.assign(`/reviews/moderation`),
          },
        ]
      : [];

  return (
    <div className="flex flex-col gap-4">
      <SectionList<ReviewRow>
        {...context}
        path="reviews"
        ns="customers.reviews.reviews"
        columns={reviews}
        optional={[
          'status',
          'product',
          'seller',
          'anonymous',
          'helpful',
          'reports',
          'moderation',
          'edited',
        ]}
        defaultOptional={['status', 'product', 'reports']}
        filter={{ kind: 'values', field: 'status', values: REVIEW_STATUSES }}
        sortColumn="created"
        rowId={(row) => row.reviewId}
        rowName={(row) => shortId(row.reviewId)}
        rowActions={openQueue}
      />
      <SectionList<RatingRow>
        {...context}
        path="seller-ratings"
        ns="customers.reviews.ratings"
        columns={ratings}
        optional={['status', 'seller', 'order', 'described', 'arrived', 'reason']}
        defaultOptional={['status', 'seller', 'described', 'arrived']}
        filter={{ kind: 'values', field: 'status', values: RATING_STATUSES }}
        sortColumn="created"
        rowId={(row) => row.ratingId}
        rowName={(row) => shortId(row.ratingId)}
      />
      <SectionList<VoteRow>
        {...context}
        path="helpful-votes"
        ns="customers.reviews.votes"
        columns={votes}
        optional={['product']}
        defaultOptional={['product']}
        filter={{ kind: 'none' }}
        sortColumn="voted"
        rowId={(row, index) => `${row.reviewId}-${row.votedAt}-${index}`}
        rowName={(row) => shortId(row.reviewId)}
      />
      <SectionList<ReportRow>
        {...context}
        path="review-reports"
        ns="customers.reviews.reports"
        columns={reports}
        optional={['review', 'reason', 'status']}
        defaultOptional={['review', 'reason', 'status']}
        filter={{ kind: 'values', field: 'role', values: REPORT_ROLES }}
        sortColumn="created"
        rowId={(row) => row.reportId}
        rowName={(row) => shortId(row.reportId)}
      />
    </div>
  );
}
