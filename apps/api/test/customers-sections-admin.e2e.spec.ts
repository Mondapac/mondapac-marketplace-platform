import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CUSTOMER_LIST_READER } from '../src/modules/customers/application/ports/customer-list.reader';
import { CUSTOMER_TIMELINE_REPOSITORY } from '../src/modules/customers/application/ports/customer-timeline.repository';
import { InMemoryCustomerList } from '../src/modules/customers/application/testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from '../src/modules/customers/application/testing/in-memory-customer-management';
import type { CustomerListRow } from '../src/modules/customers/domain/customer-list';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The customer page's sections over HTTP (customers management phase 2b): the real guards, gate,
// controllers, customers' use cases and identity's facade on the identity fakes; the list and the
// timeline in memory. Proves the keys (customers.customers.view alone reaches no section; the
// reveal needs its protected key), CSRF on every POST, the closed bodies, `no-store`, that the
// sign-ins carry no address, the reveal's audit row and timeline entry, "sign out everywhere",
// "send password reset" and the export's step-up, in both Markets; the per-admin reveal limit's
// 429 request.throttled with Retry-After and its bulk-reveal events, and the password reset's
// limit and 429 (security review of #969).

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SECURITY = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const BUYER = id<'Account'>(0xa201);
const ROLE = id<'Role'>(0xe001);
const VIEW_ROLE = id<'Role'>(0xe002);
const KEYS = [
  'customers.customers.view',
  'customers.customers.export',
  'identity.customer-sign-in.view',
  'identity.customer-sign-in.reveal',
  'identity.customer-session.end',
  'identity.customer-password-reset.send',
];
const EXPORT_STEP_UP = 'customers.customers.export';
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('customer page sections over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let timeline: InMemoryCustomerTimeline;
  const http = () => request(app!.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];

  const row = (accountId: Id<'Account'>): CustomerListRow => ({
    accountId,
    email: 'buyer@example.test',
    groups: [],
    displayName: 'Buyer',
    status: 'active',
    emailVerified: true,
    signedUpAt: START,
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
  });

  const account = (accountId: Id<'Account'>, population: 'admin' | 'customer', label: string) =>
    fakes.seedAccount({
      id: accountId,
      marketId,
      population,
      email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
      displayName: label,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });

  async function boot() {
    const list = new InMemoryCustomerList();
    list.add(market, row(BUYER));
    timeline = new InMemoryCustomerTimeline(list);
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CUSTOMER_LIST_READER)
          .useValue(list)
          .overrideProvider(CUSTOMER_TIMELINE_REPOSITORY)
          .useValue(timeline),
    }));
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'sections-seed'), {});
    const role = (roleId: Id<'Role'>, keys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Sections ${keys.length}`,
        permissionKeys: keys,
        version: 1,
        createdAt: START,
      });
    role(ROLE, KEYS);
    role(VIEW_ROLE, ['customers.customers.view']);
    account(SECURITY, 'admin', 'security');
    account(VIEWER, 'admin', 'viewer');
    account(BUYER, 'customer', 'buyer');
    for (const [n, accountId, roleId] of [
      [1, SECURITY, ROLE],
      [2, VIEWER, VIEW_ROLE],
    ] as const) {
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    // The seed's own audit rows are not this suite's subject.
    fakes.audits.length = 0;
  }

  function sessionOf(n: number, accountId: Id<'Account'>, population: 'admin' | 'customer') {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId,
        population,
        sellerId: null,
        transport: 'cookie',
        device: population === 'customer' ? 'safari.ios' : null,
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  async function signIn(n: number, outcome: string, hoursAgo: number): Promise<Id<'SignInRecord'>> {
    const recordId = id<'SignInRecord'>(0x5000 + n);
    await fakes.recordRepository.add(market, {
      id: recordId,
      population: 'customer',
      accountId: BUYER,
      outcome,
      occurredAt: START.subtract({ hours: hoursAgo }),
      address: `203.0.113.${n}`,
      sessionId: null,
      correlationId: 'sign-in',
      device: 'chrome.windows',
    });
    return recordId;
  }

  const base = `/customers/admin/customers/${BUYER}`;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lists the sign-ins without an address, and refuses an admin without identity’s key', async () => {
    await boot();
    await signIn(1, 'signed-in', 1);
    await signIn(2, 'password.incorrect', 2);
    const admin = sessionOf(1, SECURITY, 'admin');

    const listed = await http()
      .post(`${base}/sign-ins`)
      .set(admin)
      .send({ filters: { result: ['success', 'failure'] }, paging: 'pages' });
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toMatchObject({ total: 2, page: 1, hasNext: false });
    expect(
      (listed.body as { items: { result: string; device: string; city: null }[] }).items.map(
        (item) => [item.result, item.device, item.city],
      ),
    ).toEqual([
      ['success', 'chrome.windows', null],
      ['failure', 'chrome.windows', null],
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('203.0.113');

    const viewer = sessionOf(2, VIEWER, 'admin');
    const denied = await http().post(`${base}/sign-ins`).set(viewer).send({});
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'access.denied' });
    const stray = await http().post(`${base}/sign-ins`).set(admin).send({ accountId: BUYER });
    expect(stray.status).toBe(400);
    const unknown = await http()
      .post(`/customers/admin/customers/${id(0xa999)}/sign-ins`)
      .set(admin)
      .send({});
    expect(unknown.status).toBe(404);
  });

  it('reveals one sign-in’s address under the protected key, audited and on the timeline', async () => {
    await boot();
    const signInId = await signIn(3, 'signed-in', 1);
    const viewer = sessionOf(2, VIEWER, 'admin');
    expect(
      (await http().post(`${base}/sign-ins/${signInId}/reveal`).set(viewer).send({})).status,
    ).toBe(403);
    const admin = sessionOf(1, SECURITY, 'admin');
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin;
    void _csrf;
    expect(
      (await http().post(`${base}/sign-ins/${signInId}/reveal`).set(noCsrf).send({})).status,
    ).toBe(403);
    expect(fakes.audits).toEqual([]);

    const shown = await http().post(`${base}/sign-ins/${signInId}/reveal`).set(admin).send({});
    expect(shown.status).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toEqual({
      signInId,
      address: '203.0.113.3',
      occurredAt: START.subtract({ hours: 1 }).toString(),
    });
    expect(fakes.audits.map((audit) => [audit.action, audit.targetId])).toEqual([
      ['identity.account.sign-in-address-revealed', BUYER],
    ]);
    const entries = await timeline.page(
      market,
      { accountId: BUYER, kinds: null, from: null, to: null },
      'desc',
      { offset: 0, limit: 10 },
    );
    expect(entries.map((entry) => [entry.kind, entry.actorAccountId])).toEqual([
      ['sign-in-address-revealed', SECURITY],
    ]);

    const missing = await http()
      .post(`${base}/sign-ins/${id(0x5999)}/reveal`)
      .set(admin)
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'customers.sign-in-not-found' });
    const body = await http()
      .post(`${base}/sign-ins/${signInId}/reveal`)
      .set(admin)
      .send({ accountId: BUYER });
    expect(body.status).toBe(400);
  });

  it('answers 429 request.throttled with Retry-After past the admin’s reveal limit, and raises one alert', async () => {
    await boot();
    const signInId = await signIn(5, 'signed-in', 1);
    const limits = app!.get(MarketRegistry).get(market.marketId).customers!.adminActionLimits;
    const admin = sessionOf(1, SECURITY, 'admin');
    const reveal = () => http().post(`${base}/sign-ins/${signInId}/reveal`).set(admin).send({});
    for (let index = 0; index < limits.piiRevealsPerHour; index += 1) {
      expect((await reveal()).status).toBe(200);
    }

    const refused = await reveal();
    expect(refused.status).toBe(429);
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.body).toEqual({
      statusCode: 429,
      code: 'request.throttled',
      details: { retryAfterSeconds: expect.any(Number) as number },
    });
    const seconds = (refused.body as { details: { retryAfterSeconds: number } }).details
      .retryAfterSeconds;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(3600);
    expect(refused.headers['retry-after']).toBe(String(seconds));
    expect(JSON.stringify(refused.body)).not.toContain('203.0.113');
    // Only the admitted reveals were audited. From the alert count on, each admitted reveal
    // recorded the bulk-reveal event naming the admin (one alert per admin in the security centre).
    expect(fakes.audits).toHaveLength(limits.piiRevealsPerHour);
    const bulk = fakes.recordedSecurityEvents.filter(
      (event) => event.type === 'customers.pii-reveal.bulk' && event.marketId === code,
    );
    expect(bulk.map((event) => event.payload)).toEqual(
      Array.from(
        { length: limits.piiRevealsPerHour - limits.piiRevealAlertAt + 1 },
        (_, index) => ({ reveals: limits.piiRevealAlertAt + index }),
      ),
    );
    expect(new Set(bulk.map((event) => `${event.targetId}|${event.actor}`))).toEqual(
      new Set([`${SECURITY}|authenticated`]),
    );
  });

  it('answers 429 request.throttled with Retry-After past the admin’s password reset limit', async () => {
    await boot();
    const limit = app!.get(MarketRegistry).get(market.marketId).customers!.adminActionLimits
      .passwordResetsPerHour;
    const admin = sessionOf(1, SECURITY, 'admin');
    const reset = () => http().post(`${base}/password-reset`).set(admin).send({});
    // The first sends the mail; identity refuses the repeats within five minutes, and every one
    // of them still counts towards the admin's hour.
    expect((await reset()).status).toBe(200);
    for (let index = 1; index < limit; index += 1) {
      const repeat = await reset();
      expect(repeat.status).toBe(429);
      expect(repeat.body).toMatchObject({ code: 'customers.password-reset-recently-requested' });
      expect(repeat.headers['retry-after']).toBeUndefined();
    }

    const refused = await reset();
    expect(refused.status).toBe(429);
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.body).toEqual({
      statusCode: 429,
      code: 'request.throttled',
      details: { retryAfterSeconds: expect.any(Number) as number },
    });
    const seconds = (refused.body as { details: { retryAfterSeconds: number } }).details
      .retryAfterSeconds;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(3600);
    expect(refused.headers['retry-after']).toBe(String(seconds));
    expect(fakes.audits.map((audit) => audit.action)).toEqual([
      'identity.account.password-reset-sent-by-admin',
    ]);

    // Another admin is not affected by the first one's count.
    const viewerKeys = sessionOf(2, VIEWER, 'admin');
    expect((await http().post(`${base}/password-reset`).set(viewerKeys).send({})).status).toBe(403);
  });

  it('lists the live sessions and signs the customer out everywhere', async () => {
    await boot();
    sessionOf(10, BUYER, 'customer');
    sessionOf(11, BUYER, 'customer');
    const admin = sessionOf(1, SECURITY, 'admin');

    const listed = await http().get(`${base}/sessions`).set(admin);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toMatchObject({ more: false });
    expect((listed.body as { items: { device: string }[] }).items).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toMatch(/sessionId|token/);

    const viewer = sessionOf(2, VIEWER, 'admin');
    expect((await http().post(`${base}/sessions/end`).set(viewer).send({})).status).toBe(403);
    const ended = await http().post(`${base}/sessions/end`).set(admin).send({});
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ revokedSessions: 2 });
    expect(fakes.audits.map((audit) => audit.action)).toEqual([
      'identity.account.sessions-ended-by-admin',
    ]);
    const after = await http().get(`${base}/sessions`).set(admin);
    expect(after.body).toMatchObject({ items: [] });
  });

  it('sends the password reset once, and refuses a second within five minutes', async () => {
    await boot();
    const admin = sessionOf(1, SECURITY, 'admin');
    const sent = await http().post(`${base}/password-reset`).set(admin).send({});
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: true });
    expect(JSON.stringify(sent.body)).not.toMatch(/token|link/i);
    const again = await http().post(`${base}/password-reset`).set(admin).send({});
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: 'customers.password-reset-recently-requested' });
    expect(fakes.audits.map((audit) => audit.action)).toEqual([
      'identity.account.password-reset-sent-by-admin',
    ]);
  });

  it('asks a fresh two-step proof for the sign-ins export, and writes the file with it', async () => {
    await boot();
    await signIn(4, 'signed-in', 1);
    const admin = sessionOf(1, SECURITY, 'admin');
    const refused = await http().post(`${base}/sign-ins/export`).set(admin).send({ format: 'csv' });
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toMatch(/^second-factor\./);

    fakes.factors.set(SECURITY, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: SECURITY,
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
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf101)}|${EXPORT_STEP_UP}`, clock.now());
    const file = await http().post(`${base}/sign-ins/export`).set(admin).send({ format: 'csv' });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.text).toContain('chrome.windows');
    expect(file.text).not.toContain('203.0.113');
    expect(fakes.audits.map((audit) => audit.action)).toContain(
      'customers.customer-section.exported',
    );
  });
});
