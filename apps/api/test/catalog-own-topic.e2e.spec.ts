import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  TOPIC_READER,
  type TopicBrief,
  type TopicReader,
} from '../src/modules/catalog/application/ports/topic.reader';
import type { TopicState } from '../src/modules/catalog/domain/topic';
import { OWN_TOPIC_STATUS } from '../src/modules/catalog/presentation/own-topic.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller topic picker over HTTP (product tags T2): the real guards, controller, the gate with
// the real role seed (the Seller Owner holds the edit key; a custom role with the view key only
// does not) and the use case; the topic store as an in-memory fake that keeps the Markets apart.
// Proved here, in both Market fixtures: the session and key gates, active topics only, search,
// keyset paging, the closed query, no data of another Market, and the OpenAPI entry.

const START = Temporal.Instant.from('2026-11-07T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa201);
const VIEWER = id<'Account'>(0xa202);
const SELLER = id<'Seller'>(0xb201);
const VIEW_ONLY_ROLE = id<'Role'>(0xf921);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

/** Topics per Market; the list is the real reader's contract on active filter, search and keyset. */
class MemoryTopics implements TopicReader {
  readonly byMarket = new Map<string, TopicState[]>();
  list(market: MarketContext, query: Parameters<TopicReader['list']>[1]) {
    const all = [...(this.byMarket.get(market.marketId) ?? [])].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
    const start = query.afterId === null ? 0 : all.findIndex((t) => t.id === query.afterId) + 1;
    const matching = all
      .slice(start)
      .filter((t) => query.status === null || t.status === query.status)
      .filter(
        (t) =>
          query.search === null ||
          t.slug.includes(query.search.toLowerCase()) ||
          t.terms.some((term) => term.text.toLowerCase().includes(query.search!.toLowerCase())),
      );
    const items = matching.slice(0, query.limit);
    return Promise.resolve({
      items,
      nextAfterId: matching.length > query.limit ? items[items.length - 1]!.id : null,
    });
  }
  briefsOf(): Promise<readonly TopicBrief[]> {
    return Promise.resolve([]);
  }
}

describe('seller topic picker over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  const topics = new MemoryTopics();
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
          .overrideProvider(TOPIC_READER)
          .useValue(topics),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'topic-0002'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedRole({
      id: VIEW_ONLY_ROLE,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: SELLER,
      name: 'Viewer',
      permissionKeys: ['catalog.own-product.view'],
      version: 1,
      createdAt: START,
    });
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    let n = 0;
    for (const [accountId, label, roleId] of [
      [OWNER, 'owner', ownerRole],
      [VIEWER, 'viewer', VIEW_ONLY_ROLE],
    ] as const) {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'seller',
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
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe200 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.seedMembership({
        id: id<'SellerMembership'>(0xf200 + n),
        marketId,
        accountId,
        sellerId: SELLER,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    }
  }

  function sellerSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xfb00 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'seller'),
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const topic = (
    n: number,
    slug: string,
    name: string,
    over: Partial<TopicState> = {},
  ): TopicState => ({
    id: id<'Topic'>(0x7000 + n),
    slug,
    group: 'occasion',
    status: 'active',
    terms: [
      { locale: 'en-AU', kind: 'name', text: name, key: name.toLowerCase() },
      { locale: 'ja-JP', kind: 'name', text: name, key: name.toLowerCase() },
      {
        locale: 'en-AU',
        kind: 'synonym',
        text: `${name} alias`,
        key: `${name} alias`.toLowerCase(),
      },
    ],
    intro: 'Hidden intro',
    createdBy: id<'Account'>(0x1),
    createdAt: START,
    updatedAt: START,
    version: 1,
    ...over,
  });

  const SELLER_ROUTE = '/catalog/seller/topics';

  beforeEach(() => {
    fakes.reset();
    topics.byMarket.clear();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the picker to their status', () => {
    expect(OWN_TOPIC_STATUS).toEqual({ 'validation.failed': 400, 'access.unavailable': 503 });
  });

  it('documents the picker in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(document.paths[SELLER_ROUTE]).toHaveProperty('get');
    for (const status of ['200', '400', '401', '403', '503']) {
      expect(document.paths[SELLER_ROUTE]?.get?.responses).toHaveProperty(status);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const otherCode = TEST_MARKETS.find((m) => m !== code)!;

    function stock() {
      topics.byMarket.set(code, [
        topic(1, 'ramadan', 'Ramadan'),
        topic(2, 'barbecue', 'Barbecue'),
        topic(3, 'old-theme', 'Old theme', { status: 'archived' }),
        topic(4, 'persian', 'Persian', { group: 'cuisine' }),
      ]);
      topics.byMarket.set(otherCode, [topic(9, 'canary', 'Canary')]);
    }

    it('answers 401 without a session and 403 to a seller without the edit key', async () => {
      await boot();
      await seeded(code);
      stock();
      await http()
        .get(SELLER_ROUTE)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .expect(401);
      const denied = await http()
        .get(SELLER_ROUTE)
        .set(sellerSession(code, VIEWER, 1))
        .expect(403);
      expect(denied.body).toMatchObject({ code: 'access.denied' });
      expect(JSON.stringify(denied.body)).not.toContain('ramadan');
    });

    it('lists the active topics of the Market by slug, without archived ones or other Markets', async () => {
      await boot();
      await seeded(code);
      stock();
      const response = await http()
        .get(SELLER_ROUTE)
        .set(sellerSession(code, OWNER, 2))
        .expect(200);
      expect(response.headers['cache-control']).toContain('no-store');
      const body = response.body as { items: { slug: string }[]; maxPerProduct: number };
      expect(body.items.map((item) => item.slug)).toEqual(['barbecue', 'persian', 'ramadan']);
      expect(body.maxPerProduct).toBe(10);
      expect(body.items[0]).toEqual({
        id: id<'Topic'>(0x7002),
        slug: 'barbecue',
        group: 'occasion',
        name: expect.any(String) as string,
        names: expect.any(Object) as Record<string, string>,
      });
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/old-theme|canary|Hidden intro|alias/);
    });

    it('searches by name or slug and pages by keyset', async () => {
      await boot();
      await seeded(code);
      stock();
      const session = sellerSession(code, OWNER, 3);
      const found = await http().get(`${SELLER_ROUTE}?search=bar`).set(session).expect(200);
      expect((found.body as { items: { slug: string }[] }).items.map((i) => i.slug)).toEqual([
        'barbecue',
      ]);
      const first = await http().get(`${SELLER_ROUTE}?limit=2`).set(session).expect(200);
      const page = first.body as { items: { slug: string }[]; nextAfterId: string };
      expect(page.items.map((i) => i.slug)).toEqual(['barbecue', 'persian']);
      const second = await http()
        .get(`${SELLER_ROUTE}?limit=2&afterId=${page.nextAfterId}`)
        .set(session)
        .expect(200);
      expect(second.body).toMatchObject({ items: [{ slug: 'ramadan' }], nextAfterId: null });
    });

    it('refuses a malformed query with 400 and the field', async () => {
      await boot();
      await seeded(code);
      stock();
      const session = sellerSession(code, OWNER, 4);
      for (const query of ['limit=0', 'limit=abc', 'afterId=x', 'status=archived', 'market=AU']) {
        const response = await http().get(`${SELLER_ROUTE}?${query}`).set(session).expect(400);
        expect(response.body).toMatchObject({ code: 'validation.failed' });
      }
    });

    it('shows the other Market its own topics only', async () => {
      await boot();
      await seeded(otherCode);
      stock();
      const response = await http()
        .get(SELLER_ROUTE)
        .set(sellerSession(otherCode, OWNER, 5))
        .expect(200);
      expect((response.body as { items: { slug: string }[] }).items.map((i) => i.slug)).toEqual([
        'canary',
      ]);
    });
  });
});
