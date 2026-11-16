import { money } from '@mondapac/shared-kernel';
import { planBasket } from '../domain/plan-basket';
import { basketCardBody } from './basket-card-body';

describe('basketCardBody', () => {
  it('writes money as strings and survives JSON', () => {
    const price = money(1250n, 'AUD');
    const proposal = planBasket({
      items: [
        { text: 'rice', quantity: 2, unit: null },
        { text: 'saffron', quantity: 1, unit: null },
      ],
      candidates: [
        [
          {
            offerId: 'o1',
            productId: 'p1',
            sellerId: 's1',
            sellerName: 'Farm',
            name: 'Rice',
            price,
            priceFrom: false,
            taxInclusive: true,
          },
        ],
        [],
      ],
      mode: 'multi-store',
      goal: 'best-match',
    });
    const body = JSON.parse(JSON.stringify(basketCardBody(proposal))) as {
      kind: string;
      proposal: {
        total: unknown;
        stores: { lines: { lineTotal: unknown }[] }[];
        notFound: unknown[];
      };
    };
    expect(body.kind).toBe('basket-proposal');
    expect(body.proposal.total).toEqual({ amount: '2500', currency: 'AUD' });
    expect(body.proposal.stores[0]!.lines[0]!.lineTotal).toEqual({
      amount: '2500',
      currency: 'AUD',
    });
    expect(body.proposal.notFound).toEqual([
      { itemIndex: 1, text: 'saffron', reason: 'not-found' },
    ]);
  });
});

describe.each(['AUD', 'NZD'])(
  'basketCardBody in %s, single-store with an unsure line',
  (currency) => {
    it('carries options, alternatives, alternative stores and nulls', () => {
      const cand = (offer: string, seller: string, name: string, cents: bigint) => ({
        offerId: offer,
        productId: `p-${offer}`,
        sellerId: seller,
        sellerName: `Store ${seller}`,
        name,
        price: money(cents, currency),
        priceFrom: false,
        taxInclusive: true,
      });
      const proposal = planBasket({
        items: [
          { text: 'rice', quantity: 1, unit: null },
          { text: 'dates', quantity: 500, unit: 'g' },
        ],
        candidates: [
          [
            cand('r1', 'A', 'Rice', 500n),
            cand('r2', 'B', 'Rice', 450n),
            cand('r3', 'B', 'Rice basmati', 700n),
          ],
          [cand('d1', 'B', 'Medjool dates', 900n)],
        ],
        mode: 'single-store',
        goal: 'best-match',
      });
      const body = JSON.parse(JSON.stringify(basketCardBody(proposal))) as {
        proposal: {
          stores: { lines: { alternatives: unknown[] }[] }[];
          uncertain: { options: { quantity: unknown; sizeNote: unknown; price: unknown }[] }[];
          alternativeStores: { total: unknown }[];
        };
      };
      expect(body.proposal.stores[0]!.lines[0]!.alternatives).toHaveLength(1);
      expect(body.proposal.uncertain[0]!.options[0]).toMatchObject({
        quantity: null,
        sizeNote: null,
        price: { amount: '900', currency },
      });
      expect(body.proposal.alternativeStores[0]!.total).toEqual({ amount: '500', currency });
    });
  },
);
