import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
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
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AccessDeclaration } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { SellerAccessContractImplementation } from '../../presentation/seller-access.contract';
import {
  AccountAccessReviewers,
  activeFactorsIn,
  type ActiveSecondFactorReader,
  isAccessReviewer,
  type ReviewerRule,
  SELLER_ACCESS_APPROVE,
} from '../access/account-access-reviewers';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import {
  EMPTY_PERMISSION_REGISTRY,
  effectiveKeysOf,
  holdsEvery,
  type EffectiveKeyResolver,
  type PermissionRegistryView,
  type RoleGrant,
} from '../access/effective-keys';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type {
  AccessReviewer,
  AccessReviewers,
  ReviewerCandidateReader,
} from '../ports/access-reviewers';
import { AccessReviewersUnavailableError } from '../ports/access-reviewers';
import { ListRegisteredSellers } from './list-registered-sellers.use-case';
import {
  MAX_REVIEWER_RECIPIENTS,
  NotifyAccessReviewers,
  REVIEWER_NOTICE_BUDGET_MS,
  REVIEWER_NOTICE_SEND_TIMEOUT_MS,
} from './notify-access-reviewers.use-case';
import type { ApproveSellerAccess } from './approve-seller-access.use-case';
import type { ReapplySellerAccess } from './reapply-seller-access.use-case';
import type { RejectSellerAccess } from './reject-seller-access.use-case';
import { SellerAccessOf } from './seller-access-of.use-case';
import { SellerAccessOfSystem } from './seller-access-of-system.use-case';

// The reviewer notice (identity design 8.7; ux.md E3; request R-3; mini-review 3 with Ali's
// rulings and Hassan's M2 and L2), in memory, for both Market fixtures: the system-only contract
// method, the Market from the context, the pending-only guard, the recipient read (the grant
// read and the registry are bound since 8a-1, the factor store since slice 7; it fails closed),
// the fixed mail, the cap and the 20-second budget. The SQL of the recipient read is covered by
// test/db/reviewer-candidates.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');

/** A use case this spec never calls: calling it fails the test. */
const notUsed = <T>(): T =>
  ({
    execute: () => Promise.reject(new Error('not used in this spec')),
  }) as unknown as T;

/** A factor store holding active factors for exactly these accounts (slice 7). */
const factorsFor = (accounts: Iterable<string>): ActiveSecondFactorReader => {
  const holders = new Set(accounts);
  return {
    activeAmong: (_market, ids) =>
      Promise.resolve(new Set(ids.filter((accountId) => holders.has(accountId)))),
  };
};
/** No account has an active factor. */
const NO_FACTORS = factorsFor([]);
/** Every account has an active factor. */
const EVERY_FACTOR: ActiveSecondFactorReader = {
  activeAmong: (_market, ids) => Promise.resolve(new Set(ids)),
};
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const FOREIGN_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const UNREGISTERED_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b003');
const NEVER_ISSUED_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b0ff');
const OWNER_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');

// Canaries: seller data that must never reach the notice, its headers or a log line.
const CANARY_NAME = 'Canary Owner Zebra';
const CANARY_EMAIL = 'canary.owner@seller-canary.test';

const reviewer = (n: number): AccessReviewer => ({
  accountId: id<'Account'>(`01990000-0000-7000-8000-${String(0xd000 + n).padStart(12, '0')}`),
  email: `reviewer.${n}@admin-canary.test`,
});

function accountState(
  code: string,
  overrides: Partial<AccountState> & Pick<AccountState, 'id'>,
): AccountState {
  return {
    marketId: code as AccountState['marketId'],
    population: 'admin',
    email: { typed: `${overrides.id}@admin.test`, normalized: `${overrides.id}@admin.test` },
    displayName: 'Admin',
    status: 'active',
    emailVerifiedAt: START,
    existingAccountNoticeAt: null,
    signedUpAt: START,
    createdAt: START,
    version: 1,
    credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    ...overrides,
  };
}

/** A transport that records each message and answers as the test says. */
class ScriptedTransport implements MailTransport {
  readonly attempts: MailMessage[] = [];
  constructor(
    private readonly answer: (index: number) => Promise<void> = () => Promise.resolve(),
  ) {}

  send(message: MailMessage): Promise<void> {
    this.attempts.push(message);
    return this.answer(this.attempts.length - 1);
  }
}

/** A reviewer source that answers a fixed list, or fails. */
const reviewersOf = (
  list: readonly AccessReviewer[] | 'down',
): AccessReviewers & {
  calls: number;
} => {
  const source = {
    calls: 0,
    reviewersOf: () => {
      source.calls += 1;
      return list === 'down'
        ? Promise.reject(new AccessReviewersUnavailableError())
        : Promise.resolve(list);
    },
  };
  return source;
};

describe.each(TEST_MARKETS)('the reviewer notice in market %s (identity design 8.7)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const otherCode = TEST_MARKETS.find((other) => other !== code)!;
  const system = testCallContext(market, 'system', 'reviewer-notice-0001');
  let logs: jest.SpyInstance[];

  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Every structured log line written during the test, as JSON. */
  const calls = (): unknown[][] => logs.flatMap((spy) => spy.mock.calls as unknown[][]);
  const logged = (): string[] => calls().map((call) => JSON.stringify(call));
  const logOf = (msg: string): unknown =>
    calls().find((call) => (call[0] as { msg?: string }).msg === msg)?.[0];

  function setUp(
    options: {
      reviewers?: AccessReviewers;
      transport?: MailTransport;
      sellerState?: SellerAccessStateCode;
    } = {},
  ) {
    const fakes = new IdentityFakes();
    const units: (UnitOfWorkOptions | undefined)[] = [];
    let runOnceCalls = 0;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push(o);
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, o) => {
        runOnceCalls += 1;
        return fakes.unitOfWork.runOnce(m, delivery, work, o);
      },
    };
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
        grants: fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
      }),
    );
    // The seller owner, with canary data, and three sellers: pending here, one of the other
    // Market, one never registered.
    fakes.seedAccount(
      accountState(code, {
        id: OWNER_ID,
        population: 'seller',
        displayName: CANARY_NAME,
        email: { typed: CANARY_EMAIL, normalized: CANARY_EMAIL },
      }),
    );
    const seller = (sellerId: Id<'Seller'>, marketCode: string, registered: boolean) =>
      fakes.seedSellerAccess({
        sellerId,
        marketId: marketCode as AccountState['marketId'],
        origin: 'self',
        state: options.sellerState ?? 'pending',
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: registered ? START : null,
        version: 2,
        createdAt: START,
      });
    seller(SELLER_ID, code, true);
    seller(FOREIGN_SELLER_ID, otherCode, true);
    seller(UNREGISTERED_SELLER_ID, code, false);
    const transport = options.transport ?? new ScriptedTransport();
    const reviewers = options.reviewers ?? reviewersOf([reviewer(1), reviewer(2)]);
    const notify = new NotifyAccessReviewers(gate, {
      unitOfWork,
      sellerAccess: fakes.sellerAccessRepository,
      reviewers,
      targets: policy,
      composer,
      transport,
      policy,
    });
    const contract = new SellerAccessContractImplementation({
      sellerAccessOf: new SellerAccessOf(gate, {
        unitOfWork,
        sellerAccess: fakes.sellerAccessRepository,
      }),
      sellerAccessOfSystem: new SellerAccessOfSystem(gate, {
        unitOfWork,
        sellerAccess: fakes.sellerAccessRepository,
      }),
      listRegisteredSellers: new ListRegisteredSellers(gate, {
        unitOfWork,
        sellerAccess: fakes.sellerAccessRepository,
      }),
      notifyAccessReviewers: notify,
      // The decisions and re-apply behind the contract have their own spec (slice 9).
      approveSellerAccess: notUsed<ApproveSellerAccess>(),
      rejectSellerAccess: notUsed<RejectSellerAccess>(),
      reapplySellerAccess: notUsed<ReapplySellerAccess>(),
      // The R-5 reads have their own spec (slice 9a).
      listSellerAccessDecisions: notUsed(),
      findAccessDecisionsByBasis: notUsed(),
    });
    return {
      fakes,
      units,
      runOnceCalls: () => runOnceCalls,
      transport,
      reviewers,
      notify,
      contract,
      unitOfWork,
    };
  }

  const queue = () => policy.target(market, 'admin', 'seller-review-queue')!;
  const expectedMail = () =>
    composer.compose(market, { template: 'reviewer-notice', population: 'admin', url: queue() });

  it('declares rule system under its own name', () => {
    expect(NotifyAccessReviewers.access).toEqual<AccessDeclaration>({
      name: 'identity.notify-access-reviewers',
      rule: { kind: 'system' },
    });
  });

  // K1
  it('sends one fixed mail per eligible admin, one address each, with the configured queue link', async () => {
    const s = setUp();

    await expect(s.contract.notifyAccessReviewers(system, SELLER_ID)).resolves.toEqual({
      ok: true,
      value: { code: 'reviewer-notice.sent' },
    });

    const transport = s.transport as ScriptedTransport;
    const expected = expectedMail();
    expect(transport.attempts).toEqual([
      { to: reviewer(1).email, from: policy.mailSender(market), ...expected },
      { to: reviewer(2).email, from: policy.mailSender(market), ...expected },
    ]);
    // The Market's default locale, and the queue page only: no seller id, no query from data.
    expect(expected.subject).toBe(
      code === 'AU'
        ? 'A seller application is waiting for review'
        : '審査待ちの出品者申請があります',
    );
    expect(expected.text).toContain(queue());
    const everything = JSON.stringify(transport.attempts);
    for (const canary of [CANARY_NAME, CANARY_EMAIL, SELLER_ID, OWNER_ID]) {
      expect(everything).not.toContain(canary);
    }
    for (const mail of transport.attempts) expect(mail.to).not.toContain(',');
    // Counts and ids in the log, never an address or the body.
    expect(logOf('identity.reviewer-notice.sent')).toEqual({
      msg: 'identity.reviewer-notice.sent',
      sellerId: SELLER_ID,
      recipients: 2,
      sent: 2,
      failed: 0,
      notAttempted: 0,
      marketId: code,
      correlationId: 'reviewer-notice-0001',
    });
  });

  // K2
  it('refuses every actor but the system with access.denied, and sends nothing', async () => {
    const s = setUp();
    const authenticated = (population: 'seller' | 'admin' | 'customer') =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: OWNER_ID,
          sessionId: SESSION_ID,
          sellerId: population === 'seller' ? SELLER_ID : null,
        }),
      );
    const contexts: CallContext[] = [
      testCallContext(market, 'anonymous'),
      // The seller's own owner, signed in to that seller.
      authenticated('seller'),
      // An admin (one holding the approve key is refused alike: the rule is `system`).
      authenticated('admin'),
      authenticated('customer'),
    ];

    for (const context of contexts) {
      await expect(s.contract.notifyAccessReviewers(context, SELLER_ID)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
    expect((s.reviewers as ReturnType<typeof reviewersOf>).calls).toBe(0);
  });

  // K3
  it('answers seller.unknown, byte-identical, for another Market, a never-issued id and an unregistered seller', async () => {
    const s = setUp();

    const answers = [];
    for (const sellerId of [FOREIGN_SELLER_ID, NEVER_ISSUED_ID, UNREGISTERED_SELLER_ID]) {
      answers.push(JSON.stringify(await s.contract.notifyAccessReviewers(system, sellerId)));
    }

    expect(new Set(answers)).toEqual(
      new Set([
        JSON.stringify({
          ok: true,
          value: { code: 'reviewer-notice.skipped', reason: 'seller.unknown' },
        }),
      ]),
    );
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
    expect((s.reviewers as ReturnType<typeof reviewersOf>).calls).toBe(0);
  });

  // K4
  it.each<SellerAccessStateCode>(['approved', 'rejected', 'suspended'])(
    'answers seller.not-pending for a %s seller and sends nothing',
    async (state) => {
      const s = setUp({ sellerState: state });

      await expect(s.notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
        ok: true,
        value: { code: 'reviewer-notice.skipped', reason: 'seller.not-pending' },
      });
      expect((s.transport as ScriptedTransport).attempts).toEqual([]);
    },
  );

  // K6
  it('with no admins who may approve: recipients.none, a warning with ids only, and no mail', async () => {
    const s = setUp({ reviewers: reviewersOf([]) });

    await expect(s.notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
      ok: true,
      value: { code: 'reviewer-notice.skipped', reason: 'recipients.none' },
    });
    expect(logOf('identity.reviewer-notice.no-recipients')).toEqual({
      msg: 'identity.reviewer-notice.no-recipients',
      sellerId: SELLER_ID,
      marketId: code,
      correlationId: 'reviewer-notice-0001',
    });
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
  });

  // K7
  it('answers unavailable when every send fails, and sent when one of two fails', async () => {
    const allDown = setUp({
      transport: new ScriptedTransport(() => Promise.reject(new Error('down'))),
    });
    await expect(allDown.notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
      ok: false,
      error: { code: 'reviewer-notice.unavailable' },
    });

    const oneDown = setUp({
      transport: new ScriptedTransport((index) =>
        index === 0 ? Promise.reject(new Error('down')) : Promise.resolve(),
      ),
    });
    await expect(oneDown.notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
      ok: true,
      value: { code: 'reviewer-notice.sent' },
    });
    expect(logOf('identity.reviewer-notice.sent')).toMatchObject({ sent: 1, failed: 1 });
  });

  it('answers unavailable when the recipient read fails, and sends nothing', async () => {
    const s = setUp({ reviewers: reviewersOf('down') });

    await expect(s.notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
      ok: false,
      error: { code: 'reviewer-notice.unavailable' },
    });
    expect(logOf('identity.reviewer-notice.unavailable')).toMatchObject({
      reason: 'recipients-read-failed',
    });
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
  });

  // K8
  it('writes nothing: read-only units only, no inbox, outbox or audit row, and no address in a log', async () => {
    const s = setUp();

    await s.notify.execute(system, { sellerId: SELLER_ID });

    expect(s.units).toEqual([{ readOnly: true }]);
    expect(s.runOnceCalls()).toBe(0);
    expect(s.fakes.events).toEqual([]);
    expect(s.fakes.inbox.size).toBe(0);
    const lines = logged().join('\n');
    for (const secret of [reviewer(1).email, reviewer(2).email, CANARY_EMAIL, CANARY_NAME]) {
      expect(lines).not.toContain(secret);
    }
    expect(lines).not.toContain(expectedMail().subject);
  });

  // K9
  it('refuses a malformed id with validation.failed and never echoes it', async () => {
    const s = setUp();
    const malformed = 'not-a-uuid<script>canary-id';

    const result = await s.notify.execute(system, { sellerId: malformed });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] },
    });
    expect(JSON.stringify(result)).not.toContain('canary-id');
    expect(logged().join('\n')).not.toContain('canary-id');
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
  });

  it(`caps the recipients at ${MAX_REVIEWER_RECIPIENTS} in account-id order, with an error log of the count only`, async () => {
    const many = Array.from({ length: MAX_REVIEWER_RECIPIENTS + 3 }, (_v, n) => reviewer(n + 1));
    const s = setUp({ reviewers: reviewersOf(many) });

    await expect(s.notify.execute(system, { sellerId: SELLER_ID })).resolves.toMatchObject({
      ok: true,
    });

    expect((s.transport as ScriptedTransport).attempts.map((m) => m.to)).toEqual(
      many.slice(0, MAX_REVIEWER_RECIPIENTS).map((r) => r.email),
    );
    expect(logOf('identity.reviewer-notice.recipients-capped')).toEqual({
      msg: 'identity.reviewer-notice.recipients-capped',
      count: MAX_REVIEWER_RECIPIENTS + 3,
      marketId: code,
      correlationId: 'reviewer-notice-0001',
    });
  });

  // L2: the budget.
  it('counts a send that outlives its timeout as failed and goes on to the next one', async () => {
    jest.useFakeTimers();
    const s = setUp({
      transport: new ScriptedTransport((index) =>
        index === 0 ? new Promise<void>(() => undefined) : Promise.resolve(),
      ),
    });

    const pending = s.notify.execute(system, { sellerId: SELLER_ID });
    await jest.advanceTimersByTimeAsync(REVIEWER_NOTICE_SEND_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: true, value: { code: 'reviewer-notice.sent' } });
    expect(logOf('identity.reviewer-notice.sent')).toMatchObject({ sent: 1, failed: 1 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops sending when the 20-second budget runs out: none sent is unavailable, nothing continues', async () => {
    jest.useFakeTimers();
    const hanging = new ScriptedTransport(() => new Promise<void>(() => undefined));
    const many = Array.from({ length: 10 }, (_v, n) => reviewer(n + 1));
    const s = setUp({ reviewers: reviewersOf(many), transport: hanging });

    const pending = s.notify.execute(system, { sellerId: SELLER_ID });
    await jest.advanceTimersByTimeAsync(REVIEWER_NOTICE_BUDGET_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'reviewer-notice.unavailable' },
    });
    const attempted = REVIEWER_NOTICE_BUDGET_MS / REVIEWER_NOTICE_SEND_TIMEOUT_MS;
    expect(hanging.attempts).toHaveLength(attempted);
    expect(logOf('identity.reviewer-notice.unavailable')).toMatchObject({
      reason: 'no-send-accepted',
      recipients: 10,
      sent: 0,
      failed: attempted,
      notAttempted: 10 - attempted,
    });
    // Nothing keeps sending in the background.
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * REVIEWER_NOTICE_BUDGET_MS);
    expect(hanging.attempts).toHaveLength(attempted);
  });

  it('answers sent when the budget runs out after at least one mail was accepted', async () => {
    jest.useFakeTimers();
    // The first send is accepted at once; every later one hangs until its timeout.
    const slow = new ScriptedTransport((index) =>
      index === 0 ? Promise.resolve() : new Promise<void>(() => undefined),
    );
    const s = setUp({
      reviewers: reviewersOf(Array.from({ length: 10 }, (_v, n) => reviewer(n + 1))),
      transport: slow,
    });

    const pending = s.notify.execute(system, { sellerId: SELLER_ID });
    await jest.advanceTimersByTimeAsync(REVIEWER_NOTICE_BUDGET_MS);

    await expect(pending).resolves.toEqual({ ok: true, value: { code: 'reviewer-notice.sent' } });
    // One accepted, then four timeouts of 5 s fill the 20 s budget; the other five never start.
    const timedOut = REVIEWER_NOTICE_BUDGET_MS / REVIEWER_NOTICE_SEND_TIMEOUT_MS;
    expect(logOf('identity.reviewer-notice.sent')).toMatchObject({
      recipients: 10,
      sent: 1,
      failed: timedOut,
      notAttempted: 10 - 1 - timedOut,
    });
    expect(slow.attempts).toHaveLength(1 + timedOut);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts the budget from the start: reads that use it up mean unavailable and no send (Hassan L-A)', async () => {
    jest.useFakeTimers();
    const slowRead: AccessReviewers = {
      reviewersOf: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([reviewer(1), reviewer(2)]), REVIEWER_NOTICE_BUDGET_MS),
        ),
    };
    const s = setUp({ reviewers: slowRead });

    const pending = s.notify.execute(system, { sellerId: SELLER_ID });
    await jest.advanceTimersByTimeAsync(REVIEWER_NOTICE_BUDGET_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'reviewer-notice.unavailable' },
    });
    expect((s.transport as ScriptedTransport).attempts).toEqual([]);
    expect(logOf('identity.reviewer-notice.unavailable')).toMatchObject({ reason: 'budget-spent' });
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('the recipient read (Hassan M2): SQL narrows, effectiveKeysOf decides', () => {
    const platformSystem: RoleGrant = {
      roleId: id<'Role'>('01990000-0000-7000-8000-00000000d0ff'),
      kind: 'system',
      scope: 'platform',
      sellerId: null,
      storedKeys: [],
    };

    /** The checked-in seed's roles of this Market, as fixture rows, by `scope:seedCode`. */
    function seedRealRoles(fakes: IdentityFakes): Map<string, RoleState> {
      const roles = new Map<string, RoleState>();
      new CheckedInRoleSeed().roles().forEach((seeded, n) => {
        const state: RoleState = {
          id: id<'Role'>(`01990000-0000-7000-8000-${String(0xc000 + n).padStart(12, '0')}`),
          marketId: code as RoleState['marketId'],
          scope: seeded.scope,
          kind: seeded.kind,
          seedCode: seeded.seedCode,
          seedVersion: seeded.seedVersion,
          sellerId: null,
          permissionKeys: seeded.kind === 'system' ? [] : [...seeded.permissionKeys].sort(),
          version: 1,
          createdAt: START,
        };
        fakes.seedRole(state);
        roles.set(`${seeded.scope}:${seeded.seedCode}`, state);
      });
      return roles;
    }

    /** An assignment of `role` to `accountId`, as a test fixture (admins exist only in tests). */
    function assign(fakes: IdentityFakes, accountId: Id<'Account'>, role: RoleState, n: number) {
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${String(0xb100 + n).padStart(12, '0')}`),
        marketId: code as RoleState['marketId'],
        accountId,
        roleId: role.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }

    function seedAdmins(fakes: IdentityFakes) {
      const n = (k: number) =>
        id<'Account'>(`01990000-0000-7000-8000-${String(0xe000 + k).padStart(12, '0')}`);
      const rows: AccountState[] = [
        // Would hold the Platform Administrator system role.
        accountState(code, { id: n(1) }),
        // Would hold a custom platform role with the approve key.
        accountState(code, { id: n(2) }),
        accountState(code, { id: n(3), status: 'disabled' }),
        accountState(code, { id: n(4), emailVerifiedAt: null }),
        accountState(code, { id: n(5), population: 'seller' }),
        accountState(code, { id: n(6), population: 'customer', displayName: null }),
        accountState(otherCode, { id: n(7) }),
      ];
      rows.forEach((row) => fakes.seedAccount(row));
      return { candidates: [n(1), n(2)], all: rows };
    }

    it('narrows to active, verified admins of the Market, by id, in one read-only unit', async () => {
      const s = setUp();
      const { candidates } = seedAdmins(s.fakes);

      const read = await s.fakes.reviewerCandidateReader.activeVerifiedAdmins(market, 1000);

      expect(read.map((r) => r.accountId)).toEqual(candidates);
    });

    it('answers an empty set when no candidate has an active factor, even a Platform Administrator on the real registry (fail closed)', async () => {
      const s = setUp();
      const { candidates } = seedAdmins(s.fakes);
      // Both candidates hold every platform key; neither has an active factor in the store.
      const administrator = seedRealRoles(s.fakes).get('platform:platform-administrator')!;
      candidates.forEach((accountId, n) => assign(s.fakes, accountId, administrator, n));
      const reviewers = new AccountAccessReviewers({
        unitOfWork: s.unitOfWork,
        candidates: s.fakes.reviewerCandidateReader,
        grants: s.fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
        factors: NO_FACTORS,
      });

      await expect(reviewers.reviewersOf(market)).resolves.toEqual([]);
      expect(s.units).toEqual([{ readOnly: true }]);
      // So the notice answers recipients.none with the real read.
      const notify = new NotifyAccessReviewers(createUseCaseGate(markets, null), {
        unitOfWork: s.unitOfWork,
        sellerAccess: s.fakes.sellerAccessRepository,
        reviewers,
        targets: policy,
        composer,
        transport: s.transport,
        policy,
      });
      await expect(notify.execute(system, { sellerId: SELLER_ID })).resolves.toEqual({
        ok: true,
        value: { code: 'reviewer-notice.skipped', reason: 'recipients.none' },
      });
      expect((s.transport as ScriptedTransport).attempts).toEqual([]);
    });

    it('fails with unavailable, never a guess, when the read unit fails', async () => {
      const s = setUp();
      const reviewers = new AccountAccessReviewers({
        unitOfWork: {
          ...s.unitOfWork,
          run: () => Promise.resolve({ ok: false, error: 'down' }),
        } as never,
        candidates: s.fakes.reviewerCandidateReader,
        grants: s.fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
        factors: EVERY_FACTOR,
      });

      await expect(reviewers.reviewersOf(market)).rejects.toBeInstanceOf(
        AccessReviewersUnavailableError,
      );
    });

    it('holds no key without a role, and no admin is a reviewer without an active factor', () => {
      const keys = realEffectiveKeys();
      for (const population of ['customer', 'seller', 'admin'] as const) {
        expect([...keys({ population, accountId: reviewer(1).accountId })]).toEqual([]);
        expect([
          ...effectiveKeysOf(
            { population, accountId: reviewer(1).accountId, grant: platformSystem },
            EMPTY_PERMISSION_REGISTRY,
          ),
        ]).toEqual([]);
      }
      expect(holdsEvery(new Set([SELLER_ACCESS_APPROVE]), [SELLER_ACCESS_APPROVE])).toBe(true);
      expect(
        isAccessReviewer(reviewer(1), platformSystem, {
          factors: activeFactorsIn(new Set()),
          keys,
        }),
      ).toBe(false);
      expect(
        isAccessReviewer(reviewer(1), platformSystem, {
          factors: { hasActiveFactor: () => true },
          keys,
        }),
      ).toBe(true);
    });

    it('never treats an empty requirement as held (Hassan I-2)', () => {
      expect(holdsEvery(new Set([SELLER_ACCESS_APPROVE]), [])).toBe(false);
      expect(holdsEvery(new Set(), [])).toBe(false);
    });

    // K5 with fakes (Sajad F1): fixture grants, factors and registry, through the one rule.
    describe('with fixture roles, factors and registry (K5)', () => {
      const n = (k: number) =>
        id<'Account'>(`01990000-0000-7000-8000-${String(0xf000 + k).padStart(12, '0')}`);
      const ADMINISTRATOR = n(1);
      const CUSTOM_APPROVER = n(2);
      const NO_FACTOR = n(3);
      const CUSTOM_WITHOUT_KEY = n(4);
      const UNKNOWN_STORED_KEY = n(5);
      const NO_ROLE = n(6);
      const DISABLED = n(7);
      const UNVERIFIED = n(8);
      const SELLER_SIDE = n(9);
      const OTHER_MARKET = n(10);
      const grantOf = (
        n: number,
        kind: RoleGrant['kind'],
        scope: RoleGrant['scope'],
        storedKeys: string[],
      ): RoleGrant => ({
        roleId: id<'Role'>(`01990000-0000-7000-8000-${String(0xd000 + n).padStart(12, '0')}`),
        kind,
        scope,
        sellerId: null,
        storedKeys,
      });
      const system = grantOf(1, 'system', 'platform', []);
      const approver = grantOf(2, 'custom', 'platform', [
        'identity.role.view',
        SELLER_ACCESS_APPROVE,
      ]);
      const grants = new Map<string, RoleGrant>([
        [ADMINISTRATOR, system],
        [CUSTOM_APPROVER, approver],
        [NO_FACTOR, system],
        [CUSTOM_WITHOUT_KEY, grantOf(3, 'custom', 'platform', ['identity.role.view'])],
        [
          UNKNOWN_STORED_KEY,
          grantOf(4, 'custom', 'platform', ['identity.seller-access.approve-all']),
        ],
        [DISABLED, system],
        [UNVERIFIED, system],
        [SELLER_SIDE, grantOf(5, 'system', 'seller', [])],
        [OTHER_MARKET, system],
      ]);
      const registry = (keys: readonly string[]): PermissionRegistryView => ({
        keysOf: (scope) => new Set(scope === 'platform' ? keys : ['catalog.offer.edit']),
      });
      const withFactor = new Set<string>([
        ADMINISTRATOR,
        CUSTOM_APPROVER,
        CUSTOM_WITHOUT_KEY,
        UNKNOWN_STORED_KEY,
        NO_ROLE,
        DISABLED,
        UNVERIFIED,
        SELLER_SIDE,
        OTHER_MARKET,
      ]);
      const fixtureGrants: RoleGrantReader = {
        grantsOf: (_market, accountIds) =>
          Promise.resolve(
            new Map(
              accountIds.flatMap((a) => {
                const grant = grants.get(a);
                return grant === undefined ? [] : [[a, grant] as const];
              }),
            ),
          ),
      };
      const ruleWith = (declared: readonly string[]): ReviewerRule => {
        const keys: EffectiveKeyResolver = (subject) =>
          effectiveKeysOf(subject, registry(declared));
        return { factors: { hasActiveFactor: (accountId) => withFactor.has(accountId) }, keys };
      };
      const depsWith = (rule: ReviewerRule) => ({
        grants: fixtureGrants,
        effectiveKeys: rule.keys,
        factors: factorsFor(withFactor),
      });
      const DECLARED = ['identity.role.view', SELLER_ACCESS_APPROVE];

      function seed(fakes: IdentityFakes): AccountState[] {
        const rows = [
          accountState(code, { id: ADMINISTRATOR }),
          accountState(code, { id: CUSTOM_APPROVER }),
          accountState(code, { id: NO_FACTOR }),
          accountState(code, { id: CUSTOM_WITHOUT_KEY }),
          accountState(code, { id: UNKNOWN_STORED_KEY }),
          accountState(code, { id: NO_ROLE }),
          accountState(code, { id: DISABLED, status: 'disabled' }),
          accountState(code, { id: UNVERIFIED, emailVerifiedAt: null }),
          accountState(code, { id: SELLER_SIDE, population: 'seller' }),
          accountState(otherCode, { id: OTHER_MARKET }),
        ];
        rows.forEach((row) => fakes.seedAccount(row));
        return rows;
      }

      it('includes the Platform Administrator and a custom role holding the key, by account id', async () => {
        const s = setUp();
        seed(s.fakes);
        // The candidate read answers in reverse order: the resolver still answers by id (F2).
        const reversed: ReviewerCandidateReader = {
          activeVerifiedAdmins: async (m, limit) =>
            (await s.fakes.reviewerCandidateReader.activeVerifiedAdmins(m, limit)).reverse(),
        };

        const reviewers = await new AccountAccessReviewers({
          unitOfWork: s.unitOfWork,
          candidates: reversed,
          ...depsWith(ruleWith(DECLARED)),
        }).reviewersOf(market);

        // Excluded: no active factor, a role without the key, a stored key the registry does not
        // know, no role; disabled, unverified, seller-side and other-Market accounts never reach
        // the rule (the SQL narrowing).
        expect(reviewers.map((r) => r.accountId)).toEqual([ADMINISTRATOR, CUSTOM_APPROVER]);
      });

      it('drops a stored approve key once the registry no longer declares it (R7)', async () => {
        const s = setUp();
        seed(s.fakes);

        const reviewers = await new AccountAccessReviewers({
          unitOfWork: s.unitOfWork,
          candidates: s.fakes.reviewerCandidateReader,
          ...depsWith(ruleWith(['identity.role.view'])),
        }).reviewersOf(market);

        expect(reviewers).toEqual([]);
      });

      it('equivalence (Hassan L-B): for every fixture account that passes the SQL narrowing and has an active factor, a recipient exactly when the gate allows permissions [approve]', async () => {
        const s = setUp();
        const rows = seed(s.fakes);
        const rule = ruleWith(DECLARED);
        const check = new AccountAuthorisationCheck({
          unitOfWork: s.unitOfWork,
          accounts: s.fakes.accountRepository,
          memberships: s.fakes.membershipRepository,
          sellerAccess: s.fakes.sellerAccessRepository,
          grants: fixtureGrants,
          effectiveKeys: rule.keys,
        });
        const recipients = new Set(
          (
            await new AccountAccessReviewers({
              unitOfWork: s.unitOfWork,
              candidates: s.fakes.reviewerCandidateReader,
              ...depsWith(rule),
            }).reviewersOf(market)
          ).map((r) => r.accountId),
        );
        const narrowed = new Set(
          (await s.fakes.reviewerCandidateReader.activeVerifiedAdmins(market, 1000)).map(
            (c) => c.accountId,
          ),
        );
        const approve: AccessDeclaration = {
          name: 'identity.approve-anything',
          rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE as never] },
        };

        const compared: [string, boolean][] = [];
        for (const row of rows.filter((a) => narrowed.has(a.id) && withFactor.has(a.id))) {
          const context = testCallContext(
            market,
            testAuthenticatedActor(market, {
              population: row.population,
              accountId: row.id,
              sessionId: SESSION_ID,
              sellerId: null,
            }),
          );
          const allowed = (await check.check(context, approve)).allowed;
          expect([row.id, recipients.has(row.id)]).toEqual([row.id, allowed]);
          compared.push([row.id, allowed]);
        }
        // Non-vacuous: both answers occur.
        expect(compared.some(([, allowed]) => allowed)).toBe(true);
        expect(compared.some(([, allowed]) => !allowed)).toBe(true);

        // Separately: no account without a verified email or an active factor is a recipient,
        // even when the gate would allow it the key.
        for (const row of rows.filter((a) => a.emailVerifiedAt === null || !withFactor.has(a.id))) {
          expect([row.id, recipients.has(row.id)]).toEqual([row.id, false]);
        }
      });
    });

    // Slice 8a-1 (Hassan L-B; identity design 12.1): the equivalence again, on the real
    // registry, the real seed's roles and the grant read, through the one resolver the module
    // binds. Only the factor half is a fixture: no admin has a factor before slice 7.
    describe('on the real registry and seed (slice 8a-1)', () => {
      const n = (k: number) =>
        id<'Account'>(`01990000-0000-7000-8000-${String(0xa100 + k).padStart(12, '0')}`);
      const CODES = [
        'platform-administrator',
        'onboarding-compliance',
        'catalogue-moderator',
        'operations-support',
        'finance',
        'viewer',
      ] as const;

      it('a recipient exactly when the gate allows permissions [identity.seller-access.approve]', async () => {
        const s = setUp();
        const roles = seedRealRoles(s.fakes);
        const registry = realPermissionRegistry();
        const effectiveKeys = realEffectiveKeys(registry);
        // One admin fixture account per platform role of the seed, one with no role, one with
        // a seller-scope role (a corrupt row), one disabled and one unverified administrator.
        const rows: AccountState[] = [];
        CODES.forEach((seedCode, k) => {
          const row = accountState(code, { id: n(k) });
          s.fakes.seedAccount(row);
          assign(s.fakes, row.id, roles.get(`platform:${seedCode}`)!, k);
          rows.push(row);
        });
        const noRole = accountState(code, { id: n(20) });
        const sellerRole = accountState(code, { id: n(21) });
        const disabled = accountState(code, { id: n(22), status: 'disabled' });
        const unverified = accountState(code, { id: n(23), emailVerifiedAt: null });
        for (const row of [noRole, sellerRole, disabled, unverified]) {
          s.fakes.seedAccount(row);
          rows.push(row);
        }
        assign(s.fakes, sellerRole.id, roles.get('seller:seller-owner')!, 21);
        assign(s.fakes, disabled.id, roles.get('platform:platform-administrator')!, 22);
        assign(s.fakes, unverified.id, roles.get('platform:platform-administrator')!, 23);

        const check = new AccountAuthorisationCheck({
          unitOfWork: s.unitOfWork,
          accounts: s.fakes.accountRepository,
          memberships: s.fakes.membershipRepository,
          sellerAccess: s.fakes.sellerAccessRepository,
          grants: s.fakes.grantReader,
          effectiveKeys,
        });
        const recipients = new Set(
          (
            await new AccountAccessReviewers({
              unitOfWork: s.unitOfWork,
              candidates: s.fakes.reviewerCandidateReader,
              grants: s.fakes.grantReader,
              effectiveKeys,
              factors: EVERY_FACTOR,
            }).reviewersOf(market)
          ).map((r) => r.accountId),
        );
        const narrowed = new Set(
          (await s.fakes.reviewerCandidateReader.activeVerifiedAdmins(market, 1000)).map(
            (c) => c.accountId,
          ),
        );
        const approve: AccessDeclaration = {
          name: 'identity.approve-anything',
          rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE as never] },
        };

        const compared: [string, boolean][] = [];
        for (const row of rows.filter((a) => narrowed.has(a.id))) {
          const context = testCallContext(
            market,
            testAuthenticatedActor(market, {
              population: 'admin',
              accountId: row.id,
              sessionId: SESSION_ID,
              sellerId: null,
            }),
          );
          const allowed = (await check.check(context, approve)).allowed;
          expect([row.id, recipients.has(row.id)]).toEqual([row.id, allowed]);
          compared.push([row.id, allowed]);
        }
        // The Platform Administrator and Onboarding and Compliance hold the key; the other
        // default roles, no role and a seller-scope role do not. Both answers occur.
        expect(compared.filter(([, allowed]) => allowed).map(([a]) => a)).toEqual([n(0), n(1)]);
        expect(compared.some(([, allowed]) => !allowed)).toBe(true);
        expect(recipients.has(disabled.id)).toBe(false);
        expect(recipients.has(unverified.id)).toBe(false);

        // And with an empty factor store nobody is a recipient.
        await expect(
          new AccountAccessReviewers({
            unitOfWork: s.unitOfWork,
            candidates: s.fakes.reviewerCandidateReader,
            grants: s.fakes.grantReader,
            effectiveKeys,
            factors: NO_FACTORS,
          }).reviewersOf(market),
        ).resolves.toEqual([]);
      });
    });
  });
});
