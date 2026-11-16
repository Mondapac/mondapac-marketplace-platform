import { money, ok, err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { BasketSources } from '../application/ports/basket-sources';
import type { BasketCandidate, CartMode } from '../domain/plan-basket';
import type { ToolRequest } from '../domain/tools';
import { BasketAssistantTools } from './basket-assistant-tools';

const cand = (
  offer: string,
  seller: string,
  name: string,
  cents: number,
  currency: string,
): BasketCandidate => ({
  offerId: offer,
  productId: `p-${offer}`,
  sellerId: seller,
  sellerName: `Store ${seller}`,
  name,
  price: money(BigInt(cents), currency),
  priceFrom: false,
  taxInclusive: true,
});

describe.each(TEST_MARKET_IDS)('BasketAssistantTools in market %s', (marketCode) => {
  const context: CallContext = testCallContext(
    testMarketContext(marketCode, 'default'),
    'anonymous',
  );
  const currency = marketCode === 'ZZ' ? 'JPY' : 'AUD';
  const passed: ToolRequest[] = [];
  const inner: AssistantTools = {
    run: (_context, request) => {
      passed.push(request);
      return Promise.resolve({ forModel: '{}', isError: false, cards: [], notices: [] });
    },
  };
  const results: Record<string, readonly BasketCandidate[] | 'unavailable'> = {};
  const searched: string[] = [];
  let mode: CartMode = 'multi-store';
  const sources: BasketSources = {
    candidates: (_context, text) => {
      searched.push(text);
      const found = results[text] ?? [];
      return Promise.resolve(
        found === 'unavailable' ? err({ code: 'unavailable' as const }) : ok(found),
      );
    },
    cartMode: () => Promise.resolve(mode),
  };
  const tools = (timeoutMs?: number) => new BasketAssistantTools(inner, sources, timeoutMs);
  const plan = (
    items: { text: string; quantity: number; unit?: 'kg' | 'each' }[],
  ): ToolRequest => ({
    tool: 'plan_basket',
    items: items.map((item) => ({ unit: null, ...item })),
  });

  beforeEach(() => {
    passed.length = 0;
    searched.length = 0;
    mode = 'multi-store';
    for (const key of Object.keys(results)) delete results[key];
  });

  it('passes every other tool to the wrapped tools unchanged', async () => {
    const outcome: ToolOutcome = await tools().run(context, { tool: 'support_contact' });
    expect(passed).toEqual([{ tool: 'support_contact' }]);
    expect(outcome.isError).toBe(false);
  });

  it('shows a basket card and tells the model counts only, never a price, store or total', async () => {
    results['rice'] = [cand('o1', 'A', 'Rice 1 kg', 500, currency)];
    results['saffron'] = [];
    const outcome = await tools().run(
      context,
      plan([
        { text: 'rice', quantity: 2, unit: 'kg' },
        { text: 'saffron', quantity: 1 },
      ]),
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.cards).toHaveLength(1);
    const [card] = outcome.cards;
    expect(card).toMatchObject({
      kind: 'basket-proposal',
      proposal: { mode: 'multi-store', itemCount: 2, total: money(1000n, currency) },
    });
    const told = JSON.parse(outcome.forModel) as Record<string, unknown>;
    expect(told).toMatchObject({
      lines: 2,
      found: 1,
      unsure: 0,
      notFound: 1,
      cartMode: 'multi-store',
    });
    expect(outcome.forModel).not.toMatch(/Store A|Rice|1000|500|price|total/i);
  });

  it('reads the cart mode of the Market and plans one store in single-store mode', async () => {
    mode = 'single-store';
    results['rice'] = [
      cand('o1', 'A', 'Rice', 500, currency),
      cand('o2', 'B', 'Rice', 400, currency),
    ];
    results['milk'] = [cand('o3', 'B', 'Milk', 200, currency)];
    const outcome = await tools().run(
      context,
      plan([
        { text: 'rice', quantity: 1 },
        { text: 'milk', quantity: 1 },
      ]),
    );
    expect(outcome.cards[0]).toMatchObject({
      kind: 'basket-proposal',
      proposal: { mode: 'single-store', stores: [{ sellerId: 'B' }] },
    });
  });

  it('searches each distinct line once, in the buyer words', async () => {
    results['Rice'] = [cand('o1', 'A', 'Rice', 500, currency)];
    await tools().run(
      context,
      plan([
        { text: 'Rice', quantity: 1 },
        { text: 'rice ', quantity: 2 },
        { text: 'Rice', quantity: 3 },
      ]),
    );
    expect(searched).toEqual(['Rice']);
  });

  it('fails closed when a search cannot be read: no basket, never "not found"', async () => {
    results['rice'] = [cand('o1', 'A', 'Rice', 500, currency)];
    results['milk'] = 'unavailable';
    const outcome = await tools().run(
      context,
      plan([
        { text: 'rice', quantity: 1 },
        { text: 'milk', quantity: 1 },
      ]),
    );
    expect(outcome).toMatchObject({ isError: true, cards: [], notices: ['tool-failed'] });
  });

  it('fails closed when the plan is too slow', async () => {
    const slow: BasketSources = {
      candidates: () => new Promise(() => undefined),
      cartMode: () => Promise.resolve('multi-store'),
    };
    const outcome = await new BasketAssistantTools(inner, slow, 5).run(
      context,
      plan([{ text: 'rice', quantity: 1 }]),
    );
    expect(outcome).toMatchObject({ isError: true, cards: [], notices: ['tool-failed'] });
  });

  it('never changes anything: the only outcome is a card', async () => {
    results['rice'] = [cand('o1', 'A', 'Rice', 500, currency)];
    const outcome = await tools().run(context, plan([{ text: 'rice', quantity: 1 }]));
    expect(outcome.cards.map((card) => card.kind)).toEqual(['basket-proposal']);
    expect(passed).toEqual([]);
  });
});
