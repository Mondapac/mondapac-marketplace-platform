import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { openSession } from '../../domain/session';
import { AdminCustomerSessions } from '../use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignIns } from '../use-cases/admin-customer-sign-ins.use-case';
import { AdminRevealCustomerSignIn } from '../use-cases/admin-reveal-customer-sign-in.use-case';
import { AdminSendCustomerPasswordReset } from '../use-cases/admin-send-customer-password-reset.use-case';
import { AdminSignOutCustomer } from '../use-cases/admin-sign-out-customer.use-case';
import type { CustomerSignInsRequest } from './customer-security';

// The customer page's security section (customers management phase 2b), for both Market
// fixtures: only a platform admin that is not acting as anyone; only the
// customer's own customer-population records of the last 90 days; never the address in a list;
// the reveal audits the record id before it answers; "sign out everywhere" ends every session
// under the credential lock with an audit row; the reset mail is requested for an active, verified
// customer only, not twice in five minutes, with an audit row and no token in sight.

const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId<T>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad test id');
  return parsed.value;
};
const ADMIN_ID = id<'Account'>(0xa1);
const CUSTOMER_ID = id<'Account'>(0xc1);
const OTHER_CUSTOMER_ID = id<'Account'>(0xc2);
const SELLER_ACCOUNT_ID = id<'Account'>(0xb1);
const SELLER_ID = id<'Seller'>(0xd1);
const SESSION_ID = id<'Session'>(0xa001);
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};
const LIFETIME = { idleTimeoutSeconds: 86_400, absoluteLifetimeSeconds: 30 * 86_400 };

describe.each(TEST_MARKETS)('the customer security section in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;
  let recordSeq = 0;

  beforeEach(() => {
    fakes = new IdentityFakes();
    recordSeq = 0;
  });

  function seed(
    accountId: Id<'Account'>,
    population: 'admin' | 'seller' | 'customer',
    overrides: Partial<AccountState> = {},
  ) {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: 'Me@Example.com', normalized: `${accountId}@example.com` },
      displayName: 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: NOW.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: NOW.subtract({ hours: 49 }),
      createdAt: NOW.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: NOW },
      ...overrides,
    });
  }

  async function record(
    accountId: Id<'Account'>,
    outcome: string,
    at: Temporal.Instant,
    population: 'customer' | 'seller' = 'customer',
    device: 'chrome.windows' | 'safari.ios' | null = 'chrome.windows',
  ): Promise<Id<'SignInRecord'>> {
    recordSeq += 1;
    const recordId = id<'SignInRecord'>(0x5000 + recordSeq);
    await fakes.recordRepository.add(market, {
      id: recordId,
      population,
      accountId,
      outcome,
      occurredAt: at,
      address: `198.51.100.${recordSeq}`,
      sessionId: null,
      correlationId: 'correlation-1',
      device,
    });
    return recordId;
  }

  async function session(accountId: Id<'Account'>, n: number, device: 'safari.ios' | null) {
    await fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xe000 + n),
        marketId: market.marketId,
        accountId,
        population: 'customer',
        transport: 'cookie',
        device,
        lifetime: LIFETIME,
        now: NOW.subtract({ minutes: n }),
      }),
      new Uint8Array(32).fill(n),
    );
  }

  const deps = () => ({
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    records: fakes.recordRepository,
    audit: fakes.audit,
    clock: new FixedClock(NOW),
  });
  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'> | null = population === 'seller' ? SELLER_ID : null,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, { population, accountId, sessionId: SESSION_ID, sellerId }),
    );
  const admin = () => contextOf('admin', ADMIN_ID);
  /** An admin session that carries the acting-as marker (SEL-08 reserves it). */
  const actingAs = (): CallContext => {
    const context = admin();
    return { ...context, actor: { ...context.actor, actingAs: { sellerId: SELLER_ID } } as never };
  };
  const refusedCallers = () => [
    contextOf('customer', CUSTOMER_ID),
    contextOf('seller', SELLER_ACCOUNT_ID),
    actingAs(),
  ];
  const request = (overrides: Partial<CustomerSignInsRequest> = {}): CustomerSignInsRequest => ({
    accountId: CUSTOMER_ID,
    results: null,
    from: null,
    to: null,
    direction: 'desc',
    window: { offset: 0, limit: 25 },
    withTotal: true,
    ...overrides,
  });

  describe('the sign-ins', () => {
    const signIns = () => new AdminCustomerSignIns(gate, deps());

    it('lists the customer’s own records of the last 90 days, newest first, without the address', async () => {
      seed(CUSTOMER_ID, 'customer');
      await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }));
      await record(CUSTOMER_ID, 'password.incorrect', NOW.subtract({ hours: 2 }), 'customer', null);
      await record(CUSTOMER_ID, 'password-reset', NOW.subtract({ hours: 3 }));
      await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 24 * 91 }));
      await record(OTHER_CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }));
      await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }), 'seller');

      const result = await signIns().execute(admin(), request());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.total).toBe(3);
      expect(result.value.since).toBe(NOW.subtract({ hours: 24 * 90 }).toString());
      expect(result.value.rows.map((row) => [row.outcome, row.result, row.device])).toEqual([
        ['signed-in', 'success', 'chrome.windows'],
        ['password.incorrect', 'failure', null],
        ['password-reset', 'credential-change', 'chrome.windows'],
      ]);
      expect(result.value.rows.every((row) => row.city === null)).toBe(true);
      expect(JSON.stringify(result.value)).not.toContain('198.51.100');
      expect(fakes.audits).toEqual([]);
    });

    it('filters by result and range, pages without a total and never reaches past 90 days', async () => {
      seed(CUSTOMER_ID, 'customer');
      for (let n = 1; n <= 4; n += 1) {
        await record(CUSTOMER_ID, 'password.incorrect', NOW.subtract({ hours: n }));
      }
      await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 5 }));
      await record(CUSTOMER_ID, 'password.incorrect', NOW.subtract({ hours: 24 * 100 }));

      const failures = await signIns().execute(
        admin(),
        request({
          results: ['failure'],
          from: NOW.subtract({ hours: 24 * 365 }),
          window: { offset: 0, limit: 3 },
          withTotal: false,
        }),
      );
      expect(failures).toMatchObject({ ok: true, value: { total: null } });
      if (!failures.ok) return;
      expect(failures.value.rows).toHaveLength(3);
      expect(failures.value.rows.every((row) => row.result === 'failure')).toBe(true);

      const ranged = await signIns().execute(
        admin(),
        request({ from: NOW.subtract({ hours: 2, minutes: 30 }), to: NOW, direction: 'asc' }),
      );
      expect(ranged.ok && ranged.value.rows.map((row) => row.occurredAt)).toEqual([
        NOW.subtract({ hours: 2 }).toString(),
        NOW.subtract({ hours: 1 }).toString(),
      ]);
    });

    it('refuses a customer, a seller and an acting-as session', async () => {
      seed(CUSTOMER_ID, 'customer');
      await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }));
      for (const context of refusedCallers()) {
        await expect(signIns().execute(context, request())).resolves.toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });
  });

  describe('the reveal of one sign-in’s address', () => {
    const reveal = () => new AdminRevealCustomerSignIn(gate, deps());

    it('answers the address after writing an audit row that names the record only', async () => {
      seed(CUSTOMER_ID, 'customer');
      const signInId = await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }));

      const result = await reveal().execute(admin(), { accountId: CUSTOMER_ID, signInId });

      expect(result).toEqual({
        ok: true,
        value: { address: '198.51.100.1', occurredAt: NOW.subtract({ hours: 1 }).toString() },
      });
      expect(fakes.audits).toHaveLength(1);
      expect(fakes.audits[0]).toMatchObject({
        action: 'identity.account.sign-in-address-revealed',
        targetId: CUSTOMER_ID,
        marketId: code,
        after: { signInId },
      });
      expect(JSON.stringify(fakes.audits)).not.toContain('198.51.100');
    });

    it('treats another customer’s, a seller’s and an older record as unknown, and audits nothing', async () => {
      seed(CUSTOMER_ID, 'customer');
      const others = [
        await record(OTHER_CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 })),
        await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }), 'seller'),
        await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 24 * 91 })),
      ];
      for (const signInId of others) {
        await expect(
          reveal().execute(admin(), { accountId: CUSTOMER_ID, signInId }),
        ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
      }
      expect(fakes.audits).toEqual([]);
    });

    it('refuses every caller that is not a plain platform admin, before reading', async () => {
      seed(CUSTOMER_ID, 'customer');
      const signInId = await record(CUSTOMER_ID, 'signed-in', NOW.subtract({ hours: 1 }));
      for (const context of refusedCallers()) {
        await expect(
          reveal().execute(context, { accountId: CUSTOMER_ID, signInId }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
      expect(fakes.audits).toEqual([]);
    });
  });

  describe('the sessions and "sign out everywhere"', () => {
    it('lists the live sessions by device and times only', async () => {
      seed(CUSTOMER_ID, 'customer');
      await session(CUSTOMER_ID, 1, 'safari.ios');
      await session(CUSTOMER_ID, 2, null);

      const result = await new AdminCustomerSessions(gate, deps()).execute(admin(), {
        accountId: CUSTOMER_ID,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.more).toBe(false);
      expect(result.value.items.map((item) => item.device).sort()).toEqual(
        [null, 'safari.ios'].sort(),
      );
      expect(Object.keys(result.value.items[0]!).sort()).toEqual([
        'device',
        'lastActiveAt',
        'signedInAt',
      ]);
    });

    it('answers account.unknown for a seller account', async () => {
      seed(SELLER_ACCOUNT_ID, 'seller');
      await expect(
        new AdminCustomerSessions(gate, deps()).execute(admin(), { accountId: SELLER_ACCOUNT_ID }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
    });

    it('ends every session under the credential lock and audits the count', async () => {
      seed(CUSTOMER_ID, 'customer');
      await session(CUSTOMER_ID, 1, 'safari.ios');
      await session(CUSTOMER_ID, 2, null);

      const result = await new AdminSignOutCustomer(gate, deps()).execute(admin(), {
        accountId: CUSTOMER_ID,
      });

      expect(result).toEqual({ ok: true, value: { revokedSessions: 2 } });
      expect(fakes.credentialLocks).toEqual([CUSTOMER_ID]);
      expect([...fakes.sessions.values()].map(({ session: s }) => s.revokedReason)).toEqual([
        'admin-signed-out',
        'admin-signed-out',
      ]);
      expect(fakes.audits).toMatchObject([
        {
          action: 'identity.account.sessions-ended-by-admin',
          targetId: CUSTOMER_ID,
          after: { revokedSessions: 2 },
        },
      ]);
    });

    it('never ends an admin’s or a seller’s sessions, and refuses every other caller', async () => {
      seed(SELLER_ACCOUNT_ID, 'seller');
      await expect(
        new AdminSignOutCustomer(gate, deps()).execute(admin(), { accountId: SELLER_ACCOUNT_ID }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
      seed(CUSTOMER_ID, 'customer');
      for (const context of refusedCallers()) {
        await expect(
          new AdminSignOutCustomer(gate, deps()).execute(context, { accountId: CUSTOMER_ID }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
      expect(fakes.audits).toEqual([]);
    });
  });

  describe('"send password reset"', () => {
    const reset = () =>
      new AdminSendCustomerPasswordReset(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        links: fakes.linkRepository,
        outbox: fakes.outbox,
        audit: fakes.audit,
        clock: new FixedClock(NOW),
        ids: new SequenceIdGenerator(new FixedClock(NOW)),
      });
    const requested = () =>
      fakes.events.filter((event) => event.type === 'identity.one-time-link-requested.v1');

    it('requests the reset link for the customer and audits the link id, with no token', async () => {
      seed(CUSTOMER_ID, 'customer');

      await expect(reset().execute(admin(), { accountId: CUSTOMER_ID })).resolves.toEqual({
        ok: true,
        value: { sent: true },
      });

      expect(requested()).toHaveLength(1);
      const [link] = [...fakes.links.values()];
      expect(link).toMatchObject({ accountId: CUSTOMER_ID, purpose: 'reset-password' });
      expect(link?.tokenHash).toBeNull();
      expect(fakes.audits).toMatchObject([
        {
          action: 'identity.account.password-reset-sent-by-admin',
          targetId: CUSTOMER_ID,
          after: { linkId: link?.id },
        },
      ]);
    });

    it('refuses a second mail within five minutes and sends one after', async () => {
      seed(CUSTOMER_ID, 'customer');
      await reset().execute(admin(), { accountId: CUSTOMER_ID });
      await expect(reset().execute(admin(), { accountId: CUSTOMER_ID })).resolves.toEqual({
        ok: false,
        error: { code: 'password-reset.recently-requested' },
      });
      const later = new AdminSendCustomerPasswordReset(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        links: fakes.linkRepository,
        outbox: fakes.outbox,
        audit: fakes.audit,
        clock: new FixedClock(NOW.add({ minutes: 6 })),
        ids: new SequenceIdGenerator(new FixedClock(NOW)),
      });
      await expect(later.execute(admin(), { accountId: CUSTOMER_ID })).resolves.toMatchObject({
        ok: true,
      });
      expect(requested()).toHaveLength(2);
    });

    it('sends nothing to a disabled, an unverified or a non-customer account', async () => {
      seed(CUSTOMER_ID, 'customer', { status: 'disabled' });
      seed(OTHER_CUSTOMER_ID, 'customer', { emailVerifiedAt: null });
      seed(SELLER_ACCOUNT_ID, 'seller');
      for (const [accountId, code] of [
        [CUSTOMER_ID, 'account.not-eligible'],
        [OTHER_CUSTOMER_ID, 'account.not-eligible'],
        [SELLER_ACCOUNT_ID, 'account.unknown'],
      ] as const) {
        await expect(reset().execute(admin(), { accountId })).resolves.toEqual({
          ok: false,
          error: { code },
        });
      }
      expect(requested()).toEqual([]);
      expect(fakes.audits).toEqual([]);
    });

    it('refuses every caller that is not a plain platform admin', async () => {
      seed(CUSTOMER_ID, 'customer');
      for (const context of refusedCallers()) {
        await expect(reset().execute(context, { accountId: CUSTOMER_ID })).resolves.toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(requested()).toEqual([]);
    });
  });

  it('declares one key per entry point, the reveal’s protected one on top of the view key', () => {
    expect(AdminCustomerSignIns.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['identity.customer-sign-in.view'],
    });
    expect(AdminCustomerSessions.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['identity.customer-sign-in.view'],
    });
    expect(AdminRevealCustomerSignIn.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['identity.customer-sign-in.view', 'identity.customer-sign-in.reveal'],
    });
    expect(AdminSignOutCustomer.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['identity.customer-session.end'],
    });
    expect(AdminSendCustomerPasswordReset.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['identity.customer-password-reset.send'],
    });
  });
});
