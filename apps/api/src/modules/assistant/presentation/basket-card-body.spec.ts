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
