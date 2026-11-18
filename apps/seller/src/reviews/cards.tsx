'use client';

import { Badge, Icon, Menu, SelectBox, type MenuItem, type RowSelectionState } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../catalog/format.ts';
import type { ReviewColumn } from './columns.ts';
import type { SellerReply, SellerReviewRow } from './types.ts';

/** Stars as an icon row with the number as text, so the colour or shape is never the only signal. */
function Stars({ rating }: { readonly rating: number }) {
  const t = useTranslations('reviews');
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={t('stars', { rating })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon key={n} name="star" className={n <= rating ? 'text-attention-fg' : 'text-fg-muted'} />
      ))}
    </span>
  );
}

function ReplyBlock({ reply }: { readonly reply: SellerReply }) {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const zone = useTimeZone();
  const editable = Date.parse(reply.editableUntil) > Date.now();
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
 * The reviews of one page, one card each (reviews keep their card layout): a box to select the
 * review, the stars, the date and the links, the title and the text, the shop's reply, and the row
 * Actions menu in the corner. No buttons sit inside a card. Review text is plain text from a
 * buyer: it is rendered as text and never as markup, and the buyer's name is never shown.
 */
export function ReviewCards({
  rows,
  columns,
  selection,
  actions,
  reported,
  selectPageLabel,
}: {
  readonly rows: readonly SellerReviewRow[];
  readonly columns: readonly ReviewColumn[];
  readonly selection: RowSelectionState;
  readonly actions: (row: SellerReviewRow) => readonly MenuItem[];
  /** Reviews reported in this visit: they carry a badge. */
  readonly reported: ReadonlySet<string>;
  readonly selectPageLabel: string;
}) {
  const t = useTranslations('reviews');
  const locale = useLocale();
  const zone = useTimeZone();
  const has = (column: ReviewColumn) => columns.includes(column);
  const ticked = (row: SellerReviewRow) => selection.allMatching || selection.selected.has(row.id);
  const onPage = rows.filter(ticked).length;
  const all = rows.length > 0 && onPage === rows.length;

  const detail = (column: ReviewColumn, review: SellerReviewRow, name: string): ReactNode => {
    switch (column) {
      case 'published':
        return review.publishedAt === null ? null : (
          <time key={column} className="text-sm text-fg-muted" dateTime={review.publishedAt}>
            {shortInstant(review.publishedAt, locale, zone)}
          </time>
        );
      case 'product':
        return (
          <a
            key={column}
            className="inline-flex min-h-8 items-center text-sm text-link underline"
            href={`/products/${review.productId}`}
            aria-label={t('list.link-product', { name })}
          >
            {t('product-link')}
          </a>
        );
      case 'order':
        return review.orderRef === null ? null : (
          <a
            key={column}
            className="text-sm text-link underline"
            href={`/orders/${review.orderRef}`}
          >
            {t('order-link')}
          </a>
        );
      case 'reply':
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? null : (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-muted px-4 py-3 text-sm text-fg-muted">
          <SelectBox
            label={selectPageLabel}
            checked={all}
            indeterminate={onPage > 0 && !all}
            onChange={(event) => selection.togglePage(event.target.checked)}
          />
          <span className="ps-1" aria-hidden="true">
            {selectPageLabel}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((review) => {
          const items = actions(review);
          const name = review.title ?? t('list.untitled', { rating: review.rating });
          return (
            <li
              key={review.id}
              className={`rounded-lg border border-line p-4 ${ticked(review) ? 'bg-selected' : 'bg-surface'}`}
            >
              <article className="flex flex-col gap-3">
                <header className="flex items-start gap-3">
                  <span className="pt-1">
                    <SelectBox
                      label={t('list.select.row', { name })}
                      checked={ticked(review)}
                      onChange={() => selection.toggleRow(review.id)}
                    />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                    <Stars rating={review.rating} />
                    {columns.map((column) => detail(column, review, name))}
                    {reported.has(review.id) ? (
                      <Badge tone="info">{t('report.sent-badge')}</Badge>
                    ) : null}
                  </div>
                  {items.length === 0 ? null : (
                    <Menu label={t('list.row-actions.for', { name })} items={items} />
                  )}
                </header>
                {review.title === null ? null : (
                  <h2 className="break-words text-base font-medium">{review.title}</h2>
                )}
                {review.body === null ? (
                  <p className="text-sm text-fg-muted">{t('no-text')}</p>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{review.body}</p>
                )}
                {has('reply') && review.reply !== null ? <ReplyBlock reply={review.reply} /> : null}
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
