import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import sharp from 'sharp';
import { IMAGE_PROCESSOR } from '../src/modules/catalog/application/ports/image-processor';
import { SharpImageProcessor } from '../src/modules/catalog/infrastructure/sharp-image-processor';
import { PRODUCT_IMAGE_REPOSITORY } from '../src/modules/catalog/application/ports/product-image.repository';
import type {
  ProductImage,
  ProductImageRepository,
} from '../src/modules/catalog/application/ports/product-image.repository';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SaveWorkingCopy } from '../src/modules/catalog/application/working-copy/save-working-copy.service';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { PRODUCT_IMAGE_STATUS } from '../src/modules/catalog/presentation/product-image.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { MemoryObjectStore } from '../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../src/platform/storage/object-store';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller photo routes over HTTP (catalog slice 13): the real guards, body parser, controller,
// gate and use cases, with identity's ports, the product and photo stores and the object store as
// in-memory fakes. Proved here: the larger body of the upload route and no other, the session,
// the CSRF token, the closed body, the status of each refusal and the headers of a served photo.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
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

class MemoryImages implements ProductImageRepository {
  readonly rows: ProductImage[] = [];
  add(_m: unknown, image: ProductImage) {
    this.rows.push(image);
    return Promise.resolve();
  }
  list() {
    return Promise.resolve(this.rows);
  }
  find(_m: unknown, _p: unknown, imageId: string) {
    return Promise.resolve(this.rows.find((row) => row.id === imageId) ?? null);
  }
  cleanIdsOf() {
    return Promise.resolve(new Set<string>());
  }
  listForRevision() {
    return Promise.resolve([]);
  }
  takeDown() {
    return Promise.resolve(false);
  }
  listUnattached() {
    return Promise.resolve([]);
  }
  deleteUnused(_m: unknown, _p: unknown, imageId: string) {
    const index = this.rows.findIndex((row) => row.id === imageId);
    if (index < 0) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }
}

describe('seller photo routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let product: Product | null;
  let reserve: unknown;
  let images: MemoryImages;
  let store: MemoryObjectStore;
  // When true the picture processor answers busy, as a saturated decode queue does.
  let busy = false;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(product) })
          .overrideProvider(PRODUCT_IMAGE_REPOSITORY)
          .useValue(images)
          .overrideProvider(OBJECT_STORE)
          .useValue(store)
          .overrideProvider(IMAGE_PROCESSOR)
          .useValue({
            process: (bytes: Buffer) =>
              busy
                ? Promise.resolve({ ok: false, error: { code: 'file.busy' } })
                : new SharpImageProcessor().process(bytes),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(true) })
          .overrideProvider(SaveWorkingCopy)
          .useValue({ reserveSaves: () => Promise.resolve(reserve) }),
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
  const base = (id: string) => `/catalog/seller/products/${id}/images`;
  // Noise does not compress, so the base64 body is well past the 64 KiB JSON limit.
  const photo = (width = 1600, height = 1200) =>
    sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer()
      .then((bytes) => bytes.toString('base64'));

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    product = null;
    reserve = null;
    images = new MemoryImages();
    store = new MemoryObjectStore();
    busy = false;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the photo refusals to their statuses', () => {
    expect(PRODUCT_IMAGE_STATUS).toMatchObject({
      'image.not-found': 404,
      'image.in-use': 409,
      'image.limit-reached': 409,
      'file.too-large': 413,
      'file.unsupported-type': 415,
      'file.too-many-pixels': 422,
      'file.unreadable': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('takes a photo larger than 64 KiB, stores it and serves it back as a plain JPEG', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const data = await photo();
      expect(data.length).toBeGreaterThan(64 * 1024);

      const created = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data })
        .expect(201);
      expect(created.body).toMatchObject({ width: 1600, height: 1200 });
      const imageId = (created.body as { imageId: string }).imageId;

      const served = await http()
        .get(`${base(PRODUCT)}/${imageId}/thumb`)
        .set(headers(code, session))
        .expect(200);
      expect(served.headers['content-type']).toBe('image/jpeg');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['cache-control']).toContain('no-store');
      expect(served.headers['content-security-policy']).toContain('sandbox');
      expect((await sharp(served.body as Buffer).metadata()).width).toBe(240);

      const listed = await http().get(base(PRODUCT)).set(headers(code, session)).expect(200);
      expect((listed.body as { images: unknown[] }).images).toHaveLength(1);

      await http()
        .delete(`${base(PRODUCT)}/${imageId}`)
        .set(headers(code, session))
        .expect(200);
      expect(images.rows).toHaveLength(0);
    });

    it('refuses a body over the photo limit with 413 and nothing stored', async () => {
      await boot();
      await seeded(code);
      const response = await http()
        .post(base(PRODUCT))
        .set(headers(code, sessionOf(code)))
        .send({ data: 'A'.repeat(6_200_000) });
      expect(response.status).toBe(413);
      expect(store.objects.size).toBe(0);
    });

    it('answers 503 access.unavailable with Retry-After when the decode queue is full, and stores nothing', async () => {
      await boot();
      await seeded(code);
      busy = true;

      const response = await http()
        .post(base(PRODUCT))
        .set(headers(code, sessionOf(code)))
        .send({ data: await photo(800, 600) });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'access.unavailable' });
      expect(response.headers['retry-after']).toBe('2');
      expect(store.objects.size).toBe(0);
      expect(images.rows).toHaveLength(0);
    });

    it('keeps the 64 KiB limit on every other JSON route', async () => {
      await boot();
      await seeded(code);
      const response = await http()
        .put(`/catalog/seller/products/${PRODUCT}/draft`)
        .set(headers(code, sessionOf(code)))
        .send({ content: { filler: 'x'.repeat(70_000) }, variantIds: [] });
      expect(response.status).toBe(413);
    });

    it('refuses a missing CSRF token, a wrong content type, an unknown field and a non-image', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const noCsrf = Object.fromEntries(
        Object.entries(session).filter(([name]) => name !== 'x-csrf-token'),
      );
      await http()
        .post(base(PRODUCT))
        .set(headers(code, noCsrf))
        .send({ data: await photo(400, 400) })
        .expect(403);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, { ...session, 'content-type': 'text/plain' }))
        .send('hello')
        .expect(415);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400), extra: 1 })
        .expect(400);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: Buffer.from('not an image at all').toString('base64') })
        .expect(415);
      expect(store.objects.size).toBe(0);
    });

    it("answers another seller's product as 404 and a throttled account as 429", async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      product = Product.restore({ ...state(code), ownerSellerId: id<'Seller'>(0xb099) });
      await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(404);
      product = Product.restore(state(code));
      reserve = { code: 'request.throttled', retryAfterSeconds: 7 };
      const slow = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(429);
      expect(slow.headers['retry-after']).toBe('7');
    });
  });
});
