import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FLAGS_OFF,
  InMemoryCategoryOfferReviewFlags,
  InMemorySellerReviewStandings,
} from '../../../../../test/support/catalog-seller-review-fakes';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type {
  AuthorisationCheck,
  ConsumedStepUp,
  StepUpProofConsumer,
  StepUpRefusal,
} from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerReviewStanding } from '../../domain/seller-review-standing';
import type { SellerOfferReviewFlags } from '../ports/seller-offer-review-flags.reader';
import { ChangeCategoryAlwaysReview } from './change-category-always-review.use-case';
import { ChangeCategoryReviewStop } from './change-category-review-stop.use-case';
import { ViewCategoryOfferReviewFlags } from './view-category-offer-review-flags.use-case';
import { ViewSellerReviewStanding } from './view-seller-review-standing.use-case';

// The category Offer review flags and the admin reads of slice 4 (risk-based Offer approval) in
// memory, on both Market fixtures. The PostgreSQL side is test/db/offer-review-probation.db-spec.ts.

const START = Temporal.Instant.from('2026-11-25T10:00:00Z');
const VERIFIED = Temporal.Instant.from('2026-11-25T09:59:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const store = new InMemoryCategoryOfferReviewFlags();
  const standings = new InMemorySellerReviewStandings();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let held = true;
  const checked: unknown[] = [];
  const authorisation: AuthorisationCheck = {
    check: (...args: unknown[]) => {
      checked.push(args);
      return Promise.resolve(
        held ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, authorisation);
  let unitFails = false;
  const unitOfWork: UnitOfWork = {
    run: ((_market: unknown, work: () => Promise<unknown>) =>
      unitFails
        ? Promise.resolve({ ok: false, error: { code: 'unit.failed' } })
        : work()) as UnitOfWork['run'],
    runOnce: noRunOnce,
  };
  const spent: string[] = [];
  let refusal: StepUpRefusal | null = null;
  const stepUp: StepUpProofConsumer = {
    consume: (_context: CallContext, actionKey: string) => {
      if (refusal !== null) {
        return Promise.resolve(err(refusal) as Result<ConsumedStepUp, StepUpRefusal>);
      }
      spent.push(actionKey);
      return Promise.resolve(ok({ sessionId: ids.next<'Session'>(), verifiedAt: VERIFIED }));
    },
  };
  let flags: SellerOfferReviewFlags | null = FLAGS_OFF;
  let probationOffers = 10;
  const deps = { unitOfWork, categoryFlags: store, audit, stepUp, clock, ids };
  return {
    ids,
    store,
    standings,
    audits,
    checked,
    spent,
    refuse: (value: StepUpRefusal) => void (refusal = value),
    withhold: () => void (held = false),
    failUnit: () => void (unitFails = true),
    setFlags: (value: SellerOfferReviewFlags | null) => void (flags = value),
    setN: (n: number) => void (probationOffers = n),
    alwaysReview: new ChangeCategoryAlwaysReview(gate, deps),
    reviewStop: new ChangeCategoryReviewStop(gate, deps),
    viewFlags: new ViewCategoryOfferReviewFlags(gate, { unitOfWork, categoryFlags: store }),
    viewStanding: new ViewSellerReviewStanding(gate, {
      unitOfWork,
      standings,
      sellerFlags: {
        flagsOf: () =>
          flags === null ? Promise.reject(new Error('down')) : Promise.resolve(flags),
      },
      reviewInputs: { probationOffers: () => Promise.resolve(probationOffers) },
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

const actorOf = (t: Setup, code: string, population: 'admin' | 'seller'): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population,
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId: population === 'seller' ? t.ids.next<'Seller'>() : null,
    }),
  );
};

const CASES = [
  {
    name: 'alwaysReview',
    field: 'alwaysReview',
    flag: 'always-review',
    action: 'catalog.category.offer-review-changed',
    key: 'catalog.category-review.manage',
    stepUp: 'catalog.category-review.change',
  },
  {
    name: 'reviewStop',
    field: 'reviewStop',
    flag: 'review-stop',
    action: 'catalog.category.review-stop-changed',
    key: 'catalog.offer-review-stop.manage',
    stepUp: 'catalog.offer-review-stop.change',
  },
] as const;

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKET_IDS)('Category Offer review flags (slice 4) in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const body = (on: boolean, expectedVersion = 0, reason: unknown = ' Recall notice ') => ({
    on,
    reason,
    expectedVersion,
  });

  describe.each(CASES)('change $name', (c) => {
    it('creates the row at version 1, then raises it by one; logs the reason, audits booleans', async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      const admin = actorOf(t, code, 'admin');
      expect(await t[c.name].execute(admin, { categoryId, body: body(true) })).toEqual(
        ok({ on: true, changed: true, version: 1 }),
      );
      expect(await t[c.name].execute(admin, { categoryId, body: body(false, 1) })).toEqual(
        ok({ on: false, changed: true, version: 2 }),
      );
      const row = t.store.rows.get(`${code}|${categoryId}`)!;
      expect(row.version).toBe(2);
      expect(row[c.field]).toEqual({
        on: false,
        changedAt: START,
        changedBy: (admin.actor as { accountId: string }).accountId,
      });
      expect(t.store.changes.map((x) => [x.flag, x.previous, x.next, x.reason])).toEqual([
        [c.flag, false, true, 'Recall notice'],
        [c.flag, true, false, 'Recall notice'],
      ]);
      expect(t.audits).toHaveLength(2);
      expect(t.audits[0]).toMatchObject({ action: c.action, targetId: categoryId });
      expect(t.audits[0]!.before).toEqual({ on: false });
      expect(t.audits[0]!.after).toEqual({ on: true, stepUpVerifiedAt: VERIFIED });
      expect(JSON.stringify(t.audits)).not.toContain('Recall');
      expect(t.spent).toEqual([c.stepUp, c.stepUp]);
      expect(JSON.stringify(t.checked)).toContain(c.key);
    });

    it('writes nothing and spends no proof for a value already held', async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      expect(
        await t[c.name].execute(actorOf(t, code, 'admin'), { categoryId, body: body(false) }),
      ).toEqual(ok({ on: false, changed: false, version: 0 }));
      expect(t.store.rows.size).toBe(0);
      expect(t.audits).toEqual([]);
      expect(t.spent).toEqual([]);
    });

    it('answers conflict.stale for a version not seen, or when another change won', async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      const admin = actorOf(t, code, 'admin');
      expect(await t[c.name].execute(admin, { categoryId, body: body(true, 1) })).toEqual(
        err({ code: 'conflict.stale' }),
      );
      t.store.loseNextSave = true;
      expect(await t[c.name].execute(admin, { categoryId, body: body(true, 0) })).toEqual(
        err({ code: 'conflict.stale' }),
      );
      expect(t.store.changes).toEqual([]);
      expect(t.audits).toEqual([]);
    });

    it('commits nothing when the two-step proof is refused', async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      t.refuse({ code: 'second-factor.required', actionKey: c.stepUp });
      expect(
        await t[c.name].execute(actorOf(t, code, 'admin'), { categoryId, body: body(true) }),
      ).toEqual(err({ code: 'second-factor.required', actionKey: c.stepUp }));
      expect(t.store.rows.size).toBe(0);
      expect(t.store.changes).toEqual([]);
      expect(t.audits).toEqual([]);
    });

    it.each([
      ['not an object', [true], [{ path: '', code: 'type' }]],
      ['no reason', { on: true, expectedVersion: 0 }, [{ path: 'reason', code: 'required' }]],
      ['a blank reason', body(true, 0, ' '), [{ path: 'reason', code: 'required' }]],
      ['a long reason', body(true, 0, 'x'.repeat(501)), [{ path: 'reason', code: 'too-long' }]],
      ['a negative version', body(true, -1), [{ path: 'expectedVersion', code: 'type' }]],
      ['a non-boolean on', { ...body(true), on: 'yes' }, [{ path: 'on', code: 'type' }]],
      ['an unknown field', { ...body(true), x: 1 }, [{ path: 'x', code: 'unknown-field' }]],
    ])('refuses %s', async (_name, raw, fields) => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      expect(await t[c.name].execute(actorOf(t, code, 'admin'), { categoryId, body: raw })).toEqual(
        err({ code: 'validation.failed', fields }),
      );
    });

    it("answers category.not-found for an unknown, malformed or other Market's category", async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(other, categoryId);
      const admin = actorOf(t, code, 'admin');
      const notFound = err({ code: 'category.not-found' });
      expect(await t[c.name].execute(admin, { categoryId, body: body(true) })).toEqual(notFound);
      expect(await t[c.name].execute(admin, { categoryId: 'x', body: body(true) })).toEqual(
        notFound,
      );
      expect(t.store.rows.size).toBe(0);
    });

    it('refuses an acting-as session, a seller and an admin without the key', async () => {
      const t = setUp();
      const categoryId = t.ids.next<'Category'>();
      t.store.addCategory(market, categoryId);
      const base = actorOf(t, code, 'admin');
      const actingAs = {
        ...base,
        actor: { ...base.actor, actingAs: { adminAccountId: t.ids.next<'Account'>() } },
      } as unknown as CallContext;
      const denied = err({ code: 'access.denied' });
      expect(await t[c.name].execute(actingAs, { categoryId, body: body(true) })).toEqual(denied);
      expect(
        await t[c.name].execute(actorOf(t, code, 'seller'), { categoryId, body: body(true) }),
      ).toEqual(denied);
      t.withhold();
      expect(
        await t[c.name].execute(actorOf(t, code, 'admin'), { categoryId, body: body(true) }),
      ).toEqual(denied);
      expect(t.store.rows.size).toBe(0);
      expect(t.spent).toEqual([]);
    });
  });

  it('keeps the two flags of a category on one row and lists only flagged categories', async () => {
    const t = setUp();
    const meat = t.ids.next<'Category'>();
    const home = t.ids.next<'Category'>();
    t.store.addCategory(market, meat);
    t.store.addCategory(market, home);
    const admin = actorOf(t, code, 'admin');
    await t.alwaysReview.execute(admin, { categoryId: meat, body: body(true, 0) });
    await t.reviewStop.execute(admin, { categoryId: meat, body: body(true, 1) });
    await t.alwaysReview.execute(admin, { categoryId: home, body: body(true, 0) });
    await t.alwaysReview.execute(admin, { categoryId: home, body: body(false, 1) });
    expect(await t.viewFlags.execute(admin, {})).toEqual(
      ok([
        {
          categoryId: meat,
          alwaysReview: true,
          reviewStop: true,
          version: 2,
          alwaysReviewChangedAt: START,
          reviewStopChangedAt: START,
        },
      ]),
    );
    expect(JSON.stringify(t.checked)).toContain('catalog.category-tree.view');
    expect(await t.viewFlags.execute(actorOf(t, code, 'seller'), {})).toEqual(
      err({ code: 'access.denied' }),
    );
  });

  describe('view seller review standing', () => {
    const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;

    it('answers count 0, epoch 0 and probation for a seller with no standing', async () => {
      const t = setUp();
      expect(await t.viewStanding.execute(actorOf(t, code, 'admin'), { sellerId: SELLER })).toEqual(
        ok({
          status: 'probation',
          source: null,
          trustedSince: null,
          count: 0,
          target: 10,
          probationOffers: 10,
          epoch: 0,
          targetKind: 'initial',
          consecutiveChangesNeeded: 0,
          trustLostAt: null,
          flags: FLAGS_OFF,
        }),
      );
      expect(JSON.stringify(t.checked)).toContain('catalog.product.approve');
    });

    it('answers Trusted by count, and by the admin flag; flags null when sellers cannot answer', async () => {
      const t = setUp();
      t.standings.rows.set(
        `${code}|${SELLER}`,
        SellerReviewStanding.start({ marketId: code, sellerId: SELLER, now: START }).state,
      );
      for (let n = 0; n < 3; n += 1) {
        await t.standings.credit(market, {
          sellerId: SELLER,
          epoch: 1,
          productId: `01990000-0000-7000-8000-0000000d000${n}` as Id<'Product'>,
          offerId: `01990000-0000-7000-8000-0000000e000${n}` as Id<'Offer'>,
          creditedAt: START,
        });
      }
      const admin = actorOf(t, code, 'admin');
      t.setN(3);
      const byCount = await t.viewStanding.execute(admin, { sellerId: SELLER });
      expect(byCount).toEqual(
        ok(expect.objectContaining({ status: 'trusted', source: 'count', count: 3, epoch: 1 })),
      );
      t.setN(5);
      t.setFlags({ ...FLAGS_OFF, trustedFromStart: { on: true, at: START } });
      expect(await t.viewStanding.execute(admin, { sellerId: SELLER })).toEqual(
        ok(expect.objectContaining({ status: 'trusted', source: 'admin', count: 3 })),
      );
      t.setFlags(null);
      expect(await t.viewStanding.execute(admin, { sellerId: SELLER })).toEqual(
        ok(expect.objectContaining({ status: 'probation', flags: null })),
      );
    });

    it('is refused to a seller; malformed is not-found; a failed read is unavailable', async () => {
      const t = setUp();
      expect(
        await t.viewStanding.execute(actorOf(t, code, 'seller'), { sellerId: SELLER }),
      ).toEqual(err({ code: 'access.denied' }));
      const admin = actorOf(t, code, 'admin');
      expect(await t.viewStanding.execute(admin, { sellerId: 'nope' })).toEqual(
        err({ code: 'seller.not-found' }),
      );
      t.standings.failNext = true;
      expect(await t.viewStanding.execute(admin, { sellerId: SELLER })).toEqual(
        err({ code: 'access.unavailable' }),
      );
      t.failUnit();
      expect(await t.viewStanding.execute(admin, { sellerId: SELLER })).toEqual(
        err({ code: 'access.unavailable' }),
      );
    });

    it("never shows another Market's standing", async () => {
      const t = setUp();
      t.standings.rows.set(`${other.marketId}|${SELLER}`, {
        ...SellerReviewStanding.start({
          marketId: other.marketId,
          sellerId: SELLER,
          now: START,
        }).state,
        trustedAt: START,
      });
      expect(await t.viewStanding.execute(actorOf(t, code, 'admin'), { sellerId: SELLER })).toEqual(
        ok(expect.objectContaining({ status: 'probation', epoch: 0 })),
      );
    });
  });
});
