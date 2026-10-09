import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { ATTRIBUTE_REPOSITORY } from '../src/modules/catalog/application/ports/attribute.repository';
import { SubmitProduct } from '../src/modules/catalog/application/revisions/submit-product.service';
import { SaveDraft } from '../src/modules/catalog/application/working-copy/save-draft.service';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SaveWorkingCopy } from '../src/modules/catalog/application/working-copy/save-working-copy.service';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { OWN_PRODUCT_STATUS } from '../src/modules/catalog/presentation/own-product.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller product routes over HTTP (catalog design 4.2, 8.2; OFR-01): the real guards,
// controller, gate and the real `own-offer.create-on-platform-product` use case, with identity's
// ports and catalog's stores as in-memory fakes. Proved here: the seller session, the CSRF token,
// the key, the closed body, the status of each refusal, the throttle headers and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('seller product routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let added: Product[];
  let product: Product | null;
  let eligible: boolean;
  let reserve: unknown;
  let allowed: unknown;
  let saveResult: unknown;
  let submitResult: unknown;
  let saveCalls: unknown[];
  let submitCalls: unknown[];
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
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            findById: () => Promise.resolve(product),
            nextProductCode: () => Promise.resolve('P00000042'),
            add: (_m: unknown, created: Product) => {
              added.push(created);
              return Promise.resolve();
            },
          })
          .overrideProvider(ATTRIBUTE_REPOSITORY)
          .useValue({ loadSchema: () => Promise.resolve({}) })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve(allowed) })
          .overrideProvider(SaveWorkingCopy)
          .useValue({ reserveSaves: () => Promise.resolve(reserve) })
          .overrideProvider(SaveDraft)
          .useValue({
            execute: (_c: unknown, input: unknown) => {
              saveCalls.push(input);
              return Promise.resolve(saveResult);
            },
          })
          .overrideProvider(SubmitProduct)
          .useValue({
            execute: (_c: unknown, input: unknown) => {
              submitCalls.push(input);
              return Promise.resolve(submitResult);
            },
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const state = (code: string): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'SELLER',
    ownerSellerId: SELLER,
    createdBySellerId: SELLER,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'draft',
    discardedAt: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: null,
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
  });

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'offer-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
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
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'Owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    product = Product.restore(state(code));
  }

  function sessionOf(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf101),
        marketId: code as AccountState['marketId'],
        accountId: OWNER,
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

  const headers = (code: string, extra: Record<string, string>) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'seller'),
    ...extra,
  });
  const post = (code: string, path: string, payload: unknown, extra: Record<string, string>) =>
    http()
      .post(path)
      .set(headers(code, extra))
      .send(payload as object);
  const put = (code: string, path: string, payload: unknown, extra: Record<string, string>) =>
    http()
      .put(path)
      .set(headers(code, extra))
      .send(payload as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    added = [];
    product = null;
    eligible = true;
    reserve = null;
    allowed = 'all';
    saveCalls = [];
    submitCalls = [];
    saveResult = { ok: true, value: { variantIds: [], refusedFields: [] } };
    submitResult = {
      ok: true,
      value: { revisionId: id<'ProductRevision'>(0xd002), revisionNo: 1, published: false },
    };
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the three routes and their error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const create = document.paths['/catalog/seller/products']?.post?.responses;
    for (const status of ['201', '400', '403', '422', '429', '503']) {
      expect(create).toHaveProperty(status);
    }
    const draft = document.paths['/catalog/seller/products/{productId}/draft']?.put?.responses;
    for (const status of ['200', '400', '403', '404', '409', '422', '429', '503']) {
      expect(draft).toHaveProperty(status);
    }
    const submit = document.paths['/catalog/seller/products/{productId}/submit']?.post?.responses;
    for (const status of ['200', '400', '403', '404', '409', '422', '429', '503']) {
      expect(submit).toHaveProperty(status);
    }
  });

  it('adds the seller guards to the platform status table', () => {
    expect(OWN_PRODUCT_STATUS).toMatchObject({
      'seller.not-eligible': 403,
      'setting.product-creation-off': 422,
      'type.not-allowed': 422,
      'product.not-found': 404,
      'claim-text.refused': 422,
      'request.throttled': 429,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('creates a SELLER draft product owned by the session seller and logs the outcome', async () => {
      await boot();
      await seeded(code);

      const created = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple' },
        sessionOf(code),
      );

      expect(created.status).toBe(201);
      expect(added).toHaveLength(1);
      expect(created.body).toMatchObject({
        productId: added[0]!.state.id,
        productCode: 'P00000042',
      });
      expect((created.body as { variantIds: string[] }).variantIds).toHaveLength(1);
      expect(added[0]!.state).toMatchObject({
        scope: 'SELLER',
        ownerSellerId: SELLER,
        status: 'draft',
        marketId: code,
      });
      expect(
        logLines.find((l) => l.msg === 'catalog.own-product-create' && l.outcome),
      ).toMatchObject({ outcome: 'ok', marketId: code });
    });

    it('refuses without the CSRF token and without a session, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const noCsrf = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple' },
        { cookie: session.cookie },
      );
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(
        (await post(code, '/catalog/seller/products', { typeCode: 'simple' }, {})).status,
      ).toBe(401);
      expect(added).toHaveLength(0);
    });

    it('answers a seller who may not sell with 403 and a type the seller may not sell with 422', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      eligible = false;
      const notEligible = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple' },
        session,
      );
      expect(notEligible.status).toBe(403);
      expect(notEligible.body).toEqual({ statusCode: 403, code: 'seller.not-eligible' });

      eligible = true;
      allowed = new Set(['configurable']);
      const notAllowed = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple' },
        session,
      );
      expect(notAllowed.status).toBe(422);
      expect(notAllowed.body).toEqual({ statusCode: 422, code: 'type.not-allowed' });

      allowed = null;
      expect(
        (await post(code, '/catalog/seller/products', { typeCode: 'simple' }, session)).status,
      ).toBe(503);
      expect(added).toHaveLength(0);
    });

    it('refuses an unknown field, a missing field and an unknown type', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const extra = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple', sellerId: 'x' },
        session,
      );
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      expect((await post(code, '/catalog/seller/products', {}, session)).status).toBe(400);
      const unknown = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'hologram' },
        session,
      );
      expect(unknown.status).toBe(422);
      expect(unknown.body).toEqual({ statusCode: 422, code: 'product.type-not-offered' });
    });

    it('answers a spent budget with 429 and Retry-After', async () => {
      await boot();
      await seeded(code);
      reserve = { code: 'request.throttled', retryAfterSeconds: 17 };

      const throttled = await post(
        code,
        '/catalog/seller/products',
        { typeCode: 'simple' },
        sessionOf(code),
      );

      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBe('17');
      expect(throttled.body).toMatchObject({ code: 'request.throttled' });
      expect(added).toHaveLength(0);
    });

    it('saves a draft through the closed body and passes the path id as the product', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const saved = await put(
        code,
        `/catalog/seller/products/${PRODUCT}/draft`,
        { content: { texts: {} }, variantIds: [] },
        session,
      );

      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({ variantIds: [], refusedFields: [] });
      expect(saveCalls).toEqual([{ productId: PRODUCT, content: { texts: {} }, variantIds: [] }]);
      const extra = await put(
        code,
        `/catalog/seller/products/${PRODUCT}/draft`,
        { content: {}, variantIds: [], ownerSellerId: 'x' },
        session,
      );
      expect(extra.status).toBe(400);
      expect(saveCalls).toHaveLength(1);
    });

    it('answers a malformed product id as an unknown product, byte-identical', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const draft = await put(
        code,
        '/catalog/seller/products/not-an-id/draft',
        { content: {}, variantIds: [] },
        session,
      );
      const submit = await post(
        code,
        '/catalog/seller/products/not-an-id/submit',
        { replacePending: false },
        session,
      );

      expect(draft.status).toBe(404);
      expect(submit.status).toBe(404);
      expect(draft.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      expect(submit.body).toEqual(draft.body);
    });

    it('submits an own product, answers the revision and refuses another seller’s product', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const submitted = await post(
        code,
        `/catalog/seller/products/${PRODUCT}/submit`,
        { replacePending: false },
        session,
      );

      expect(submitted.status).toBe(200);
      expect(submitted.body).toEqual({
        revisionId: id<'ProductRevision'>(0xd002),
        revisionNo: 1,
        published: false,
      });
      expect(submitCalls).toEqual([{ productId: PRODUCT, replacePending: false }]);

      product = Product.restore({ ...state(code), ownerSellerId: id<'Seller'>(0xb999) });
      const other = await post(
        code,
        `/catalog/seller/products/${PRODUCT}/submit`,
        { replacePending: false },
        session,
      );
      expect(other.status).toBe(404);
      expect(other.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      expect(submitCalls).toHaveLength(1);
    });
  });
});
