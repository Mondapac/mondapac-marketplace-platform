import type { AuthorisationCheck } from '../../../../platform/authz';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import { err, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  OwnOfferSubmitPreview,
  type OwnOfferSubmitPreviewDependencies,
} from './own-offer-submit-preview.use-case';

// The preview's guards that the HTTP rig cannot reach (QA r2 finding 1): an acting-as session that
// asks for a badge, a population that is not a seller, and a read unit that failed. Both Markets.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(['AU', 'ZZ'])('own-offer submit preview guards in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-11-26T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );

  let calls: string[];
  let readFails: boolean;
  const build = () => {
    const touch = (name: string) => () => {
      calls.push(name);
      return Promise.reject(new Error(`${name} must not be reached`));
    };
    const unitOfWork = {
      run: (_m: MarketContext, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
        if (options?.readOnly === true && readFails) {
          return Promise.resolve(err({ code: 'unit.failed' }));
        }
        return work();
      },
    } as unknown as UnitOfWork;
    const deps: OwnOfferSubmitPreviewDependencies = {
      unitOfWork,
      offers: { findById: touch('offers.findById') } as never,
      products: { findById: touch('products.findById') } as never,
      eligibility: { isEligible: () => Promise.resolve(true) },
      allowedTypes: { allowedFor: touch('allowedTypes') },
      evaluator: { activeTypeCodes: touch('evaluator.activeTypeCodes') },
      reviewInputs: { settings: touch('settings'), facts: touch('facts') } as never,
      counters: {
        reserve: (_m: MarketContext, list: readonly unknown[]) => {
          calls.push('counters.reserve');
          return Promise.resolve(
            list.map(() => ({ kind: 'x', count: 1, windowStartedAt: clock.now() })),
          );
        },
      } as never,
      counterKeys: { keyOf: () => new Uint8Array(32) },
      clock,
    };
    return new OwnOfferSubmitPreview(gate, deps);
  };

  beforeEach(() => {
    calls = [];
    readFails = false;
  });

  it('refuses a badge request in an acting-as session, asking certification nothing', async () => {
    const context = contextOf('seller');
    const acting = {
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ids.next() } },
    };
    const answer = await build().execute(acting, {
      offerId: ids.next<'Offer'>(),
      requestedTags: ['halal'],
    });
    expect(answer).toEqual(err({ code: 'access.denied' }));
    expect(calls).not.toContain('evaluator.activeTypeCodes');
  });

  it.each(['customer', 'admin'] as const)(
    'refuses the %s population with access.denied, reading nothing',
    async (population) => {
      const answer = await build().execute(contextOf(population), { offerId: ids.next<'Offer'>() });
      expect(answer).toEqual(err({ code: 'access.denied' }));
      expect(calls).toEqual([]);
    },
  );

  it('answers access.unavailable when the read unit fails, never a guess', async () => {
    readFails = true;
    const answer = await build().execute(contextOf('seller'), { offerId: ids.next<'Offer'>() });
    expect(answer).toEqual(err({ code: 'access.unavailable' }));
    expect(calls).toEqual(['counters.reserve']);
  });
});
