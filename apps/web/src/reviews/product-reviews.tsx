'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { formatDate } from '../format/date.ts';
import { readReviewsPage } from './reviews-api.ts';
import {
  averageOf,
  shareOf,
  type ProductSummary,
  type PublicReview,
  type ReviewsPage,
} from './reviews-model.ts';
import { Stars } from './stars.tsx';

/**
 * The product page's reviews: the stars summary with the five-row chart (each row filters the
 * list), the published reviews newest first, and "Show more". Only published reviews reach
 * this component; the page draws it only while the Market's reviews switch is on.
 */
export function ProductReviews({
  productId,
  summary,
  initial,
  sellers,
}: {
  readonly productId: string;
  readonly summary: ProductSummary;
  readonly initial: ReviewsPage;
  /** Seller names of the product's offers, by seller id, for the "Bought from" label. */
  readonly sellers: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const [filter, setFilter] = useState<number | null>(null);
  const [page, setPage] = useState<ReviewsPage>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The newest request wins: a slow answer for an earlier filter never replaces a later one.
  const latest = useRef(0);
  const average = summary.averageTimes100 === null ? null : averageOf(summary.averageTimes100);

  async function load(stars: number | null, cursor?: string): Promise<void> {
    const ticket = ++latest.current;
    setBusy(true);
    setFailed(false);
    const next = await readReviewsPage(productId, {
      ...(stars === null ? {} : { stars }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (ticket !== latest.current) return;
    setBusy(false);
    if (next === null) {
      setFailed(true);
      return;
    }
    setPage((current) =>
      cursor === undefined
        ? next
        : { reviews: [...current.reviews, ...next.reviews], nextCursor: next.nextCursor },
    );
  }

  function choose(stars: number | null): void {
    if (stars === filter) return;
    setFilter(stars);
    if (stars === null) {
      // "All" is the page the server drew, no request.
      latest.current++;
      setBusy(false);
      setFailed(false);
      setPage(initial);
      return;
    }
    void load(stars);
  }

  return (
    <section className="sec rv" id="reviews" aria-labelledby="reviews-title">
      <h2 id="reviews-title">{t('title')}</h2>
      <div className="rv-sum">
        <div className="rv-avg">
          <b className="num">{average}</b>
          <Stars
            value={(summary.averageTimes100 ?? 0) / 100}
            label={t('average-label', { average: average ?? '0' })}
          />
          <small>{t('count', { count: summary.count })}</small>
        </div>
        <div className="rv-bars" role="group" aria-label={t('filter')}>
          {[5, 4, 3, 2, 1].map((stars) => {
            const count = summary.histogram[stars - 1] ?? 0;
            const percent = shareOf(count, summary.count);
            return (
              <button
                key={stars}
                type="button"
                className="rv-bar"
                aria-pressed={filter === stars}
                disabled={count === 0}
                aria-label={t('bar-label', { stars, count })}
                onClick={() => choose(filter === stars ? null : stars)}
              >
                <span className="num">{t('bar-stars', { stars })}</span>
                <span className="rv-track" aria-hidden="true">
                  <span style={{ inlineSize: `${percent}%` }} />
                </span>
                <span className="num">{percent}%</span>
              </button>
            );
          })}
          {filter === null ? null : (
            <button type="button" className="rv-clear" onClick={() => choose(null)}>
              {t('show-all')}
            </button>
          )}
        </div>
      </div>
      <div role="status" className="sr-only">
        {busy ? t('loading') : t('shown', { count: page.reviews.length })}
      </div>
      {page.reviews.length === 0 ? (
        <p className="rv-none">{busy ? t('loading') : t('none-here')}</p>
      ) : (
        <ul className="rv-list" aria-busy={busy}>
          {page.reviews.map((review) => (
            <li key={review.id}>
              <ReviewCard review={review} sellers={sellers} locale={locale} />
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <p className="rv-err" role="alert">
          {t('failed')}
        </p>
      ) : null}
      {page.nextCursor === null ? null : (
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => void load(filter, page.nextCursor ?? undefined)}
        >
          {t('more')}
        </button>
      )}
    </section>
  );
}

function ReviewCard({
  review,
  sellers,
  locale,
}: {
  readonly review: PublicReview;
  readonly sellers: Readonly<Record<string, string>>;
  readonly locale: string;
}) {
  const t = useTranslations('reviews');
  const day = (iso: string) =>
    formatDate(iso, locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const seller = sellers[review.sellerId];
  const who =
    review.author.kind === 'named'
      ? review.author.name
      : review.author.kind === 'former-customer'
        ? t('former-customer')
        : t('verified-buyer');
  return (
    <article className="rv-card">
      <div className="rv-head">
        <Stars value={review.rating} label={t('rating-label', { stars: review.rating })} />
        {review.title ? <b dir="auto">{review.title}</b> : null}
      </div>
      {review.body ? (
        <p className="rv-body" dir="auto">
          {review.body}
        </p>
      ) : null}
      <p className="rv-by">
        <span>{who}</span>
        <span className="rv-chip">{t('verified-purchase')}</span>
        {seller === undefined ? null : <span>{t('bought-from', { seller })}</span>}
        <time dateTime={review.publishedOn}>{day(review.publishedOn)}</time>
        {review.editedOn === null ? null : (
          <span>{t('edited', { date: day(review.editedOn) })}</span>
        )}
      </p>
    </article>
  );
}
