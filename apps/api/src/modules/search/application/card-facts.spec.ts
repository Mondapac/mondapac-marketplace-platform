import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  CARD_BADGE_BATCH,
  CARD_FACTS_DEADLINE_MS,
  MAX_CARD_BADGES,
  cardBadgesOf,
  withCardFacts,
} from './card-facts';
import type { DetailBadge } from './ports/product-detail-sources';
import { StubCardFacts } from './testing/stub-card-facts';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const variant = (n: number): Id<'Variant'> => id<'Variant'>(0x2000 + n);
const seller = (n: number): Id<'Seller'> => id<'Seller'>(0x5000 + n);

const badge = (typeCode: string, over: Partial<DetailBadge> = {}): DetailBadge => ({
  typeCode,
  typeName: `${typeCode} certified`,
  artworkKey: typeCode,
  basis: 'SELLER',
  sellerClaim: false,
  issuerName: 'Council',
  validUntilLocalDate: '2027-01-31',
  verifiedWithIssuer: true,
  ...over,
});

interface Item {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly cartVariantId: Id<'Variant'> | null;
}
const item = (n: number, cart: Id<'Variant'> | null = variant(n)): Item => ({
  offerId: offer(n),
  sellerId: seller(n % 2),
  cartVariantId: cart,
});
const unitOf = (i: Item) => i.cartVariantId;

// The card facts of a list (seller name, seals, "Only N left"), for both Market fixtures. Seals are
// catalog's live badges copied field by field (AI rule R1: never built here); every source fails
// soft, so a list never fails for a card fact.
describe.each(['AU', 'ZZ'] as const)('card facts in market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  let cards: StubCardFacts;

  beforeEach(() => {
    cards = new StubCardFacts();
  });

  it('adds the store name, the seals and the low band of the cart unit to each item', async () => {
    cards.sellerNames.set(seller(1), { storeName: 'Kedron Farms' });
    cards.offerBadges.set(offer(1), [badge('halal'), badge('vegan')]);
    cards.setStock(offer(1), variant(1), { status: 'low', onlyLeft: 3 });

    const [first] = await withCardFacts(cards, context, [item(1)], unitOf);

    expect(first).toEqual({
      ...item(1),
      sellerName: 'Kedron Farms',
      badges: [
        { typeCode: 'halal', typeName: 'halal certified', artworkKey: 'halal' },
        { typeCode: 'vegan', typeName: 'vegan certified', artworkKey: 'vegan' },
      ],
      onlyLeft: 3,
    });
  });

  it('shows no count outside the low band and none for a card without one cart unit', async () => {
    cards.setStock(offer(1), variant(1), { status: 'in-stock', onlyLeft: null });
    cards.setStock(offer(2), variant(2), { status: 'out', onlyLeft: null });
    cards.setStock(offer(3), variant(9), { status: 'low', onlyLeft: 2 });

    const facts = await withCardFacts(cards, context, [item(1), item(2), item(3, null)], unitOf);

    expect(facts.map((f) => f.onlyLeft)).toEqual([null, null, null]);
    // Only the units the cards cart are asked: never a Variant the card does not name.
    expect(cards.stockCalls).toEqual([
      [
        { offerId: offer(1), variantId: variant(1) },
        { offerId: offer(2), variantId: variant(2) },
      ],
    ]);
  });

  it("never makes a seal of a seller's own declaration; one per type, at most two", () => {
    expect(
      cardBadgesOf([
        badge('halal', { sellerClaim: true }),
        badge('kosher', { basis: 'MANUFACTURER' }),
        badge('kosher'),
        badge('vegan'),
        badge('organic'),
        badge('leaf'),
      ]).map((seal) => seal.typeCode),
    ).toEqual(['kosher', 'vegan']);
    expect(MAX_CARD_BADGES).toBe(2);
    expect(cardBadgesOf(undefined)).toEqual([]);
  });

  it('asks catalog for badges in batches of twenty (its limit)', async () => {
    const items = Array.from({ length: 45 }, (_, n) => item(n + 1));
    cards.offerBadges.set(offer(45), [badge('halal')]);

    const facts = await withCardFacts(cards, context, items, unitOf);

    expect(cards.badgeCalls.map((call) => call.length)).toEqual([CARD_BADGE_BATCH, 20, 5]);
    expect(facts[44]?.badges).toHaveLength(1);
  });

  it.each(['sellers', 'availability', 'badges'] as const)(
    'gives every card none of a fact whose source (%s) cannot answer, and keeps the rest',
    async (down) => {
      cards.sellerNames.set(seller(1), { storeName: 'Kedron Farms' });
      cards.offerBadges.set(offer(1), [badge('halal')]);
      cards.setStock(offer(1), variant(1), { status: 'low', onlyLeft: 2 });
      cards.failing.add(down);

      const [first] = await withCardFacts(cards, context, [item(1)], unitOf);

      expect(first?.sellerName).toBe(down === 'sellers' ? null : 'Kedron Farms');
      expect(first?.onlyLeft).toBe(down === 'availability' ? null : 2);
      expect(first?.badges).toHaveLength(down === 'badges' ? 0 : 1);
    },
  );

  it('drops every seal when one badge batch fails (all or none)', async () => {
    const items = Array.from({ length: 21 }, (_, n) => item(n + 1));
    cards.offerBadges.set(offer(1), [badge('halal')]);
    const real = cards.badges.bind(cards);
    let call = 0;
    cards.badges = (ctx, ids) => (++call === 2 ? Promise.resolve(null) : real(ctx, ids));

    const facts = await withCardFacts(cards, context, items, unitOf);

    expect(facts.every((f) => f.badges.length === 0)).toBe(true);
  });

  it('gives no fact for a source that throws or is slower than the deadline', async () => {
    jest.useFakeTimers();
    try {
      cards.sellers = () => Promise.reject(new Error('down'));
      cards.badges = () => new Promise(() => undefined);
      const pending = withCardFacts(cards, context, [item(1)], unitOf);
      await jest.advanceTimersByTimeAsync(CARD_FACTS_DEADLINE_MS);
      const [first] = await pending;
      expect(first).toMatchObject({ sellerName: null, badges: [] });
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a blank store name as none and reads nothing for an empty list', async () => {
    cards.sellerNames.set(seller(1), { storeName: '  ' });
    const [first] = await withCardFacts(cards, context, [item(1)], unitOf);
    expect(first?.sellerName).toBeNull();
    cards.badgeCalls.length = 0;
    expect(await withCardFacts(cards, context, [], unitOf)).toEqual([]);
    expect(cards.badgeCalls).toEqual([]);
  });
});
