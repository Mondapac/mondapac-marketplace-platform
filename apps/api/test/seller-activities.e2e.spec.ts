import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CATALOG_ACTIVITIES_FACADE } from '../src/modules/catalog';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import {
  SELLER_BUSINESS_ACTIVITY_REPOSITORY,
  type ActivityChangeRecord,
  type SellerBusinessActivityRepository,
} from '../src/modules/sellers/application/ports/seller-business-activity.repository';
import { SELLER_FILE_REPOSITORY } from '../src/modules/sellers/application/ports/seller-file.repository';
import type { StoredActivityAssignment } from '../src/modules/sellers/domain/seller-business-activities';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin routes of a seller's business activities over HTTP (ADR-0040 decision 4; package 4a):
// `GET` and `PUT /sellers/admin/:sellerId/business-activities` with the real guards, controller,
// gate and use cases on both Market fixtures. Identity's database ports are in-memory fakes; the
// assignment store, the seller files and catalog's contract are recording stubs (the SQL is
// test/db/seller-business-activities.db-spec.ts).

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
const activityId = (n: number) =>
  id<'BusinessActivity'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CUSTOMER = accountId(3);
const SUPPORT = accountId(4);
const SELLER_SESSION_ACCOUNT = accountId(6);
const FINANCE = accountId(7);
const CANARY = 'canary-reason-wombat';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

class StubAssignments implements SellerBusinessActivityRepository {
  sellers = new Set<string>();
  held = new Map<string, StoredActivityAssignment>();
  log: { sellerId: string; reason: string; at: Temporal.Instant; by: Id<'Account'> }[] = [];

  lock(market: MarketContext, seller: Id<'Seller'>) {
    return Promise.resolve(this.sellers.has(`${market.marketId}|${seller}`));
  }
  find(market: MarketContext, ids: readonly Id<'Seller'>[]) {
    const found = new Map<Id<'Seller'>, StoredActivityAssignment>();
    for (const one of ids) {
      const row = this.held.get(`${market.marketId}|${one}`);
      if (row !== undefined) found.set(one, row);
    }
    return Promise.resolve(found as ReadonlyMap<Id<'Seller'>, StoredActivityAssignment>);
  }
  replace(
    market: MarketContext,
    seller: Id<'Seller'>,
    next: {
      mainActivityId: Id<'BusinessActivity'>;
      extraActivityIds: readonly Id<'BusinessActivity'>[];
    },
  ) {
    this.held.set(`${market.marketId}|${seller}`, {
      mainActivityId: next.mainActivityId,
      extraActivityIds: next.extraActivityIds,
    });
    return Promise.resolve();
  }
  appendChange(
    _market: MarketContext,
    entry: Parameters<SellerBusinessActivityRepository['appendChange']>[1],
  ) {
    this.log.push({ sellerId: entry.sellerId, reason: entry.reason, at: entry.at, by: entry.by });
    return Promise.resolve();
  }
  lastChange(_market: MarketContext, seller: Id<'Seller'>): Promise<ActivityChangeRecord | null> {
    const last = this.log.filter((l) => l.sellerId === seller).at(-1);
    return Promise.resolve(
      last === undefined ? null : { changedBy: last.by, changedAt: last.at, reason: last.reason },
    );
  }
}

describe('seller business activities over HTTP (integration, package 4a)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const assignments = new StubAssignments();
  const activeActivities = new Set<string>();
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SELLER_BUSINESS_ACTIVITY_REPOSITORY)
          .useValue(assignments)
          .overrideProvider(SELLER_FILE_REPOSITORY)
          .useValue({
            existingIds: (market: MarketContext, ids: readonly Id<'Seller'>[]) =>
              Promise.resolve(
                new Set(ids.filter((one) => assignments.sellers.has(`${market.marketId}|${one}`))),
              ),
          })
          .overrideProvider(CATALOG_ACTIVITIES_FACADE)
          .useValue({
            activeBusinessActivityIds: (_c: unknown, ids: readonly Id<'BusinessActivity'>[]) =>
              Promise.resolve(ok(new Set(ids.filter((one) => activeActivities.has(one))))),
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
    // The Viewer default role holds the read key (seed version 25) and not the manage key.
    admin(2, VIEWER, 'viewer');
    // The Finance default role holds neither activity key.
    admin(7, FINANCE, 'finance');
    // A custom platform role with the read key alone.
    const viewOnly = id<'Role'>(`01990000-0000-7000-8000-${n12(0xe100)}`);
    fakes.seedRole({
      id: viewOnly,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      permissionKeys: ['sellers.business-activity.view'],
      version: 1,
      createdAt: START,
    });
    account(4, SUPPORT, 'admin');
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + 4)}`),
      marketId,
      accountId: SUPPORT,
      roleId: viewOnly,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
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
    { proved = true } = {},
  ) {
    const issued = tokens.issue();
    if (population === 'admin' && proved) {
      // A fresh step-up proof of this session for the replace action (identity's verify route).
      fakes.stepUpProofs.set(
        `${code}|01990000-0000-7000-8000-${n12(0xf200 + n)}|sellers.business-activity.change`,
        clock.now(),
      );
    }
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

  const route = (seller: Id<'Seller'>) => `/sellers/admin/${seller}/business-activities`;
  const get = (code: string, seller: Id<'Seller'>, headers: Record<string, string> | null) => {
    const call = http()
      .get(route(seller))
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return headers === null ? call : call.set('cookie', headers.cookie!);
  };
  const put = (
    code: string,
    seller: Id<'Seller'>,
    headers: Record<string, string> | null,
    body: unknown,
    { csrf = true } = {},
  ) => {
    const call = http()
      .put(route(seller))
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    if (headers === null) return call.send(body as object);
    return call
      .set('cookie', headers.cookie!)
      .set(csrf ? { 'x-csrf-token': headers['x-csrf-token']! } : {})
      .send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    assignments.sellers = new Set();
    assignments.held = new Map();
    assignments.log = [];
    activeActivities.clear();
    for (const n of [1, 2, 3]) activeActivities.add(activityId(n));
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents both routes and their bodies in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    const path = document.paths['/sellers/admin/{sellerId}/business-activities'];
    expect(path).toHaveProperty('get');
    expect(path).toHaveProperty('put');
    for (const schema of [
      'SellerActivitiesRequest',
      'SellerActivitiesBody',
      'SellerActivitiesChangeBody',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((m) => m !== code)!;

    it('reads an empty assignment, replaces it, and reads it back with the reason', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);

      const empty = await get(code, sellerId(1), sessionHeaders(code, ROOT, 1));
      expect(empty.status).toBe(200);
      expect(empty.headers['cache-control']).toBe('no-store');
      expect(empty.body).toEqual({ mainActivityId: null, extraActivityIds: [], lastChange: null });

      const set = await put(code, sellerId(1), sessionHeaders(code, ROOT, 2), {
        mainActivityId: activityId(1),
        extraActivityIds: [activityId(3), activityId(2)],
        reason: CANARY,
      });
      expect(set.status).toBe(200);
      expect(set.headers['cache-control']).toBe('no-store');
      expect(set.body).toEqual({
        mainActivityId: activityId(1),
        extraActivityIds: [activityId(2), activityId(3)],
        changed: true,
      });

      const read = await get(code, sellerId(1), sessionHeaders(code, ROOT, 3));
      expect(read.body).toEqual({
        mainActivityId: activityId(1),
        extraActivityIds: [activityId(2), activityId(3)],
        lastChange: { changedBy: ROOT, changedAt: START.toString(), reason: CANARY },
      });
      // The reason is admin text: it is answered, never logged.
      expect(JSON.stringify(logLines)).not.toContain(CANARY);
      expect(logLines.find((line) => line.msg === 'sellers.seller-activities-set')).toMatchObject({
        marketId: code,
        correlationId: expect.any(String) as unknown,
      });
    });

    it('answers validation.failed with paths and codes only', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);
      const headers = () => sessionHeaders(code, ROOT, 4);

      const noReason = await put(code, sellerId(1), headers(), {
        mainActivityId: activityId(1),
        extraActivityIds: [],
      });
      const inactive = await put(code, sellerId(1), headers(), {
        mainActivityId: activityId(9),
        extraActivityIds: [activityId(1)],
        reason: CANARY,
      });

      expect(noReason.status).toBe(400);
      expect(noReason.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'required' }] },
      });
      expect(inactive.status).toBe(400);
      expect(inactive.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'mainActivityId', code: 'not-active' }] },
      });
      expect(JSON.stringify(inactive.body)).not.toContain(CANARY);
      expect(assignments.held.size).toBe(0);
    });

    it('refuses a visitor, a customer, a seller session and an admin without the key; nothing is written', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);
      const body = { mainActivityId: activityId(1), extraActivityIds: [], reason: 'x' };

      const visitor = await put(code, sellerId(1), null, body);
      const customer = await put(
        code,
        sellerId(1),
        sessionHeaders(code, CUSTOMER, 5, 'customer'),
        body,
      );
      const seller = await put(
        code,
        sellerId(1),
        sessionHeaders(code, SELLER_SESSION_ACCOUNT, 6, 'seller'),
        body,
      );
      const viewer = await put(code, sellerId(1), sessionHeaders(code, VIEWER, 7), body);
      const viewOnly = await put(code, sellerId(1), sessionHeaders(code, SUPPORT, 8), body);

      expect(visitor.status).toBe(401);
      expect(customer.status).toBe(401);
      expect(seller.status).toBe(401);
      expect(viewer.status).toBe(403);
      expect(viewer.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(viewOnly.status).toBe(403);
      expect(assignments.held.size).toBe(0);
      expect(assignments.log).toHaveLength(0);
    });

    it('lets the read key read but not replace, and refuses a read without it', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);

      const read = await get(code, sellerId(1), sessionHeaders(code, SUPPORT, 9));
      const viewerRead = await get(code, sellerId(1), sessionHeaders(code, VIEWER, 10));
      const financeRead = await get(code, sellerId(1), sessionHeaders(code, FINANCE, 16));
      const visitorRead = await get(code, sellerId(1), null);

      expect(read.status).toBe(200);
      // The Viewer role reads every unprotected `view` key, this one included.
      expect(viewerRead.status).toBe(200);
      expect(financeRead.status).toBe(403);
      expect(financeRead.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(visitorRead.status).toBe(401);
    });

    it('needs a fresh two-step proof of the admin session to replace, but not to read', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);
      const unproved = sessionHeaders(code, ROOT, 17, 'admin', { proved: false });

      const refused = await put(code, sellerId(1), unproved, {
        mainActivityId: activityId(1),
        extraActivityIds: [],
        reason: 'x',
      });
      const read = await get(code, sellerId(1), unproved);

      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).not.toBe(404);
      expect(assignments.held.size).toBe(0);
      expect(read.status).toBe(200);
    });

    it('needs the CSRF token to replace', async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${code}|${sellerId(1)}`);

      const refused = await put(
        code,
        sellerId(1),
        sessionHeaders(code, ROOT, 11),
        { mainActivityId: activityId(1), extraActivityIds: [], reason: 'x' },
        { csrf: false },
      );

      expect(refused.status).toBe(403);
      expect(assignments.held.size).toBe(0);
    });

    it("treats another Market's seller and an unknown seller as not found, on read and write", async () => {
      await boot();
      await seeded(code);
      assignments.sellers.add(`${other}|${sellerId(2)}`);
      const body = { mainActivityId: activityId(1), extraActivityIds: [], reason: 'x' };

      const foreignRead = await get(code, sellerId(2), sessionHeaders(code, ROOT, 12));
      const foreignWrite = await put(code, sellerId(2), sessionHeaders(code, ROOT, 13), body);
      const unknown = await put(code, sellerId(3), sessionHeaders(code, ROOT, 14), body);
      const malformed = await get(
        code,
        'not-an-id' as Id<'Seller'>,
        sessionHeaders(code, ROOT, 15),
      );

      for (const answer of [foreignRead, foreignWrite, unknown, malformed]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toMatchObject({ code: 'file.not-found' });
      }
      expect(assignments.held.size).toBe(0);
    });
  });
});
