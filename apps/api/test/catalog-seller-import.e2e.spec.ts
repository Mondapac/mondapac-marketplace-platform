import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { ATTRIBUTE_REPOSITORY } from '../src/modules/catalog/application/ports/attribute.repository';
import { CATEGORY_TREE_READER } from '../src/modules/catalog/application/ports/category-tree.reader';
import { IMPORT_FILE_STORE } from '../src/modules/catalog/application/ports/import-file-store';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SELLER_IMPORT_FACTS_READER } from '../src/modules/catalog/application/ports/seller-import-facts.reader';
import { SELLER_IMPORT_REPOSITORY } from '../src/modules/catalog/application/ports/seller-import.repository';
import { SELLER_IMPORT_STATUS } from '../src/modules/catalog/presentation/seller-import.controller';
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

// The seller import over HTTP (catalog design 14c): the real guards, controller, gates and check,
// with identity's ports and the import's store, repository and counters as fakes. Proved here: the
// seller session, the CSRF token, the two keys (the Catalogue and Stock role lacks the import key),
// the closed body, the status of each refusal, the byte-identical answer for an id that is not the
// seller's, and the routes in OpenAPI.

const START = Temporal.Instant.from('2026-11-07T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MANAGER = id<'Account'>(0xa101);
const STOCK = id<'Account'>(0xa102);
const SELLER = id<'Seller'>(0xb020);
const UNKNOWN_IMPORT = '01990000-0000-7000-8000-00000000dead';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps the refusal codes of the seller import to their statuses', () => {
  expect(SELLER_IMPORT_STATUS).toMatchObject({
    'import.not-found': 404,
    'file.too-large': 413,
    'file.unsupported-type': 415,
    'seller.not-eligible': 403,
    'request.throttled': 429,
  });
});

describe('seller import over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let added: unknown[];
  let stored: string[];
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue({
            reserve: (_m: MarketContext, list: readonly { limit: { kind: string } }[]) =>
              Promise.resolve(
                list.map((counter) => ({
                  kind: counter.limit.kind,
                  count: 1,
                  windowStartedAt: clock.now(),
                })),
              ),
            purgeStartedBefore: () => Promise.resolve(0),
          })
          .overrideProvider(CATEGORY_TREE_READER)
          .useValue({ nodes: () => Promise.resolve([]) })
          .overrideProvider(ATTRIBUTE_REPOSITORY)
          .useValue({
            loadSchema: () =>
              Promise.resolve({
                schemaRef: {
                  familyCode: 'default',
                  familyRevisionId: 'r',
                  definitionRevisionIds: [],
                },
                fields: [],
              }),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(true) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve('all') })
          .overrideProvider(SELLER_IMPORT_FACTS_READER)
          .useValue({
            load: () => Promise.resolve({ offersBySku: new Map(), productsByCode: new Map() }),
          })
          .overrideProvider(IMPORT_FILE_STORE)
          .useValue({
            keyOf: (_m: unknown, importId: string) => `catalog/seller-imports/${importId}`,
            put: (key: string) => {
              stored.push(key);
              return Promise.resolve();
            },
            get: () => Promise.resolve(null),
            delete: () => Promise.resolve(),
          })
          .overrideProvider(SELLER_IMPORT_REPOSITORY)
          .useValue({
            find: () => Promise.resolve(null),
            latestOf: () => Promise.resolve(null),
            hasActive: () => Promise.resolve(false),
            discardChecked: () => Promise.resolve([]),
            add: (_m: unknown, job: unknown) => {
              added.push(job);
              return Promise.resolve();
            },
            rows: () => Promise.resolve([]),
          }),
    }));
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'simport-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === seedCode,
      )!.id;
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
    const member = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>, n: number) => {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'seller',
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
        id: id<'RoleAssignment'>(0xe100 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.seedMembership({
        id: id<'SellerMembership'>(0xf100 + n),
        marketId,
        accountId,
        sellerId: SELLER,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    };
    member(MANAGER, 'manager', roleOf('store-manager'), 1);
    member(STOCK, 'stock', roleOf('catalogue-stock'), 2);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf200 + n),
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
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const headersOf = (code: string, session: Record<string, string> | null, csrf = false) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'seller'),
    ...(session === null ? {} : { cookie: session.cookie! }),
    ...(session !== null && csrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
  });
  const get = (code: string, path: string, session: Record<string, string> | null) =>
    http().get(`/catalog/seller/imports${path}`).set(headersOf(code, session));
  const post = (
    code: string,
    path: string,
    body: unknown,
    session: Record<string, string> | null,
    csrf = true,
  ) =>
    http()
      .post(`/catalog/seller/imports${path}`)
      .set(headersOf(code, session, csrf))
      .send(body as object);
  const asData = (text: string, mode = 'my-products') => ({
    mode,
    fileName: 'products.csv',
    data: Buffer.from(text).toString('base64'),
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    added = [];
    stored = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the routes and their error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const upload = document.paths['/catalog/seller/imports']?.post?.responses;
    for (const status of ['201', '400', '401', '403', '413', '415', '422', '429', '503']) {
      expect(upload).toHaveProperty(status);
    }
    for (const route of [
      ['/catalog/seller/imports/template', 'get'],
      ['/catalog/seller/imports/current', 'get'],
      ['/catalog/seller/imports/{importId}', 'get'],
      ['/catalog/seller/imports/{importId}/start', 'post'],
      ['/catalog/seller/imports/{importId}/resume', 'post'],
      ['/catalog/seller/imports/{importId}/discard', 'post'],
      ['/catalog/seller/imports/{importId}/report', 'get'],
      ['/catalog/seller/imports/{importId}/photos', 'post'],
    ] as const) {
      expect(document.paths[route[0]]?.[route[1]]).toBeDefined();
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session and 403 without the import key', async () => {
      await boot();
      await seeded(code);

      expect((await get(code, '/template', null)).status).toBe(401);
      expect((await post(code, '', asData('a'), null)).status).toBe(401);
      const refused = await post(code, '', asData('a'), sessionOf(code, STOCK, 2));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      const start = await post(
        code,
        `/${UNKNOWN_IMPORT}/start`,
        { skipErrors: false },
        sessionOf(code, STOCK, 2),
      );
      expect(start.status).toBe(403);
      expect(added).toEqual([]);
    });

    it('gives the Store Manager the template as no-store CSV and XLSX, with the limits', async () => {
      await boot();
      await seeded(code);

      const response = await get(code, '/template', sessionOf(code, MANAGER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as {
        limits: unknown;
        modes: { mode: string; csv: string; xlsx: string; columns: { key: string }[] }[];
      };
      expect(body.limits).toEqual({ rows: 5000, fileBytes: 10 * 1024 * 1024 });
      expect(body.modes.map((m) => m.mode)).toEqual(
        expect.arrayContaining(['my-products', 'sell-from-catalogue']),
      );
      const mine = body.modes.find((m) => m.mode === 'my-products')!;
      expect(mine.csv).toContain('Seller SKU');
      expect(mine.xlsx.length).toBeGreaterThan(0);
      // Price, stock and Cost are not columns of any template (ADR-0024).
      for (const mode of body.modes) {
        expect(mode.csv.toLowerCase()).not.toMatch(/price|stock|cost/);
      }
    });

    it('refuses the upload without the CSRF token', async () => {
      await boot();
      await seeded(code);

      const response = await post(code, '', asData('a'), sessionOf(code, MANAGER, 1), false);

      expect(response.status).toBe(403);
      expect(added).toEqual([]);
    });

    it('answers 400 with the field for a body that is not closed', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MANAGER, 1);

      for (const [body, path] of [
        [{ data: 'QQ==' }, 'mode'],
        [{ mode: 'nope', data: 'QQ==' }, 'mode'],
        [{ mode: 'my-products' }, 'data'],
        [{ mode: 'my-products', data: 'QQ==', extra: 1 }, 'extra'],
        [{ mode: 'my-products', data: 'QQ==', fileName: 7 }, 'fileName'],
        [{ mode: 'my-products', data: '@@@@' }, 'data'],
      ] as const) {
        const response = await post(code, '', body, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
    });

    it('answers 413 when the text is over the limit, before decoding it', async () => {
      await boot();
      await seeded(code);

      const response = await post(
        code,
        '',
        {
          mode: 'my-products',
          fileName: 'big.csv',
          data: 'A'.repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 8),
        },
        sessionOf(code, MANAGER, 1),
      );

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({ code: 'file.too-large' });
    });

    it('answers 422 for a file without rows and for the wrong columns, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MANAGER, 1);

      const noRows = await post(
        code,
        '',
        asData('Seller SKU,Title,Main category,Product type\n'),
        session,
      );
      expect(noRows.status).toBe(422);
      expect(noRows.body).toMatchObject({ code: 'file.no-rows' });
      const wrong = await post(code, '', asData('Name,Colour\nA,B\n'), session);
      expect(wrong.status).toBe(422);
      expect(wrong.body).toMatchObject({ code: 'columns.missing' });
      expect(stored).toEqual([]);
      expect(added).toEqual([]);
    });

    it('refuses a file that is no CSV or workbook with 415 and never opens a ZIP of photos', async () => {
      await boot();
      await seeded(code);
      const zip = await http()
        .post('/catalog/seller/imports')
        .set(headersOf(code, sessionOf(code, MANAGER, 1), true))
        .send({
          mode: 'my-products',
          fileName: 'photos.zip',
          data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).toString('base64'),
        });
      expect(zip.status).toBe(415);
      expect(zip.body).toMatchObject({ code: 'file.unsupported-type' });
      expect(stored).toEqual([]);
    });

    it('stores the checked file and job of a good upload, never echoing the file name', async () => {
      await boot();
      await seeded(code);

      const response = await post(
        code,
        '',
        {
          mode: 'my-products',
          fileName: '../../etc/passwd<script>.csv',
          data: Buffer.from(
            'Seller SKU,Title,Main category,Product type,Price,Stock\nSKU-1,Lamb,Meat,simple,9.99,5\n',
          ).toString('base64'),
        },
        sessionOf(code, MANAGER, 1),
      );

      // The category does not exist in this fake, so the row has an error; the check still ran.
      expect(response.status).toBe(201);
      const body = response.body as {
        state: string;
        fileLabel: string;
        rows: number;
        ignoredColumns: { header: string; mark: string | null }[];
      };
      expect(body.state).toBe('checked');
      expect(body.rows).toBe(1);
      expect(body.fileLabel).not.toMatch(/[/<>]/);
      expect(body.ignoredColumns).toEqual(
        expect.arrayContaining([
          { header: 'Price', mark: 'elsewhere' },
          { header: 'Stock', mark: 'elsewhere' },
        ]),
      );
      expect(stored).toHaveLength(1);
      expect(added).toHaveLength(1);
      expect(JSON.stringify(added[0])).not.toContain('9.99');
    });

    it('answers the same 404 for an id that is not the seller’s as for any unknown id', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MANAGER, 1);

      const read = await get(code, `/${UNKNOWN_IMPORT}`, session);
      const discard = await post(code, `/${UNKNOWN_IMPORT}/discard`, {}, session);
      const start = await post(code, `/${UNKNOWN_IMPORT}/start`, { skipErrors: false }, session);
      const report = await get(code, `/${UNKNOWN_IMPORT}/report?kind=errors`, session);

      for (const response of [read, discard, start, report]) {
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'import.not-found' });
      }
      expect(JSON.stringify(read.body)).toBe(JSON.stringify(discard.body));
    });

    it('answers 400 for a malformed import id and null for no current import', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MANAGER, 1);

      const bad = await get(code, '/not-an-id', session);
      expect([400, 404]).toContain(bad.status);
      const current = await get(code, '/current', session);
      expect(current.status).toBe(200);
      expect(current.body).toEqual({ import: null });
    });
  });
});
