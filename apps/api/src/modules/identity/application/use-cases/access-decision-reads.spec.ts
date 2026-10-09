import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { ActorContext, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  realEffectiveKeys,
  realPermissionRegistry,
} from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz/authorisation-check';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccessDecisionsUnavailable } from '../../contracts/seller-access.contract';
import type { AccountState } from '../../domain/account';
import { AccessDecision, type AccessDecisionKind } from '../../domain/access-decision';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { SellerAccessContractImplementation } from '../../presentation/seller-access.contract';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { AccessDecisionRepository } from '../ports/access-decision.repository';
import {
  isActingAsSession,
  MAX_ACCESS_DECISIONS,
  MAX_BASIS_PAIRS,
} from '../sellers/access-decision-reads';
import { FindAccessDecisionsByBasis } from './find-access-decisions-by-basis.use-case';
import { ListSellerAccessDecisions } from './list-seller-access-decisions.use-case';
import { SeedRoles } from './seed-roles.use-case';

// Identity slice 9a in memory (identity design 8.1; sellers request R-5; Mohammad's design,
// Hassan's conditions C1, C2, C5 and C6 on the identity side): `accessDecisionsOf` for the admin
// review and `accessDecisionsByBasis` for the reconciliation job, through the seller-access
// contract, on both Market fixtures. The PostgreSQL side is test/db/access-decision-reads.db-spec.ts.

const START = Temporal.Instant.from('2026-10-09T08:00:00Z');
const REASON = 'Canary R-5 reason: licence 5551234 belongs to another business';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const n12 = (n: number) => String(n).padStart(12, '0');
const uuid = <T extends string>(n: number) => `01990000-0000-7000-8000-${n12(n)}` as Id<T>;
const SELLER = uuid<'Seller'>(0xb001);
const NEIGHBOUR = uuid<'Seller'>(0xb002);
const FOREIGN = uuid<'Seller'>(0xb003);
const UNKNOWN = uuid<'Seller'>(0xb0ff);
const ADMIN = uuid<'Account'>(0xa001);
const MODERATOR = uuid<'Account'>(0xa002);
const NO_VIEW = uuid<'Account'>(0xa003);
const OWNER = uuid<'Account'>(0xa004);
const DECIDER = uuid<'Account'>(0xa0dd);
const NO_VIEW_ROLE = uuid<'Role'>(0xe0ff);
const BASIS_1 = uuid(0x5001);
const BASIS_2 = uuid(0x5002);
const UNAVAILABLE: AccessDecisionsUnavailable = { code: 'access-decisions.unavailable' };

const notUsed = <T>(): T =>
  ({
    execute: () => Promise.reject(new Error('not used in this spec')),
  }) as unknown as T;

/** An authorisation check that admits everyone: what the use case checks again on its own. */
const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

function setUp(options: { readonly openGate?: boolean } = {}) {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, opts?: UnitOfWorkOptions) => {
      units.push(opts);
      return fakes.unitOfWork.run(m, work);
    },
    runOnce: (m, delivery, work, opts) => fakes.unitOfWork.runOnce(m, delivery, work, opts),
  };
  const gate = createUseCaseGate(
    markets,
    options.openGate === true
      ? admitsAll
      : new AccountAuthorisationCheck({
          unitOfWork,
          accounts: fakes.accountRepository,
          memberships: fakes.membershipRepository,
          sellerAccess: fakes.sellerAccessRepository,
          grants: fakes.grantReader,
          effectiveKeys: realEffectiveKeys(),
        }),
  );
  // A wrapper, so a test can make one read fail as the database or the key store would.
  const decisions: AccessDecisionRepository & { fail: Error | null; reads: number } = {
    fail: null,
    reads: 0,
    add: (m, d) => fakes.decisionRepository.add(m, d),
    findById: (m, id) => fakes.decisionRepository.findById(m, id),
    latestOf: (m, id) => fakes.decisionRepository.latestOf(m, id),
    historyOf: (m, id, limit) => {
      decisions.reads += 1;
      if (decisions.fail !== null) return Promise.reject(decisions.fail);
      return fakes.decisionRepository.historyOf(m, id, limit);
    },
    findByBasis: (m, basisIds) => {
      decisions.reads += 1;
      if (decisions.fail !== null) return Promise.reject(decisions.fail);
      return fakes.decisionRepository.findByBasis(m, basisIds);
    },
  };
  const list = new ListSellerAccessDecisions(gate, {
    unitOfWork,
    decisions,
    accounts: fakes.accountRepository,
    grants: fakes.grantReader,
    effectiveKeys: realEffectiveKeys(),
  });
  const byBasis = new FindAccessDecisionsByBasis(gate, { unitOfWork, decisions });
  return {
    fakes,
    units,
    decisions,
    contract: new SellerAccessContractImplementation({
      sellerAccessOf: notUsed(),
      sellerAccessOfSystem: notUsed(),
      sellerAccountSummaries: notUsed(),
      listRegisteredSellers: notUsed(),
      notifyAccessReviewers: notUsed(),
      approveSellerAccess: notUsed(),
      rejectSellerAccess: notUsed(),
      reapplySellerAccess: notUsed(),
      listSellerAccessDecisions: list,
      findAccessDecisionsByBasis: byBasis,
    }),
    seed: new SeedRoles(gate, {
      unitOfWork,
      roles: fakes.roleRepository,
      seed: new CheckedInRoleSeed(),
      permissions: realPermissionRegistry(),
      clock,
      ids,
      audit: fakes.audit,
    }),
  };
}

type Setup = ReturnType<typeof setUp>;

describe.each(TEST_MARKETS)('R-5 access decision reads in market %s (slice 9a)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const otherCode = TEST_MARKETS.find((c) => c !== code)!;
  const otherMarket = testMarketContext(otherCode, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const system = testCallContext(market, 'system');
  const actorOf = (accountId: Id<'Account'>, population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: uuid<'Session'>(0xc000 + Number.parseInt(accountId.slice(-4), 16)),
        sellerId: population === 'seller' ? SELLER : null,
      }),
    );
  const admin = actorOf(ADMIN, 'admin');
  const moderator = actorOf(MODERATOR, 'admin');
  const noView = actorOf(NO_VIEW, 'admin');
  const sellerActor = actorOf(OWNER, 'seller');

  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));
  const logged = () => JSON.stringify(logs.flatMap((spy) => spy.mock.calls as unknown[]));
  const lines = () =>
    logs.flatMap((spy) => (spy.mock.calls as unknown[][]).map((call) => call[0])) as {
      msg?: string;
    }[];

  /** Roles; an onboarding admin, a catalogue moderator, an admin without the key; the owner. */
  async function seeded(s: Setup) {
    await s.seed.execute(system, {});
    const roleOf = (scope: string, seedCode: string) =>
      [...s.fakes.roles.values()].find((r) => r.scope === scope && r.seedCode === seedCode)!.id;
    s.fakes.seedRole({
      id: NO_VIEW_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      permissionKeys: ['identity.customer-account.view'],
      version: 1,
      createdAt: START,
    });
    const people: [Id<'Account'>, AccountState['population'], Id<'Role'>][] = [
      [ADMIN, 'admin', roleOf('platform', 'onboarding-compliance')],
      [MODERATOR, 'admin', roleOf('platform', 'catalogue-moderator')],
      [NO_VIEW, 'admin', NO_VIEW_ROLE],
      [OWNER, 'seller', roleOf('seller', 'seller-owner')],
    ];
    people.forEach(([id, population, roleId], n) => {
      const email = `p${n}@example.com`;
      s.fakes.seedAccount({
        id,
        marketId,
        population,
        email: { typed: email, normalized: email },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('a long enough password'), changedAt: START },
      });
      s.fakes.seedAssignment({
        id: uuid<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId: id,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    });
    s.fakes.seedMembership({
      id: uuid<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    for (const [sellerId, m] of [
      [SELLER, marketId],
      [NEIGHBOUR, marketId],
      [FOREIGN, otherCode as AccountState['marketId']],
    ] as const) {
      s.fakes.seedSellerAccess({
        sellerId,
        marketId: m,
        origin: 'self',
        state: 'approved',
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 3,
        createdAt: START,
      });
      s.fakes.subjectKeys.set(sellerId, 'live');
    }
    s.fakes.events.length = 0;
    s.fakes.audits.length = 0;
  }

  let decisionSeq = 0;
  /** Stores one decision as the deciding use cases do (its reason sealed under the seller's key). */
  async function decided(
    s: Setup,
    decision: AccessDecisionKind,
    options: {
      readonly sellerId?: Id<'Seller'>;
      readonly in?: MarketContext;
      readonly basisId?: Id | null;
      readonly by?: Id<'Account'> | null;
      readonly minutes?: number;
    } = {},
  ): Promise<Id<'AccessDecision'>> {
    const id = uuid<'AccessDecision'>(0x9000 + ++decisionSeq);
    const m = options.in ?? market;
    await s.fakes.decisionRepository.add(
      m,
      AccessDecision.restore({
        id,
        marketId: m.marketId,
        sellerId: options.sellerId ?? SELLER,
        decision,
        reason: AccessDecision.needsReason(decision) ? REASON : null,
        basisId: options.basisId ?? null,
        decidedByAccountId: options.by === undefined ? DECIDER : options.by,
        decidedAt: START.add({ minutes: options.minutes ?? decisionSeq }),
      }),
    );
    return id;
  }

  // --- accessDecisionsOf -------------------------------------------------------------------

  it('answers the decisions newest first, the reason decrypted only for the admin who asked', async () => {
    const s = setUp();
    await seeded(s);
    const approved = await decided(s, 'approved', { by: null, basisId: BASIS_1, minutes: 1 });
    const suspended = await decided(s, 'suspended', { minutes: 2 });
    const reinstated = await decided(s, 'reinstated', { minutes: 3 });

    const result = await s.contract.accessDecisionsOf(admin, SELLER);

    expect(result).toEqual({
      ok: true,
      value: {
        sellerId: SELLER,
        truncated: false,
        decisions: [
          {
            decisionId: reinstated,
            kind: 'reinstated',
            resultingState: 'approved',
            decidedAt: START.add({ minutes: 3 }),
            decidedBy: { kind: 'admin', accountId: DECIDER },
            basisId: null,
            reason: { status: 'none' },
          },
          {
            decisionId: suspended,
            kind: 'suspended',
            resultingState: 'suspended',
            decidedAt: START.add({ minutes: 2 }),
            decidedBy: { kind: 'admin', accountId: DECIDER },
            basisId: null,
            reason: { status: 'present', text: REASON },
          },
          {
            decisionId: approved,
            kind: 'approved',
            resultingState: 'approved',
            decidedAt: START.add({ minutes: 1 }),
            decidedBy: { kind: 'system' },
            basisId: BASIS_1,
            reason: { status: 'none' },
          },
        ],
      },
    });
    // ADR-0025: one read-only unit, no transaction; nothing written (Hassan C4).
    expect(s.units.at(-1)).toEqual({ readOnly: true });
    expect(s.fakes.audits).toEqual([]);
    expect(s.fakes.events).toEqual([]);
    // Any holder of the view key (identity design 5.6) reads it at this facade (Hassan Q2).
    await expect(s.contract.accessDecisionsOf(moderator, SELLER)).resolves.toMatchObject({
      ok: true,
    });
  });

  it(`answers exactly ${MAX_ACCESS_DECISIONS} rows with truncated false (Sajad 1)`, async () => {
    const s = setUp();
    await seeded(s);
    for (let i = 0; i < MAX_ACCESS_DECISIONS; i += 1) await decided(s, 'approved');

    const result = await s.contract.accessDecisionsOf(admin, SELLER);

    expect(result.ok && result.value.decisions.length).toBe(MAX_ACCESS_DECISIONS);
    expect(result.ok && result.value.truncated).toBe(false);
  });

  it(`answers the newest ${MAX_ACCESS_DECISIONS} of ${MAX_ACCESS_DECISIONS + 1}, the oldest dropped, with truncated (Sajad 1)`, async () => {
    const s = setUp();
    await seeded(s);
    const ids: Id<'AccessDecision'>[] = [];
    for (let i = 0; i < MAX_ACCESS_DECISIONS + 1; i += 1) ids.push(await decided(s, 'approved'));

    const result = await s.contract.accessDecisionsOf(admin, SELLER);

    expect(result.ok && result.value.truncated).toBe(true);
    // decided() gives each later decision a later instant: newest first is the reverse order.
    expect(result.ok && result.value.decisions.map((d) => d.decisionId)).toEqual(
      ids.slice(1).reverse(),
    );
  });

  it('refuses the system actor, a seller actor and an admin without the view key (gate)', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'rejected');

    for (const context of [system, sellerActor, noView]) {
      await expect(s.contract.accessDecisionsOf(context, SELLER)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(s.decisions.reads).toBe(0);
    expect(logged()).not.toContain('5551234');
  });

  it('refuses them again in the use case when the gate admits (Hassan C1)', async () => {
    const s = setUp({ openGate: true });
    await seeded(s);
    await decided(s, 'rejected');

    // An admin actor carrying the reserved acting-as marker (Hassan L2). A plain object is not
    // minted, so today the gate already refuses it before the use case; the use case's marker
    // check is covered on its own below, and by minted actors once SEL-08 adds the field (L1).
    const actingAs = {
      ...admin,
      actor: {
        ...admin.actor,
        actingAs: { accountId: OWNER, sellerId: SELLER },
      },
    } as unknown as CallContext;
    for (const context of [system, sellerActor, noView, actingAs]) {
      await expect(s.contract.accessDecisionsOf(context, SELLER)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(s.decisions.reads).toBe(0);
    // A disabled admin is refused in the read itself, before any reason is opened.
    s.fakes.accounts.set(ADMIN, { ...s.fakes.accounts.get(ADMIN)!, status: 'disabled' });
    await expect(s.contract.accessDecisionsOf(admin, SELLER)).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(s.decisions.reads).toBe(0);
  });

  it('answers erased for every reason once the seller key is destroyed; the others stay', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'rejected', { minutes: 1 });
    await decided(s, 'approved', { minutes: 2 });
    await decided(s, 'suspended', { minutes: 3 });
    s.fakes.subjectKeys.set(SELLER, 'destroyed');

    const result = await s.contract.accessDecisionsOf(admin, SELLER);

    expect(result.ok && result.value.decisions.map((d) => [d.kind, d.reason])).toEqual([
      ['suspended', { status: 'erased' }],
      ['approved', { status: 'none' }],
      ['rejected', { status: 'erased' }],
    ]);
  });

  it('answers unavailable, never erased nor partial, on an integrity failure, and logs it without the ciphertext (C2)', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'approved', { minutes: 1 });
    const tampered = await decided(s, 'rejected', { minutes: 2 });
    await decided(s, 'suspended', { minutes: 3 });
    const stored = s.fakes.decisions.get(tampered)!;
    // The ciphertext of another seller: it does not authenticate here.
    s.fakes.decisions.set(tampered, {
      ...stored,
      cipher: stored.cipher!.replace(SELLER, NEIGHBOUR),
    });

    const result = await s.contract.accessDecisionsOf(admin, SELLER);

    expect(result).toEqual({ ok: false, error: UNAVAILABLE });
    expect(Object.keys((result as { error: object }).error)).toEqual(['code']);
    const alert = lines().find((line) => line.msg === 'identity.access-decisions.integrity-failed');
    expect(alert).toEqual({
      msg: 'identity.access-decisions.integrity-failed',
      useCase: 'identity.list-seller-access-decisions',
      check: 'ciphertext-authentication',
      sellerId: SELLER,
      marketId: code,
      correlationId: admin.correlationId,
    });
    expect(logged()).not.toContain('fake1|');
    expect(logged()).not.toContain('5551234');
  });

  it('answers unavailable on a missing key and on a database failure, with no detail', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'rejected');

    s.fakes.subjectKeys.delete(SELLER);
    await expect(s.contract.accessDecisionsOf(admin, SELLER)).resolves.toEqual({
      ok: false,
      error: UNAVAILABLE,
    });
    s.fakes.subjectKeys.set(SELLER, 'live');
    s.decisions.fail = new Error('connection reset; statement held 5551234');
    await expect(s.contract.accessDecisionsOf(admin, SELLER)).resolves.toEqual({
      ok: false,
      error: UNAVAILABLE,
    });
    expect(
      lines()
        .filter((line) => line.msg === 'identity.access-decisions.read-failed')
        .map((line) => (line as { error?: string }).error),
    ).toEqual(['SubjectKeyMissingError', 'Error']);
    expect(logged()).not.toContain('5551234');
    expect(logged()).not.toContain('connection reset');
  });

  it("answers another Market's seller and an unknown id byte-identically, empty", async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'rejected', { sellerId: FOREIGN, in: otherMarket });

    const foreign = await s.contract.accessDecisionsOf(admin, FOREIGN);
    const unknown = await s.contract.accessDecisionsOf(admin, UNKNOWN);

    expect(foreign).toEqual({
      ok: true,
      value: { sellerId: FOREIGN, decisions: [], truncated: false },
    });
    expect(JSON.stringify(foreign).replaceAll(FOREIGN, 'X')).toBe(
      JSON.stringify(unknown).replaceAll(UNKNOWN, 'X'),
    );
  });

  it('refuses a malformed seller id with validation.failed, never echoing it', async () => {
    const s = setUp();
    await seeded(s);
    const malformed = 'not-an-id-<script>9f3c';

    const result = await s.contract.accessDecisionsOf(admin, malformed as Id<'Seller'>);

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] },
    });
    expect(logged()).not.toContain('9f3c');
    expect(s.decisions.reads).toBe(0);
  });

  it("keeps the reason out of identity's logs on every path (log canary, C5)", async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'rejected', { minutes: 1 });
    await decided(s, 'suspended', { minutes: 2 });

    await s.contract.accessDecisionsOf(admin, SELLER);
    await s.contract.accessDecisionsOf(noView, SELLER);
    await s.contract.accessDecisionsOf(admin, 'bad' as Id<'Seller'>);
    s.decisions.fail = new Error(REASON);
    await s.contract.accessDecisionsOf(admin, SELLER);

    expect(lines().map((line) => line.msg)).toEqual(
      expect.arrayContaining([
        'identity.list-seller-access-decisions',
        'identity.access-decisions.read-failed',
      ]),
    );
    expect(logged()).not.toContain('5551234');
    expect(logged()).not.toContain('Canary R-5');
  });

  // --- accessDecisionsByBasis --------------------------------------------------------------

  it('answers the decisions whose Market, seller and basis all match; no reason, no decider', async () => {
    const s = setUp();
    await seeded(s);
    const mine = await decided(s, 'rejected', { basisId: BASIS_1, minutes: 1 });
    // The same basis under another seller of this Market: never answered for SELLER (C5).
    const neighbours = await decided(s, 'approved', {
      sellerId: NEIGHBOUR,
      basisId: BASIS_1,
      minutes: 2,
    });
    await decided(s, 'approved', { basisId: null, minutes: 3 });

    const result = await s.contract.accessDecisionsByBasis(system, [
      { sellerId: SELLER, basisId: BASIS_1 },
      { sellerId: SELLER, basisId: BASIS_1 },
      { sellerId: SELLER, basisId: BASIS_2 },
    ]);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          sellerId: SELLER,
          basisId: BASIS_1,
          decisionId: mine,
          kind: 'rejected',
          decidedAt: START.add({ minutes: 1 }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(neighbours);
    expect(JSON.stringify(result)).not.toContain('5551234');
    expect(s.units.at(-1)).toEqual({ readOnly: true });
    await expect(
      s.contract.accessDecisionsByBasis(system, [{ sellerId: NEIGHBOUR, basisId: BASIS_1 }]),
    ).resolves.toMatchObject({ ok: true, value: [{ decisionId: neighbours }] });
  });

  it('never answers a decision of another Market for the same pair', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'approved', { sellerId: FOREIGN, in: otherMarket, basisId: BASIS_2 });
    await decided(s, 'approved', { basisId: BASIS_1 });

    await expect(
      s.contract.accessDecisionsByBasis(system, [{ sellerId: FOREIGN, basisId: BASIS_2 }]),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      s.contract.accessDecisionsByBasis(testCallContext(otherMarket, 'system'), [
        { sellerId: SELLER, basisId: BASIS_1 },
      ]),
    ).resolves.toEqual({ ok: true, value: [] });
  });

  it('refuses an admin (even one holding the keys) and a seller actor', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'approved', { basisId: BASIS_1 });

    for (const context of [admin, moderator, sellerActor]) {
      await expect(
        s.contract.accessDecisionsByBasis(context, [{ sellerId: SELLER, basisId: BASIS_1 }]),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(s.decisions.reads).toBe(0);
  });

  it(`refuses 0 or more than ${MAX_BASIS_PAIRS} pairs and a malformed id, never echoing it`, async () => {
    const s = setUp();
    await seeded(s);
    const pair = { sellerId: SELLER, basisId: BASIS_1 };
    const malformed = 'basis-<b>7e1d' as Id;

    const answers = [
      await s.contract.accessDecisionsByBasis(system, []),
      await s.contract.accessDecisionsByBasis(system, Array(MAX_BASIS_PAIRS + 1).fill(pair)),
      await s.contract.accessDecisionsByBasis(system, [
        pair,
        { sellerId: SELLER, basisId: malformed },
      ]),
      await s.contract.accessDecisionsByBasis(system, [
        { sellerId: malformed as Id<'Seller'>, basisId: BASIS_1 },
      ]),
    ];

    expect(answers.map((a) => !a.ok && a.error)).toEqual([
      { code: 'validation.failed', fields: [{ path: 'items', code: 'length' }] },
      { code: 'validation.failed', fields: [{ path: 'items', code: 'length' }] },
      { code: 'validation.failed', fields: [{ path: 'items', code: 'format' }] },
      { code: 'validation.failed', fields: [{ path: 'items', code: 'format' }] },
    ]);
    expect(JSON.stringify(answers) + logged()).not.toContain('7e1d');
    expect(s.decisions.reads).toBe(0);
    // Exactly the cap is accepted (duplicates answered once).
    await expect(
      s.contract.accessDecisionsByBasis(system, Array(MAX_BASIS_PAIRS).fill(pair)),
    ).resolves.toEqual({ ok: true, value: [] });
  });

  it(`answers ${MAX_BASIS_PAIRS} distinct pairs, every one (Sajad 2)`, async () => {
    const s = setUp();
    await seeded(s);
    const pairs: { sellerId: Id<'Seller'>; basisId: Id }[] = [];
    for (let i = 0; i < MAX_BASIS_PAIRS; i += 1) {
      const basisId = uuid(0x6000 + i);
      await decided(s, 'approved', { basisId });
      pairs.push({ sellerId: SELLER, basisId });
    }

    const result = await s.contract.accessDecisionsByBasis(system, pairs);

    expect(result.ok && result.value.map((r) => r.basisId).sort()).toEqual(
      pairs.map((p) => p.basisId).sort(),
    );
  });

  it('answers unavailable, never an empty list, when the read fails (C6)', async () => {
    const s = setUp();
    await seeded(s);
    await decided(s, 'approved', { basisId: BASIS_1 });
    s.decisions.fail = new Error('canceling statement due to statement timeout');

    const result = await s.contract.accessDecisionsByBasis(system, [
      { sellerId: SELLER, basisId: BASIS_1 },
    ]);

    expect(result).toEqual({ ok: false, error: UNAVAILABLE });
    expect(logged()).not.toContain('statement timeout');
  });
});

describe('the acting-as marker (SEL-08, reserved; Hassan C1)', () => {
  const market = testMarketContext(TEST_MARKETS[0], PLATFORM_TENANT_ID);
  const admin = testAuthenticatedActor(market, {
    population: 'admin',
    accountId: uuid<'Account'>(0xa001),
    sessionId: uuid<'Session'>(0xc001),
    sellerId: null,
  });

  it('is absent from every actor the kernel mints today', () => {
    // Compile-time tripwire (Hassan L1): this stops compiling once SEL-08 adds `actingAs` to
    // `ActorContext`. Then replace `isActingAsSession` with a typed check and add use-case tests
    // with a minted acting-as actor (identity design 6.7, the SEL-08 row of PR #215).
    const actor: ActorContext = admin;
    // @ts-expect-error actingAs is not on ActorContext until SEL-08
    expect(actor.actingAs).toBeUndefined();
    expect(isActingAsSession(admin)).toBe(false);
    expect(isActingAsSession(testCallContext(market, 'system').actor)).toBe(false);
  });

  it('refuses an actor that carries it, whatever its population', () => {
    const acting = {
      ...admin,
      actingAs: { accountId: uuid<'Account'>(0xa004), sellerId: uuid<'Seller'>(0xb001) },
    } as unknown as ActorContext;

    expect(isActingAsSession(acting)).toBe(true);
    expect(isActingAsSession({ ...admin, actingAs: null } as unknown as ActorContext)).toBe(false);
  });
});
