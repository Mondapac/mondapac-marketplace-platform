import { money } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import {
  MAX_ALTERNATIVE_STORES,
  planBasket,
  type BasketCandidate,
  type BasketItem,
  type CartMode,
} from './plan-basket';

// The planner is pure: the same list and results always give the same basket. Every fixture runs
// in both cart modes and in two currencies (the Market fixtures of CLAUDE.md).

const CURRENCIES = ['AUD', 'NZD'] as const;

describe.each(CURRENCIES)('planBasket (%s)', (currency) => {
  const price = (cents: number): Money => money(BigInt(cents), currency);
  const cand = (
    offer: string,
    seller: string,
    name: string,
    cents: number | null,
    extra: Partial<BasketCandidate> = {},
  ): BasketCandidate => ({
    offerId: offer,
    productId: `p-${offer}`,
    sellerId: seller,
    sellerName: `Store ${seller}`,
    name,
    price: cents === null ? null : price(cents),
    priceFrom: false,
    taxInclusive: true,
    ...extra,
  });
  const item = (text: string, quantity = 1, unit: BasketItem['unit'] = null): BasketItem => ({
    text,
    quantity,
    unit,
  });
  const plan = (
    mode: CartMode,
    items: readonly BasketItem[],
    candidates: readonly (readonly BasketCandidate[])[],
  ) => planBasket({ items, candidates, mode, goal: 'best-match' });

  describe('multi-store', () => {
    it('takes the best match of each line from any store and groups by store with subtotals', () => {
      const result = plan(
        'multi-store',
        [item('basmati rice', 2, 'kg'), item('full cream milk', 2, 'l'), item('eggs', 12, 'each')],
        [
          [cand('o1', 'A', 'Basmati Rice 1 kg', 500), cand('o2', 'B', 'Basmati Rice 2 kg', 900)],
          [cand('o3', 'B', 'Full Cream Milk 1 L', 200)],
          [cand('o4', 'A', 'Eggs 12 pack', 650)],
        ],
      );
      expect(result.mode).toBe('multi-store');
      // 2 kg of rice: two 1 kg packs from the first (best-ranked) result.
      const [storeA, storeB] = result.stores;
      expect(storeA!.sellerId).toBe('A');
      expect(storeA!.lines.map((line) => [line.text, line.quantity])).toEqual([
        ['basmati rice', 2],
        ['eggs', 12],
      ]);
      expect(storeA!.subtotal).toEqual(price(2 * 500 + 12 * 650));
      expect(storeB!.lines[0]).toMatchObject({ text: 'full cream milk', quantity: 2 });
      expect(storeB!.subtotal).toEqual(price(400));
      expect(result.total).toEqual(price(2 * 500 + 12 * 650 + 400));
      expect(result.uncertain).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.alternativeStores).toEqual([]);
      expect(result.deliveryShownAtCheckout).toBe(true);
    });

    it('rounds packs up and notes a larger pack, and keeps an exact pack exact', () => {
      const result = plan(
        'multi-store',
        [item('flour', 1.5, 'kg'), item('sugar', 1, 'kg')],
        [[cand('o1', 'A', 'Plain Flour 1 kg', 300)], [cand('o2', 'A', 'White Sugar 1kg', 250)]],
      );
      const [flour, sugar] = result.stores[0]!.lines;
      expect(flour).toMatchObject({ quantity: 2, sizeNote: 'larger' });
      expect(sugar).toMatchObject({ quantity: 1, sizeNote: 'exact' });
    });

    it('does not pick a pack more than twice what was asked: it becomes an option', () => {
      const result = plan(
        'multi-store',
        [item('rice', 1, 'kg')],
        [[cand('o1', 'A', 'Rice 5 kg', 2000), cand('o2', 'A', 'Rice 1 kg', 500)]],
      );
      expect(result.stores[0]!.lines[0]).toMatchObject({ offerId: 'o2', quantity: 1 });
      const tooBig = plan(
        'multi-store',
        [item('rice', 1, 'kg')],
        [[cand('o1', 'A', 'Rice 5 kg', 2000)]],
      );
      expect(tooBig.stores).toEqual([]);
      expect(tooBig.uncertain[0]!.options.map((option) => option.offerId)).toEqual(['o1']);
    });

    it('asks the buyer when a weight is wanted and the name has no size', () => {
      const result = plan(
        'multi-store',
        [item('dates', 500, 'g')],
        [[cand('o1', 'A', 'Medjool Dates', 1200), cand('o2', 'B', 'Dates Deluxe', 1100)]],
      );
      expect(result.stores).toEqual([]);
      expect(result.uncertain).toHaveLength(1);
      expect(
        result.uncertain[0]!.options.map((option) => [option.offerId, option.quantity]),
      ).toEqual([
        ['o1', null],
        ['o2', null],
      ]);
      expect(result.total).toBeNull();
    });

    it('marks a line unsure (2 to 3 options) when no result carries all its words', () => {
      const result = plan(
        'multi-store',
        [item('sourdough bread')],
        [
          [
            cand('o1', 'A', 'White Bread', 400),
            cand('o2', 'B', 'Rye Bread', 450),
            cand('o3', 'C', 'Bread Rolls', 300),
            cand('o4', 'D', 'Flatbread', 350),
          ],
        ],
      );
      expect(result.stores).toEqual([]);
      expect(result.uncertain[0]!.options.map((option) => option.offerId)).toEqual([
        'o1',
        'o2',
        'o3',
      ]);
    });

    it('reports a line with no result as not found, and drops results with no price', () => {
      const result = plan(
        'multi-store',
        [item('saffron'), item('tea')],
        [[], [cand('o1', 'A', 'Black Tea', null)]],
      );
      expect(result.notFound).toEqual([
        { itemIndex: 0, text: 'saffron', reason: 'not-found' },
        { itemIndex: 1, text: 'tea', reason: 'not-found' },
      ]);
      expect(result.total).toBeNull();
    });

    it('matches Persian and mixed lists, with Eastern digits and look-alike letters', () => {
      const result = plan(
        'multi-store',
        [item('برنج ایرانی', 2, 'kg'), item('chickpeas', 1, 'kg')],
        [[cand('o1', 'A', 'برنج ایرانی ۱ کیلوگرم', 800)], [cand('o2', 'A', 'Chickpeas 1kg', 400)]],
      );
      expect(result.stores[0]!.lines.map((line) => [line.offerId, line.quantity])).toEqual([
        ['o1', 2],
        ['o2', 1],
      ]);
    });

    it('offers up to two other fitting products to swap, never the same offer', () => {
      const result = plan(
        'multi-store',
        [item('milk')],
        [
          [
            cand('o1', 'A', 'Milk 1 L', 200),
            cand('o2', 'B', 'Milk 2 L', 380),
            cand('o3', 'C', 'Milk 1 L Organic', 300),
            cand('o4', 'D', 'Milk Powder', 900),
          ],
        ],
      );
      const [line] = result.stores[0]!.lines;
      expect(line!.offerId).toBe('o1');
      expect(line!.alternatives.map((option) => option.offerId)).toEqual(['o2', 'o3']);
    });

    it('is a from-price total when a line has Variants at different prices', () => {
      const result = plan(
        'multi-store',
        [item('shirt')],
        [[cand('o1', 'A', 'Shirt', 2000, { priceFrom: true })]],
      );
      expect(result.stores[0]!.subtotalIsFrom).toBe(true);
      expect(result.totalIsFrom).toBe(true);
    });

    it('ignores a result in a different currency from the list and repeated offers', () => {
      const result = plan(
        'multi-store',
        [item('rice')],
        [
          [
            cand('o1', 'A', 'Rice', 500),
            { ...cand('o2', 'B', 'Rice', 100), price: money(100n, 'JPY') },
            cand('o1', 'A', 'Rice', 500),
          ],
        ],
      );
      expect(result.stores[0]!.lines[0]!.alternatives).toEqual([]);
    });
  });

  describe('single-store', () => {
    const items = [item('rice'), item('milk'), item('eggs')];
    const candidates = [
      [cand('r1', 'A', 'Rice', 500), cand('r2', 'B', 'Rice', 450)],
      [cand('m1', 'A', 'Milk', 200), cand('m2', 'B', 'Milk', 190)],
      [cand('e2', 'B', 'Eggs', 600)],
    ];

    it('chooses the store with the most lines covered and lists the next best stores', () => {
      const result = plan('single-store', items, candidates);
      expect(result.mode).toBe('single-store');
      expect(result.stores).toHaveLength(1);
      expect(result.stores[0]!.sellerId).toBe('B');
      expect(result.stores[0]!.lines.map((line) => line.offerId)).toEqual(['r2', 'm2', 'e2']);
      expect(result.total).toEqual(price(450 + 190 + 600));
      expect(result.alternativeStores).toEqual([
        { sellerId: 'A', sellerName: 'Store A', covered: 2, total: price(700) },
      ]);
    });

    it('breaks a tie in coverage by the lower total, then by the store id', () => {
      const tie = plan(
        'single-store',
        [item('rice')],
        [
          [
            cand('r1', 'A', 'Rice', 500),
            cand('r2', 'B', 'Rice', 450),
            cand('r3', 'C', 'Rice', 450),
          ],
        ],
      );
      expect(tie.stores[0]!.sellerId).toBe('B');
      expect(tie.alternativeStores.map((store) => store.sellerId)).toEqual(['C', 'A']);
    });

    it('says which lines the chosen store does not have, and offers its own options for unsure ones', () => {
      const result = plan(
        'single-store',
        [item('rice'), item('saffron'), item('sourdough bread'), item('tea'), item('oil')],
        [
          [cand('r1', 'A', 'Rice', 500)],
          [],
          [cand('b1', 'A', 'White Bread', 400), cand('b2', 'B', 'Rye Bread', 400)],
          [cand('t2', 'B', 'Tea', 300)],
          [cand('l1', 'A', 'Oil', 700)],
        ],
      );
      expect(result.stores[0]!.sellerId).toBe('A');
      expect(result.notFound).toEqual([
        { itemIndex: 1, text: 'saffron', reason: 'not-found' },
        { itemIndex: 3, text: 'tea', reason: 'not-in-store' },
      ]);
      expect(result.uncertain).toEqual([
        expect.objectContaining({
          itemIndex: 2,
          options: [expect.objectContaining({ offerId: 'b1', sellerId: 'A' })],
        }),
      ]);
    });

    it('shows at most three other stores', () => {
      const many = plan(
        'single-store',
        [item('rice')],
        [[...'ABCDEFG'].map((seller, index) => cand(`r${seller}`, seller, 'Rice', 500 + index))],
      );
      expect(many.alternativeStores).toHaveLength(MAX_ALTERNATIVE_STORES);
    });

    it('has no store when nothing fits; lines fall to options or not found', () => {
      const result = plan('single-store', [item('tea')], [[cand('t1', 'A', 'Coffee', 300)]]);
      expect(result.stores).toEqual([]);
      expect(result.uncertain).toHaveLength(1);
      expect(result.alternativeStores).toEqual([]);
    });
  });

  it('gives the same basket for the same input', () => {
    const input = {
      items: [item('rice', 2, 'kg'), item('milk')],
      candidates: [
        [cand('r1', 'A', 'Rice 1 kg', 500), cand('r2', 'B', 'Rice 1 kg', 400)],
        [cand('m1', 'B', 'Milk', 200)],
      ],
      goal: 'best-match' as const,
    };
    for (const mode of ['multi-store', 'single-store'] as const) {
      expect(planBasket({ ...input, mode })).toEqual(planBasket({ ...input, mode }));
    }
  });

  it('handles a list with no results at all', () => {
    const result = plan('multi-store', [item('a b')], [[]]);
    expect(result.itemCount).toBe(1);
    expect(result.total).toBeNull();
    expect(result.totalIsFrom).toBe(false);
  });
});
