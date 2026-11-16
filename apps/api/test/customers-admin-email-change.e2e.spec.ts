import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ACCOUNT_DELETION_REQUEST_REPOSITORY } from '../src/modules/customers/application/ports/account-deletion-request.repository';
import { CUSTOMER_LIST_READER } from '../src/modules/customers/application/ports/customer-list.reader';
import { InMemoryCustomerList } from '../src/modules/customers/application/testing/in-memory-customer-list';
import { MemoryAccountDeletionRequests } from '../src/modules/customers/application/testing/in-memory-account-deletion';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomLinkTokens } from '../src/modules/identity/infrastructure/links/random-link-tokens';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin email change over HTTP (customers admin email change): the real guards, gate,
// controllers and use cases of customers and identity, identity's ports on the in-memory fakes,
// the deletion requests in memory. Proves the admin population, CSRF, the protected key (a
// viewer is refused), the step-up proof (spent once), the closed body, `no-store`, the status of
// each refusal, then the anonymous confirm route: its headers, link.rejected for every cause,
// the password, the swap with every session ended and no cookie set; in both Markets.

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const PASSWORD = 'correct horse battery staple';
const NEW_EMAIL = 'Maryam.New@Mailbox.test';
const KEY = 'customers.customer-email.change';
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CHANGER = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const CUSTOMER = id<'Account'>(0xa201);
const OTHER_CUSTOMER = id<'Account'>(0xa202);
const fakes = new IdentityFakes();
const sessionTokens = new RandomSessionTokens();
const linkTokens = new RandomLinkTokens();
const emailPath = (accountId: string) => `/customers/admin/customers/${accountId}/email`;
const cancelPath = (accountId: string) => `/customers/admin/customers/${accountId}/email-change`;
const CONFIRM = '/identity/customer/email-change/confirm';

describe.each(TEST_MARKETS)('admin customer email change over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let logLines: LogLine[];
  let clock: FixedClock;
  let requests: MemoryAccountDeletionRequests;
  let listReader: InMemoryCustomerList;
  const http = () => request(app!.getHttpServer());
  const marketOf = (c = code) => testMarketContext(c, PLATFORM_TENANT_ID);

  const account = (
    accountId: Id<'Account'>,
    population: 'admin' | 'customer',
    label: string,
    overrides: Partial<AccountState> = {},
  ) =>
    fakes.seedAccount({
      id: accountId,
      marketId: code as AccountState['marketId'],
      population,
      email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
      displayName: population === 'customer' ? null : label,
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: START.subtract({ hours: 48 }),
      createdAt: START.subtract({ hours: 48 }),
      version: 1,
      credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START.subtract({ hours: 48 }) },
      ...overrides,
    });

  async function boot() {
    ({ app, logLines } = await createTestApp({
      panelOrigins: true,
      env: { LOG_LEVEL: 'info' },
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ACCOUNT_DELETION_REQUEST_REPOSITORY)
          .useValue(requests)
          .overrideProvider(CUSTOMER_LIST_READER)
          .useValue(listReader),
    }));
    await app
      .get(SeedRoles)
      .execute(testCallContext(marketOf(), 'system', 'email-change-seed'), {});
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    const assign = (n: number, accountId: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId: code as AccountState['marketId'],
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    account(CHANGER, 'admin', 'changer');
    account(VIEWER, 'admin', 'viewer');
    account(CUSTOMER, 'customer', 'maryam');
    account(OTHER_CUSTOMER, 'customer', 'other');
    // The protected key is held by the Platform Administrator role by definition.
    assign(1, CHANGER, roleOf('platform-administrator'));
    assign(2, VIEWER, roleOf('viewer'));
    for (const [factor, accountId] of [
      [0xf301, CHANGER],
      [0xf302, VIEWER],
    ] as const) {
      fakes.factors.set(accountId, {
        id: id<'SecondFactor'>(factor),
        marketId: code as AccountState['marketId'],
        accountId,
        state: 'active',
        secretCiphertext: 'sealed',
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: START,
        lockedAt: null,
        createdAt: START,
        recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
          position: index + 1,
          codeHash: new Uint8Array(32).fill(index + 1),
          usedAt: null,
        })),
        version: 1,
      });
    }
  }

  function sessionOf(population: 'admin' | 'customer', n: number, accountId: Id<'Account'>) {
    const issued = sessionTokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId,
        population,
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...(population === 'customer' ? {} : panelHeaders(code, population)),
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const prove = (n: number) =>
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf100 + n)}|${KEY}`, clock.now());
  const live = (n: number) =>
    fakes.sessions.get(id<'Session'>(0xf100 + n))?.session.revokedAt === null;
  const customer = () => fakes.accounts.get(CUSTOMER)!;

  /** Issues the requested confirm-email-change link as the mail handler would; answers the token. */
  function issueChangeLink(): string {
    const [linkId, link] = [...fakes.links.entries()].find(
      ([, l]) => l.accountId === CUSTOMER && l.purpose === 'confirm-email-change',
    )!;
    const { token, tokenHash } = linkTokens.issue();
    fakes.links.set(linkId, {
      ...link,
      tokenHash,
      issuedAt: clock.now(),
      expiresAt: clock.now().add({ hours: 1 }),
      version: link.version + 1,
    });
    return token;
  }
  const confirm = (body: unknown) =>
    http()
      .post(CONFIRM)
      .set({ 'x-market-id': code, 'content-type': 'application/json' })
      .send(JSON.stringify(body));

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    requests = new MemoryAccountDeletionRequests();
    listReader = new InMemoryCustomerList();
    listReader.add(marketOf(), {
      accountId: CUSTOMER,
      email: 'maryam@example.com',
      displayName: null,
      status: 'active',
      emailVerified: true,
      signedUpAt: START.subtract({ hours: 48 }),
      firstOrderAt: null,
      lastOrderAt: null,
      orderCount: 0,
      spentMinor: 0n,
      currency: null,
      refundCount: 0,
      refundedMinor: 0n,
    });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('refuses a visitor and a customer session on both admin routes, writing nothing', async () => {
    await boot();
    const visitor = { 'x-market-id': code, ...panelHeaders(code, 'admin') };
    const buyer = sessionOf('customer', 1, CUSTOMER);
    for (const headers of [visitor, buyer]) {
      for (const res of [
        await http().put(emailPath(CUSTOMER)).set(headers).send({ email: NEW_EMAIL }),
        await http().delete(cancelPath(CUSTOMER)).set(headers),
      ]) {
        expect([401, 403]).toContain(res.status);
      }
    }
    expect(customer().pendingEmail ?? null).toBeNull();
  });

  it('refuses a write without the CSRF token', async () => {
    await boot();
    const { cookie } = sessionOf('admin', 2, CHANGER);
    prove(2);
    const res = await http()
      .put(emailPath(CUSTOMER))
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), cookie })
      .send({ email: NEW_EMAIL });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'request.csrf' });
    expect(customer().pendingEmail ?? null).toBeNull();
  });

  it('refuses a viewer (no protected key) even with a proof', async () => {
    await boot();
    prove(3);
    const res = await http()
      .put(emailPath(CUSTOMER))
      .set(sessionOf('admin', 3, VIEWER))
      .send({ email: NEW_EMAIL });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'access.denied' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(customer().pendingEmail ?? null).toBeNull();
  });

  it('needs a fresh step-up proof: 403 with the action key, nothing written', async () => {
    await boot();
    const admin = sessionOf('admin', 4, CHANGER);
    const res = await http().put(emailPath(CUSTOMER)).set(admin).send({ email: NEW_EMAIL });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'second-factor.required', details: { actionKey: KEY } });
    expect((await http().delete(cancelPath(CUSTOMER)).set(admin)).status).toBe(403);
    expect(customer().pendingEmail ?? null).toBeNull();
  });

  it('closes the body and answers the refusals with their statuses', async () => {
    await boot();
    const admin = sessionOf('admin', 5, CHANGER);
    prove(5);
    const extra = await http()
      .put(emailPath(CUSTOMER))
      .set(admin)
      .send({ email: NEW_EMAIL, accountId: OTHER_CUSTOMER });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({ code: 'validation.failed' });
    const bad = await http().put(emailPath(CUSTOMER)).set(admin).send({ email: 'not an address' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 'validation.failed',
      details: { fields: [{ path: 'email', code: 'invalid' }] },
    });
    const taken = await http()
      .put(emailPath(CUSTOMER))
      .set(admin)
      .send({ email: 'OTHER@example.com' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'customers.email-taken' });
    expect(JSON.stringify(taken.body).toLowerCase()).not.toContain('other@example.com');
    const unknown = await http()
      .put(emailPath(id<'Account'>(0xdead)))
      .set(admin)
      .send({ email: NEW_EMAIL });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'customers.customer-not-found' });
    const none = await http().delete(cancelPath(CUSTOMER)).set(admin);
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ code: 'customers.email-change-not-found' });
    expect(customer().pendingEmail ?? null).toBeNull();
  });

  it('requests, shows the pending address on the overview, spends the proof, and cancels', async () => {
    await boot();
    const admin = sessionOf('admin', 6, CHANGER);
    prove(6);
    const res = await http().put(emailPath(CUSTOMER)).set(admin).send({ email: NEW_EMAIL });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ changed: true, requestedAt: START.toString() });
    expect(customer().email.typed).toBe('maryam@Example.com');
    expect(customer().pendingEmail?.typed).toBe(NEW_EMAIL);
    // R4: the proof is spent by the request.
    const again = await http().put(emailPath(CUSTOMER)).set(admin).send({ email: NEW_EMAIL });
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ code: 'second-factor.required' });

    const page = await http().get(`/customers/admin/customers/${CUSTOMER}`).set(admin);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      email: 'maryam@example.com',
      pendingEmailChange: { email: NEW_EMAIL, requestedAt: START.toString() },
    });

    prove(6);
    const cancelled = await http().delete(cancelPath(CUSTOMER)).set(admin);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });
    expect(customer().pendingEmail ?? null).toBeNull();
    // The logs carry ids and codes, never the address.
    expect(JSON.stringify(logLines).toLowerCase()).not.toContain(NEW_EMAIL.toLowerCase());
  });

  it('confirms with the link and the password: swaps, ends every session, sets no cookie', async () => {
    await boot();
    const buyer = 7;
    sessionOf('customer', buyer, CUSTOMER);
    const admin = sessionOf('admin', 8, CHANGER);
    prove(8);
    expect(
      (await http().put(emailPath(CUSTOMER)).set(admin).send({ email: NEW_EMAIL })).status,
    ).toBe(200);
    const token = issueChangeLink();

    const wrong = await confirm({ token, password: 'not the password at all' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'credentials.invalid' });
    expect(customer().pendingEmail?.typed).toBe(NEW_EMAIL);

    const res = await confirm({ token, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: 'email-change.confirmed' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(customer().email.typed).toBe(NEW_EMAIL);
    expect(customer().pendingEmail ?? null).toBeNull();
    expect(live(buyer)).toBe(false);
    expect(fakes.events.map((e) => e.type)).toContain('identity.account-email-changed.v1');

    const reused = await confirm({ token, password: PASSWORD });
    expect(reused.status).toBe(400);
    expect(reused.body).toMatchObject({ code: 'link.rejected' });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(token);
    expect(all).not.toContain(PASSWORD);
  });

  it('answers link.rejected for an unknown or malformed token and 415 for another type', async () => {
    await boot();
    for (const token of [linkTokens.issue().token, 'garbage']) {
      const res = await confirm({ token, password: PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'link.rejected' });
    }
    const form = await http()
      .post(CONFIRM)
      .set({ 'x-market-id': code, 'content-type': 'application/x-www-form-urlencoded' })
      .send('token=x&password=y');
    expect(form.status).toBe(415);
    const missing = await confirm({ token: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'validation.failed' });
  });
});
