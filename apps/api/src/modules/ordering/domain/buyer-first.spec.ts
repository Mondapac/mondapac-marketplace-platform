import type { Id } from '@mondapac/shared-kernel';
import { buyerFirstOf, type BuyerFirstClaims } from './buyer-first';

const ORDER = '0195a000-0000-7000-8000-000000000001' as Id<'Order'>;
const EARLIER = '0195a000-0000-7000-8000-000000000002' as Id<'Order'>;
const S1 = '0195a000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const S2 = '0195a000-0000-7000-8000-0000000000a2' as Id<'Seller'>;
const SO1 = '0195a000-0000-7000-8000-0000000000b1' as Id<'SellerOrder'>;
const SO2 = '0195a000-0000-7000-8000-0000000000b2' as Id<'SellerOrder'>;

const confirmed = {
  id: ORDER,
  status: 'confirmed' as const,
  sellerOrders: [
    { id: SO1, sellerId: S1 },
    { id: SO2, sellerId: S2 },
  ],
};

const claims = (
  firstOrderId: Id<'Order'>,
  withSeller: readonly (readonly [Id<'Seller'>, Id<'Order'>])[],
): BuyerFirstClaims => ({ firstOrderId, firstWithSeller: new Map(withSeller) });

describe('buyerFirstOf', () => {
  it('marks every seller order of the first order first, and first with its seller', () => {
    const flags = buyerFirstOf(
      confirmed,
      claims(ORDER, [
        [S1, ORDER],
        [S2, ORDER],
      ]),
    );
    expect(flags.get(SO1)).toEqual({ order: true, withSeller: true });
    expect(flags.get(SO2)).toEqual({ order: true, withSeller: true });
  });

  it('marks a returning buyer not first, yet first with a seller it never bought from', () => {
    const flags = buyerFirstOf(
      confirmed,
      claims(EARLIER, [
        [S1, EARLIER],
        [S2, ORDER],
      ]),
    );
    expect(flags.get(SO1)).toEqual({ order: false, withSeller: false });
    expect(flags.get(SO2)).toEqual({ order: false, withSeller: true });
  });

  it('gives null (unknown) to a seller order whose claims are missing or contradict', () => {
    const flags = buyerFirstOf(confirmed, claims(ORDER, [[S1, EARLIER]]));
    // First order in the Market, yet another order is first with S1: only a corrupted claim says so.
    expect(flags.get(SO1)).toBeNull();
    expect(flags.get(SO2)).toBeNull();
  });

  it('gives no flags to an order that is not confirmed', () => {
    for (const status of ['pending-payment', 'cancelled'] as const) {
      expect(buyerFirstOf({ ...confirmed, status }, claims(ORDER, [[S1, ORDER]])).size).toBe(0);
    }
  });
});
