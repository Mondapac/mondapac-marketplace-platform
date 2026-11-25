import type { Prisma } from '../../../generated/prisma/client';
import type { OfferQueueFilter, QueueTextSearch } from '../application/ports/own-catalog.reader';
import { likeLiteral } from './like-literal';

// The text search of the review queue (`q`), one condition per kind of row, so the list and its
// count read the same rows. The text is a bound parameter of an ILIKE with its `\`, `%` and `_`
// escaped, as on the admin Products list. Expected plan, not measured: the partial queue indexes
// (`pending-first-publish` Offers, products with a pending revision) pick the few queue rows and the
// search filters them. Prisma compiles the to-one relation filters to uncorrelated `IN (SELECT ...)`
// subqueries inside an OR, which Postgres may run per row or hashed (a scan of the whole products,
// revisions and texts tables); which one depends on its estimates. Fine at today's volume. Before
// the catalogue reaches about 100k products, or on the first slow-query report, capture
// `EXPLAIN (ANALYZE, BUFFERS)` on seeded data; if a hashed SubPlan shows up, move this search to a
// `$queryRaw` with a correlated EXISTS carrying `market_id`, rather than add a trigram index.

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

/**
 * The conditions of an Offer queue filter beyond seller and submit window, for the list and its
 * count alike: the text search, the platform category of the product's published revision (an
 * uncorrelated relation filter on catalog's own tables, as the held-edit list's) and the Offer ids
 * of a resolved `reasons` filter (an empty list keeps none).
 */
export function offerQueueAnd(filter: OfferQueueFilter): Prisma.CatalogOfferWhereInput[] {
  const and: Prisma.CatalogOfferWhereInput[] = [];
  if (filter.search !== undefined) and.push(offerQueueSearchWhere(filter.search));
  if (filter.categoryId !== undefined) {
    and.push({
      product: {
        is: {
          publishedRevision: { is: { categories: { some: { categoryId: filter.categoryId } } } },
        },
      },
    });
  }
  if (filter.offerIds !== undefined) and.push({ id: { in: [...filter.offerIds] } });
  return and;
}
