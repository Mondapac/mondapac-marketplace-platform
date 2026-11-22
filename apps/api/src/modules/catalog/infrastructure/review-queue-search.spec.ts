import type { Id } from '@mondapac/shared-kernel';
import { offerQueueSearchWhere, revisionQueueSearchWhere } from './review-queue-search';

// The review queue search conditions: the text is matched as typed (`\`, `%` and `_` escaped for
// the ILIKE Prisma builds from `contains`), case-insensitively, on the product code, the name the
// row shows (in the asked locale) and the matched stores.

const SELLER = '01990000-0000-7000-8000-000000002001' as Id<'Seller'>;

describe('review queue search conditions', () => {
  it('escapes the LIKE wildcards and the escape character of an Offer row search', () => {
    const where = offerQueueSearchWhere({ text: '50%_off\\', locale: 'en', sellerIds: [SELLER] });
    const part = { contains: '50\\%\\_off\\\\', mode: 'insensitive' };
    expect(where).toEqual({
      OR: [
        { product: { is: { productCode: part } } },
        {
          product: {
            is: { publishedRevision: { is: { texts: { some: { locale: 'en', name: part } } } } },
          },
        },
        { sellerId: { in: [SELLER] } },
      ],
    });
  });

  it('searches a product revision row on its code, its pending name and its store', () => {
    const where = revisionQueueSearchWhere({ text: 'a_b', locale: 'ms-MY', sellerIds: [SELLER] });
    const part = { contains: 'a\\_b', mode: 'insensitive' };
    expect(where).toEqual({
      OR: [
        { productCode: part },
        { pendingRevision: { is: { texts: { some: { locale: 'ms-MY', name: part } } } } },
        { ownerSellerId: { in: [SELLER] } },
      ],
    });
  });

  it('leaves the store condition out when no store matched', () => {
    const offer = offerQueueSearchWhere({ text: 'dates', locale: 'en', sellerIds: [] });
    const revision = revisionQueueSearchWhere({ text: 'dates', locale: 'en', sellerIds: [] });
    expect(offer.OR).toHaveLength(2);
    expect(revision.OR).toHaveLength(2);
  });
});
