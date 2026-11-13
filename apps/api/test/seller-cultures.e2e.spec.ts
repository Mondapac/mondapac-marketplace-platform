import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CATALOG_CULTURES_FACADE, type CatalogCultureSummary } from '../src/modules/catalog';
import { CERTIFICATION_FACADE } from '../src/modules/certification';
import {
  SELLER_CULTURE_REPOSITORY,
  type SellerCultureRepository,
} from '../src/modules/sellers/application/ports/seller-culture.repository';
import { SELLER_FILE_REPOSITORY } from '../src/modules/sellers/application/ports/seller-file.repository';
import type { SellerCultureState } from '../src/modules/sellers/domain/seller-culture';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// A seller's culture memberships over HTTP (multi-culture package 2; ADR-0047 decision 3, ADR-0048):
// `GET` and `POST /sellers/own-cultures` and, for a reviewer, `GET /sellers/admin/:sellerId/cultures`
// and `POST .../cultures/:cultureId/decision` with the real guards, controllers, gate and use cases
// on both Market fixtures. Identity's database ports are in-memory fakes; the membership store,
// the seller files and the catalog and certification contracts are stubs (the SQL is
// test/db/seller-cultures.db-spec.ts).

const PASSWORD = 'correct horse battery staple';
const START = Temporal.Instant.from('2026-11-02T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const sellerId = (n: number) => id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`);
const cultureId = (n: number) => id<'Culture'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CUSTOMER = accountId(3);
const SUPPORT = accountId(4);
const SELLER_SESSION_ACCOUNT = accountId(6);
const FINANCE = accountId(7);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

class StubMemberships implements SellerCultureRepository {
  sellers = new Set<string>();
  rows = new Map<string, SellerCultureState>();
  private k = (m: MarketContext, s: string, c: string) => `${m.marketId}|${s}|${c}`;
  forSeller(m: MarketContext, seller: Id<'Seller'>) {
    return Promise.resolve(
      [...this.rows].filter(([k]) => k.startsWith(`${m.marketId}|${seller}|`)).map(([, v]) => v),
    );
  }
  among(m: MarketContext, seller: Id<'Seller'>, cultureIds: readonly Id<'Culture'>[]) {
    const found = new Map<Id<'Culture'>, SellerCultureState>();
    for (const c of cultureIds) {
      const row = this.rows.get(this.k(m, seller, c));
      if (row) found.set(c, row);
    }
    return Promise.resolve(found as ReadonlyMap<Id<'Culture'>, SellerCultureState>);
  }
  approvedForSellers(m: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const answer = new Map<Id<'Seller'>, Id<'Culture'>[]>();
    for (const [k, v] of this.rows) {
      if (!k.startsWith(`${m.marketId}|`) || v.status !== 'approved') continue;
      if (!sellerIds.includes(v.sellerId)) continue;
      answer.set(v.sellerId, [...(answer.get(v.sellerId) ?? []), v.cultureId]);
    }
    return Promise.resolve(answer as ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>);
  }
  sellerIdsWithoutCultures() {
    return Promise.resolve([]);
  }
  approvedIn(m: MarketContext, cultureId: Id<'Culture'>, limit: number) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(
          ([k, v]) =>
            k.startsWith(`${m.marketId}|`) && v.cultureId === cultureId && v.status === 'approved',
        )
        .map(([, v]) => v)
        .slice(0, limit),
    );
  }
  hasApproved(m: MarketContext, cultureId: Id<'Culture'>) {
    return Promise.resolve(
      [...this.rows].some(
        ([k, v]) =>
          k.startsWith(`${m.marketId}|`) && v.cultureId === cultureId && v.status === 'approved',
      ),
    );
  }
  insert(m: MarketContext, state: SellerCultureState) {
    const key = this.k(m, state.sellerId, state.cultureId);
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, state);
    return Promise.resolve(true);
  }
  transition(
    m: MarketContext,
    state: SellerCultureState,
    expected: { version: number; status: string },
  ) {
    const key = this.k(m, state.sellerId, state.cultureId);
    const now = this.rows.get(key);
    if (now?.version !== expected.version || now.status !== expected.status) {
      return Promise.resolve(false);
    }
    this.rows.set(key, state);
    return Promise.resolve(true);
  }
}

describe('seller cultures over HTTP (integration, multi-culture package 2)', () => {
  let app: NestExpressApplication;
  const memberships = new StubMemberships();
  const cultures = new Map<string, CatalogCultureSummary>();
  const certificates = { held: new Set<string>(), down: false };
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SELLER_CULTURE_REPOSITORY)
          .useValue(memberships)
          .overrideProvider(SELLER_FILE_REPOSITORY)
          .useValue({
            existingIds: (market: MarketContext, ids: readonly Id<'Seller'>[]) =>
              Promise.resolve(
                new Set(ids.filter((one) => memberships.sellers.has(`${market.marketId}|${one}`))),
              ),
          })
          .overrideProvider(CATALOG_CULTURES_FACADE)
          .useValue({
            culturesByIds: (_c: unknown, ids: readonly Id<'Culture'>[]) =>
              Promise.resolve(
                ok(ids.filter((one) => cultures.has(one)).map((one) => cultures.get(one)!)),
              ),
            activeCultures: () =>
              Promise.resolve(ok([...cultures.values()].filter((c) => c.status === 'active'))),
          })
          .overrideProvider(CERTIFICATION_FACADE)
          .useValue({
            sellerValidCertificateTypes: (
              _c: unknown,
              ids: readonly string[],
              typeCodes: readonly string[],
            ) =>
              Promise.resolve(
                certificates.down
                  ? { ok: false, error: { code: 'certification.unavailable' } }
                  : ok(
                      ids.map((one) => ({
                        sellerId: one,
                        validTypeCodes: [...certificates.held].filter((t) => typeCodes.includes(t)),
                      })),
                    ),
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'acts-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: population === 'customer' ? null : `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    // The Viewer default role does not hold the seller-review key.
    admin(2, VIEWER, 'viewer');
    // The Finance default role holds no seller-review key.
    admin(7, FINANCE, 'finance');
    // The Onboarding and Compliance default role holds the seller-review key.
    admin(4, SUPPORT, 'onboarding-compliance');
    // Every admin has an active second factor, for the admin step-up of the replace route.
    for (const [n, accountOf] of [
      [1, ROOT],
      [2, VIEWER],
      [4, SUPPORT],
      [7, FINANCE],
    ] as const) {
      fakes.factors.set(accountOf, {
        id: id<'SecondFactor'>(`01990000-0000-7000-8000-${n12(0xf300 + n)}`),
        marketId,
        accountId: accountOf,
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
    account(3, CUSTOMER, 'customer');
    account(6, SELLER_SESSION_ACCOUNT, 'seller');
  }

  function sessionHeaders(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' | 'seller' = 'admin',
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf200 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? sellerId(1) : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  /** Signs a seller up for real, confirms the email, and answers its session and its id. */
  async function signedInSeller(code: string) {
    const headers = { 'x-market-id': code, ...panelHeaders(code, 'seller') };
    const system = testCallContext(marketOf(code), 'system', 'cultures-0001');
    await http()
      .post('/identity/seller/sign-up')
      .set(headers)
      .send({ displayName: 'Amina Rahman', email: 'Owner@Example.com', password: PASSWORD })
      .expect(202);
    const link = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = link.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(system, {
      delivery: {
        eventId:
          `0199dddd-0000-7000-8000-${String(fakes.mails.length + 1).padStart(12, '0')}` as Id<'event'>,
        subscriber: 'identity.link-mail',
        attempt: 1,
      },
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: 'verify-email',
      aggregateVersion: link.aggregateVersion,
    });
    const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const confirmed = await http()
      .post('/identity/seller/confirm-email')
      .set(headers)
      .send({ token, password: PASSWORD })
      .expect(200);
    const registered = fakes.events.find((e) => e.type === 'identity.seller-registered.v1')!;
    const [cookie] = confirmed.headers['set-cookie'] as unknown as string[];
    return {
      sellerId: (registered.payload as { sellerId: Id<'Seller'> }).sellerId,
      headers: {
        cookie: cookie!.split(';', 1)[0]!,
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  type CulturesBody = { cultures: { cultureCode: string; certificate?: string }[] };
  const bodyOf = (response: { body: unknown }): CulturesBody => response.body as CulturesBody;
  const ownRoute = '/sellers/own-cultures';
  const adminRoute = (seller: string) => `/sellers/admin/${seller}/cultures`;
  const decisionRoute = (seller: string, culture: string) =>
    `${adminRoute(seller)}/${culture}/decision`;
  const as = (code: string, population: 'admin' | 'seller') =>
    ({ 'x-market-id': code, ...panelHeaders(code, population) }) as Record<string, string>;
  const addCulture = (n: number, codeOf: string, extra: Partial<CatalogCultureSummary> = {}) =>
    cultures.set(cultureId(n), {
      id: cultureId(n),
      code: codeOf,
      status: 'active',
      displayOrder: n,
      requiredCertificationType: null,
      isDefault: false,
      names: { en: codeOf },
      ...extra,
    });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    memberships.sellers = new Set();
    memberships.rows = new Map();
    cultures.clear();
    certificates.held.clear();
    certificates.down = false;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the four routes and their bodies in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths['/sellers/own-cultures']).toHaveProperty('get');
    expect(document.paths['/sellers/own-cultures']).toHaveProperty('post');
    expect(document.paths['/sellers/admin/{sellerId}/cultures']).toHaveProperty('get');
    expect(
      document.paths['/sellers/admin/{sellerId}/cultures/{cultureId}/decision'],
    ).toHaveProperty('post');
    for (const schema of [
      'SellerCulturesRequestBody',
      'RequestedCulturesBody',
      'SellerCulturesBody',
      'SellerCultureDecisionRequest',
      'SellerCultureDecisionBody',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const certType = code === 'AU' ? 'halal' : 'kosher';

    it('lets a seller request several cultures, then a reviewer see and decide them', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'plain');
      addCulture(2, 'certified', { requiredCertificationType: certType });
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);

      const requested = await http()
        .post(ownRoute)
        .set({ ...as(code, 'seller'), ...seller.headers })
        .send({ cultureIds: [cultureId(1), cultureId(2)] });
      expect(requested.status).toBe(201);
      expect(requested.headers['cache-control']).toBe('no-store');
      expect(bodyOf(requested).cultures).toMatchObject([
        {
          cultureCode: 'plain',
          status: 'requested',
          outcome: 'requested',
          needsCertificate: false,
        },
        {
          cultureCode: 'certified',
          status: 'requested',
          needsCertificate: true,
          requiredCertificationType: certType,
        },
      ]);

      const mine = await http()
        .get(ownRoute)
        .set({ ...as(code, 'seller'), cookie: seller.headers.cookie });
      expect(mine.status).toBe(200);
      expect(bodyOf(mine).cultures).toHaveLength(2);

      const reviewer = sessionHeaders(code, SUPPORT, 4);
      const listed = await http()
        .get(adminRoute(seller.sellerId))
        .set({ ...as(code, 'admin'), cookie: reviewer.cookie });
      expect(listed.status).toBe(200);
      const certified = bodyOf(listed).cultures.find(
        (c: { cultureCode: string }) => c.cultureCode === 'certified',
      );
      expect(certified).toMatchObject({ certificate: 'missing', needsCertificate: true });

      const refused = await http()
        .post(decisionRoute(seller.sellerId, cultureId(2)))
        .set({ ...as(code, 'admin'), ...reviewer })
        .send({ decision: 'approve' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'culture.certificate-required',
        details: { requiredCertificationType: certType },
      });

      certificates.held.add(certType);
      const approved = await http()
        .post(decisionRoute(seller.sellerId, cultureId(2)))
        .set({ ...as(code, 'admin'), ...reviewer })
        .send({ decision: 'approve' });
      expect(approved.status).toBe(200);
      expect((approved.body as { culture: unknown }).culture).toMatchObject({
        status: 'approved',
        version: 2,
      });

      const second = await http()
        .post(decisionRoute(seller.sellerId, cultureId(2)))
        .set({ ...as(code, 'admin'), ...reviewer })
        .send({ decision: 'reject', reason: 'Too late' });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'culture.not-requested' });
    });

    it('answers a clear 400 for an inactive or unknown culture, an empty list and a bad body', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'old', { status: 'inactive' });
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);
      const post = (body: unknown) =>
        http()
          .post(ownRoute)
          .set({ ...as(code, 'seller'), ...seller.headers })
          .send(body as object);

      const inactive = await post({ cultureIds: [cultureId(1), cultureId(9)] });
      expect(inactive.status).toBe(400);
      expect(inactive.body).toMatchObject({
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'cultureIds.0', code: 'not-active' },
            { path: 'cultureIds.1', code: 'not-active' },
          ],
        },
      });
      expect((await post({ cultureIds: [] })).status).toBe(400);
      expect((await post({ cultureIds: [cultureId(1)], extra: true })).status).toBe(400);
      expect(memberships.rows.size).toBe(0);
    });

    it('refuses a rejection without a reason and records the reason it is given', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'plain');
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);
      await http()
        .post(ownRoute)
        .set({ ...as(code, 'seller'), ...seller.headers })
        .send({ cultureIds: [cultureId(1)] })
        .expect(201);
      const reviewer = sessionHeaders(code, ROOT, 1);
      const decide = (body: unknown) =>
        http()
          .post(decisionRoute(seller.sellerId, cultureId(1)))
          .set({ ...as(code, 'admin'), ...reviewer })
          .send(body as object);

      expect((await decide({ decision: 'reject' })).status).toBe(400);
      const rejected = await decide({ decision: 'reject', reason: 'Not in the standard' });
      expect(rejected.status).toBe(200);
      const mine = await http()
        .get(ownRoute)
        .set({ ...as(code, 'seller'), cookie: seller.headers.cookie });
      expect(bodyOf(mine).cultures[0]).toMatchObject({
        status: 'rejected',
        reason: 'Not in the standard',
      });
    });

    it('keeps a seller to its own cultures and away from the reviewer routes', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'plain');
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);
      // A seller route under an admin or customer session, and the reviewer routes under a seller
      // session or an admin without the seller-review key, are all refused.
      const adminSession = sessionHeaders(code, ROOT, 1);
      expect(
        (
          await http()
            .get(ownRoute)
            .set({ ...as(code, 'seller'), cookie: adminSession.cookie })
        ).status,
      ).toBeGreaterThanOrEqual(401);
      expect(
        (
          await http()
            .get(adminRoute(seller.sellerId))
            .set({ ...as(code, 'admin'), cookie: seller.headers.cookie })
        ).status,
      ).toBeGreaterThanOrEqual(401);
      for (const [n, account] of [
        [2, VIEWER],
        [7, FINANCE],
      ] as const) {
        const headers = sessionHeaders(code, account, 10 + n);
        const read = await http()
          .get(adminRoute(seller.sellerId))
          .set({ ...as(code, 'admin'), cookie: headers.cookie });
        const decide = await http()
          .post(decisionRoute(seller.sellerId, cultureId(1)))
          .set({ ...as(code, 'admin'), ...headers })
          .send({ decision: 'approve' });
        expect([read.status, decide.status]).toEqual([403, 403]);
      }
      // Without a session.
      expect((await http().get(ownRoute).set(as(code, 'seller'))).status).toBe(401);
      expect(
        (await http().post(ownRoute).set(as(code, 'seller')).send({})).status,
      ).toBeGreaterThanOrEqual(401);
      // Without the CSRF header the write is refused and nothing is stored.
      const noCsrf = await http()
        .post(ownRoute)
        .set({ ...as(code, 'seller'), cookie: seller.headers.cookie })
        .send({ cultureIds: [cultureId(1)] });
      expect(noCsrf.status).toBe(403);
      expect(memberships.rows.size).toBe(0);
    });

    it("treats another Market's seller and an unknown seller as not found for the reviewer", async () => {
      await boot();
      await seeded(code);
      memberships.sellers.add(`${other}|${sellerId(2)}`);
      const reviewer = sessionHeaders(code, ROOT, 12);
      for (const target of [sellerId(2), sellerId(3), 'not-an-id']) {
        const read = await http()
          .get(adminRoute(target))
          .set({ ...as(code, 'admin'), cookie: reviewer.cookie });
        expect(read.status).toBe(404);
        expect(read.body).toMatchObject({ code: 'file.not-found' });
      }
    });

    it('refuses an approval for an expired or a wrong-type certificate, and a decision on another Market (package 3a)', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'certified', { requiredCertificationType: certType });
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);
      await http()
        .post(ownRoute)
        .set({ ...as(code, 'seller'), ...seller.headers })
        .send({ cultureIds: [cultureId(1)] })
        .expect(201);
      const reviewer = sessionHeaders(code, ROOT, 2);
      const decide = (target: string) =>
        http()
          .post(decisionRoute(target, cultureId(1)))
          .set({ ...as(code, 'admin'), ...reviewer })
          .send({ decision: 'approve' });

      // An expired certificate is no longer "valid": certification answers no type for it.
      certificates.held.clear();
      const expired = await decide(seller.sellerId);
      expect(expired.status).toBe(409);
      expect(expired.body).toMatchObject({
        code: 'culture.certificate-required',
        details: { requiredCertificationType: certType },
      });

      // A valid certificate of another type never stands in for the required one.
      certificates.held.add(code === 'AU' ? 'kosher' : 'halal');
      const wrongType = await decide(seller.sellerId);
      expect(wrongType.status).toBe(409);
      expect(wrongType.body).toMatchObject({ code: 'culture.certificate-required' });
      expect([...memberships.rows.values()][0]!.status).toBe('requested');

      // A seller of the other Market is not found, even with a valid certificate of the type.
      certificates.held.add(certType);
      memberships.sellers.add(`${other}|${sellerId(5)}`);
      const foreign = await decide(sellerId(5));
      expect(foreign.status).toBe(404);
      expect([...memberships.rows.values()]).toHaveLength(1);
    });

    it('fails closed with 503 when the certificate cannot be read', async () => {
      await boot();
      await seeded(code);
      addCulture(1, 'certified', { requiredCertificationType: certType });
      const seller = await signedInSeller(code);
      memberships.sellers.add(`${code}|${seller.sellerId}`);
      await http()
        .post(ownRoute)
        .set({ ...as(code, 'seller'), ...seller.headers })
        .send({ cultureIds: [cultureId(1)] })
        .expect(201);
      certificates.down = true;
      certificates.held.add(certType);
      const reviewer = sessionHeaders(code, ROOT, 1);
      const answer = await http()
        .post(decisionRoute(seller.sellerId, cultureId(1)))
        .set({ ...as(code, 'admin'), ...reviewer })
        .send({ decision: 'approve' });
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ code: 'culture.certificate-unavailable' });
      expect([...memberships.rows.values()][0]!.status).toBe('requested');
    });
  });
});
