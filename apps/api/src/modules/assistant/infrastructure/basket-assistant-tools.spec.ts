import { money, ok, err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { BasketSources } from '../application/ports/basket-sources';
import type { SellUnit } from '../domain/basket-units';
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
  const unitReads: string[] = [];
  const unitsOf: Record<string, readonly SellUnit[]> = {};
  let mode: CartMode = 'multi-store';
  const sources: BasketSources = {
    candidates: (_context, text) => {
      searched.push(text);
      const found = results[text] ?? [];
      return Promise.resolve(
        found === 'unavailable' ? err({ code: 'unavailable' as const }) : ok(found),
      );
    },
    units: (_context, offerId) => {
      unitReads.push(offerId);
      const found = unitsOf[offerId];
      return Promise.resolve(
        found === undefined ? err({ code: 'unavailable' as const }) : ok(found),
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
      units: () => Promise.resolve(err({ code: 'unavailable' as const })),
      cartMode: () => Promise.resolve('multi-store'),
    };
    const outcome = await new BasketAssistantTools(inner, slow, 5).run(
      context,
      plan([{ text: 'rice', quantity: 1 }]),
    );
    expect(outcome).toMatchObject({ isError: true, cards: [], notices: ['tool-failed'] });
  });

  it('fills in the sell unit whose price is the price shown, and leaves it null when unread', async () => {
    unitReads.length = 0;
    results['rice'] = [cand('o1', 'A', 'Rice', 500, currency)];
    results['tea'] = [cand('o2', 'A', 'Tea', 300, currency)];
    unitsOf['o1'] = [
      { variantId: 'v-big', unitPrice: money(900n, currency), maxQuantity: 3 },
      { variantId: 'v-one', unitPrice: money(500n, currency), maxQuantity: 7 },
    ];
    // o2 has no entry: its units cannot be read, which does not fail the plan.
    const outcome = await tools().run(
      context,
      plan([
        { text: 'rice', quantity: 1 },
        { text: 'tea', quantity: 1 },
      ]),
    );
    const card = outcome.cards[0];
    if (card?.kind !== 'basket-proposal') throw new Error('no card');
    const lines = card.proposal.stores.flatMap((store) => store.lines);
    expect(lines.map((line) => [line.offerId, line.variantId, line.maxQuantity])).toEqual([
      ['o1', 'v-one', 7],
      ['o2', null, null],
    ]);
    expect(unitReads.sort()).toEqual(['o1', 'o2']);
  });

  it('never changes anything: the only outcome is a card', async () => {
    results['rice'] = [cand('o1', 'A', 'Rice', 500, currency)];
    const outcome = await tools().run(context, plan([{ text: 'rice', quantity: 1 }]));
    expect(outcome.cards.map((card) => card.kind)).toEqual(['basket-proposal']);
    expect(passed).toEqual([]);
  });
});

describe('BasketAssistantTools sell units', () => {
  const context = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
  const inner: AssistantTools = {
    run: () => Promise.resolve({ forModel: '{}', isError: false, cards: [], notices: [] }),
  };
  const one: ToolRequest = {
    tool: 'plan_basket',
    items: [{ text: 'rice', quantity: 1, unit: null }],
  };
  const sources = (units: BasketSources['units']): BasketSources => ({
    candidates: () => Promise.resolve(ok([cand('o1', 'A', 'Rice', 500, 'AUD')])),
    units,
    cartMode: () => Promise.resolve('multi-store'),
  });

  it('still returns the card, with no unit, when the unit read is too slow', async () => {
    const never = sources(() => new Promise(() => undefined));
    const outcome = await new BasketAssistantTools(inner, never, 5_000, 50).run(context, one);
    expect(outcome.isError).toBe(false);
    const card = outcome.cards[0];
    if (card?.kind !== 'basket-proposal') throw new Error('no card');
    expect(card.proposal.stores[0]!.lines[0]!.variantId).toBeNull();
  });

  it('still returns the card when a unit read throws', async () => {
    const throwing = sources(() => Promise.reject(new Error('x')));
    const outcome = await new BasketAssistantTools(inner, throwing).run(context, one);
    expect(outcome.isError).toBe(false);
    expect(outcome.cards.map((card) => card.kind)).toEqual(['basket-proposal']);
  });
});

describe('BasketAssistantTools load limits', () => {
  const context = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
  const inner: AssistantTools = {
    run: () => Promise.resolve({ forModel: '{}', isError: false, cards: [], notices: [] }),
  };
  const one: ToolRequest = {
    tool: 'plan_basket',
    items: [{ text: 'rice', quantity: 1, unit: null }],
  };

  it('sheds a ninth plan at once instead of queueing it', async () => {
    const release: (() => void)[] = [];
    const slow: BasketSources = {
      candidates: () =>
        new Promise((resolve) => {
          release.push(() => resolve(ok([])));
        }),
      units: () => Promise.resolve(err({ code: 'unavailable' as const })),
      cartMode: () => Promise.resolve('multi-store'),
    };
    const tools = new BasketAssistantTools(inner, slow, 5_000);
    const running = Array.from({ length: 8 }, () => tools.run(context, one));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await tools.run(context, one)).toMatchObject({
      isError: true,
      notices: ['tool-failed'],
    });
    release.forEach((done) => done());
    const done = await Promise.all(running);
    expect(done.every((outcome) => !outcome.isError)).toBe(true);
  });

  it('starts no new search batch after it timed out', async () => {
    let searches = 0;
    const slow: BasketSources = {
      candidates: async () => {
        searches += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ok([]);
      },
      units: () => Promise.resolve(err({ code: 'unavailable' as const })),
      cartMode: () => Promise.resolve('multi-store'),
    };
    const many: ToolRequest = {
      tool: 'plan_basket',
      items: Array.from({ length: 40 }, (_, index) => ({
        text: `item ${index}x`,
        quantity: 1,
        unit: null,
      })),
    };
    const outcome = await new BasketAssistantTools(inner, slow, 40).run(context, many);
    expect(outcome.isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(searches).toBeLessThan(40);
  });
});
