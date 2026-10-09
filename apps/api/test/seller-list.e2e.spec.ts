import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import {
  SELLER_ACCESS_READER,
  type SellerAccessReader,
} from '../src/modules/sellers/application/ports/seller-access-reader';
import {
  SELLER_LIST_REPOSITORY,
  type ListCounts,
  type ListedSeller,
  type SellerListRepository,
} from '../src/modules/sellers/application/ports/seller-list.repository';
import type { AccessState } from '../src/modules/sellers/domain/seller-status';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin seller list over HTTP (sellers design 6.2, 7.8; slice 6): `POST /sellers/admin/list`
// with the real guards, controller, gate and use case on both Market fixtures. Identity's
// database ports are in-memory fakes; the list's own store and the access reader are recording
// stubs (their SQL is test/db/seller-list.db-spec.ts). Admin sessions are seeded into the fake
// store as in the admin team list spec.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const sellerId = (n: number) => id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CUSTOMER = accountId(3);
const SUPPORT = accountId(4);
const CANARY = 'canary-search-term';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

const emptyCounts: ListCounts = {
  awaitingReview: { onboarding: 0, identityChange: 0 },
  incomplete: 0,
  all: 0,
};

/** Rows per Market; records what the use case asked for. */
class StubList implements SellerListRepository {
  rows = new Map<string, ListedSeller[]>();
  queries: { tab: string; marketId: string; take: number; onlyIds: unknown }[] = [];

  private page(tab: string, market: MarketContext, take: number, onlyIds: unknown) {
    this.queries.push({ tab, marketId: market.marketId, take, onlyIds });
    return Promise.resolve((this.rows.get(market.marketId) ?? []).slice(0, take));
  }
  awaitingReview(market: MarketContext, query: { take: number; onlyIds: unknown }) {
    return this.page('awaiting-review', market, query.take, query.onlyIds);
  }
  incomplete(market: MarketContext, query: { take: number; onlyIds: unknown }) {
    return this.page('incomplete', market, query.take, query.onlyIds);
  }
  all(market: MarketContext, query: { take: number; onlyIds: unknown }) {
    return this.page('all', market, query.take, query.onlyIds);
  }
  counts() {
    return Promise.resolve(emptyCounts);
  }
  searchCandidates() {
    return Promise.resolve({ ids: [sellerId(1)], overflow: false });
  }
}

class StubAccess implements SellerAccessReader {
  calls: (readonly Id<'Seller'>[])[] = [];
  state: AccessState = 'pending';
  failing = false;
  accessOf(): Promise<AccessState | null> {
    return Promise.resolve(this.state);
  }
  accessOfMany(_context: CallContext, ids: readonly Id<'Seller'>[]) {
    this.calls.push(ids);
    if (this.failing) return Promise.reject(new Error('identity down'));
    return Promise.resolve(
      new Map(ids.map((one): [Id<'Seller'>, AccessState] => [one, this.state])),
    );
  }
}

const row = (n: number): ListedSeller => ({
  sellerId: sellerId(n),
  origin: 'self',
  storeName: `Shop ${n}`,
  heldSlug: null,
  draftSlug: `shop-${n}`,
  serviceAreaCode: 'open',
  operatingTimezone: 'Australia/Brisbane',
  draftComplete: true,
  hasApprovedRevision: false,
  hasAddress: true,
  createdAt: START,
  lastChangedAt: START,
  pending: {
    revisionId: id<'BusinessFileRevision'>(`01990000-0000-7000-8000-${n12(0xd000 + n)}`),
    kind: 'onboarding',
    revisionNo: 1,
    submittedAt: START,
  },
});

describe('admin seller list over HTTP (integration, slice 6)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const list = new StubList();
  const access = new StubAccess();
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
          .overrideProvider(SELLER_LIST_REPOSITORY)
          .useValue(list)
          .overrideProvider(SELLER_ACCESS_READER)
          .useValue(access),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'list-0001'), {});
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
    admin(2, VIEWER, 'viewer');
    admin(4, SUPPORT, 'operations-support');
    account(3, CUSTOMER, 'customer');
  }

  function sessionHeaders(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' = 'admin',
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf200 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
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

  const post = (
    code: string,
    headers: Record<string, string> | null,
    body: unknown = {},
    { csrf = true } = {},
  ) => {
    const call = http()
      .post('/sellers/admin/list')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    if (headers === null) return call.send(body as object);
    const { 'x-csrf-token': token, cookie } = headers;
    return call
      .set('cookie', cookie!)
      .set(csrf ? { 'x-csrf-token': token! } : {})
      .send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    list.rows = new Map();
    list.queries = [];
    access.calls = [];
    access.failing = false;
    access.state = 'pending';
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route, its body and the row shape in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, { post?: { requestBody?: unknown } }>;
      components: { schemas: Record<string, unknown> };
    };

    expect(document.paths['/sellers/admin/list']?.post?.requestBody).toBeDefined();
    for (const schema of ['SellerListRequest', 'SellerListBody', 'SellerListRowView']) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the market sellers for an administrator: clear fields, no-store, one identity call', async () => {
      await boot();
      await seeded(code);
      list.rows.set(code, [row(1), row(2)]);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      list.rows.set(other, [row(9)]);

      const listed = await post(code, sessionHeaders(code, ROOT, 1), { limit: 10 });

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const body = listed.body as { tab: string; items: Record<string, unknown>[]; next: unknown };
      expect(body.tab).toBe('awaiting-review');
      expect(body.next).toBeNull();
      expect(body.items.map((item) => item.sellerId)).toEqual([sellerId(1), sellerId(2)]);
      expect(body.items[0]).toEqual({
        sellerId: sellerId(1),
        storeName: 'Shop 1',
        slug: 'shop-1',
        status: 'awaiting-review',
        origin: 'self',
        kind: 'onboarding',
        submittedAt: START.toString(),
        serviceAreaCode: 'open',
        timezone: 'Australia/Brisbane',
        createdAt: START.toString(),
        lastChangedAt: START.toString(),
      });
      expect(list.queries.map((q) => q.marketId)).toEqual([code]);
      expect(access.calls).toEqual([[sellerId(1), sellerId(2)]]);
    });

    it('takes the search from the body, reads candidates, and logs neither the term nor a name', async () => {
      await boot();
      await seeded(code);
      list.rows.set(code, [row(1)]);

      const listed = await post(code, sessionHeaders(code, ROOT, 2), {
        tab: 'all',
        search: CANARY,
      });

      expect(listed.status).toBe(200);
      expect(list.queries[0]).toMatchObject({ tab: 'all', onlyIds: [sellerId(1)] });
      const logs = JSON.stringify(logLines);
      expect(logs).toContain('sellers.list');
      expect(logs).not.toContain(CANARY);
      expect(logs).not.toContain('Shop 1');
      // The correlation id of the request is on the line.
      expect(logLines.find((line) => line.msg === 'sellers.list-route')).toMatchObject({
        marketId: code,
        correlationId: expect.any(String) as unknown,
      });
    });

    it('refuses a visitor, a customer session and an admin whose role lacks the key; nothing is read', async () => {
      await boot();
      await seeded(code);
      list.rows.set(code, [row(1)]);

      const visitor = await post(code, null);
      const customer = await post(code, sessionHeaders(code, CUSTOMER, 3, 'customer'));
      const support = await post(code, sessionHeaders(code, SUPPORT, 4));

      expect(visitor.status).toBe(401);
      expect(customer.status).toBe(401);
      expect(support.status).toBe(403);
      expect(support.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(list.queries).toHaveLength(0);
      expect(access.calls).toHaveLength(0);
    });

    it('lets the Viewer default role list (the seed holds sellers.seller.view)', async () => {
      await boot();
      await seeded(code);
      list.rows.set(code, [row(1)]);

      const listed = await post(code, sessionHeaders(code, VIEWER, 8));

      expect(listed.status).toBe(200);
      expect((listed.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('needs the CSRF token although it is a read', async () => {
      await boot();
      await seeded(code);

      const refused = await post(code, sessionHeaders(code, ROOT, 5), {}, { csrf: false });

      expect(refused.status).toBe(403);
      expect(list.queries).toHaveLength(0);
    });

    it('answers validation.failed with paths and codes only for a bad body', async () => {
      await boot();
      await seeded(code);

      const bad = await post(code, sessionHeaders(code, ROOT, 6), {
        tab: 'all',
        kind: 'onboarding',
        sellerId: CANARY,
      });

      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      expect(JSON.stringify(bad.body)).not.toContain(CANARY);
    });

    it('is 503 sellers.unavailable, not an empty list, when identity cannot answer', async () => {
      await boot();
      await seeded(code);
      list.rows.set(code, [row(1)]);
      access.failing = true;

      const down = await post(code, sessionHeaders(code, ROOT, 7));

      expect(down.status).toBe(503);
      expect(down.body).toEqual({ statusCode: 503, code: 'sellers.unavailable' });
      expect(down.headers['cache-control']).toBe('no-store');
    });
  });
});
