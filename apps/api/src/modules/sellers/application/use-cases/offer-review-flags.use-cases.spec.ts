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
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { InMemoryOfferReviewFlags } from '../../../../../test/support/sellers-offer-review-flags-fakes';
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
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import { ChangeOfferReviewFullReviewUseCase } from './change-offer-review-full-review.use-case';
import { ChangeOfferReviewStopUseCase } from './change-offer-review-stop.use-case';
import { ChangeOfferReviewTrustUseCase } from './change-offer-review-trust.use-case';
import { OfferReviewFlagsSystem } from './offer-review-flags-system.use-case';
import { OfferReviewFlags } from './offer-review-flags.use-case';
import { ViewOfferReviewFlagsUseCase } from './view-offer-review-flags.use-case';

// The three Offer review flags of a seller (SEL-25; risk-based Offer approval slice 4) in memory,
// on both Market fixtures. The PostgreSQL side is test/db/offer-review-probation.db-spec.ts.

const START = Temporal.Instant.from('2026-11-25T10:00:00Z');
const VERIFIED = Temporal.Instant.from('2026-11-25T09:59:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const rows = new InMemoryOfferReviewFlags();
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
  const unitOfWork: UnitOfWork = {
    run: ((_market: unknown, work: () => Promise<unknown>) => work()) as UnitOfWork['run'],
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
  const deps = { unitOfWork, offerReviewFlags: rows, audit, stepUp, clock, ids };
  return {
    ids,
    rows,
    audits,
    checked,
    spent,
    refuse: (value: StepUpRefusal) => void (refusal = value),
    withhold: () => void (held = false),
    trust: new ChangeOfferReviewTrustUseCase(gate, deps),
    fullReview: new ChangeOfferReviewFullReviewUseCase(gate, deps),
    stop: new ChangeOfferReviewStopUseCase(gate, deps),
    view: new ViewOfferReviewFlagsUseCase(gate, { unitOfWork, offerReviewFlags: rows }),
    read: new OfferReviewFlags(gate, { unitOfWork, offerReviewFlags: rows }),
    readSystem: new OfferReviewFlagsSystem(gate, { unitOfWork, offerReviewFlags: rows }),
  };
}
type Setup = ReturnType<typeof setUp>;

const actorOf = (
  t: Setup,
  code: string,
  population: 'admin' | 'seller',
  sellerId: Id<'Seller'> | null = null,
): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population,
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
};

const CASES = [
  {
    name: 'trust',
    flag: 'trusted-from-start',
    field: 'trustedFromStart',
    action: 'sellers.offer-review-trust.changed',
    key: 'sellers.offer-review-trust.manage',
    stepUp: 'sellers.offer-review-trust.change',
  },
  {
    name: 'fullReview',
    flag: 'full-review',
    field: 'fullReview',
    action: 'sellers.offer-review-full-review.changed',
    key: 'sellers.offer-review-full.manage',
    stepUp: null,
  },
  {
    name: 'stop',
    flag: 'review-stop',
    field: 'reviewStop',
    action: 'sellers.offer-review-stop.changed',
    key: 'sellers.offer-review-stop.manage',
    stepUp: 'sellers.offer-review-stop.change',
  },
] as const;

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKET_IDS)('Offer review flags (SEL-25) in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const body = (on: boolean, expectedVersion = 1, reason: unknown = '  Long record  ') => ({
    on,
    reason,
    expectedVersion,
  });

  describe.each(CASES)('change $name', (c) => {
    it('switches the flag with who and when, logs the reason, audits booleans only', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const admin = actorOf(t, code, 'admin');
      const result = await t[c.name].execute(admin, { sellerId, body: body(true) });
      expect(result).toEqual(ok({ on: true, changed: true, version: 2 }));
      const row = t.rows.rows.get(`${code}|${sellerId}`)!;
      expect(row[c.field]).toEqual({
        on: true,
        changedAt: START,
        changedBy: (admin.actor as { accountId: string }).accountId,
      });
      expect(row.version).toBe(2);
      expect(t.rows.changes).toEqual([
        expect.objectContaining({
          sellerId,
          flag: c.flag,
          previous: false,
          next: true,
          reason: 'Long record',
          marketId: code,
        }),
      ]);
      expect(t.audits).toHaveLength(1);
      expect(t.audits[0]).toMatchObject({ action: c.action, targetId: sellerId });
      expect(t.audits[0]!.before).toEqual({ on: false });
      expect(t.audits[0]!.after).toEqual(
        c.stepUp === null ? { on: true } : { on: true, stepUpVerifiedAt: VERIFIED },
      );
      expect(JSON.stringify(t.audits)).not.toContain('Long record');
      expect(t.spent).toEqual(c.stepUp === null ? [] : [c.stepUp]);
      expect(JSON.stringify(t.checked)).toContain(c.key);
    });

    it('writes nothing and spends no proof for a value already held', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const result = await t[c.name].execute(actorOf(t, code, 'admin'), {
        sellerId,
        body: body(false),
      });
      expect(result).toEqual(ok({ on: false, changed: false, version: 1 }));
      expect(t.rows.changes).toEqual([]);
      expect(t.audits).toEqual([]);
      expect(t.spent).toEqual([]);
    });

    it('answers conflict.stale for a version other than the one seen, or a lost race', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId, { version: 4 });
      const admin = actorOf(t, code, 'admin');
      expect(await t[c.name].execute(admin, { sellerId, body: body(true, 3) })).toEqual(
        err({ code: 'conflict.stale' }),
      );
      t.rows.loseNextSet = true;
      expect(await t[c.name].execute(admin, { sellerId, body: body(true, 4) })).toEqual(
        err({ code: 'conflict.stale' }),
      );
      expect(t.rows.changes).toEqual([]);
      expect(t.audits).toEqual([]);
    });

    it.each([
      ['not an object', 'on', [{ path: '', code: 'type' }]],
      ['no reason', { on: true, expectedVersion: 1 }, [{ path: 'reason', code: 'required' }]],
      ['a blank reason', body(true, 1, '   '), [{ path: 'reason', code: 'required' }]],
      ['a long reason', body(true, 1, 'x'.repeat(501)), [{ path: 'reason', code: 'too-long' }]],
      ['a non-string reason', body(true, 1, 7), [{ path: 'reason', code: 'type' }]],
      ['no on', { reason: 'r', expectedVersion: 1 }, [{ path: 'on', code: 'required' }]],
      ['a version 0', body(true, 0), [{ path: 'expectedVersion', code: 'type' }]],
      ['an unknown field', { ...body(true), note: 'x' }, [{ path: 'note', code: 'unknown-field' }]],
    ])('refuses %s', async (_name, raw, fields) => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const result = await t[c.name].execute(actorOf(t, code, 'admin'), { sellerId, body: raw });
      expect(result).toEqual(err({ code: 'validation.failed', fields }));
    });

    it('takes a reason of exactly 500 characters', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const result = await t[c.name].execute(actorOf(t, code, 'admin'), {
        sellerId,
        body: body(true, 1, 'é'.repeat(500)),
      });
      expect(result.ok).toBe(true);
    });

    it("answers file.not-found for an unknown, malformed or other Market's seller", async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(other, sellerId);
      const admin = actorOf(t, code, 'admin');
      const notFound = err({ code: 'file.not-found' });
      expect(await t[c.name].execute(admin, { sellerId, body: body(true) })).toEqual(notFound);
      expect(await t[c.name].execute(admin, { sellerId: 'nope', body: body(true) })).toEqual(
        notFound,
      );
      expect(t.rows.rows.get(`${other.marketId}|${sellerId}`)?.[c.field].on).toBe(false);
    });

    it('refuses an acting-as session, a seller and an admin without the key', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const base = actorOf(t, code, 'admin');
      const actingAs = {
        ...base,
        actor: { ...base.actor, actingAs: { adminAccountId: t.ids.next<'Account'>() } },
      } as unknown as CallContext;
      const denied = err({ code: 'access.denied' });
      expect(await t[c.name].execute(actingAs, { sellerId, body: body(true) })).toEqual(denied);
      const seller = actorOf(t, code, 'seller', sellerId);
      expect(await t[c.name].execute(seller, { sellerId, body: body(true) })).toEqual(denied);
      t.withhold();
      expect(
        await t[c.name].execute(actorOf(t, code, 'admin'), { sellerId, body: body(true) }),
      ).toEqual(denied);
      expect(t.rows.rows.get(`${code}|${sellerId}`)?.[c.field].on).toBe(false);
      expect(t.audits).toEqual([]);
      expect(t.spent).toEqual([]);
    });

    if (c.stepUp !== null) {
      it('commits nothing when the two-step proof is refused', async () => {
        const t = setUp();
        const sellerId = t.ids.next<'Seller'>();
        t.rows.seed(market, sellerId);
        t.refuse({ code: 'second-factor.required', actionKey: c.stepUp });
        const result = await t[c.name].execute(actorOf(t, code, 'admin'), {
          sellerId,
          body: body(true),
        });
        expect(result).toEqual(err({ code: 'second-factor.required', actionKey: c.stepUp }));
        expect(t.rows.rows.get(`${code}|${sellerId}`)).toMatchObject({ version: 1 });
        expect(t.rows.changes).toEqual([]);
        expect(t.audits).toEqual([]);
      });
    }
  });

  describe('view and facade', () => {
    it('shows the three flags, when each changed, and the version to an admin', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      const admin = actorOf(t, code, 'admin');
      await t.stop.execute(admin, { sellerId, body: body(true) });
      expect(await t.view.execute(admin, { sellerId })).toEqual(
        ok({
          trustedFromStart: { on: false, changedAt: null },
          fullReview: { on: false, changedAt: null },
          reviewStop: { on: true, changedAt: START },
          version: 2,
        }),
      );
      expect(JSON.stringify(t.checked)).toContain('sellers.seller.view');
    });

    it('refuses the view to a seller and answers file.not-found for another Market', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(other, sellerId);
      expect(await t.view.execute(actorOf(t, code, 'admin'), { sellerId })).toEqual(
        err({ code: 'file.not-found' }),
      );
      expect(await t.view.execute(actorOf(t, code, 'seller', sellerId), { sellerId })).toEqual(
        err({ code: 'access.denied' }),
      );
    });

    it('answers the facade to an admin, the system and the own seller only', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      const otherSeller = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId, {
        fullReview: { on: true, changedAt: START, changedBy: null },
      });
      t.rows.seed(market, otherSeller);
      const facade = new SellersFacadeImplementation({
        offerReviewFlags: t.read,
        offerReviewFlagsSystem: t.readSystem,
      } as unknown as ConstructorParameters<typeof SellersFacadeImplementation>[0]);
      const expected = ok({
        trustedFromStart: { on: false, at: null },
        fullReview: { on: true, at: START },
        reviewStop: { on: false, at: null },
      });
      expect(await facade.offerReviewFlagsOf(testCallContext(market, 'system'), sellerId)).toEqual(
        expected,
      );
      expect(await facade.offerReviewFlagsOf(actorOf(t, code, 'admin'), sellerId)).toEqual(
        expected,
      );
      expect(
        await facade.offerReviewFlagsOf(actorOf(t, code, 'seller', sellerId), sellerId),
      ).toEqual(expected);
      expect(
        (await facade.offerReviewFlagsOf(actorOf(t, code, 'seller', otherSeller), sellerId)).ok,
      ).toBe(false);
      expect(
        (await facade.offerReviewFlagsOf(testCallContext(market, 'anonymous'), sellerId)).ok,
      ).toBe(false);
    });

    it('answers sellers.unavailable for an unknown seller, another Market and a read error', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      const system = testCallContext(market, 'system');
      const unavailable = err({ code: 'sellers.unavailable' });
      expect(await t.readSystem.execute(system, { sellerId })).toEqual(unavailable);
      t.rows.seed(other, sellerId);
      expect(await t.readSystem.execute(system, { sellerId })).toEqual(unavailable);
      t.rows.seed(market, sellerId);
      t.rows.failReads = true;
      expect(await t.readSystem.execute(system, { sellerId })).toEqual(unavailable);
      expect(await t.read.execute(actorOf(t, code, 'admin'), { sellerId })).toEqual(unavailable);
    });

    it('keeps the request reader away from the system actor and the system reader from requests', async () => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId);
      expect((await t.read.execute(testCallContext(market, 'system'), { sellerId })).ok).toBe(
        false,
      );
      expect((await t.readSystem.execute(actorOf(t, code, 'admin'), { sellerId })).ok).toBe(false);
    });
  });
});
