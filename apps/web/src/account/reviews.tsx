'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ReviewForm, DeleteReview } from '../reviews/review-form.tsx';
import type { OwnReview, ToReviewProduct, ToReviewSellerOrder } from '../reviews/reviews-model.ts';
import { SellerRatingForm } from '../reviews/seller-rating-form.tsx';
import { Stars } from '../reviews/stars.tsx';
import { useReviews, useWaitingCount } from '../reviews/use-reviews.ts';
import { AccountEmpty, AccountFrame, useDay } from './account-area.tsx';
import { useAccount } from './account-state.tsx';

/** "N things wait for your review" with a link, on Orders; nothing while reviews are off. */
export function ReviewsPrompt() {
  const t = useTranslations('reviews.prompt');
  const { source } = useAccount();
  const count = useWaitingCount(source.live);
  if (count === null || count === 0) return null;
  return (
    <p className="ac-note">
      <span>{t('waiting', { count })}</span> <Link href="/account/reviews">{t('open')}</Link>
    </p>
  );
}

/** The names the account already holds, by id: products by offer, sellers by seller id. */
function useNames() {
  const { orders } = useAccount();
  return useMemo(() => {
    const products = new Map<string, string>();
    const sellers = new Map<string, string>();
    const sellerOrders = new Map<string, string>();
    for (const order of orders)
      for (const part of order.parts) {
        sellers.set(part.sellerId.toLowerCase(), part.sellerName);
        for (const line of part.lines) {
          // A sell unit's key is "<offer id>:<variant id>".
          const offer = line.offerId.split(':')[0];
          if (offer !== undefined) products.set(offer.toLowerCase(), line.name);
        }
      }
    return { products, sellers, sellerOrders };
  }, [orders]);
}

/** Reviews: what waits for one, and what the buyer has written. */
export function AccountReviews() {
  const t = useTranslations('reviews');
  const { source } = useAccount();
  const { state, reload } = useReviews(source.live);
  const names = useNames();
  const day = useDay();
  const [open, setOpen] = useState<string | null>(null);

  if (state.kind === 'loading') {
    return (
      <AccountFrame title={t('account.title')}>
        <p role="status">{t('loading')}</p>
      </AccountFrame>
    );
  }
  if (state.kind === 'off' || state.kind === 'failed') {
    return (
      <AccountFrame title={t('account.title')}>
        <AccountEmpty
          icon="bag"
          title={state.kind === 'off' ? t('account.off') : t('account.failed')}
        >
          <p>{state.kind === 'off' ? t('account.off-body') : t('account.failed-body')}</p>
          <Link className="btn" href="/account/orders">
            {t('account.to-orders')}
          </Link>
        </AccountEmpty>
      </AccountFrame>
    );
  }
  const { toReview, mine } = state;
  const sellerOf = (id: string) => names.sellers.get(id.toLowerCase()) ?? t('account.a-seller');
  const productOf = (offerId: string) =>
    names.products.get(offerId.toLowerCase()) ?? t('account.a-product');
  const visible = mine.reviews.filter((review) => review.status !== 'deleted-by-author');
  const nothing =
    toReview.products.length === 0 && toReview.sellerOrders.length === 0 && visible.length === 0;
  const done = (key: string) => {
    setOpen(null);
    reload();
    void key;
  };
  return (
    <AccountFrame title={t('account.title')}>
      {nothing ? (
        <AccountEmpty icon="bag" title={t('account.nothing')}>
          <p>{t('account.nothing-body')}</p>
        </AccountEmpty>
      ) : null}
      {toReview.products.length === 0 && toReview.sellerOrders.length === 0 ? null : (
        <section className="ac-card" aria-labelledby="rv-to-review">
          <h2 id="rv-to-review">{t('account.to-review')}</h2>
          <ul className="rv-todo">
            {toReview.products.map((item: ToReviewProduct) => {
              const key = `p-${item.productId}`;
              return (
                <li key={key}>
                  <div className="rv-todo-row">
                    <span>
                      <b>{productOf(item.offerId)}</b>
                      <small>
                        {t('account.from', { seller: sellerOf(item.sellerId) })} ·{' '}
                        {t('account.until', { date: day(item.windowEndsAt.slice(0, 10)) })}
                      </small>
                    </span>
                    <button
                      className="btn ghost"
                      type="button"
                      aria-expanded={open === key}
                      onClick={() => setOpen(open === key ? null : key)}
                    >
                      {t('account.write')}
                    </button>
                  </div>
                  {open === key ? (
                    <ReviewForm
                      productId={item.productId}
                      productName={productOf(item.offerId)}
                      onSaved={() => undefined}
                      onCancel={() => setOpen(null)}
                    />
                  ) : null}
                </li>
              );
            })}
            {toReview.sellerOrders.map((item: ToReviewSellerOrder) => {
              const key = `s-${item.sellerOrderId}`;
              return (
                <li key={key}>
                  <div className="rv-todo-row">
                    <span>
                      <b>{t('account.rate-seller', { seller: sellerOf(item.sellerId) })}</b>
                      <small>
                        {t('account.delivered', { date: day(item.deliveredAt.slice(0, 10)) })} ·{' '}
                        {t('account.until', { date: day(item.windowEndsAt.slice(0, 10)) })}
                      </small>
                    </span>
                    <button
                      className="btn ghost"
                      type="button"
                      aria-expanded={open === key}
                      onClick={() => setOpen(open === key ? null : key)}
                    >
                      {t('account.rate')}
                    </button>
                  </div>
                  {open === key ? (
                    <SellerRatingForm
                      sellerOrderId={item.sellerOrderId}
                      sellerName={sellerOf(item.sellerId)}
                      onSaved={() => done(key)}
                      onCancel={() => setOpen(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {visible.length === 0 ? null : (
        <section className="ac-card" aria-labelledby="rv-mine">
          <h2 id="rv-mine">{t('account.mine')}</h2>
          <ul className="rv-todo">
            {visible.map((review) => (
              <li key={review.id}>
                <OwnReviewRow
                  review={review}
                  name={productOf(review.offerId)}
                  editing={open === `r-${review.id}`}
                  onEdit={() => setOpen(open === `r-${review.id}` ? null : `r-${review.id}`)}
                  onChanged={() => done(review.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </AccountFrame>
  );
}

function OwnReviewRow({
  review,
  name,
  editing,
  onEdit,
  onChanged,
}: {
  readonly review: OwnReview;
  readonly name: string;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('reviews');
  const day = useDay();
  const editable = Date.parse(review.editableUntil) > Date.now();
  return (
    <div className="rv-own">
      <div className="rv-todo-row">
        <span>
          <Link href={`/p/${review.productId}`}>
            <b>{name}</b>
          </Link>
          <Stars value={review.rating} label={t('rating-label', { stars: review.rating })} />
          <span className={`ac-badge ${review.status === 'published' ? 'ok' : 'wait'}`}>
            {t(`status.${review.status}`)}
          </span>
        </span>
      </div>
      {review.title ? <b dir="auto">{review.title}</b> : null}
      {review.body ? (
        <p className="rv-body" dir="auto">
          {review.body}
        </p>
      ) : null}
      {editing ? (
        <ReviewForm
          productId={review.productId}
          productName={name}
          existing={review}
          onSaved={onChanged}
          onCancel={onEdit}
        />
      ) : (
        <div className="ac-acts">
          {editable ? (
            <button className="btn ghost" type="button" onClick={onEdit}>
              {t('account.edit')}
            </button>
          ) : (
            <small>
              {t('account.edit-closed', { date: day(review.editableUntil.slice(0, 10)) })}
            </small>
          )}
          <DeleteReview review={review} onDeleted={onChanged} />
        </div>
      )}
    </div>
  );
}
