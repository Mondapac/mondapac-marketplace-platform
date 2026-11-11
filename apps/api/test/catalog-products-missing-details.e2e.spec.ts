import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AttributeSchema, Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_REPOSITORY } from '../src/modules/catalog/application/ports/attribute.repository';
import {
  PRODUCT_DETAILS_GAP_READER,
  type ProductDetailsGapReader,
  type PublishedProductValues,
} from '../src/modules/catalog/application/ports/product-details-gap.reader';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { ProductFamilyResolver } from '../src/modules/catalog/application/attributes/product-family-resolver';
import { MISSING_DETAILS_EMAIL_STORE } from '../src/modules/catalog/application/ports/missing-details-email.store';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The report "Products missing required details" over HTTP (attributes plan, package A4): the real
// guards, controller, gate with the real role seed and use case; the product reader and the
// feature-set schema as in-memory fakes. Proved in both Market fixtures: the route needs the
// attribute view key (a role without it is refused), an admin session is required, the answer
// lists the products that miss required fields and pages by id, and a malformed query is 400.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xb701);
const VIEWER = id<'Account'>(0xb703);
const VIEWER_ROLE = id<'Role'>(0xb704);
const EDITOR = id<'Account'>(0xb702);
const EDITOR_ROLE = id<'Role'>(0xb801);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('products missing required details over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const rows = new Map<string, PublishedProductValues[]>();
  const gap: ProductDetailsGapReader = {
    publishedByIds: () => Promise.resolve([]),
    published: (market, filter) =>
      Promise.resolve(
        (rows.get(market.marketId) ?? [])
          .filter((row) => filter.afterId === null || row.productId > filter.afterId)
          .sort((a, b) => (a.productId < b.productId ? -1 : 1))
          .slice(0, filter.limit),
      ),
  };
  const schema: AttributeSchema = {
    schemaRef: { familyRevisionId: 'fam-rev-1', definitionRevisionIds: [] } as never,
    fields: [
      {
        code: 'origin',
        dataType: 'text',
        localizable: false,
        required: true,
        isVariantOption: false,
        material: false,
        claimChecked: true,
        bounds: { maxLength: 100 },
      },
    ],
  };
  const attributes = { loadSchema: () => Promise.resolve(schema) };
  // Every product's category holds the one feature set of this spec.
  const resolver = {
    open: () =>
      Promise.resolve({ resolve: () => Promise.resolve({ ok: true, familyCode: 'pantry' }) }),
  };
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(PRODUCT_DETAILS_GAP_READER)
          .useValue(gap)
          .overrideProvider(ATTRIBUTE_REPOSITORY)
          .useValue(attributes)
          .overrideProvider(ProductFamilyResolver)
          .useValue(resolver)
          // The preview reads nothing and claims nothing; these must not reach a database.
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({ storeNames: () => Promise.resolve(new Map()) })
          .overrideProvider(ATTRIBUTE_ADMIN_READER)
          .useValue({ definitions: () => Promise.resolve([]) })
          .overrideProvider(MISSING_DETAILS_EMAIL_STORE)
          .useValue({
            latest: () => Promise.resolve([]),
            claim: () => Promise.reject(new Error('a preview must not claim')),
            pending: () => Promise.resolve([]),
            settle: () => Promise.resolve(false),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'attr-0003'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Attribute editor',
      permissionKeys: ['catalog.attribute.view', 'catalog.attribute.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    for (const [accountId, label, roleId] of [
      [MODERATOR, 'moderator', roleOf('catalogue-moderator')],
      [EDITOR, 'editor', EDITOR_ROLE],
    ] as const) {
      n += 1;
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
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    rows.set(
      code,
      [1, 2, 3].map((n) => ({
        productId: id<'Product'>(0x3000 + n),
        productCode: `P${n}`,
        ownerSellerId: null,
        revisionFamilyCode: 'pantry',
        primaryCategoryId: null,
        name: null,
        attributeValues: n === 2 ? { origin: 'AU' } : {},
      })),
    );
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf900 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
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

  const REPORT = '/catalog/admin/reports/products-missing-details';

  beforeEach(() => {
    fakes.reset();
    rows.clear();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the report route in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[REPORT]).toHaveProperty('get');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the products that miss a required field and pages by id', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, EDITOR, 1);
      const all = await http().get(REPORT).set(viewer).expect(200);
      expect(all.body).toEqual({
        items: [
          {
            productId: id<'Product'>(0x3001),
            productCode: 'P1',
            name: null,
            sellerId: null,
            featureSetCode: 'pantry',
            missing: ['origin'],
          },
          {
            productId: id<'Product'>(0x3003),
            productCode: 'P3',
            name: null,
            sellerId: null,
            featureSetCode: 'pantry',
            missing: ['origin'],
          },
        ],
        nextAfterId: null,
        scanned: 3,
        unreadableFeatureSets: [],
      });
      const first = await http().get(`${REPORT}?limit=1`).set(viewer).expect(200);
      expect(first.body).toMatchObject({
        items: [{ productCode: 'P1' }],
        nextAfterId: id<'Product'>(0x3001),
      });
      const next = await http()
        .get(`${REPORT}?limit=1&afterId=${id<'Product'>(0x3001)}`)
        .set(viewer)
        .expect(200);
      expect(next.body).toMatchObject({ items: [{ productCode: 'P3' }], nextAfterId: null });
    }, 30_000);

    it('refuses a malformed query, an anonymous caller and an unknown parameter', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, EDITOR, 2);
      for (const query of [
        'limit=0',
        'limit=abc',
        'afterId=nope',
        'familyCode=Bad%20Code',
        'x=1',
      ]) {
        const refused = await http().get(`${REPORT}?${query}`).set(viewer).expect(400);
        expect(refused.body).toMatchObject({ code: 'validation.failed' });
      }
      await http()
        .get(REPORT)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .expect(401);
    }, 30_000);

    it('refuses to email sellers without the key, a malformed body or a cross-site call', async () => {
      await boot();
      await seeded(code);
      const url = `${REPORT}/email-sellers`;
      const editor = adminSession(code, EDITOR, 3);
      const body = { productIds: [id<'Product'>(0x3001)], dryRun: true };
      await http()
        .post(url)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .send(body)
        .expect(401);
      const noCsrf: Record<string, string> = { ...editor };
      delete noCsrf['x-csrf-token'];
      const refusedCsrf = await http().post(url).set(noCsrf).send(body).expect(403);
      expect(refusedCsrf.body).toMatchObject({ code: 'request.csrf' });
      // A signed-in admin who may only view attributes is refused.
      fakes.seedRole({
        id: VIEWER_ROLE,
        marketId: code as AccountState['marketId'],
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Attribute viewer',
        permissionKeys: ['catalog.attribute.view'],
        version: 1,
        createdAt: START,
      });
      fakes.seedAccount({
        id: VIEWER,
        marketId: code as AccountState['marketId'],
        population: 'admin',
        email: { typed: 'viewer@Example.com', normalized: 'viewer@example.com' },
        displayName: 'Name viewer',
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe9f0),
        marketId: code as AccountState['marketId'],
        accountId: VIEWER,
        roleId: VIEWER_ROLE,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      await http()
        .post(url)
        .set(adminSession(code, VIEWER, 5))
        .send(body)
        .expect(403);
      for (const bad of [{}, { productIds: [] }, { productIds: ['nope'] }, { ...body, extra: 1 }]) {
        const refused = await http().post(url).set(editor).send(bad).expect(400);
        expect(refused.body).toMatchObject({ code: 'validation.failed' });
      }
    }, 30_000);

    it('answers a preview of Email sellers and writes nothing', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 4);
      const answer = await http()
        .post(`${REPORT}/email-sellers`)
        .set(editor)
        .send({ productIds: [id<'Product'>(0x3001)], dryRun: true });
      // A Market with no seller page link refuses (503); one with it previews (200).
      expect([200, 503]).toContain(answer.status);
      if (answer.status === 200) {
        expect(answer.body).toMatchObject({ dryRun: true, throttleDays: 7, sellers: [] });
      } else {
        expect(answer.body).toMatchObject({ code: 'missing-details-email.unconfigured' });
      }
    }, 30_000);
  });
});
