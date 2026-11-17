import { money } from '@mondapac/shared-kernel';
import { attachSellUnits, offerIdsOf, type SellUnitsByOffer } from './basket-units';
import { planBasket, type BasketCandidate } from './plan-basket';

const candidate = (
  offerId: string,
  name: string,
  cents: bigint,
  priceFrom = false,
): BasketCandidate => ({
  offerId,
  productId: `p-${offerId}`,
  sellerId: 's1',
  sellerName: 'Store',
  name,
  price: money(cents, 'AUD'),
  priceFrom,
  taxInclusive: true,
});

const unit = (variantId: string, cents: bigint, maxQuantity = 5) => ({
  variantId,
  unitPrice: money(cents, 'AUD'),
  maxQuantity,
});

describe('attachSellUnits', () => {
  const proposal = planBasket({
    items: [{ text: 'rice', quantity: 1, unit: null }],
    candidates: [
      [
        candidate('o1', 'Rice', 500n),
        candidate('o2', 'Rice basmati', 700n),
        candidate('o3', 'Rice jasmine', 650n),
      ],
    ],
    mode: 'multi-store',
    goal: 'best-match',
  });

  it('lists each offer once, in card order', () => {
    expect(offerIdsOf(proposal)).toEqual(['o1', 'o2', 'o3']);
  });

  it('picks the unit priced like the card, for lines and for alternatives', () => {
    const units: SellUnitsByOffer = new Map([
      ['o1', [unit('a', 900n), unit('b', 500n, 9)]],
      ['o2', [unit('c', 700n, 2)]],
    ]);
    const filled = attachSellUnits(proposal, units);
    const line = filled.stores[0]!.lines[0]!;
    expect([line.variantId, line.maxQuantity]).toEqual(['b', 9]);
    const byOffer = new Map(line.alternatives.map((option) => [option.offerId, option]));
    expect(byOffer.get('o2')?.variantId).toBe('c');
    expect(byOffer.get('o3')?.variantId).toBeNull();
  });

  it('keeps picks, quantities, prices and totals as the planner made them', () => {
    const filled = attachSellUnits(proposal, new Map([['o1', [unit('b', 500n)]]]));
    expect(filled.total).toEqual(proposal.total);
    expect(filled.stores[0]!.subtotal).toEqual(proposal.stores[0]!.subtotal);
    expect(filled.stores[0]!.lines[0]!.quantity).toBe(proposal.stores[0]!.lines[0]!.quantity);
  });

  it('takes the cheapest unit for a "from" price, and none when no unit has the price', () => {
    const from = planBasket({
      items: [{ text: 'rice', quantity: 1, unit: null }],
      candidates: [[candidate('o1', 'Rice', 500n, true)]],
      mode: 'multi-store',
      goal: 'best-match',
    });
    const cheapest = attachSellUnits(from, new Map([['o1', [unit('a', 900n), unit('b', 500n)]]]));
    const picked = cheapest.stores[0]?.lines[0] ?? cheapest.uncertain[0]?.options[0];
    expect(picked?.variantId).toBe('b');
    const mismatch = attachSellUnits(proposal, new Map([['o1', [unit('a', 999n)]]]));
    expect(mismatch.stores[0]!.lines[0]!.variantId).toBeNull();
  });

  it('gives no unit for a "from" price when the cheapest unit read costs more', () => {
    const from = planBasket({
      items: [{ text: 'rice', quantity: 1, unit: null }],
      candidates: [[candidate('o1', 'Rice', 500n, true)]],
      mode: 'multi-store',
      goal: 'best-match',
    });
    const filled = attachSellUnits(from, new Map([['o1', [unit('a', 900n), unit('b', 700n)]]]));
    const picked = filled.stores[0]?.lines[0] ?? filled.uncertain[0]?.options[0];
    expect(picked?.variantId).toBeNull();
  });

  it('lists picked lines before options and alternatives', () => {
    const ids = offerIdsOf(proposal);
    expect(ids[0]).toBe('o1');
  });

  it('never matches a unit in another currency', () => {
    const other = attachSellUnits(
      proposal,
      new Map([['o1', [{ variantId: 'x', unitPrice: money(500n, 'NZD'), maxQuantity: 5 }]]]),
    );
    expect(other.stores[0]!.lines[0]!.variantId).toBeNull();
  });
});
