'use client';

import {
  Badge,
  ListThumb,
  SuperTable,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { formatInstant, known, OFFER_STATUSES } from './format.ts';
import { moveOnEnter } from './grid-keys.ts';
import { OFFER_TONE } from './offer-tone.ts';
import type { OfferColumn } from './offers-columns.ts';
import type { InlineRow } from './offers-inline.tsx';
import { productThumbSrc } from './product-thumb.ts';
import type { OfferListRow } from './types.ts';

/** The name a row goes by: the published product name, else its code. */
export function offerName(offer: OfferListRow, unnamed: string): string {
  return offer.product.name ?? offer.product.productCode ?? unnamed;
}

/**
 * The seller's Offers of one page, from one column definition (`SuperTable`): a box to select the
 * row, the product (the link to the Offer), the status, then the columns the seller chose in their
 * order, and the row Actions menu last. From 1024 px a table; below it each Offer is a card with
 * the product and the state, and the on-sale line.
 */
export function OffersTable({
  marketId,
  rows,
  columns,
  selection,
  empty,
  skeletonRows,
  actions,
  inline,
}: {
  /** The panel's Market: a platform product's thumbnail is served by its public image route. */
  readonly marketId: string;
  readonly rows: readonly OfferListRow[];
  readonly columns: readonly OfferColumn[];
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: OfferListRow) => readonly MenuItem[];
  /** The price and stock cells and the opened sizes (Offer page PR 8); none when not given. */
  readonly inline?: {
    readonly price: boolean;
    readonly stock: boolean;
    readonly priceCell: (row: InlineRow) => ReactNode;
    readonly stockCell: (row: InlineRow) => ReactNode;
    readonly expanded: (row: InlineRow) => ReactNode;
  };
}) {
  const t = useTranslations('catalog.offers');
  const unnamed = useTranslations('catalog.products')('unnamed');
  const notGiven = useTranslations('catalog')('not-given');
  const locale = useLocale();
  const zone = useTimeZone();
  const content = (column: OfferColumn, offer: OfferListRow): ReactNode => {
    switch (column) {
      case 'sku':
        return <span className="break-words">{offer.sellerSku}</span>;
      case 'listed':
        return offer.listed ? t('listed.yes') : t('listed.no');
      case 'submitted':
        return offer.submittedAt === null ? (
          <span className="text-fg-muted">{notGiven}</span>
        ) : (
          formatInstant(offer.submittedAt, locale, zone)
        );
    }
  };

  const defs: SuperColumn<OfferListRow>[] = [
    {
      id: 'product',
      header: t('col.product'),
      primary: true,
      skeleton: 'thumb',
      headClassName: 'lg:min-w-72',
      cell: (offer) => (
        <div className="flex min-w-0 items-center gap-3">
          <ListThumb
            src={productThumbSrc(marketId, { productId: offer.productId, ...offer.product })}
          />
          <div className="min-w-0">
            <a
              className="break-words font-medium text-link underline"
              href={`/offers/${offer.offerId}`}
            >
              {offerName(offer, unnamed)}
            </a>
            {/* The code under the name, as in Products: the cell then fills the thumbnail's
                height, so the name lines up with the other cells (top aligned). */}
            {offer.product.name === null || offer.product.productCode === null ? null : (
              <div className="break-words text-xs text-fg-muted">{offer.product.productCode}</div>
            )}
          </div>
        </div>
      ),
    },
    ...(inline?.price === true
      ? [
          {
            id: 'price',
            header: t('col.price'),
            skeleton: 'number' as const,
            // A fixed width, so the column does not move when an estimate shows under a field.
            headClassName: 'lg:w-44',
            cell: (offer: OfferListRow) =>
              inline.priceCell({ offerId: offer.offerId, name: offerName(offer, unnamed) }),
          },
        ]
      : []),
    ...(inline?.stock === true
      ? [
          {
            id: 'stock',
            header: t('col.stock'),
            skeleton: 'number' as const,
            headClassName: 'lg:w-32',
            cell: (offer: OfferListRow) =>
              inline.stockCell({ offerId: offer.offerId, name: offerName(offer, unnamed) }),
          },
        ]
      : []),
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (offer) => {
        const status = known(offer.status, OFFER_STATUSES);
        return <Badge tone={OFFER_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>;
      },
    },
    ...columns.map((column): SuperColumn<OfferListRow> => ({
      id: column,
      header: t(`col.${column}`),
      ...(column === 'submitted' ? { skeleton: 'date' as const } : {}),
      cell: (offer) => content(column, offer),
    })),
  ];

  return (
    <SuperTable<OfferListRow>
      caption={t('title')}
      rows={rows}
      rowId={(offer) => offer.offerId}
      rowName={(offer) => offerName(offer, unnamed)}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: t('list.select.page'),
          pageShort: t('list.select.page-short'),
          row: (name) => t('list.select.row', { name }),
        },
      }}
      actions={{
        header: t('list.row-actions.header'),
        label: (name) => t('list.row-actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(inline === undefined
        ? {}
        : {
            expanded: (offer: OfferListRow) =>
              inline.expanded({ offerId: offer.offerId, name: offerName(offer, unnamed) }),
            // Enter moves down a column of price or stock fields, as in the opened sizes.
            onKeyDown: moveOnEnter,
          })}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass="lg:min-w-200"
    />
  );
}
