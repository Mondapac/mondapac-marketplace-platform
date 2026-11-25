import { Logger } from '@nestjs/common';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  SequenceIdGenerator,
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { FakeOfferSellUnits } from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import type { OwnCommissionSource, OwnLineCommission } from '../ports/own-commission';
import { MAX_ESTIMATE_LINES, ViewReceiveEstimates } from './view-receive-estimates.use-case';

// `pricing.view-receive-estimates` in memory on both Market fixtures: the commission and what the
// seller receives come from the own-commission source unchanged, with the line's tax rate and the
// Market's price convention; the Offer is the seller's own and each Variant priceable on it; an
// unreadable value is `pricing.estimate-unavailable`, never a guessed amount.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

/** A stand-in for commission-payouts: 15% of the amount less its tax, rounded half up. */
class FakeOwnCommission implements OwnCommissionSource {
  taxRateBps: number | 'no-category' | null = 0;
  failCommission = false;
  readonly calls: { amounts: readonly bigint[]; taxInclusive: boolean; taxRateBps: number }[] = [];
  readonly taxAsked: Id<'Offer'>[] = [];

  lineTaxRate(_context: CallContext, offerId: Id<'Offer'>): Promise<number | 'no-category' | null> {
    this.taxAsked.push(offerId);
    return Promise.resolve(this.taxRateBps);
  }

  commissionsOn(
    _context: CallContext,
    amounts: readonly bigint[],
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<readonly OwnLineCommission[] | null> {
    this.calls.push({ amounts, taxInclusive, taxRateBps });
    if (this.failCommission) return Promise.resolve(null);
    return Promise.resolve(
      amounts.map((amount) => {
        const base = taxInclusive ? (amount * 10000n) / BigInt(10000 + taxRateBps) : amount;
        const commission = (base * 1500n + 5000n) / 10000n;
        return { commission, sellerReceives: amount - commission };
      }),
    );
  }
}

describe.each(['AU', 'ZZ'] as const)('pricing.view-receive-estimates in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const ids = new SequenceIdGenerator(
      new FixedClock(Temporal.Instant.from('2026-11-25T10:00:00Z')),
    );
    const offers = new FakeOfferSellUnits();
    const ownCommission = new FakeOwnCommission();
    const useCase = new ViewReceiveEstimates(gate, { offers, policies, ownCommission });
    const sellerId = ids.next<'Seller'>();
    const offerId = ids.next<'Offer'>();
    const v1 = ids.next<'Variant'>();
    const v2 = ids.next<'Variant'>();
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: false,
      priceableVariantIds: [v1, v2],
    });
    const contextOf = (seller: Id<'Seller'> = sellerId): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: seller,
        }),
      );
    const view = (lines: unknown, context: CallContext = contextOf(), offer: unknown = offerId) =>
      useCase.execute(context, { offerId: offer, lines });
    return { ids, offers, ownCommission, sellerId, offerId, v1, v2, view, contextOf };
  }

  it('answers the commission and what the seller receives per line, in the Market currency', async () => {
    const { view, v1, v2, offerId, ownCommission } = setup();
    ownCommission.taxRateBps = 1000;

    const answer = await view(`${v1}:1590,${v2}:950`);

    const taxInclusive = policies.pricesIncludeTax(market);
    const result = answer.ok ? answer.value : null;
    expect(result).toMatchObject({
      offerId,
      currency: policies.forMarket(market).currency,
      taxInclusive,
    });
    expect(result?.lines.map((line) => line.variantId)).toEqual([v1, v2]);
    for (const line of result?.lines ?? []) {
      expect(BigInt(line.commissionMinor) + BigInt(line.youReceiveMinor)).toBe(
        BigInt(line.priceMinor),
      );
    }
    // One read of the rate for the whole request.
    expect(ownCommission.calls).toEqual([
      { amounts: [1590n, 950n], taxInclusive, taxRateBps: 1000 },
    ]);
    expect(ownCommission.taxAsked).toEqual([offerId]);
  });

  it('never answers the rate', async () => {
    const { view, v1 } = setup();
    const answer = await view(`${v1}:1000`);
    expect(JSON.stringify(answer)).not.toMatch(/rate|bps/i);
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['missing price', 'x'],
    ['zero price', 'V:0'],
    ['leading zero', 'V:0100'],
    ['negative', 'V:-5'],
    ['decimal', 'V:15.90'],
    ['above the ceiling', `V:${10n ** 12n + 1n}`],
    ['extra part', 'V:100:1'],
  ])('refuses lines that are %s', async (_label, lines) => {
    const { view, v1 } = setup();
    const text = typeof lines === 'string' ? lines.replace('V', v1) : lines;
    const answer = await view(text);
    expect(answer).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'lines', code: 'format' }] },
    });
  });

  it('refuses a Variant asked twice and more than the most lines', async () => {
    const { view, v1, ids } = setup();
    expect((await view(`${v1}:100,${v1}:200`)).ok).toBe(false);
    const many = Array.from(
      { length: MAX_ESTIMATE_LINES + 1 },
      () => `${ids.next<'Variant'>()}:100`,
    ).join(',');
    const answer = await view(many);
    expect(answer.ok ? null : answer.error.code).toBe('validation.failed');
  });

  it('refuses a bad Offer id', async () => {
    const { view, v1 } = setup();
    const answer = await view(`${v1}:100`, undefined, 'nope');
    expect(answer.ok ? null : answer.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'offerId', code: 'format' }],
    });
  });

  it("answers another seller's Offer, an unknown one, a deleted one and a foreign Variant as one not-found, before any money is read", async () => {
    const { view, v1, ids, offers, offerId, contextOf, ownCommission, sellerId } = setup();
    const notFound = { ok: false, error: { code: 'pricing.offer-not-found' } };

    expect(await view(`${v1}:100`, contextOf(ids.next<'Seller'>()))).toEqual(notFound);
    expect(await view(`${v1}:100`, undefined, ids.next<'Offer'>())).toEqual(notFound);
    expect(await view(`${ids.next<'Variant'>()}:100`)).toEqual(notFound);
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: true,
      priceableVariantIds: [v1],
    });
    expect(await view(`${v1}:100`)).toEqual(notFound);
    expect(ownCommission.calls).toEqual([]);
    expect(ownCommission.taxAsked).toEqual([]);
  });

  it('refuses a Login as Seller session before any read', async () => {
    const { view, v1, contextOf, ownCommission, offers } = setup();
    const base = contextOf();
    const actingAs = {
      ...base,
      actor: { ...base.actor, actingAs: { adminAccountId: 'a' } } as never,
    } as CallContext;
    const spy = jest.spyOn(offers, 'sellUnitsOf');

    // The gate refuses the marked session first; the use case's own check is the second layer.
    const answer = await view(`${v1}:100`, actingAs);
    expect(answer.ok ? null : answer.error.code).toMatch(
      /^(access\.denied|pricing\.acting-as-refused)$/,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(ownCommission.taxAsked).toEqual([]);
  });

  it('says the product has no published tax category, apart from a fault', async () => {
    const { view, v1, ownCommission } = setup();
    ownCommission.taxRateBps = 'no-category';
    expect(await view(`${v1}:100`)).toEqual({
      ok: false,
      error: { code: 'pricing.estimate-no-tax-category' },
    });
    expect(ownCommission.calls).toEqual([]);
  });

  it('answers unavailable, not a fault, when the Offer cannot be read', async () => {
    const { view, v1, offers } = setup();
    jest.spyOn(offers, 'sellUnitsOf').mockRejectedValue(new Error('catalog down'));
    expect(await view(`${v1}:100`)).toEqual({
      ok: false,
      error: { code: 'pricing.estimate-unavailable' },
    });
  });

  it('refuses a session that is not a seller', async () => {
    const { view, v1, ids } = setup();
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const answer = await view(`${v1}:100`, customer);
    expect(answer.ok ? null : answer.error.code).toBe('access.denied');
  });

  it('shows no money when the tax rate or the commission cannot be read', async () => {
    const { view, v1, ownCommission } = setup();
    const unavailable = { ok: false, error: { code: 'pricing.estimate-unavailable' } };

    ownCommission.taxRateBps = null;
    expect(await view(`${v1}:100`)).toEqual(unavailable);
    expect(ownCommission.calls).toEqual([]);

    ownCommission.taxRateBps = 0;
    ownCommission.failCommission = true;
    expect(await view(`${v1}:100`)).toEqual(unavailable);
  });
});

describe('pricing.view-receive-estimates access', () => {
  it('needs the price view key and the seller ledger key, approved sellers only', () => {
    expect(ViewReceiveEstimates.access).toEqual({
      name: 'pricing.view-receive-estimates',
      rule: {
        kind: 'permissions',
        allOf: ['pricing.price.view', 'commission-payouts.earnings.view'],
      },
      whenSellerNotApproved: 'deny',
    });
  });
});
