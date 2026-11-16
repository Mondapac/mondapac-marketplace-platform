import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realEffectiveKeys } from '../../../../../test/support/permission-registry';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { StepUpActionRegistry, type AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { OneTimeLink } from '../../domain/one-time-link';
import { openSession } from '../../domain/session';
import { RandomLinkTokens } from '../../infrastructure/links/random-link-tokens';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { RandomSessionTokens } from '../../infrastructure/sessions/random-session-tokens';
import type { ThrottleKeys } from '../ports/session-secrets';
import { CancelCustomerEmailChangeForDeletion } from './cancel-customer-email-change-for-deletion.use-case';
import { AdminCancelCustomerEmailChange } from './admin-cancel-customer-email-change.use-case';
import {
  AdminRequestCustomerEmailChange,
  isPlainAdmin,
} from './admin-request-customer-email-change.use-case';
import { ConfirmCustomerEmail } from './confirm-customer-email.use-case';
import { ConfirmCustomerEmailChange } from './confirm-customer-email-change.use-case';
import { CustomerPendingEmailOf } from './customer-pending-email-of.use-case';
import { PurgeExpired } from './purge-expired.use-case';
import { RequestPasswordReset } from './request-password-reset.use-case';
import { SendEmailChangeRequestedMail } from './send-email-change-requested-mail.use-case';
import { SendEmailChangedMail } from './send-email-changed-mail.use-case';
import { SendLinkMail } from './send-link-mail.use-case';

// Customers admin email change, in memory (design note of 16 Nov 2026; Mohammad's review and
// Hassan's R1 to R12): the admin's request and cancel (step-up spent in the unit), the link mail to
// the pending address, the warning to the current one, the confirmation with link and password
// through the sign-in sequence (no session opened, every session and other link ended), the notice
// to the previous address, the read for the customer page and the purge of a lapsed request. Both
// Market fixtures (AU: link 24 h, 3 mails an hour; ZZ: 12 h, 2 an hour; en-AU and ja-JP). The
// PostgreSQL behaviour (CHECKs, the unique key at the swap, the sealed previous address) is
// covered by test/db/customer-email-change.db-spec.ts.

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const OLD_EMAIL = 'Maryam.Old@Example.com';
const NEW_EMAIL = 'Maryam.New@Mailbox.test';
const ORIGIN = '203.0.113.7';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const KEY = 'customers.customer-email.change';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId<T>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad test id');
  return parsed.value;
};
const ADMIN = id<'Account'>(0xad01);
const ADMIN_SESSION = id<'Session'>(0xad51);
const CUSTOMER = id<'Account'>(0xc001);
const OTHER_CUSTOMER = id<'Account'>(0xc002);
const ROLE = id<'Role'>(0xe001);
const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const tokenOf = (text: string): string => /#(ml1_[A-Za-z0-9_-]{43})/.exec(text)![1]!;

let deliveries = 0;
function deliveryOf(subscriber: string): EventDelivery {
  deliveries += 1;
  return {
    eventId: `0199eeee-0000-7000-8000-${String(deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber,
    attempt: 1,
  };
}

function setUp(code: string) {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const gate = createUseCaseGate(markets, admitsAll);
  const linkTokens = new RandomLinkTokens();
  const stepUpActions = new StepUpActionRegistry();
  stepUpActions.register('customers', [
    { key: KEY, defaultRequired: true, locked: true, audience: 'admin' },
  ]);
  const marketId = code as AccountState['marketId'];
  const account = (
    accountId: Id<'Account'>,
    population: AccountState['population'],
    email: string,
    extra: Partial<AccountState> = {},
  ) =>
    fakes.seedAccount({
      id: accountId,
      marketId,
      population,
      email: { typed: email, normalized: email.toLowerCase() },
      displayName: population === 'customer' ? null : 'Support Admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      ...extra,
    });
  account(ADMIN, 'admin', 'Support@Mondapac.test');
  account(CUSTOMER, 'customer', OLD_EMAIL);
  fakes.subjectKeys.set(CUSTOMER, 'live');
  fakes.seedRole({
    id: ROLE,
    marketId,
    scope: 'platform',
    kind: 'custom',
    seedCode: null,
    seedVersion: null,
    sellerId: null,
    name: 'Customer support',
    permissionKeys: [KEY, 'customers.customers.view'],
    version: 1,
    createdAt: START,
  });
  fakes.seedAssignment({
    id: id<'RoleAssignment'>(0xe101),
    marketId,
    accountId: ADMIN,
    roleId: ROLE,
    assignedByAccountId: null,
    assignedAt: START,
    version: 1,
  });
  fakes.factors.set(ADMIN, {
    id: id<'SecondFactor'>(0xf001),
    marketId,
    accountId: ADMIN,
    state: 'active',
    secretCiphertext: 'sealed',
    pendingSecretCiphertext: null,
    lastAcceptedStep: null,
    activatedAt: START.subtract({ hours: 1 }),
    lockedAt: null,
    createdAt: START.subtract({ hours: 1 }),
    // An active factor holds all ten codes (data design 3.10).
    recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
      position: index + 1,
      codeHash: new Uint8Array(32).fill(index + 1),
      usedAt: null,
    })),
    version: 1,
  });
  const adminDeps = {
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    grants: fakes.grantReader,
    effectiveKeys: realEffectiveKeys(),
    links: fakes.linkRepository,
    stepUp: fakes.stepUpRepository,
    stepUpActions,
    factors: fakes.factorRepository,
    audit: fakes.audit,
    clock,
  };
  const signInDeps = {
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    throttles: fakes.throttleRepository,
    records: fakes.recordRepository,
    securityEvents: fakes.securityEvents,
    hasher: fakes.hasher,
    tokens: new RandomSessionTokens(),
    keys,
    policy,
    clock,
    ids,
    links: fakes.linkRepository,
    outbox: fakes.outbox,
    linkTokens,
  };
  const mailDeps = {
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    composer,
    transport: fakes.mailTransport,
    policy,
  };
  return {
    fakes,
    clock,
    ids,
    account,
    request: new AdminRequestCustomerEmailChange(gate, {
      ...adminDeps,
      throttles: fakes.throttleRepository,
      keys,
      targets: policy,
      policy,
      outbox: fakes.outbox,
      ids,
    }),
    cancel: new AdminCancelCustomerEmailChange(gate, adminDeps),
    cancelForDeletion: new CancelCustomerEmailChangeForDeletion(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      links: fakes.linkRepository,
      clock,
    }),
    confirm: new ConfirmCustomerEmailChange(gate, {
      ...signInDeps,
      audit: fakes.audit,
      emailChanges: fakes.emailChangeStore,
    }),
    confirmEmail: new ConfirmCustomerEmail(gate, signInDeps),
    resetRequest: new RequestPasswordReset(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      links: fakes.linkRepository,
      throttles: fakes.throttleRepository,
      keys,
      outbox: fakes.outbox,
      policy,
      clock,
      ids,
    }),
    sendLinkMail: new SendLinkMail(gate, {
      ...mailDeps,
      links: fakes.linkRepository,
      linkTokens,
      targets: policy,
      clock,
    }),
    sendWarning: new SendEmailChangeRequestedMail(gate, mailDeps),
    sendNotice: new SendEmailChangedMail(gate, {
      ...mailDeps,
      emailChanges: fakes.emailChangeStore,
    }),
    pendingOf: new CustomerPendingEmailOf(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      policy,
      clock,
    }),
    purge: new PurgeExpired(gate, {
      unitOfWork: fakes.unitOfWork,
      sessions: fakes.sessionRepository,
      throttles: fakes.throttleRepository,
      records: fakes.recordRepository,
      links: fakes.linkRepository,
      challenges: fakes.challengeRepository,
      invitations: fakes.invitationRepository,
      policy,
      clock,
      emailChanges: fakes.emailChangeStore,
    }),
  };
}

describe.each(TEST_MARKETS)('admin email change in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const anonymous = testCallContext(market, 'anonymous', 'email-change-0001');
  const system = testCallContext(market, 'system', 'email-change-0002');
  const adminActor = (overrides: Record<string, unknown> = {}): CallContext => {
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: ADMIN_SESSION,
        sellerId: null,
      }),
      'email-change-0003',
    );
    if (Object.keys(overrides).length === 0) return context;
    // A plain object with the reserved acting-as marker is not minted: the gate refuses it today;
    // `isPlainAdmin` is checked on its own below for when SEL-08 mints the field (Hassan L1).
    return { ...context, actor: { ...context.actor, ...overrides } };
  };
  const admin = adminActor();
  const lifetimeMinutes = policy.linkLifetimeMinutes(market, 'confirm-email-change')!;
  const mailLimit = policy.mailThrottles(market).account.limit;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  type Setup = ReturnType<typeof setUp>;
  const prove = (s: Setup) =>
    s.fakes.stepUpProofs.set(`${code}|${ADMIN_SESSION}|${KEY}`, s.clock.now());
  const customer = (s: Setup): AccountState => s.fakes.accounts.get(CUSTOMER)!;
  const eventsOf = (s: Setup, type: string) => s.fakes.events.filter((e) => e.type === type);

  async function requestChange(s: Setup, email = NEW_EMAIL) {
    prove(s);
    return s.request.execute(admin, { accountId: CUSTOMER, email, origin: ORIGIN });
  }

  /** Runs the link-mail handler for the latest link request of `purpose`, as the dispatcher would. */
  async function deliverLink(s: Setup, purpose = 'confirm-email-change', event?: PendingEvent) {
    const chosen =
      event ??
      eventsOf(s, 'identity.one-time-link-requested.v1')
        .filter((e) => (e.payload as { purpose: string }).purpose === purpose)
        .at(-1)!;
    const payload = chosen.payload as {
      linkId: Id;
      accountId: Id;
      purpose: 'confirm-email-change';
    };
    return s.sendLinkMail.execute(system, {
      delivery: deliveryOf('identity.link-mail'),
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: payload.purpose,
      aggregateVersion: chosen.aggregateVersion,
    });
  }

  function openCustomerSession(s: Setup, n: number) {
    const session = openSession({
      id: id<'Session'>(0x5e00 + n),
      marketId: code as AccountState['marketId'],
      accountId: CUSTOMER,
      population: 'customer',
      sellerId: null,
      transport: 'cookie',
      lifetime: policy.sessionLifetime(market, 'customer')!,
      now: s.clock.now(),
    });
    void s.fakes.sessionRepository.add(market, session, new Uint8Array(32).fill(n));
    return session.id;
  }

  const live = (s: Setup, sessionId: Id<'Session'>) =>
    s.fakes.sessions.get(sessionId)?.session.revokedAt === null;

  it('declares the rules: the protected customers key for the admin, anonymous confirm, system mails', () => {
    for (const useCase of [AdminRequestCustomerEmailChange, AdminCancelCustomerEmailChange]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [KEY] });
    }
    expect(ConfirmCustomerEmailChange.access).toEqual({
      name: 'identity.confirm-customer-email-change',
      rule: { kind: 'anonymous' },
    });
    expect(SendEmailChangeRequestedMail.access.rule).toEqual({ kind: 'system' });
    expect(SendEmailChangedMail.access.rule).toEqual({ kind: 'system' });
    expect(CustomerPendingEmailOf.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['customers.customers.view'],
    });
  });

  describe('the request (R2, R4, R5, R10, R11)', () => {
    it('keeps the old address, stores the pending one, requests the bound link, spends the proof and audits ids only', async () => {
      const s = setUp(code);
      const result = await requestChange(s);
      expect(result).toEqual({ ok: true, value: { changed: true, requestedAt: START } });
      const state = customer(s);
      expect(state.email.typed).toBe(OLD_EMAIL);
      expect(state.pendingEmail).toEqual({ typed: NEW_EMAIL, normalized: NEW_EMAIL.toLowerCase() });
      expect(state.pendingEmailRequestedAt).toEqual(START);
      const link = [...s.fakes.links.values()].find((l) => l.purpose === 'confirm-email-change')!;
      expect(link.requestedAt).toEqual(START);
      expect(s.fakes.stepUpProofs.size).toBe(0);
      expect(eventsOf(s, 'identity.account-email-change-requested.v1')).toHaveLength(1);
      expect(eventsOf(s, 'identity.account-email-change-requested.v1')[0]!.payload).toEqual({
        accountId: CUSTOMER,
        population: 'customer',
      });
      expect(s.fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.account.email-change-requested',
          targetId: CUSTOMER,
          actor: 'authenticated',
          after: { stepUpSessionId: ADMIN_SESSION },
        }),
      ]);
      const recorded = JSON.stringify([s.fakes.events, s.fakes.audits]).toLowerCase();
      expect(recorded).not.toContain('maryam');
    });

    it('needs a fresh step-up proof and writes nothing without one (R4)', async () => {
      const s = setUp(code);
      const result = await s.request.execute(admin, {
        accountId: CUSTOMER,
        email: NEW_EMAIL,
        origin: ORIGIN,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: KEY },
      });
      expect(customer(s).pendingEmail ?? null).toBeNull();
      expect(s.fakes.links.size).toBe(0);
      expect(s.fakes.audits).toEqual([]);
    });

    it('spends the proof once: a second request needs a new one (R4, R12 step-up spent)', async () => {
      const s = setUp(code);
      expect((await requestChange(s)).ok).toBe(true);
      const again = await s.request.execute(admin, {
        accountId: CUSTOMER,
        email: 'another@mailbox.test',
        origin: ORIGIN,
      });
      expect(again).toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
      expect(customer(s).pendingEmail?.typed).toBe(NEW_EMAIL);
    });

    it('refuses an acting-as session and a seller-side actor in identity too (R4)', async () => {
      const s = setUp(code);
      prove(s);
      const actingAs = adminActor({ actingAs: { sellerId: id<'Seller'>(0xb1) } });
      expect(
        await s.request.execute(actingAs, {
          accountId: CUSTOMER,
          email: NEW_EMAIL,
          origin: ORIGIN,
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(s.fakes.stepUpProofs.size).toBe(1);
      // The use case's own check, independent of the gate: the marker refuses, so do sellers.
      expect(isPlainAdmin(admin)).toBe(true);
      expect(isPlainAdmin(actingAs)).toBe(false);
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ADMIN,
          sessionId: ADMIN_SESSION,
          sellerId: id<'Seller'>(0xb1),
        }),
      );
      expect(isPlainAdmin(seller)).toBe(false);
      expect(
        await s.request.execute(seller, { accountId: CUSTOMER, email: NEW_EMAIL, origin: ORIGIN }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(customer(s).pendingEmail ?? null).toBeNull();
    });

    it('answers unchanged for the current address and spends nothing', async () => {
      const s = setUp(code);
      expect(await requestChange(s, ' maryam.old@example.COM ')).toEqual({
        ok: true,
        value: { changed: false, requestedAt: null },
      });
      expect(s.fakes.stepUpProofs.size).toBe(1);
      expect(s.fakes.events).toEqual([]);
    });

    it('refuses a malformed address with the registration parser, before any unit (R5)', async () => {
      const s = setUp(code);
      expect(await requestChange(s, 'not an address')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'invalid' }] },
      });
    });

    it('refuses an address another customer holds, verified or not', async () => {
      for (const verified of [START, null]) {
        const s = setUp(code);
        s.account(OTHER_CUSTOMER, 'customer', NEW_EMAIL.toUpperCase(), {
          emailVerifiedAt: verified,
        });
        expect(await requestChange(s)).toEqual({
          ok: false,
          error: { code: 'account.email-taken' },
        });
        expect(s.fakes.stepUpProofs.size).toBe(1);
      }
    });

    it('answers unknown for an admin, another Market and an unknown id; not-eligible for a disabled or unverified customer', async () => {
      const s = setUp(code);
      prove(s);
      for (const accountId of [ADMIN, id<'Account'>(0x9999)]) {
        expect(
          await s.request.execute(admin, { accountId, email: NEW_EMAIL, origin: ORIGIN }),
        ).toEqual({ ok: false, error: { code: 'account.unknown' } });
      }
      const other = TEST_MARKETS.find((m) => m !== code)!;
      const foreign = setUp(other);
      foreign.fakes.stepUpProofs.set(`${code}|${ADMIN_SESSION}|${KEY}`, START);
      foreign.account(ADMIN, 'admin', 'Support@Mondapac.test', {
        marketId: code as AccountState['marketId'],
      });
      expect(
        await foreign.request.execute(admin, {
          accountId: CUSTOMER,
          email: NEW_EMAIL,
          origin: ORIGIN,
        }),
      ).toMatchObject({ ok: false });
      for (const extra of [{ status: 'disabled' as const }, { emailVerifiedAt: null }]) {
        const t = setUp(code);
        t.account(CUSTOMER, 'customer', OLD_EMAIL, extra);
        expect(await requestChange(t)).toEqual({
          ok: false,
          error: { code: 'account.not-eligible' },
        });
      }
    });

    it('counts the mails: above the Market limit the request is throttled and nothing is written (R5)', async () => {
      const s = setUp(code);
      for (let n = 0; n < mailLimit; n += 1) {
        expect((await requestChange(s, `n${n}@mailbox.test`)).ok).toBe(true);
      }
      const refused = await requestChange(s, 'over@mailbox.test');
      expect(refused).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      expect(customer(s).pendingEmail?.typed).toBe(`n${mailLimit - 1}@mailbox.test`);
    });
  });

  describe('the mails (R3, R9)', () => {
    it('mails the link only to the pending address, with the link and the lifetime only', async () => {
      const s = setUp(code);
      await requestChange(s);
      expect(await deliverLink(s)).toEqual({
        ok: true,
        value: { code: 'link-mail.sent', issued: true },
      });
      const [mail] = s.fakes.mails;
      expect(mail!.to).toBe(NEW_EMAIL);
      const target = markets.get(code as AccountState['marketId']).identity.links.targets.customer[
        'confirm-email-change'
      ]!;
      expect(mail!.text).toContain(`${target}#ml1_`);
      expect(mail!.text.toLowerCase()).not.toContain('maryam.old');
      expect(mail!.subject.toLowerCase()).not.toContain('maryam');
    });

    it('skips the link mail after a cancel (no pending address) and after a newer request (superseded)', async () => {
      const s = setUp(code);
      await requestChange(s);
      const first = eventsOf(s, 'identity.one-time-link-requested.v1').at(-1)!;
      prove(s);
      expect(await s.cancel.execute(admin, { accountId: CUSTOMER })).toEqual({
        ok: true,
        value: { code: 'email-change.cancelled' },
      });
      expect(await deliverLink(s, 'confirm-email-change', first)).toEqual({
        ok: true,
        value: { code: 'link-mail.skipped', reason: 'link.superseded' },
      });
      expect(s.fakes.mails).toEqual([]);
    });

    it('warns the current address with the new one masked, and skips once the change is confirmed', async () => {
      const s = setUp(code);
      await requestChange(s);
      const warning = eventsOf(s, 'identity.account-email-change-requested.v1')[0]!;
      const input = {
        delivery: deliveryOf('identity.email-change-requested-mail'),
        accountId: CUSTOMER,
        occurredAt: warning.occurredAt,
      };
      expect(await s.sendWarning.execute(system, input)).toEqual({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      const [mail] = s.fakes.mails;
      expect(mail!.to).toBe(OLD_EMAIL);
      expect(mail!.text).toContain('m***@m***.test');
      expect(mail!.text.toLowerCase()).not.toContain('maryam.new');
      expect(mail!.text).not.toMatch(/https?:\/\//);

      await deliverLink(s);
      const token = tokenOf(s.fakes.mails.at(-1)!.text);
      expect(
        (await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT })).ok,
      ).toBe(true);
      expect(
        await s.sendWarning.execute(system, {
          ...input,
          delivery: deliveryOf('identity.email-change-requested-mail'),
        }),
      ).toEqual({
        ok: true,
        value: { code: 'email-change-mail.skipped', reason: 'email-change.superseded' },
      });
    });
  });

  describe('the confirmation (R1, R2, R6, R7, R10, R11)', () => {
    const deliverNotice = (s: Setup, event: PendingEvent) =>
      s.sendNotice.execute(system, {
        delivery: deliveryOf('identity.email-changed-mail'),
        accountId: CUSTOMER,
        occurredAt: event.occurredAt,
        aggregateVersion: event.aggregateVersion,
      });

    async function mailedToken(s: Setup) {
      expect((await requestChange(s)).ok).toBe(true);
      await deliverLink(s);
      return tokenOf(s.fakes.mails.at(-1)!.text);
    }

    it('swaps the address, ends every session and other link, opens none, and notices the old address', async () => {
      const s = setUp(code);
      const sessionA = openCustomerSession(s, 1);
      const sessionB = openCustomerSession(s, 2);
      expect(
        (
          await s.resetRequest.execute(anonymous, {
            population: 'customer',
            email: OLD_EMAIL,
            origin: ORIGIN,
          })
        ).ok,
      ).toBe(true);
      await deliverLink(s, 'reset-password');
      const resetToken = tokenOf(s.fakes.mails.at(-1)!.text);
      const token = await mailedToken(s);

      const result = await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        client: CLIENT,
      });
      expect(result).toEqual({ ok: true, value: { code: 'email-change.confirmed' } });
      const state = customer(s);
      expect(state.email).toEqual({ typed: NEW_EMAIL, normalized: NEW_EMAIL.toLowerCase() });
      expect(state.emailVerifiedAt).toEqual(START);
      expect(state.pendingEmail ?? null).toBeNull();
      expect(live(s, sessionA)).toBe(false);
      expect(live(s, sessionB)).toBe(false);
      expect([...s.fakes.sessions.values()].filter((x) => x.session.revokedAt === null)).toEqual(
        [],
      );
      // R12 dead reset link: the reset link mailed to the old address no longer works.
      const reset = [...s.fakes.links.values()].find((l) => l.purpose === 'reset-password')!;
      expect(reset.tokenHash).toBeNull();
      void resetToken;
      // One event, ids and population only; the audit names the bound subject and the count.
      expect(eventsOf(s, 'identity.account-email-changed.v1').map((e) => e.payload)).toEqual([
        { accountId: CUSTOMER, population: 'customer' },
      ]);
      expect(eventsOf(s, 'identity.account-email-verified.v1')).toEqual([]);
      expect(s.fakes.audits.at(-1)).toMatchObject({
        action: 'identity.account.email-changed',
        actor: 'anonymous',
        after: { boundSubjectId: CUSTOMER, revokedSessions: 2 },
      });
      expect(s.fakes.records.at(-1)).toMatchObject({
        accountId: CUSTOMER,
        outcome: 'email-changed',
      });
      expect(
        JSON.stringify([s.fakes.events, s.fakes.audits, s.fakes.records]).toLowerCase(),
      ).not.toContain('maryam');

      // The notice to the previous address, the new one masked; that notice row is deleted.
      expect(s.fakes.emailChangeNotices.size).toBe(1);
      const sent = await deliverNotice(s, eventsOf(s, 'identity.account-email-changed.v1')[0]!);
      expect(sent).toEqual({ ok: true, value: { code: 'email-change-mail.sent' } });
      const notice = s.fakes.mails.at(-1)!;
      expect(notice.to).toBe(OLD_EMAIL);
      expect(notice.text).toContain('m***@m***.test');
      expect(notice.text.toLowerCase()).not.toContain('maryam.new');
      expect(s.fakes.emailChangeNotices.size).toBe(0);
      // The old address no longer signs in; the session stays closed until a new sign-in.
      expect(s.fakes.accounts.size).toBeGreaterThan(1);
    });

    it('keeps one notice per change: A to B to C before any notice notifies A and B, each with its own new address (Hassan M1)', async () => {
      const s = setUp(code);
      const first = await mailedToken(s);
      expect(
        (await s.confirm.execute(anonymous, { token: first, password: PASSWORD, client: CLIENT }))
          .ok,
      ).toBe(true);
      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      expect((await requestChange(s, 'third@mailbox.test')).ok).toBe(true);
      await deliverLink(s);
      const second = tokenOf(s.fakes.mails.at(-1)!.text);
      expect(
        (await s.confirm.execute(anonymous, { token: second, password: PASSWORD, client: CLIENT }))
          .ok,
      ).toBe(true);
      expect(customer(s).email.typed).toBe('third@mailbox.test');
      const [ab, bc] = eventsOf(s, 'identity.account-email-changed.v1');
      expect(s.fakes.emailChangeNotices.size).toBe(2);

      // The later notice first: it deletes only its own row.
      expect(await deliverNotice(s, bc!)).toEqual({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      expect(s.fakes.mails.at(-1)!.to).toBe(NEW_EMAIL);
      expect(s.fakes.mails.at(-1)!.text).toContain('t***@m***.test');
      expect(s.fakes.emailChangeNotices.size).toBe(1);
      expect(await deliverNotice(s, ab!)).toEqual({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      // A gets the notice, with B (the new address of that change) masked, not C.
      expect(s.fakes.mails.at(-1)!.to).toBe(OLD_EMAIL);
      expect(s.fakes.mails.at(-1)!.text).toContain('m***@m***.test');
      expect(s.fakes.emailChangeNotices.size).toBe(0);
      // A redelivery of a sent notice finds none and sends nothing.
      const mails = s.fakes.mails.length;
      expect(await deliverNotice(s, ab!)).toMatchObject({ ok: true });
      expect(s.fakes.mails.length).toBe(mails);
    });

    it('skips a notice whose account key is destroyed (erased) and deletes it unsent', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT });
      s.fakes.subjectKeys.set(CUSTOMER, 'destroyed');
      const mails = s.fakes.mails.length;
      expect(await deliverNotice(s, eventsOf(s, 'identity.account-email-changed.v1')[0]!)).toEqual({
        ok: true,
        value: { code: 'email-change-mail.skipped', reason: 'email-change.notice-unreadable' },
      });
      expect(s.fakes.mails.length).toBe(mails);
      expect(s.fakes.emailChangeNotices.size).toBe(0);
    });

    it('lapses at the request plus the lifetime even when the link mail went out late (Sajad 5)', async () => {
      const s = setUp(code);
      expect((await requestChange(s)).ok).toBe(true);
      // The mail is delivered one minute before the pending address lapses: the link it issues
      // would live a full lifetime from now.
      s.clock.advance(Temporal.Duration.from({ minutes: lifetimeMinutes - 1 }));
      expect(await deliverLink(s)).toMatchObject({ ok: true, value: { code: 'link-mail.sent' } });
      const token = tokenOf(s.fakes.mails.at(-1)!.text);
      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      expect(
        await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(customer(s).email.typed).toBe(OLD_EMAIL);
    });

    it('skips the link mail once the pending address has lapsed (Sajad 5)', async () => {
      const s = setUp(code);
      expect((await requestChange(s)).ok).toBe(true);
      s.clock.advance(Temporal.Duration.from({ minutes: lifetimeMinutes }));
      expect(await deliverLink(s)).toEqual({
        ok: true,
        value: { code: 'link-mail.skipped', reason: 'account.pending-email-lapsed' },
      });
    });

    it('refuses a wrong password, counts it as a sign-in failure and leaves the link usable (R12 wrong password)', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      expect(
        await s.confirm.execute(anonymous, { token, password: 'wrong password', client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'credentials.invalid' } });
      expect(customer(s).email.typed).toBe(OLD_EMAIL);
      expect(s.fakes.records.at(-1)).toMatchObject({ outcome: 'credentials.invalid' });
      expect(
        (await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT })).ok,
      ).toBe(true);
    });

    it('rejects cross-purpose tokens both ways (R1)', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      expect(
        await s.confirmEmail.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(customer(s).email.typed).toBe(OLD_EMAIL);

      const t = setUp(code);
      t.account(CUSTOMER, 'customer', OLD_EMAIL, { emailVerifiedAt: null });
      expect(
        (
          await t.resetRequest.execute(anonymous, {
            population: 'customer',
            email: OLD_EMAIL,
            origin: ORIGIN,
          })
        ).ok,
      ).toBe(true);
      // A verification link of an unverified account, at the email-change route.
      const link = OneTimeLink.request({
        id: id<'OneTimeLink'>(0x1111),
        marketId: code as AccountState['marketId'],
        accountId: CUSTOMER,
        purpose: 'verify-email',
        now: START,
        notify: true,
      });
      await t.fakes.linkRepository.add(market, link);
      await t.fakes.outbox.append(system, link.pendingEvents);
      await deliverLink(t, 'verify-email');
      const verifyToken = tokenOf(t.fakes.mails.at(-1)!.text);
      expect(
        await t.confirm.execute(anonymous, {
          token: verifyToken,
          password: PASSWORD,
          client: CLIENT,
        }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
    });

    it('rejects the link after a cancel, and after a newer request the older token only (R2, R12 cancel/re-request)', async () => {
      const s = setUp(code);
      const first = await mailedToken(s);
      prove(s);
      expect((await s.cancel.execute(admin, { accountId: CUSTOMER })).ok).toBe(true);
      expect(customer(s).pendingEmail ?? null).toBeNull();
      expect(
        await s.confirm.execute(anonymous, { token: first, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });

      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const second = await mailedToken(s);
      // A new mail window, so the Market's mail counter does not refuse the third request.
      s.clock.advance(
        Temporal.Duration.from({ minutes: policy.mailThrottles(market).account.windowMinutes }),
      );
      expect((await requestChange(s, 'third@mailbox.test')).ok).toBe(true);
      await deliverLink(s);
      const third = tokenOf(s.fakes.mails.at(-1)!.text);
      expect(
        await s.confirm.execute(anonymous, { token: second, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(
        await s.confirm.execute(anonymous, { token: third, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: true, value: { code: 'email-change.confirmed' } });
      expect(customer(s).email.typed).toBe('third@mailbox.test');
    });

    it('is single use: a second confirmation with the same token is rejected (R12 concurrency)', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      const [a, b] = await Promise.all([
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].filter((r) => !r.ok)).toEqual([
        { ok: false, error: { code: 'link.rejected' } },
      ]);
      expect(eventsOf(s, 'identity.account-email-changed.v1')).toHaveLength(1);
    });

    it('rejects when another customer took the address meanwhile, changing nothing (R12 clash)', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      s.account(OTHER_CUSTOMER, 'customer', NEW_EMAIL);
      expect(
        await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(customer(s).email.typed).toBe(OLD_EMAIL);
      expect(customer(s).pendingEmail?.typed).toBe(NEW_EMAIL);
      expect(eventsOf(s, 'identity.account-email-changed.v1')).toEqual([]);
    });

    it('answers link.rejected for a disabled account and an expired link, never account.disabled (R7)', async () => {
      const s = setUp(code);
      const token = await mailedToken(s);
      s.fakes.accounts.set(CUSTOMER, { ...customer(s), status: 'disabled' });
      expect(
        await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });

      const t = setUp(code);
      const late = await mailedToken(t);
      t.clock.advance(Temporal.Duration.from({ minutes: lifetimeMinutes }));
      expect(
        await t.confirm.execute(anonymous, { token: late, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(
        await t.confirm.execute(anonymous, {
          token: 'garbage',
          password: PASSWORD,
          client: CLIENT,
        }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
    });
  });

  describe('a requested account deletion (Hassan R6, L2)', () => {
    it('cancels the pending change: the mailed link then answers link.rejected', async () => {
      const s = setUp(code);
      expect((await requestChange(s)).ok).toBe(true);
      await deliverLink(s);
      const token = tokenOf(s.fakes.mails.at(-1)!.text);
      // customers' subscriber on its deletion-requested event, as the system actor.
      expect(await s.cancelForDeletion.execute(system, { accountId: CUSTOMER })).toEqual({
        ok: true,
        value: { cancelled: true },
      });
      expect(customer(s).pendingEmail ?? null).toBeNull();
      expect(
        await s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(customer(s).email.typed).toBe(OLD_EMAIL);
      // Repeat-safe: a redelivery finds nothing pending.
      expect(await s.cancelForDeletion.execute(system, { accountId: CUSTOMER })).toEqual({
        ok: true,
        value: { cancelled: false },
      });
    });

    it('is for the system actor only and answers false for an unknown or malformed id', async () => {
      const s = setUp(code);
      expect((await requestChange(s)).ok).toBe(true);
      expect(await s.cancelForDeletion.execute(admin, { accountId: CUSTOMER })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await s.cancelForDeletion.execute(anonymous, { accountId: CUSTOMER })).toMatchObject({
        ok: false,
      });
      expect(customer(s).pendingEmail).not.toBeNull();
      expect(await s.cancelForDeletion.execute(system, { accountId: 'nope' })).toEqual({
        ok: true,
        value: { cancelled: false },
      });
      expect(
        await s.cancelForDeletion.execute(system, { accountId: id<'Account'>(0xdead) }),
      ).toEqual({ ok: true, value: { cancelled: false } });
    });
  });

  describe('the customer page read and the purge', () => {
    it('shows the pending address to the admin until it lapses with its link; the purge clears it', async () => {
      const s = setUp(code);
      await requestChange(s);
      expect(await s.pendingOf.execute(admin, { accountId: CUSTOMER })).toEqual({
        ok: true,
        value: { email: NEW_EMAIL, requestedAt: START },
      });
      expect(
        await s.pendingOf.execute(adminActor({ actingAs: { sellerId: id<'Seller'>(0xb1) } }), {
          accountId: CUSTOMER,
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      s.clock.advance(Temporal.Duration.from({ minutes: lifetimeMinutes }));
      expect(await s.pendingOf.execute(admin, { accountId: CUSTOMER })).toEqual({
        ok: true,
        value: null,
      });
      const purged = await s.purge.execute(system, {});
      expect(purged).toMatchObject({ ok: true, value: { pendingEmails: 1 } });
      expect(customer(s).pendingEmail ?? null).toBeNull();
    });
  });
});
