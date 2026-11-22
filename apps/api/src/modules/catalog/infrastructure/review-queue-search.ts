import type { Prisma } from '../../../generated/prisma/client';
import type { QueueTextSearch } from '../application/ports/own-catalog.reader';
import { likeLiteral } from './like-literal';

// The text search of the review queue (`q`), one condition per kind of row, so the list and its
// count read the same rows. The text is a bound parameter of an ILIKE with its `\`, `%` and `_`
// escaped, as on the admin Products list. The queue rows are found through the partial queue
// indexes first (`pending-first-publish` Offers, products with a pending revision); the search then
// filters those few rows through the product (unique `market_id, id`) and the revision texts
// (primary key `market_id, revision_id, locale`), so it needs no index of its own.

const contains = (text: string) => ({ contains: likeLiteral(text), mode: 'insensitive' as const });

/** An Offer row: its product's code or published name, or a matching store. */
export function offerQueueSearchWhere(search: QueueTextSearch): Prisma.CatalogOfferWhereInput {
  const part = contains(search.text);
  return {
    OR: [
      { product: { is: { productCode: part } } },
      {
        product: {
          is: {
            publishedRevision: {
              is: { texts: { some: { locale: search.locale, name: part } } },
            },
          },
        },
      },
      ...(search.sellerIds.length === 0 ? [] : [{ sellerId: { in: [...search.sellerIds] } }]),
    ],
  };
}

/** A product revision row: the product code, the pending revision's name, or a matching store. */
export function revisionQueueSearchWhere(search: QueueTextSearch): Prisma.CatalogProductWhereInput {
  const part = contains(search.text);
  return {
    OR: [
      { productCode: part },
      { pendingRevision: { is: { texts: { some: { locale: search.locale, name: part } } } } },
      ...(search.sellerIds.length === 0 ? [] : [{ ownerSellerId: { in: [...search.sellerIds] } }]),
    ],
  };
}
