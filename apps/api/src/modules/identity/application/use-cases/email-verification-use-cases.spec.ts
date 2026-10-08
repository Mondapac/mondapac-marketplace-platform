import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { RandomLinkTokens } from '../../infrastructure/links/random-link-tokens';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { RandomSessionTokens } from '../../infrastructure/sessions/random-session-tokens';
import type { ThrottleKeys } from '../ports/session-secrets';
import { ConfirmCustomerEmail } from './confirm-customer-email.use-case';
import { PurgeUnverifiedAccounts } from './purge-unverified-accounts.use-case';
import { RegisterCustomer } from './register-customer.use-case';
import { RequestCustomerVerification } from './request-customer-verification.use-case';
import { SendExistingAccountMail } from './send-existing-account-mail.use-case';
import { SendLinkMail } from './send-link-mail.use-case';
import { SignInCustomer } from './sign-in-customer.use-case';

// Identity slice 3, in memory (identity design 3.2, 3.7, 6.3, 6.6 to 6.8, 9): the sign-up's
// link request, the mail handler, the confirmation with link and password, "send it again",
// the existing-account notice and the unverified purge. Both Market fixtures with their own
// numbers (AU: link 24 h, purge after 7 days, 3 mails an hour; ZZ: 12 h, 5 days, 2 an hour)
// and locales (en-AU, ja-JP). The PostgreSQL behaviour is covered by test/db/.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Customer@Example.com';
const ORIGIN = '203.0.113.7';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

function setUp() {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const gate = createUseCaseGate(markets, null);
  const linkTokens = new RandomLinkTokens();
  const common = {
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    links: fakes.linkRepository,
    throttles: fakes.throttleRepository,
    keys,
    outbox: fakes.outbox,
    policy,
    clock,
    ids,
  };
  const signInDeps = {
    ...common,
    sessions: fakes.sessionRepository,
    records: fakes.recordRepository,
    hasher: fakes.hasher,
    tokens: new RandomSessionTokens(),
  };
  const mailDeps = {
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    targets: policy,
    composer,
    transport: fakes.mailTransport,
    policy,
  };
  return {
    fakes,
    clock,
    register: new RegisterCustomer(gate, {
      ...common,
      hasher: fakes.hasher,
      commonPasswords: { isCommon: () => false },
    }),
    signIn: new SignInCustomer(gate, signInDeps),
    confirm: new ConfirmCustomerEmail(gate, { ...signInDeps, linkTokens }),
    resend: new RequestCustomerVerification(gate, common),
    sendLinkMail: new SendLinkMail(gate, {
      ...mailDeps,
      links: fakes.linkRepository,
      linkTokens,
      clock,
    }),
    sendNotice: new SendExistingAccountMail(gate, mailDeps),
    purge: new PurgeUnverifiedAccounts(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      policy,
      clock,
    }),
  };
}

let deliveries = 0;
function deliveryOf(event: PendingEvent, subscriber: string): EventDelivery {
  deliveries += 1;
  return {
    eventId: `0199ffff-0000-7000-8000-${String(deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber,
    attempt: 1,
  };
}

/** The token in the fragment of a mailed link. */
const tokenOf = (text: string): string => /#(ml1_[A-Za-z0-9_-]{43})/.exec(text)![1]!;

describe.each(TEST_MARKETS)('email verification in market %s (identity slice 3)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const anonymous = testCallContext(market, 'anonymous', 'verify-test-0001');
  const system = testCallContext(market, 'system', 'verify-test-0002');
  const lifetimeMinutes = policy.linkLifetimeMinutes(market, 'verify-email')!;
  const sender = policy.mailSender(market);
  let logs: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  type Setup = ReturnType<typeof setUp>;

  async function signUp(s: Setup, password = PASSWORD) {
    const result = await s.register.execute(anonymous, { email: EMAIL, password, origin: ORIGIN });
    expect(result.ok).toBe(true);
  }

  const linkEvents = (s: Setup) =>
    s.fakes.events.filter((e) => e.type === 'identity.one-time-link-requested.v1');

  /** Runs the link-mail handler for the latest link request, as the dispatcher would. */
  async function deliverLinkMail(s: Setup, event: PendingEvent = linkEvents(s).at(-1)!) {
    const payload = event.payload as { linkId: Id; accountId: Id; purpose: 'verify-email' };
    return s.sendLinkMail.execute(system, {
      delivery: deliveryOf(event, 'identity.link-mail'),
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: payload.purpose,
      aggregateVersion: event.aggregateVersion,
    });
  }

  const account = (s: Setup): AccountState => [...s.fakes.accounts.values()][0]!;

  it('declares the rules of the new use cases under their catalogue names', () => {
    expect(ConfirmCustomerEmail.access).toEqual({
      name: 'identity.confirm-customer-email',
      rule: { kind: 'anonymous' },
    });
    expect(RequestCustomerVerification.access.rule).toEqual({ kind: 'anonymous' });
    expect(SendLinkMail.access.rule).toEqual({ kind: 'system' });
    expect(SendExistingAccountMail.access.rule).toEqual({ kind: 'system' });
    expect(PurgeUnverifiedAccounts.access.rule).toEqual({ kind: 'system' });
  });

  describe('sign-up, link mail and confirmation, end to end', () => {
    it('mails a link in the Market locale, stores only its hash, and the link with the password signs in', async () => {
      const s = setUp();
      await signUp(s);

      // Hassan I5: before confirming, a correct password is refused.
      await expect(
        s.signIn.execute(anonymous, { email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'email-verification-required' } });

      await expect(deliverLinkMail(s)).resolves.toEqual({
        ok: true,
        value: { code: 'link-mail.sent', issued: true },
      });
      const [mail, ...more] = s.fakes.mails;
      expect(more).toEqual([]);
      expect(mail).toMatchObject({ to: EMAIL, from: sender });
      expect(mail!.subject).toBe(
        code === 'AU'
          ? 'Confirm your email for your MondaPac customer account'
          : 'お客様アカウントのメールアドレスを確認してください',
      );
      const token = tokenOf(mail!.text);
      const target = policy.target(market, 'customer', 'verify-email')!;
      expect(mail!.text).toContain(`${target}#${token}`);
      const [link] = [...s.fakes.links.values()];
      expect(link).toMatchObject({
        issuedAt: START,
        expiresAt: START.add({ minutes: lifetimeMinutes }),
        version: 2,
      });
      expect(JSON.stringify([...s.fakes.links.values()])).not.toContain(token);
      // No log line holds the token or the address (AC 12; P 12.3).
      const logged = JSON.stringify(logs.mock.calls);
      expect(logged).not.toContain(token);
      expect(logged.toLowerCase()).not.toContain(EMAIL.toLowerCase());

      s.clock.advance(Temporal.Duration.from({ minutes: 5 }));
      const confirmed = await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        client: CLIENT,
      });

      expect(confirmed).toEqual({
        ok: true,
        value: {
          code: 'signed-in',
          token: expect.stringMatching(/^ms1_/) as unknown,
          absoluteLifetimeSeconds: policy.sessionLifetime(market, 'customer')!
            .absoluteLifetimeSeconds,
        },
      });
      expect(account(s)).toMatchObject({ emailVerifiedAt: s.clock.now() });
      expect([...s.fakes.links.values()][0]).toMatchObject({ consumedAt: s.clock.now() });
      expect(s.fakes.events.at(-1)).toMatchObject({
        type: 'identity.account-email-verified.v1',
        payload: { accountId: account(s).id, population: 'customer' },
      });
      expect(s.fakes.records.at(-1)).toMatchObject({ outcome: 'signed-in', marketId: code });

      // Single use; and the plain sign-in now works.
      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      await expect(
        s.signIn.execute(anonymous, { email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('confirms and re-hashes in one save when the stored hash has older parameters (Hassan L2)', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);
      const before = account(s);
      s.fakes.needsRehash = true;
      const rehashed = `${fakeHashOf(PASSWORD)}$rehashed`;
      jest.spyOn(s.fakes.hasher, 'hash').mockResolvedValueOnce(ok(rehashed));

      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'signed-in' } });

      // Two changes, one version step each, stored by one save.
      expect(account(s)).toMatchObject({
        emailVerifiedAt: s.clock.now(),
        version: before.version + 2,
        credential: { passwordHash: rehashed },
      });
      expect(s.fakes.events.at(-1)).toMatchObject({
        type: 'identity.account-email-verified.v1',
      });
      expect(s.fakes.sessions.size).toBe(1);
    });

    it('refuses a link re-issued between the reservation and the closing unit (Hassan L1)', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);
      const verify = s.fakes.hasher.verify.bind(s.fakes.hasher);
      // While the password is hashed (outside any unit), "send it again" re-issues the link.
      jest.spyOn(s.fakes.hasher, 'verify').mockImplementationOnce(async (plain, stored) => {
        await s.resend.execute(anonymous, { email: EMAIL, origin: ORIGIN });
        await deliverLinkMail(s);
        return verify(plain, stored);
      });

      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });

      const [link] = [...s.fakes.links.values()];
      expect(link).toMatchObject({ consumedAt: null });
      expect(account(s).emailVerifiedAt).toBeNull();
      expect(s.fakes.sessions.size).toBe(0);
      // The mail of the re-issue holds the working link.
      await expect(
        s.confirm.execute(anonymous, {
          token: tokenOf(s.fakes.mails.at(-1)!.text),
          password: PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('a wrong password does not consume the link and stays counted (HF1)', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);

      await expect(
        s.confirm.execute(anonymous, { token, password: 'wrong password!!!', client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'credentials.invalid' } });

      expect([...s.fakes.links.values()][0]!.consumedAt).toBeNull();
      expect(account(s).emailVerifiedAt).toBeNull();
      const attempts = [...s.fakes.throttles.values()]
        .filter((row) => row.kind.startsWith('sign-in.'))
        .map((row) => [row.kind, row.attempts])
        .sort();
      expect(attempts).toEqual([
        ['sign-in.account', 1],
        ['sign-in.account-origin', 1],
        ['sign-in.origin', 1],
      ]);
      // The same link still works with the right password.
      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true });
    });

    it.each([
      ['a malformed token', () => 'not-a-token'],
      ['an unknown token', () => new RandomLinkTokens().issue().token],
      ['a session token', () => new RandomSessionTokens().issue().token],
    ])('answers link.rejected for %s, without hashing, counted per origin', async (_c, token) => {
      const s = setUp();
      await signUp(s);
      const verified = s.fakes.verified;

      await expect(
        s.confirm.execute(anonymous, { token: token(), password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(s.fakes.verified).toBe(verified);
      expect(
        [...s.fakes.throttles.values()].find((r) => r.kind === 'sign-in.origin'),
      ).toMatchObject({ attempts: 1 });
      expect(s.fakes.records.at(-1)).toMatchObject({ outcome: 'link.rejected', accountId: null });
    });

    it('answers link.rejected from the expiry the Market sets', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);
      s.clock.advance(Temporal.Duration.from({ minutes: lifetimeMinutes }));

      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(account(s).emailVerifiedAt).toBeNull();
    });

    it("refuses another Market's link: one answer, link.rejected (AC 19)", async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);
      const other = TEST_MARKETS.find((m) => m !== code)!;

      await expect(
        s.confirm.execute(
          testCallContext(testMarketContext(other, PLATFORM_TENANT_ID), 'anonymous'),
          { token, password: PASSWORD, client: CLIENT },
        ),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
    });

    it('a disabled account: account.disabled after the password, and the link stays unused', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const token = tokenOf(s.fakes.mails[0]!.text);
      s.fakes.accounts.set(account(s).id, { ...account(s), status: 'disabled' });

      await expect(
        s.confirm.execute(anonymous, { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.disabled' } });
      expect([...s.fakes.links.values()][0]!.consumedAt).toBeNull();
    });

    it('a repeated sign-up voids the mailed link; the new mail works', async () => {
      const s = setUp();
      await signUp(s);
      await deliverLinkMail(s);
      const first = tokenOf(s.fakes.mails[0]!.text);
      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await signUp(s, `${PASSWORD} again`);
      await deliverLinkMail(s);
      const second = tokenOf(s.fakes.mails[1]!.text);

      await expect(
        s.confirm.execute(anonymous, {
          token: first,
          password: `${PASSWORD} again`,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      await expect(
        s.confirm.execute(anonymous, {
          token: second,
          password: `${PASSWORD} again`,
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe('SendLinkMail (identity design 6.6, 9)', () => {
    it('sends nothing for a superseded request, and marks the delivery handled', async () => {
      const s = setUp();
      await signUp(s);
      const stale = linkEvents(s).at(-1)!;
      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await signUp(s);

      await expect(deliverLinkMail(s, stale)).resolves.toEqual({
        ok: true,
        value: { code: 'link-mail.skipped', reason: 'link.superseded' },
      });
      expect(s.fakes.mails).toEqual([]);
      expect(s.fakes.inbox.size).toBe(1);
      // The newer request still mails.
      await expect(deliverLinkMail(s)).resolves.toMatchObject({
        value: { code: 'link-mail.sent' },
      });
    });

    it('sends nothing once the link was issued (a repeated delivery)', async () => {
      const s = setUp();
      await signUp(s);
      const event = linkEvents(s).at(-1)!;
      await deliverLinkMail(s, event);

      await expect(deliverLinkMail(s, event)).resolves.toMatchObject({
        value: { code: 'link-mail.skipped', reason: 'link.superseded' },
      });
      expect(s.fakes.mails).toHaveLength(1);
    });

    it('sends nothing to an account that is gone, disabled or already verified', async () => {
      const s = setUp();
      await signUp(s);
      s.fakes.accounts.set(account(s).id, { ...account(s), emailVerifiedAt: START });

      await expect(deliverLinkMail(s)).resolves.toMatchObject({
        value: { code: 'link-mail.skipped', reason: 'account.verified' },
      });
      s.fakes.accounts.set(account(s).id, { ...account(s), status: 'disabled' });
      await expect(deliverLinkMail(s)).resolves.toMatchObject({
        value: { reason: 'account.disabled' },
      });
      s.fakes.accounts.clear();
      await expect(deliverLinkMail(s)).resolves.toMatchObject({
        value: { reason: 'account.gone' },
      });
      expect(s.fakes.mails).toEqual([]);
    });

    it('a failed send throws, issues nothing and records no inbox row (the delivery is retried)', async () => {
      const s = setUp();
      await signUp(s);
      s.fakes.mailDown = true;

      await expect(deliverLinkMail(s)).rejects.toThrow('mail transport down');
      expect([...s.fakes.links.values()][0]).toMatchObject({ tokenHash: null, version: 1 });
      expect(s.fakes.inbox.size).toBe(0);

      s.fakes.mailDown = false;
      await expect(deliverLinkMail(s)).resolves.toMatchObject({
        value: { code: 'link-mail.sent' },
      });
    });

    it('refuses any actor but the system', async () => {
      const s = setUp();
      await signUp(s);
      const event = linkEvents(s).at(-1)!;
      const payload = event.payload as { linkId: Id; accountId: Id };

      await expect(
        s.sendLinkMail.execute(anonymous, {
          delivery: deliveryOf(event, 'identity.link-mail'),
          linkId: payload.linkId,
          accountId: payload.accountId,
          purpose: 'verify-email',
          aggregateVersion: 1,
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(s.fakes.mails).toEqual([]);
    });
  });

  describe('RequestCustomerVerification ("send it again")', () => {
    it('answers the same for an unknown, an unverified and a verified address', async () => {
      const s = setUp();
      const accepted = { ok: true, value: { code: 'verification-resend.accepted' } };

      await expect(
        s.resend.execute(anonymous, { email: 'nobody@example.com', origin: ORIGIN }),
      ).resolves.toEqual(accepted);
      await signUp(s);
      const before = linkEvents(s).length;
      await expect(s.resend.execute(anonymous, { email: EMAIL, origin: ORIGIN })).resolves.toEqual(
        accepted,
      );
      expect(linkEvents(s)).toHaveLength(before + 1);

      s.fakes.accounts.set(account(s).id, { ...account(s), emailVerifiedAt: START });
      await expect(s.resend.execute(anonymous, { email: EMAIL, origin: ORIGIN })).resolves.toEqual(
        accepted,
      );
      expect(linkEvents(s)).toHaveLength(before + 1);
    });

    it("stops the mail at the Market's per-address limit, with the same answer (Mojtaba 3)", async () => {
      const s = setUp();
      await signUp(s); // the sign-up counts one mail
      const limit = policy.mailThrottles(market).account.limit;
      for (let i = 0; i < limit + 2; i += 1) {
        await expect(
          s.resend.execute(anonymous, { email: EMAIL, origin: `198.51.100.${i}` }),
        ).resolves.toMatchObject({ ok: true });
      }
      // The sign-up's request plus (limit - 1) re-sends; the rest were refused by the counter.
      expect(linkEvents(s)).toHaveLength(limit);
    });

    it('refuses a malformed email', async () => {
      const s = setUp();

      await expect(
        s.resend.execute(anonymous, { email: 'not-an-email', origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
      });
    });
  });

  describe('SendExistingAccountMail (identity design 6.7; E12)', () => {
    async function verifiedRepeat(s: Setup) {
      await signUp(s);
      s.fakes.accounts.set(account(s).id, { ...account(s), emailVerifiedAt: START });
      await signUp(s);
      return s.fakes.events.at(-1)!;
    }

    it('mails the notice with the sign-in page, in the Market locale, and no token', async () => {
      const s = setUp();
      const event = await verifiedRepeat(s);
      expect(event).toMatchObject({ payload: { cause: 'verified-notice' } });

      await expect(
        s.sendNotice.execute(system, {
          delivery: deliveryOf(event, 'identity.existing-account-mail'),
          accountId: account(s).id,
          cause: 'verified-notice',
          occurredAt: event.occurredAt,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'existing-account-mail.sent' } });
      const [mail] = s.fakes.mails;
      expect(mail).toMatchObject({ to: EMAIL, from: sender });
      expect(mail!.text).toContain(policy.target(market, 'customer', 'sign-in')!);
      expect(mail!.text).not.toContain('ml1_');
    });

    it('mails nothing for the other cause, which mails through its link request', async () => {
      const s = setUp();
      await signUp(s);

      await expect(
        s.sendNotice.execute(system, {
          delivery: deliveryOf(s.fakes.events[0]!, 'identity.existing-account-mail'),
          accountId: account(s).id,
          cause: 'unverified-replaced',
          occurredAt: START,
        }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'existing-account-mail.skipped', reason: 'cause.not-a-notice' },
      });
      expect(s.fakes.mails).toEqual([]);
    });

    it('mails nothing for a notice that a later one replaced', async () => {
      const s = setUp();
      const event = await verifiedRepeat(s);
      s.fakes.accounts.set(account(s).id, {
        ...account(s),
        existingAccountNoticeAt: START.add({ hours: 30 }),
      });

      await expect(
        s.sendNotice.execute(system, {
          delivery: deliveryOf(event, 'identity.existing-account-mail'),
          accountId: account(s).id,
          cause: 'verified-notice',
          occurredAt: event.occurredAt,
        }),
      ).resolves.toMatchObject({ value: { reason: 'notice.superseded' } });
    });
  });

  describe('PurgeUnverifiedAccounts (identity design 3.1; M5)', () => {
    it("deletes never-verified accounts only after the Market's retention, with their links", async () => {
      const s = setUp();
      await signUp(s);
      const days = policy.unverifiedAccountRetentionDays(market);
      const keep = { ...account(s), id: '01990000-0000-7000-8000-00000000beef' as Id<'Account'> };
      s.fakes.seedAccount({
        ...keep,
        email: { typed: 'kept@example.com', normalized: 'kept@example.com' },
        emailVerifiedAt: START,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });

      s.clock.advance(Temporal.Duration.from({ hours: days * 24 - 1 }));
      await expect(s.purge.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { deleted: 0, skipped: 0 },
      });

      s.clock.advance(Temporal.Duration.from({ hours: 2 }));
      await expect(s.purge.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { deleted: 1, skipped: 0 },
      });
      expect([...s.fakes.accounts.keys()]).toEqual([keep.id]);
      expect(s.fakes.links.size).toBe(0);
    });

    it('refuses any actor but the system', async () => {
      await expect(setUp().purge.execute(anonymous, {})).resolves.toMatchObject({ ok: false });
    });
  });
});
