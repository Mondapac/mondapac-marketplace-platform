import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FLAGS_OFF,
  InMemorySellerReviewStandings,
} from '../../../../../test/support/catalog-seller-review-fakes';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerReviewStanding } from '../../domain/seller-review-standing';
import type { SellerOfferReviewFlags } from '../ports/seller-offer-review-flags.reader';
import { OwnReviewStanding } from './own-review-standing.use-case';

// The seller's own probation progress (risk-based Offer approval slice 7), on both Market fixtures.

const START = Temporal.Instant.from('2026-11-26T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const standings = new InMemorySellerReviewStandings();
  const authorisation: AuthorisationCheck = {
    check: () => Promise.resolve({ allowed: true }),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = {
    run: ((_market: unknown, work: () => Promise<unknown>) => work()) as UnitOfWork['run'],
    runOnce: noRunOnce,
  };
  let flags: SellerOfferReviewFlags | null = FLAGS_OFF;
  let flagsFail = false;
  let probationOffers = 10;
  return {
    ids,
    standings,
    setFlags: (value: SellerOfferReviewFlags | null) => void (flags = value),
    failFlags: () => void (flagsFail = true),
    setN: (n: number) => void (probationOffers = n),
    failStanding: () => void (standings.failNext = true),
    standing: new OwnReviewStanding(gate, {
      unitOfWork,
      standings,
      sellerFlags: {
        flagsOf: () =>
          flagsFail ? Promise.reject(new Error('down')) : Promise.resolve(flags as never),
      },
      reviewInputs: { probationOffers: () => Promise.resolve(probationOffers) },
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

const sellerOf = (
  t: Setup,
  code: string,
  population: 'seller' | 'admin' = 'seller',
): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population,
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId: population === 'seller' ? SELLER : null,
    }),
  );
};

describe.each(TEST_MARKET_IDS)('Own review standing (slice 7) in %s', (code) => {
  const market = testMarketContext(code, 'default');

  it('counts a new seller from zero, with the initial target', async () => {
    const t = setUp();
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual(
      ok({ status: 'probation', count: 0, target: 10, restarted: false }),
    );
  });

  it('shows the count of the current epoch and the shorter target after a take-down', async () => {
    const t = setUp();
    const row = SellerReviewStanding.start({ marketId: code, sellerId: SELLER, now: START });
    t.standings.rows.set(`${code}|${SELLER}`, row.state);
    for (let n = 0; n < 2; n += 1) {
      await t.standings.credit(market, {
        sellerId: SELLER,
        epoch: 1,
        productId: `01990000-0000-7000-8000-0000000d000${n}` as Id<'Product'>,
        offerId: `01990000-0000-7000-8000-0000000e000${n}` as Id<'Offer'>,
        creditedAt: START,
      });
    }
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual(
      ok({ status: 'probation', count: 2, target: 10, restarted: false }),
    );
    const revoked = SellerReviewStanding.restore(t.standings.rows.get(`${code}|${SELLER}`)!);
    revoked.revokeForMisconduct({ now: START });
    t.standings.rows.set(`${code}|${SELLER}`, revoked.state);
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual(
      ok({ status: 'probation', count: 0, target: 5, restarted: true }),
    );
  });

  it('answers only the progress: no epoch, flags, source, dates or sampling', async () => {
    const t = setUp();
    t.setFlags({ ...FLAGS_OFF, trustedFromStart: { on: true, at: START } });
    const answer = await t.standing.execute(sellerOf(t, code), {});
    expect(answer).toEqual(ok({ status: 'trusted', count: 0, target: 0, restarted: false }));
    expect(Object.keys((answer as { value: object }).value).sort()).toEqual([
      'count',
      'restarted',
      'status',
      'target',
    ]);
  });

  it('reads Trusted by count when N was lowered under it', async () => {
    const t = setUp();
    t.standings.rows.set(
      `${code}|${SELLER}`,
      SellerReviewStanding.start({ marketId: code, sellerId: SELLER, now: START }).state,
    );
    await t.standings.credit(market, {
      sellerId: SELLER,
      epoch: 1,
      productId: '01990000-0000-7000-8000-0000000d0001' as Id<'Product'>,
      offerId: '01990000-0000-7000-8000-0000000e0001' as Id<'Offer'>,
      creditedAt: START,
    });
    t.setN(1);
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual(
      ok({ status: 'trusted', count: 0, target: 0, restarted: false }),
    );
  });

  it('reads the admin flag as off when sellers cannot answer, never as Trusted', async () => {
    const t = setUp();
    t.setFlags(null);
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual(
      ok({ status: 'probation', count: 0, target: 10, restarted: false }),
    );
  });

  it('is unavailable, never a guess, when a read fails', async () => {
    const t = setUp();
    t.failStanding();
    expect(await t.standing.execute(sellerOf(t, code), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    const u = setUp();
    u.failFlags();
    expect(await u.standing.execute(sellerOf(u, code), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });

  it('denies a session that is not a seller', async () => {
    const t = setUp();
    expect(await t.standing.execute(sellerOf(t, code, 'admin'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
