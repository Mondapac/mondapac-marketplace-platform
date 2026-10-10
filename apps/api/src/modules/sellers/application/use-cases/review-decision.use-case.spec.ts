import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FixedRegisterLookupPolicy,
  InMemoryRegisterChecks,
} from '../../../../../test/support/sellers-register-fakes';
import {
  FakeAccess,
  FakeDecider,
  FakeSealer,
  InMemoryClaims,
  InMemoryFiles,
  InMemoryFlags,
  InMemoryReviewChecks,
  InMemoryRevisions,
  InMemorySlugs,
  TransactionalUnitOfWork,
} from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { newPendingRevision, type BusinessFileContent } from '../../domain/business-file-revision';
import { identifierIndexKeyOf } from '../../domain/business-identifier';
import { registerCheckAfter } from '../../domain/register-check';
import { SellerFile } from '../../domain/seller-file';
import { parseStoreName } from '../../domain/store-name';
import type { ShopSlug } from '../../domain/shop-slug';
import type { RegisterLookupSettings } from '../ports/register-lookup-policy';
import {
  CONNECTION_WAIT_MS,
  DEFAULT_UNIT_TIMEOUT_MS,
  UNIT_ATTEMPTS,
} from '../../../../platform/unit-of-work/unit-of-work';
import { DECISION_CALL_DEADLINE_MS, RECONCILE_AFTER } from '../../domain/decision-intent';
import type { ReviewDecisionDependencies } from '../review/decision-request';
import { CloseDecision } from './close-decision.use-case';
import { ReconcileDecisions } from './reconcile-decisions.use-case';
import { ReviewApprove } from './review-approve.use-case';
import { ReviewRecordManualCheck } from './review-record-manual-check.use-case';
import { ReviewReject } from './review-reject.use-case';

// The reviewer's decision of slice 7a-decide (sellers design 3.1, 3.4, 3.6, 7.3; AC 10, 21, 22, 31,
// 32), on both Market fixtures, in memory: the two units around the call into `identity`, the
// register guard, the identifier claim, and the two paths that finish a decision whose request
// died (the event handler and the reconciliation job), including their interleavings (Hassan M3).
// PostgreSQL (the row lock, the partial indexes, the CHECKs) is covered by the db specs.

const START = Temporal.Instant.from('2026-10-10T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const REASON = 'The licence number does not match';

const CONFIGURED: RegisterLookupSettings = {
  kind: 'configured',
  adapter: 'fake',
  maxResultAgeDays: 30,
  perAccountLimit: 5,
  perOriginLimit: 30,
  marketDailyBudget: 1000,
  legalSuffixes: [],
};

const CONTENT: BusinessFileContent = {
  schemaVersion: 1,
  storeName: 'Al Noor Grocer',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
  address: { line1: '1 George St', suburb: 'Brisbane' },
  registeredAddress: null,
  identifier: { scheme: 'abn', value: '51824753556' },
  registeredForIndirectTax: true,
};

class RecordingAudit implements AuditWriter {
  readonly rows: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    this.rows.push(entry);
    return Promise.resolve();
  }
}

describe.each(['AU', 'ZZ'] as const)('the reviewer decision in Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  let clock: FixedClock;
  let ids: SequenceIdGenerator;
  let files: InMemoryFiles;
  let revisions: InMemoryRevisions;
  let claims: InMemoryClaims;
  let flags: InMemoryFlags;
  let slugs: InMemorySlugs;
  let reviewChecks: InMemoryReviewChecks;
  let registerChecks: InMemoryRegisterChecks;
  let access: FakeAccess;
  let decider: FakeDecider;
  let audit: RecordingAudit;
  let policy: FixedRegisterLookupPolicy;
  let deps: ReviewDecisionDependencies;
  let sellerId: Id<'Seller'>;
  let revisionId: Id<'BusinessFileRevision'>;
  const index = identifierIndexKeyOf(new Uint8Array(32).fill(9));
  const indexKey = Buffer.from(index).toString('hex');

  const gate = () => createUseCaseGate(markets, admitAll);
  const approve = () => new ReviewApprove(gate(), deps);
  const reject = () => new ReviewReject(gate(), deps);
  const closeDecision = () => new CloseDecision(gate(), deps);
  const reconcile = () => new ReconcileDecisions(gate(), deps);
  const manualCheck = () =>
    new ReviewRecordManualCheck(gate(), {
      unitOfWork: deps.unitOfWork,
      files,
      revisions,
      reviewChecks,
      audit,
      clock,
    });
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const system = (): CallContext => testCallContext(market, 'system', 'reconcile-0001');
  let deliveries = 0;
  const delivery = () => ({
    eventId: `0199eeee-0000-7000-8000-${String(++deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber: 'sellers.close-decision-approved',
    attempt: 1,
  });

  /** A seller with a submitted onboarding revision N (pending) and a held, unpublished slug. */
  async function submittedSeller(): Promise<{
    sellerId: Id<'Seller'>;
    revisionId: Id<'BusinessFileRevision'>;
  }> {
    const seller = ids.next<'Seller'>();
    const created = SellerFile.create({
      sellerId: seller,
      marketId: market.marketId,
      origin: 'self',
      approvalRequiredAtRegistration: true,
      now: START,
    });
    const storeName = parseStoreName(CONTENT.storeName);
    if (!storeName.ok) throw new Error('store name');
    files.add(
      SellerFile.restore({
        ...created.state,
        draft: { ...created.state.draft, storeName: storeName.value },
      }),
    );
    const sealed = await new FakeSealer().seal(market, seller, CONTENT);
    if (!sealed.ok) throw new Error('seal failed');
    const revision = newPendingRevision({
      id: ids.next<'BusinessFileRevision'>(),
      sellerId: seller,
      kind: 'onboarding',
      revisionNo: 1,
      authorKind: 'seller',
      authorAccountId: ids.next<'Account'>(),
      snapshot: {
        operatingTimezone: 'Australia/Brisbane',
        serviceAreaCode: 'area-1',
        addressTimezone: 'Australia/Brisbane',
        identifierIndex: index,
      },
      contentHash: sealed.value.contentHash,
      register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
      now: START,
    });
    await revisions.add(market, revision, sealed.value);
    await slugs.hold(market, { sellerId: seller, slug: `shop-${seller.slice(-6)}` as ShopSlug });
    access.set(seller, 'pending');
    return { sellerId: seller, revisionId: revision.id };
  }

  /** A fresh active register result for the identifier, obtained after the submission. */
  function activeCheck(seller: Id<'Seller'>) {
    registerChecks.rows.set(
      `${market.marketId}|${seller}|${indexKey}`,
      registerCheckAfter(
        null,
        'active',
        [],
        START.add({ minutes: 1 }),
        { kind: 'reviewer', accountId: ids.next<'Account'>() },
        1,
      ),
    );
  }

  const stateOf = (seller: Id<'Seller'>) => files.stored.get(`${market.marketId}|${seller}`)!;
  const statusOf = async (seller: Id<'Seller'>, revision: Id<'BusinessFileRevision'>) =>
    (await revisions.findById(market, seller, revision))?.status;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    clock = new FixedClock(START.add({ minutes: 10 }));
    ids = new SequenceIdGenerator(clock);
    files = new InMemoryFiles();
    revisions = new InMemoryRevisions();
    claims = new InMemoryClaims();
    flags = new InMemoryFlags();
    slugs = new InMemorySlugs();
    reviewChecks = new InMemoryReviewChecks();
    registerChecks = new InMemoryRegisterChecks();
    access = new FakeAccess();
    decider = new FakeDecider();
    audit = new RecordingAudit();
    policy = new FixedRegisterLookupPolicy({ [code]: CONFIGURED });
    deps = {
      unitOfWork: new TransactionalUnitOfWork([
        files,
        revisions,
        claims,
        flags,
        slugs,
        reviewChecks,
      ]),
      accessReader: access,
      decider,
      registerChecks,
      registerPolicy: policy,
      reviewChecks,
      files,
      revisions,
      claims,
      flags,
      slugs,
      ids,
      clock,
    };
    ({ sellerId, revisionId } = await submittedSeller());
  });
  afterEach(() => jest.restoreAllMocks());

  describe('approve', () => {
    it('approves revision N: the pointer, the public name, the claim and the public slug, in one settlement', async () => {
      activeCheck(sellerId);

      const result = await approve().execute(admin(), { sellerId, revisionId });

      expect(result).toEqual({ ok: true, value: { decision: 'approved', revisionId } });
      expect(decider.calls).toEqual([{ kind: 'approve', sellerId, basisId: revisionId }]);
      expect(await statusOf(sellerId, revisionId)).toBe('approved');
      expect(stateOf(sellerId)).toMatchObject({ hasApprovedRevision: true, decisionIntent: null });
      expect(files.approvals.get(`${market.marketId}|${sellerId}`)).toEqual({
        revisionId,
        publicStoreName: CONTENT.storeName,
      });
      expect(await claims.holderOf(market, index)).toBe(sellerId);
      expect([...slugs.rows.values()]).toEqual([{ sellerId, state: 'held', everPublic: true }]);
    });

    it('refuses without a current active result until a manual check is recorded (AC 32)', async () => {
      const refused = await approve().execute(admin(), { sellerId, revisionId });
      expect(refused).toEqual({
        ok: false,
        error: { code: 'review.manual-register-check-required' },
      });
      expect(decider.calls).toHaveLength(0);
      expect(stateOf(sellerId).decisionIntent).toBeNull();
      expect(claims.rows.size).toBe(0);

      const recorded = await manualCheck().execute(admin(), {
        sellerId,
        revisionId,
        observedOutcome: 'active',
      });
      expect(recorded).toEqual({ ok: true, value: { revisionId, observedOutcome: 'active' } });
      expect(audit.rows.map((row) => row.action)).toEqual([
        'sellers.register.manual-check-recorded',
      ]);

      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toMatchObject({
        ok: true,
        value: { decision: 'approved' },
      });
    });

    it('refuses a negative register reading, by hand or stored, whatever else was recorded (AC 31)', async () => {
      await manualCheck().execute(admin(), { sellerId, revisionId, observedOutcome: 'not-found' });
      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'review.register-negative' },
      });

      registerChecks.rows.set(
        `${market.marketId}|${sellerId}|${indexKey}`,
        registerCheckAfter(
          null,
          'cancelled',
          [],
          START.add({ minutes: 2 }),
          { kind: 'reviewer', accountId: ids.next<'Account'>() },
          1,
        ),
      );
      await manualCheck().execute(admin(), { sellerId, revisionId, observedOutcome: 'active' });
      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'review.register-negative' },
      });
      expect(decider.calls).toHaveLength(0);
    });

    it('refuses when another seller of the Market holds the identifier (AC 21)', async () => {
      const other = await submittedSeller();
      activeCheck(other.sellerId);
      await approve().execute(admin(), other);
      activeCheck(sellerId);

      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'review.identifier-claimed' },
      });
      expect(stateOf(sellerId).decisionIntent).toBeNull();
      expect(await statusOf(sellerId, revisionId)).toBe('pending');
    });

    it('refuses a revision id that is not the pending onboarding revision (AC 10, 22)', async () => {
      activeCheck(sellerId);
      await expect(
        approve().execute(admin(), { sellerId, revisionId: ids.next<'BusinessFileRevision'>() }),
      ).resolves.toEqual({ ok: false, error: { code: 'review.not-current-revision' } });
      await expect(approve().execute(admin(), { sellerId, revisionId: 'nope' })).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'revisionId', code: 'format' }] },
      });
      expect(stateOf(sellerId).decisionIntent).toBeNull();
    });

    it('answers file.not-found for an unknown or malformed seller, and wrong-state unless pending', async () => {
      await expect(
        approve().execute(admin(), { sellerId: ids.next<'Seller'>(), revisionId }),
      ).resolves.toEqual({ ok: false, error: { code: 'file.not-found' } });
      await expect(approve().execute(admin(), { sellerId: 'x', revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      access.set(sellerId, 'rejected');
      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'seller-access.wrong-state' },
      });
    });

    it("passes identity's refusal on and releases the intent and the claim", async () => {
      activeCheck(sellerId);
      decider.script.push('seller-access.owner-unverified');

      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: false,
        error: { code: 'seller-access.owner-unverified' },
      });
      expect(stateOf(sellerId).decisionIntent).toBeNull();
      expect(claims.rows.size).toBe(0);
      expect(await statusOf(sellerId, revisionId)).toBe('pending');
    });

    it('refuses a second decision while one is in flight, and the seller cannot edit or withdraw', async () => {
      activeCheck(sellerId);
      let second: unknown;
      decider.during = async () => {
        second = await reject().execute(admin(), { sellerId, revisionId, reason: REASON });
        decider.during = null;
      };

      await approve().execute(admin(), { sellerId, revisionId });

      expect(second).toEqual({ ok: false, error: { code: 'file.decision-in-progress' } });
      expect(decider.calls.map((call) => call.kind)).toEqual(['approve']);
    });
  });

  describe('reject', () => {
    it('rejects revision N with the reason, which only identity receives', async () => {
      const result = await reject().execute(admin(), { sellerId, revisionId, reason: REASON });

      expect(result).toEqual({ ok: true, value: { decision: 'rejected', revisionId } });
      expect(decider.calls).toEqual([
        { kind: 'reject', sellerId, basisId: revisionId, reason: REASON },
      ]);
      expect(await statusOf(sellerId, revisionId)).toBe('rejected');
      expect(stateOf(sellerId)).toMatchObject({ hasApprovedRevision: false, decisionIntent: null });
      expect(claims.rows.size).toBe(0);
      expect(JSON.stringify([...files.stored.values()])).not.toContain('licence');
    });

    it('needs no register reading and refuses a reason that is not a string', async () => {
      await expect(reject().execute(admin(), { sellerId, revisionId, reason: 7 })).resolves.toEqual(
        {
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'reason', code: 'type' }] },
        },
      );
      await expect(
        reject().execute(admin(), { sellerId, revisionId, reason: 'x'.repeat(2001) }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('a decision whose request did not hear back (design 7.3)', () => {
    beforeEach(() => activeCheck(sellerId));

    it('answers in-progress and the event handler settles it, once', async () => {
      decider.script.push('throw');
      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: true,
        value: { decision: 'in-progress', revisionId },
      });
      expect(stateOf(sellerId).decisionIntent).toMatchObject({
        kind: 'approve-requested',
        revisionId,
      });
      expect(await statusOf(sellerId, revisionId)).toBe('pending');

      const recorded = decider.recorded[0]!;
      const event = {
        delivery: delivery(),
        outcome: 'approved' as const,
        sellerId,
        decisionId: recorded.decisionId,
        basisId: revisionId,
      };
      await expect(closeDecision().execute(system(), event)).resolves.toEqual({
        ok: true,
        value: { code: 'close-decision.settled' },
      });
      await expect(closeDecision().execute(system(), event)).resolves.toEqual({
        ok: true,
        value: { code: 'close-decision.already-handled' },
      });
      expect(await statusOf(sellerId, revisionId)).toBe('approved');
      expect(stateOf(sellerId)).toMatchObject({ hasApprovedRevision: true, decisionIntent: null });
    });

    it('settles once when the handler gets in during the call (Hassan M3)', async () => {
      decider.during = async () => {
        const recorded = decider.recorded[0]!;
        await closeDecision().execute(system(), {
          delivery: delivery(),
          outcome: 'approved',
          sellerId,
          decisionId: recorded.decisionId,
          basisId: revisionId,
        });
      };

      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: true,
        value: { decision: 'approved', revisionId },
      });
      expect(await statusOf(sellerId, revisionId)).toBe('approved');
      expect(stateOf(sellerId).decisionIntent).toBeNull();
      expect(flags.open.size).toBe(0);
    });

    it('lets the job settle an intent older than five minutes from the decision identity holds', async () => {
      decider.script.push('throw');
      await approve().execute(admin(), { sellerId, revisionId });

      clock.set(clock.now().add({ minutes: 4 }));
      await expect(reconcile().execute(system(), {})).resolves.toEqual({
        ok: true,
        value: { settled: 0, released: 0, left: 0 },
      });

      clock.set(clock.now().add({ minutes: 2 }));
      await expect(reconcile().execute(system(), {})).resolves.toEqual({
        ok: true,
        value: { settled: 1, released: 0, left: 0 },
      });
      expect(await statusOf(sellerId, revisionId)).toBe('approved');
      expect(stateOf(sellerId).decisionIntent).toBeNull();
    });

    it('lets the job release an intent identity never decided while the seller is pending', async () => {
      decider.script.push('throw');
      await approve().execute(admin(), { sellerId, revisionId });
      decider.recorded.length = 0;
      clock.set(clock.now().add({ minutes: 6 }));

      await expect(reconcile().execute(system(), {})).resolves.toEqual({
        ok: true,
        value: { settled: 0, released: 1, left: 0 },
      });
      expect(stateOf(sellerId).decisionIntent).toBeNull();
      expect(claims.rows.size).toBe(0);
      expect(await statusOf(sellerId, revisionId)).toBe('pending');
    });

    it('leaves the intent when identity cannot answer, or holds no decision and is not pending (Hassan C6)', async () => {
      decider.script.push('throw');
      await approve().execute(admin(), { sellerId, revisionId });
      decider.recorded.length = 0;
      clock.set(clock.now().add({ minutes: 6 }));

      decider.byBasisFails = true;
      await expect(reconcile().execute(system(), {})).rejects.toThrow('identity unavailable');
      decider.byBasisFails = false;
      access.set(sellerId, 'approved');
      await expect(reconcile().execute(system(), {})).resolves.toEqual({
        ok: true,
        value: { settled: 0, released: 0, left: 1 },
      });
      expect(stateOf(sellerId).decisionIntent).not.toBeNull();
      expect(await claims.holderOf(market, index)).toBe(sellerId);
    });

    it('refuses the manual check while the decision is in flight', async () => {
      decider.script.push('throw');
      await approve().execute(admin(), { sellerId, revisionId });

      await expect(
        manualCheck().execute(admin(), { sellerId, revisionId, observedOutcome: 'active' }),
      ).resolves.toEqual({ ok: false, error: { code: 'file.decision-in-progress' } });
    });
  });

  it('marks an event without a basisId handled and changes nothing', async () => {
    await expect(
      closeDecision().execute(system(), {
        delivery: delivery(),
        outcome: 'approved',
        sellerId,
        decisionId: ids.next<'AccessDecision'>(),
        basisId: null,
      }),
    ).resolves.toEqual({ ok: true, value: { code: 'close-decision.no-basis' } });
    expect(await statusOf(sellerId, revisionId)).toBe('pending');
  });

  it('refuses the system use cases to a person, and the manual check to a revision not pending', async () => {
    await expect(reconcile().execute(admin(), {})).resolves.toMatchObject({ ok: false });
    await expect(
      manualCheck().execute(admin(), {
        sellerId,
        revisionId: ids.next<'BusinessFileRevision'>(),
        observedOutcome: 'active',
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'review.not-current-revision' } });
    await expect(
      manualCheck().execute(admin(), { sellerId, revisionId, observedOutcome: 'maybe' }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'observedOutcome', code: 'enum' }] },
    });
  });

  describe('identity refusals and failures after identity decided (Sajad)', () => {
    beforeEach(() => activeCheck(sellerId));

    it.each([
      ['seller-access.reason-required', undefined, { code: 'seller-access.reason-required' }],
      [
        'validation.failed',
        'characters',
        { code: 'validation.failed', fields: [{ path: 'reason', code: 'characters' }] },
      ],
      ['seller.unknown', undefined, { code: 'file.not-found' }],
      ['something.new', undefined, { code: 'access.unavailable' }],
    ] as const)('maps %s and releases the intent', async (code, rule, expected) => {
      decider.reject = (_context, seller, reason, basisId) => {
        decider.calls.push({ kind: 'reject', sellerId: seller, basisId, reason });
        return Promise.resolve(
          rule === undefined ? { kind: 'refused', code } : { kind: 'refused', code, rule },
        );
      };

      await expect(
        reject().execute(admin(), { sellerId, revisionId, reason: REASON }),
      ).resolves.toEqual({ ok: false, error: expected });
      expect(stateOf(sellerId).decisionIntent).toBeNull();
    });

    it('refuses a blank reason before it locks anything', async () => {
      await expect(
        reject().execute(admin(), { sellerId, revisionId, reason: '   ' }),
      ).resolves.toEqual({ ok: false, error: { code: 'seller-access.reason-required' } });
      expect(decider.calls).toEqual([]);
      expect(stateOf(sellerId).version).toBe(1);
    });

    it('answers in-progress when the settlement fails after identity decided', async () => {
      const save = revisions.saveDecision.bind(revisions);
      revisions.saveDecision = () => Promise.reject(new Error('connection lost'));

      await expect(approve().execute(admin(), { sellerId, revisionId })).resolves.toEqual({
        ok: true,
        value: { decision: 'in-progress', revisionId },
      });
      expect(stateOf(sellerId).decisionIntent).not.toBeNull();

      revisions.saveDecision = save;
      clock.set(clock.now().add({ minutes: 6 }));
      await expect(reconcile().execute(system(), {})).resolves.toMatchObject({
        ok: true,
        value: { settled: 1 },
      });
      expect(await statusOf(sellerId, revisionId)).toBe('approved');
    });
  });

  it('flags both sellers when a late approval meets a claim taken meanwhile (AC 21, design 7.3)', async () => {
    // A's approval times out; identity's decision is not visible to the job, which releases A.
    activeCheck(sellerId);
    decider.script.push('throw');
    await approve().execute(admin(), { sellerId, revisionId });
    const late = decider.recorded.splice(0)[0]!;
    clock.set(clock.now().add({ minutes: 6 }));
    await expect(reconcile().execute(system(), {})).resolves.toMatchObject({
      value: { released: 1 },
    });

    // B takes the same business number.
    const b = await submittedSeller();
    activeCheck(b.sellerId);
    await expect(approve().execute(admin(), b)).resolves.toMatchObject({
      value: { decision: 'approved' },
    });

    // A's late event arrives: recorded (identity approved it), both flagged for an admin.
    await expect(
      closeDecision().execute(system(), {
        delivery: delivery(),
        outcome: 'approved',
        sellerId,
        decisionId: late.decisionId,
        basisId: revisionId,
      }),
    ).resolves.toEqual({ ok: true, value: { code: 'close-decision.settled' } });
    expect(await statusOf(sellerId, revisionId)).toBe('approved');
    expect([...flags.open].sort()).toEqual(
      [
        `${market.marketId}|${sellerId}|identifier-claim-conflict`,
        `${market.marketId}|${b.sellerId}|identifier-claim-conflict`,
      ].sort(),
    );
    expect(await claims.holderOf(market, index)).toBe(b.sellerId);
  });
});

// Hassan M3: identity's decision unit (its default timeout and connection wait, over every attempt)
// ends before the request's deadline, and the deadline well before the job looks at an intent, so
// a late commit in identity can never follow a release by the job.
it("keeps identity's unit inside the call deadline, and the deadline inside the job's wait", () => {
  expect((DEFAULT_UNIT_TIMEOUT_MS + CONNECTION_WAIT_MS) * UNIT_ATTEMPTS).toBeLessThan(
    DECISION_CALL_DEADLINE_MS,
  );
  expect(DECISION_CALL_DEADLINE_MS).toBeLessThan(RECONCILE_AFTER.total('milliseconds'));
});
