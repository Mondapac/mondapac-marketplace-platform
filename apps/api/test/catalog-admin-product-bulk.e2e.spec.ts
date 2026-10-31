import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  ADMIN_PRODUCTS_READER,
  type AdminProductRow,
} from '../src/modules/catalog/application/ports/admin-products.reader';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { ADMIN_PRODUCT_BULK_STATUS } from '../src/modules/catalog/presentation/admin-product-bulk.controller';
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

// The bulk action and the export of the admin product list over HTTP (catalog design 9.2c): the
// real guards, controllers, gates and use cases, with identity's ports and the list reader as
// in-memory fakes. Proved here: the admin session and the CSRF token, the view key and the
// per-action key (the seeded Viewer role holds the first only), the closed body and its status,
// the CSV attachment headers and the formula guard. The units are in
// test/db/catalog-product-pause.db-spec.ts.

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

it('maps the refusal codes of the bulk action and the export to their statuses', () => {
  expect(ADMIN_PRODUCT_BULK_STATUS).toEqual({
    'validation.failed': 400,
    'product.not-found': 404,
    'batch.too-large': 413,
    'retire.count-changed': 409,
    'access.unavailable': 503,
  });
});

describe('admin product bulk action and export over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let rowRequests: string[][];
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  const rowOf = (code: string, name: string): AdminProductRow => ({
    productId: PRODUCT,
    productCode: `${code}-000184`,
    name,
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

  async function boot(code: string, name = 'Lamb cutlets 500 g') {
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
            counts: () => Promise.resolve([1]),
            ids: () => Promise.resolve([PRODUCT]),
            existing: (_m: MarketContext, ids: readonly string[]) =>
              Promise.resolve(new Set(ids.filter((i) => i === PRODUCT))),
            states: () =>
              Promise.resolve([
                {
                  productId: PRODUCT,
                  scope: 'SELLER',
                  status: 'published',
                  paused: false,
                  offerCount: 6,
                },
              ]),
            rowsByIds: (_m: MarketContext, ids: readonly string[]) => {
              rowRequests.push([...ids]);
              return Promise.resolve([rowOf(code, name)]);
            },
          })
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({ storeNames: () => Promise.resolve(new Map([[SELLER, 'Halal Meats']])) }),
    }));
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'bulk-0001'), {});
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

  const exportOf = (code: string, query: string, session: Record<string, string> | null) =>
    http()
      .get(`/catalog/admin/products/export${query}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
      });

  const bulk = (
    code: string,
    body: object,
    session: Record<string, string> | null,
    withCsrf = true,
  ) =>
    http()
      .post('/catalog/admin/products/bulk')
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      })
      .send(body);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    rowRequests = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents both routes and their error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const post = document.paths['/catalog/admin/products/bulk']?.post?.responses;
    for (const status of ['200', '400', '401', '403', '404', '409', '413', '415', '503']) {
      expect(post).toHaveProperty(status);
    }
    const get = document.paths['/catalog/admin/products/export']?.get?.responses;
    for (const status of ['200', '400', '401', '403', '404', '413', '503']) {
      expect(get).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('streams the CSV as a no-store attachment for the Viewer', async () => {
      await boot(code);
      await seeded(code);

      const response = await exportOf(
        code,
        `?format=csv&columns=offers&ids=${PRODUCT}`,
        sessionOf(code, VIEWER, 1),
      ).buffer(true);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="products-2026-10-30.csv"',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.text).toContain('Lamb cutlets 500 g');
      expect(response.text).toContain(`${code}-000184`);
      expect(rowRequests).toEqual([[PRODUCT]]);
    });

    it('writes a name that starts with a formula character with a leading quote', async () => {
      await boot(code, '=HYPERLINK("http://evil.example")');
      await seeded(code);

      const response = await exportOf(code, `?ids=${PRODUCT}`, sessionOf(code, VIEWER, 1)).buffer(
        true,
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain(`'=HYPERLINK`);
      expect(response.text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    });

    it('answers 400 for xlsx, an unknown column and a malformed id', async () => {
      await boot(code);
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const [query, path] of [
        ['?format=xlsx', 'format'],
        ['?columns=price', 'columns'],
        ['?ids=nope', 'ids'],
        ['?price=1', 'price'],
      ] as const) {
        const response = await exportOf(code, query, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
    });

    it('answers 404 for an id that is no product of the Market', async () => {
      await boot(code);
      await seeded(code);

      const response = await exportOf(
        code,
        `?ids=${id<'Product'>(0xc999)}`,
        sessionOf(code, VIEWER, 1),
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'product.not-found' });
    });

    it('answers 401 without a session and 403 without the view key, for both routes', async () => {
      await boot(code);
      await seeded(code);

      expect((await exportOf(code, '', null)).status).toBe(401);
      expect((await exportOf(code, '', sessionOf(code, NO_KEY, 2))).status).toBe(403);
      const body = { action: 'pause', productIds: [PRODUCT] };
      expect((await bulk(code, body, null)).status).toBe(401);
      expect((await bulk(code, body, sessionOf(code, NO_KEY, 2))).status).toBe(403);
    });

    it('refuses the bulk action without the CSRF token', async () => {
      await boot(code);
      await seeded(code);

      const response = await bulk(
        code,
        { action: 'pause', productIds: [PRODUCT] },
        sessionOf(code, VIEWER, 1),
        false,
      );

      expect(response.status).toBe(403);
    });

    it('refuses the bulk action to a Viewer, who holds the view key but no action key', async () => {
      await boot(code);
      await seeded(code);

      for (const action of ['pause', 'resume', 'delete']) {
        const response = await bulk(
          code,
          { action, productIds: [PRODUCT] },
          sessionOf(code, VIEWER, 1),
        );
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: 'access.denied' });
      }
    });

    it('answers 400 with the field for a body that is not closed', async () => {
      await boot(code);
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const [body, path] of [
        [{ productIds: [PRODUCT] }, 'action'],
        [{ action: 'pause', productIds: [PRODUCT], extra: 1 }, 'extra'],
      ] as const) {
        const response = await bulk(code, body, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
    });
  });
});
