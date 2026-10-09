import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_REPOSITORY } from '../src/modules/catalog/application/ports/attribute.repository';
import { CATALOG_MARKET_POLICY } from '../src/modules/catalog/application/ports/catalog-market-policy';
import type { CatalogMarketPolicy } from '../src/modules/catalog/application/ports/catalog-market-policy';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { PRODUCT_REVISION_REPOSITORY } from '../src/modules/catalog/application/ports/product-revision.repository';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { WORKING_COPY_REPOSITORY } from '../src/modules/catalog/application/ports/working-copy.repository';
import { Product } from '../src/modules/catalog/domain/product';
import { simpleProductType } from '../src/modules/catalog/domain/product-types/simple';
import type { StoredRevision } from '../src/modules/catalog/domain/stored-revision';
import type { WorkingCopy } from '../src/modules/catalog/domain/working-copy';
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

// The claim-text control behind the PLATFORM product routes, over HTTP (ADR-0031 decision 2a,
// Hassan B1 of PR 213): the real guards, controller, gate and the real `SaveDraft` and
// `SubmitProduct` chains with the real `CheckClaimText`; only the matcher and the database stores
// are fakes. A text that holds a claim term never reaches the stored working copy or a stored
// revision, and an unavailable matcher fails closed, on both Market fixtures.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const PRODUCT = '01990000-0000-7000-8000-00000000c001';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

const HALAL = 'halal dates';

describe('claim-text control behind the platform product routes (integration, slice 6)', () => {
  let app: NestExpressApplication;
  let products: Map<string, Product>;
  let copies: Map<string, WorkingCopy>;
  let revisions: Map<string, StoredRevision>;
  let matcherUp: boolean;
  let matched: number;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue({
            match: (_c: unknown, texts: readonly { text: string }[]) => {
              matched += texts.length;
              return Promise.resolve(
                matcherUp
                  ? {
                      ok: true as const,
                      value: texts.map((t) =>
                        t.text.includes('halal')
                          ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
                          : [],
                      ),
                    }
                  : { ok: false as const, error: { code: 'claim-text.check-unavailable' } },
              );
            },
          })
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            nextProductCode: () => Promise.resolve('P00000001'),
            add: () => Promise.resolve(),
            findById: (_m: unknown, productId: string) => {
              const found = products.get(productId);
              return Promise.resolve(
                found === undefined ? null : Product.restore({ ...found.state }),
              );
            },
            save: (_m: unknown, product: Product) => {
              products.set(product.state.id, Product.restore({ ...product.state }));
              return Promise.resolve();
            },
          })
          .overrideProvider(WORKING_COPY_REPOSITORY)
          .useValue({
            find: (_m: unknown, productId: string) =>
              Promise.resolve(copies.get(productId) ?? null),
            save: (_m: unknown, copy: WorkingCopy) => {
              copies.set(copy.productId, copy);
              return Promise.resolve();
            },
          })
          .overrideProvider(PRODUCT_REVISION_REPOSITORY)
          .useValue({
            nextRevisionNo: () => Promise.resolve(revisions.size + 1),
            add: (_m: unknown, revision: StoredRevision) => {
              revisions.set(revision.id, revision);
              return Promise.resolve();
            },
            find: () => Promise.resolve(null),
          })
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue({
            reserve: (_m: unknown, wanted: readonly { limit: { kind: string } }[], now: unknown) =>
              Promise.resolve(
                wanted.map((c) => ({ kind: c.limit.kind, count: 1, windowStartedAt: now })),
              ),
            purgeStartedBefore: () => Promise.resolve(0),
          })
          .overrideProvider(ATTRIBUTE_REPOSITORY)
          .useValue({
            loadSchema: () =>
              Promise.resolve({
                schemaRef: {
                  familyCode: 'default',
                  familyRevisionId: 'fam-rev-1',
                  definitionRevisionIds: [],
                },
                fields: [],
              }),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'roles-0001'), {});
    const roleId = [...fakes.roles.values()].find(
      (r) =>
        r.marketId === code && r.scope === 'platform' && r.seedCode === 'platform-administrator',
    )!.id;
    fakes.seedAccount({
      id: ROOT,
      marketId: code as AccountState['marketId'],
      population: 'admin',
      email: { typed: 'Root@Example.com', normalized: 'root@example.com' },
      displayName: 'Root',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>('01990000-0000-7000-8000-00000000e101'),
      marketId: code as AccountState['marketId'],
      accountId: ROOT,
      roleId,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>('01990000-0000-7000-8000-00000000f101'),
        marketId: code as AccountState['marketId'],
        accountId: ROOT,
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

  function newProduct(code: string): Product {
    const created = Product.create({
      id: id<'Product'>(PRODUCT),
      marketId: code as MarketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: id<'Variant'>('01990000-0000-7000-8000-00000000c101'),
      now: START,
    });
    if (!created.ok) throw new Error(created.error.code);
    const product = Product.restore({ ...created.value.state, version: 1 });
    products.set(product.state.id, product);
    return product;
  }

  const send = (
    method: 'post' | 'put',
    code: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    http()
      [method](`/catalog/admin/platform-products/${PRODUCT}${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    products = new Map();
    copies = new Map();
    revisions = new Map();
    matcherUp = true;
    matched = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const contentOf = (policy: CatalogMarketPolicy, name: string, extra: object = {}) => {
      const market = marketOf(code);
      return {
        texts: { [policy.locales(market).default]: { name, description: 'Sweet and soft' } },
        categoryIds: ['c1'],
        taxCategoryCode: policy.taxCategoryCodes(market)[0],
        ...extra,
      };
    };
    const nameOf = (policy: CatalogMarketPolicy) =>
      (
        copies.get(PRODUCT)?.content as {
          texts?: Record<string, { name?: string }>;
        }
      )?.texts?.[policy.locales(marketOf(code)).default]?.name;

    it('keeps a claim text out of the stored draft and fails closed when the matcher is down', async () => {
      await boot();
      const session = await seeded(code);
      const product = newProduct(code);
      const policy = app.get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY);
      const variants = [product.state.variants[0]!.id];

      const clean = await send(
        'put',
        code,
        '/draft',
        { content: contentOf(policy, 'Dates'), variantIds: variants },
        session,
      );
      expect(clean.status).toBe(200);
      expect(clean.body).toMatchObject({ refusedFields: [] });
      expect(nameOf(policy)).toBe('Dates');

      const claim = await send(
        'put',
        code,
        '/draft',
        { content: contentOf(policy, HALAL), variantIds: variants },
        session,
      );
      expect(claim.status).toBe(200);
      expect(
        (claim.body as { refusedFields: { field: string; code: string }[] }).refusedFields,
      ).toMatchObject([{ field: 'product.name', code: 'claim-text.found' }]);
      expect(nameOf(policy)).toBe('Dates');

      matcherUp = false;
      const down = await send(
        'put',
        code,
        '/draft',
        { content: contentOf(policy, 'Figs'), variantIds: variants },
        session,
      );
      expect(down.status).toBe(200);
      expect(
        (down.body as { refusedFields: { code: string }[] }).refusedFields.map((f) => f.code),
      ).toContain('claim-text.check-unavailable');
      expect(nameOf(policy)).toBe('Dates');
      expect(JSON.stringify([...copies.values()])).not.toContain('halal');
    });

    it('refuses an unknown key in the content as a whole, writing nothing', async () => {
      await boot();
      const session = await seeded(code);
      const product = newProduct(code);
      const policy = app.get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY);

      const bad = await send(
        'put',
        code,
        '/draft',
        {
          content: contentOf(policy, 'Dates', { sneaky: 'halal' }),
          variantIds: [product.state.variants[0]!.id],
        },
        session,
      );
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ statusCode: 400, code: 'working-copy.invalid-content' });
      expect(copies.size).toBe(0);
    });

    it('refuses a submit whose frozen content now holds a claim, storing no revision', async () => {
      await boot();
      const session = await seeded(code);
      newProduct(code);
      const policy = app.get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY);
      // A copy that predates the vocabulary: it holds a claim text the save never saw.
      copies.set(PRODUCT, {
        productId: id<'Product'>(PRODUCT),
        content: contentOf(policy, HALAL),
        contentSchemaVersion: 1,
        baseRevisionId: null,
        lastSavedAt: START,
        lastSavedByAccountId: ROOT,
      });

      const refused = await send('post', code, '/submit', { replacePending: false }, session);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'claim-text.refused' });
      expect(revisions.size).toBe(0);

      matcherUp = false;
      const down = await send('post', code, '/submit', { replacePending: false }, session);
      expect(down.status).toBeGreaterThanOrEqual(422);
      expect(revisions.size).toBe(0);

      matcherUp = true;
      copies.set(PRODUCT, {
        ...copies.get(PRODUCT)!,
        content: contentOf(policy, 'Dates'),
      });
      const published = await send('post', code, '/submit', { replacePending: false }, session);
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ revisionNo: 1, published: true });
      expect(revisions.size).toBe(1);
      expect(matched).toBeGreaterThan(0);
    });
  });
});
