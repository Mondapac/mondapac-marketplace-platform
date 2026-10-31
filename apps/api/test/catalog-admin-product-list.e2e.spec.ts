import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  ADMIN_PRODUCTS_READER,
  type AdminProductRow,
  type AdminProductsFilter,
} from '../src/modules/catalog/application/ports/admin-products.reader';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { ADMIN_PRODUCT_LIST_STATUS } from '../src/modules/catalog/presentation/admin-product-list.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin product list over HTTP (catalog design 8.2, 9.2 `admin-products.list`): the real
// guards, controller, gate and use case, with identity's ports and the list reader as in-memory
// fakes. Proved here: the admin session, the view key (the seeded Viewer role) and its absence,
// no-store, the closed query and its status, the number parsing and the answer shape. The SQL
// is in test/db/catalog-admin-products.db-spec.ts.

const START = Temporal.Instant.from('2026-10-30T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xa002);
const NO_KEY = id<'Account'>(0xa003);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps the refusal codes of the list to their statuses', () => {
  expect(ADMIN_PRODUCT_LIST_STATUS).toEqual({
    'validation.failed': 400,
    'access.unavailable': 503,
  });
});

describe('admin product list over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let listed: { filter: AdminProductsFilter; offset: number; limit: number }[];
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  const rowOf = (code: string): AdminProductRow => ({
    productId: PRODUCT,
    productCode: `${code}-000184`,
    name: 'Lamb cutlets 500 g',
    primaryImageId: null,
    scope: 'SELLER',
    ownerSellerId: SELLER,
    categoryId: null,
    categoryName: 'Meat',
    typeCode: 'simple',
    status: 'published',
    offerCount: 6,
    updatedAt: START,
    createdAt: START,
  });

  async function boot(code: string) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(ADMIN_PRODUCTS_READER)
          .useValue({
            counts: () => Promise.resolve([1, 2, 1]),
            list: (
              _m: MarketContext,
              filter: AdminProductsFilter,
              _order: unknown,
              page: { offset: number; limit: number },
            ) => {
              listed.push({ filter, ...page });
              return Promise.resolve({ kind: 'rows', rows: [rowOf(code)] });
            },
          })
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({ storeNames: () => Promise.resolve(new Map([[SELLER, 'Halal Meats']])) }),
    }));
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'list-0001'), {});
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'No catalog key',
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    const viewerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'viewer',
    )!.id;
    const admin = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>, n: number) => {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(VIEWER, 'viewer', viewerRole, 1);
    admin(NO_KEY, 'nokey', NO_KEY_ROLE, 2);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const get = (code: string, path: string, session: Record<string, string> | null) =>
    http()
      .get(`/catalog/admin/products${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    listed = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses = document.paths['/catalog/admin/products']?.get?.responses;
    for (const status of ['200', '400', '401', '403', '503']) {
      expect(responses).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the Market products for the Viewer, no-store, with counts and the store name', async () => {
      await boot(code);
      await seeded(code);

      const response = await get(code, '', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        items: [
          {
            productId: PRODUCT,
            productCode: `${code}-000184`,
            name: 'Lamb cutlets 500 g',
            primaryImageId: null,
            scope: 'SELLER',
            ownerSellerId: SELLER,
            ownerStoreName: 'Halal Meats',
            categoryId: null,
            categoryName: 'Meat',
            typeCode: 'simple',
            status: 'published',
            offerCount: 6,
            updatedAt: START.toString(),
            createdAt: START.toString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        counts: { active: 1, all: 2, inactive: 1 },
      });
    });

    it('reads page and pageSize from the query string as numbers', async () => {
      await boot(code);
      await seeded(code);

      const response = await get(
        code,
        '?view=all&page=1&pageSize=10&q=lamb&sort=name&direction=asc',
        sessionOf(code, VIEWER, 1),
      );

      expect(response.status).toBe(200);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ offset: 0, limit: 10, filter: { text: 'lamb' } });
    });

    it('answers 400 with the field for a bad query', async () => {
      await boot(code);
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const [query, path] of [
        ['?view=draft', 'view'],
        ['?pageSize=abc', 'pageSize'],
        ['?page=0', 'page'],
        ['?sort=price', 'sort'],
        ['?price=1', 'price'],
        ['?q=a&q=b', 'q'],
      ] as const) {
        const response = await get(code, query, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
      expect(listed).toEqual([]);
    });

    it('answers 401 without a session and 403 without the view key', async () => {
      await boot(code);
      await seeded(code);

      expect((await get(code, '', null)).status).toBe(401);
      expect((await get(code, '', sessionOf(code, NO_KEY, 2))).status).toBe(403);
    });
  });
});
