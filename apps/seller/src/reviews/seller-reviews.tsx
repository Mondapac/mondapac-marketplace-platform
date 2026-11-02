'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  Select,
  TextAreaField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import { reviewProblemOf } from './errors.ts';
import {
  REPORT_REASONS,
  type ReportReason,
  type SellerReply,
  type SellerReview,
  type SellerReviewPage,
} from './types.ts';

/** Stars as an icon row with the number as text, so the colour or shape is never the only signal. */
function Stars({ rating }: { readonly rating: number }) {
  const t = useTranslations('reviews');
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={t('stars', { rating })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name="star"
          className={n <= rating ? 'text-attention-fg' : 'text-icon opacity-40'}
        />
      ))}
    </span>
  );
}

type Mode = 'idle' | 'reply' | 'edit' | 'report';

/**
 * One review: its stars, text and date, the shop's reply (written once, editable for the
 * Market's number of days) and the report form. The buyer's name is never shown; the order link
 * is the only way to see what was bought. Review text is plain text from a buyer: it is rendered
 * as text and never as markup.
 */
function ReviewCard({
  review,
  csrfToken,
  canReply,
  canReport,
  onChanged,
}: {
  readonly review: SellerReview;
  readonly csrfToken: string;
  readonly canReply: boolean;
  readonly canReport: boolean;
  readonly onChanged: (review: SellerReview) => void;
}) {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const zone = useTimeZone();
  const [mode, setMode] = useState<Mode>('idle');
  const [text, setText] = useState('');
  const [reason, setReason] = useState<ReportReason>('abusive');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const reasonId = useId();

  const { reply } = review;
  const editable = reply !== null && Date.parse(reply.editableUntil) > Date.now();

  function open(next: Mode) {
    setProblem(null);
    setText(next === 'edit' && reply !== null ? reply.body : '');
    setMode(next);
  }

  async function send(method: 'POST' | 'PATCH', path: string, body: unknown) {
    setPending(true);
    setProblem(null);
    const result = await callApi<SellerReview | { reported: true }>(method, path, body, csrfToken);
    setPending(false);
    if (result.ok) return result.body;
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(reviewProblemOf(result.failure));
    return null;
  }

  async function saveReply() {
    const sent = await send(
      mode === 'edit' ? 'PATCH' : 'POST',
      `reviews/seller/${review.id}/reply`,
      {
        body: text,
      },
    );
    if (sent === null) return;
    onChanged(sent as SellerReview);
    setMode('idle');
    toast.success(t(mode === 'edit' ? 'reply.saved-edit' : 'reply.saved'));
  }

  async function sendReport() {
    const sent = await send('POST', `reviews/seller/${review.id}/report`, { reasonCode: reason });
    if (sent === null) return;
    setReported(true);
    setMode('idle');
    toast.success(t('report.sent'));
  }

  return (
    <Card>
      <article
        className="flex flex-col gap-3"
        aria-label={t('review-label', { rating: review.rating })}
      >
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Stars rating={review.rating} />
          {review.publishedAt === null ? null : (
            <time className="text-sm text-fg-muted" dateTime={review.publishedAt}>
              {shortInstant(review.publishedAt, locale, zone)}
            </time>
          )}
          <a className="text-sm text-link underline" href={`/products/${review.productId}`}>
            {t('product-link')}
          </a>
          {review.orderRef === null ? null : (
            <a className="text-sm text-link underline" href={`/orders/${review.orderRef}`}>
              {t('order-link')}
            </a>
          )}
        </header>
        {review.title === null ? null : (
          <h3 className="break-words text-base font-medium">{review.title}</h3>
        )}
        {review.body === null ? (
          <p className="text-sm text-fg-muted">{t('no-text')}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words">{review.body}</p>
        )}

        {reply === null ? null : <ReplyBlock reply={reply} editable={editable} />}

        {mode === 'reply' || mode === 'edit' ? (
          <div className="flex flex-col gap-3">
            <TextAreaField
              label={t(mode === 'edit' ? 'reply.edit-label' : 'reply.label')}
              help={t('reply.help')}
              value={text}
              onChange={(event) => setText(event.target.value)}
              error={problem === null ? undefined : t(`error.${problem}`)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void saveReply()}
                loading={pending}
                disabled={text.trim() === ''}
              >
                {t(mode === 'edit' ? 'reply.save-edit' : 'reply.save')}
              </Button>
              <Button variant="secondary" onClick={() => setMode('idle')} disabled={pending}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'report' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">{t('report.intro')}</p>
            <Select
              label={t('report.reason-label')}
              value={reason}
              onChange={(event) => setReason(event.target.value as ReportReason)}
              options={REPORT_REASONS.map((id) => ({ value: id, label: t(`report.reason.${id}`) }))}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void sendReport()} loading={pending}>
                {t('report.send')}
              </Button>
              <Button variant="secondary" onClick={() => setMode('idle')} disabled={pending}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {problem !== null && mode !== 'reply' && mode !== 'edit' ? (
          <Banner tone="critical">
            <span id={reasonId}>{t(`error.${problem}`)}</span>
          </Banner>
        ) : null}

        {mode === 'idle' ? (
          <div className="flex flex-wrap items-center gap-2">
            {canReply && reply === null ? (
              <Button variant="secondary" onClick={() => open('reply')}>
                {t('reply.action')}
              </Button>
            ) : null}
            {canReply && reply !== null && editable ? (
              <Button variant="secondary" onClick={() => open('edit')}>
                {t('reply.edit')}
              </Button>
            ) : null}
            {canReport && !reported ? (
              <Button variant="secondary" onClick={() => open('report')}>
                {t('report.action')}
              </Button>
            ) : null}
            {reported ? <Badge tone="info">{t('report.sent-badge')}</Badge> : null}
          </div>
        ) : null}
      </article>
    </Card>
  );
}

function ReplyBlock({
  reply,
  editable,
}: {
  readonly reply: SellerReply;
  readonly editable: boolean;
}) {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const zone = useTimeZone();
  return (
    <div className="rounded-md border border-line bg-subtle p-3">
      <p className="mb-1 text-sm font-medium">{t('reply.title')}</p>
      <p className="whitespace-pre-wrap break-words">{reply.body}</p>
      <p className="mt-2 text-xs text-fg-muted">
        <time dateTime={reply.createdAt}>{shortInstant(reply.createdAt, locale, zone)}</time>
        {reply.editedAt === null ? null : ` · ${t('reply.edited')}`}
        {editable
          ? ` · ${t('reply.editable-until', { date: shortInstant(reply.editableUntil, locale, zone) })}`
          : ` · ${t('reply.locked')}`}
      </p>
    </div>
  );
}

/**
 * The seller's published reviews, newest first, with "Show more" by cursor. Each review can be
 * answered once in public and reported to the admins; the seller can neither hide nor remove it.
 */
export function SellerReviews({
  initial,
  csrfToken,
  canReply,
  canReport,
}: {
  readonly initial: SellerReviewPage;
  readonly csrfToken: string;
  readonly canReply: boolean;
  readonly canReport: boolean;
}) {
  const t = useTranslations('reviews');
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await callApi<SellerReviewPage>(
      'GET',
      `reviews/seller?cursor=${encodeURIComponent(cursor)}`,
    );
    setLoadingMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    const known = new Set(items.map((review) => review.id));
    setItems([...items, ...result.body.items.filter((review) => !known.has(review.id))]);
    setCursor(result.body.nextCursor);
  }

  function replace(changed: SellerReview) {
    setItems((current) => current.map((review) => (review.id === changed.id ? changed : review)));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {items.length === 0 ? (
        <EmptyState icon="star" title={t('empty.title')} body={t('empty.body')} />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((review) => (
            <li key={review.id}>
              <ReviewCard
                review={review}
                csrfToken={csrfToken}
                canReply={canReply}
                canReport={canReport}
                onChanged={replace}
              />
            </li>
          ))}
        </ul>
      )}
      {moreFailed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {cursor === null ? null : (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
