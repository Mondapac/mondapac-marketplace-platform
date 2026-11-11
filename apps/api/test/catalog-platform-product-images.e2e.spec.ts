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
import { SaveWorkingCopy } from '../src/modules/catalog/application/working-copy/save-working-copy.service';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
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

// The admin photo routes of PLATFORM products over HTTP (P1 admin product images): the real
// guards, body parser pre-filter, controller, gate and use cases, with identity's ports, the
// product and photo stores and the object store as in-memory fakes. Proved here: the larger body
// for an admin session with the CSRF header only, the permission key, the closed body, a SELLER
// product refused as unknown, the statuses of the refusals and the round trip with the admin
// rendition read.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR = id<'Account'>(0xa201);
const NO_KEY = id<'Account'>(0xa202);
const EDITOR_ROLE = id<'Role'>(0xc0e1);
const NO_KEY_ROLE = id<'Role'>(0xc0e2);
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
  unreferencedObjectKeys() {
    return Promise.resolve([]);
  }
  listUnattached() {
    return Promise.resolve([]);
  }
  listMissingFormats() {
    return Promise.resolve([]);
  }
  addRenditions() {
    return Promise.resolve(true);
  }
  deleteUnused(_m: unknown, _p: unknown, imageId: string) {
    const index = this.rows.findIndex((row) => row.id === imageId);
    if (index < 0) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }
}

describe('admin platform product photo routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let product: Product | null;
  let reserve: unknown;
  let images: MemoryImages;
  let store: MemoryObjectStore;
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
          .useValue(new SharpImageProcessor())
          .overrideProvider(SaveWorkingCopy)
          .useValue({ reserveSaves: () => Promise.resolve(reserve) }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const state = (code: string, over: Partial<ProductState> = {}): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'PLATFORM',
    ownerSellerId: null,
    createdBySellerId: null,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'draft',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: null,
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
    ...over,
  });

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'img-0001'), {});
    const marketId = code as AccountState['marketId'];
    const role = (roleId: Id<'Role'>, name: string, permissionKeys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys,
        version: 1,
        createdAt: START,
      });
    role(EDITOR_ROLE, 'Product editor', ['catalog.platform-product.edit', 'catalog.product.view']);
    role(NO_KEY_ROLE, 'Viewer only', ['catalog.product.view']);
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
        id: id<'RoleAssignment'>(0xe100 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(EDITOR, 'editor', EDITOR_ROLE, 1);
    admin(NO_KEY, 'nokey', NO_KEY_ROLE, 2);
    product = Product.restore(state(code));
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf200 + n),
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

  const headers = (code: string, extra: Record<string, string>) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'admin'),
    ...extra,
  });
  const base = (productId: string) => `/catalog/admin/platform-products/${productId}/images`;
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
  });
  afterEach(async () => {
    await app?.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('takes a photo larger than 64 KiB, lists it, serves it through the admin read and deletes it', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, EDITOR, 1);
      const data = await photo();
      expect(data.length).toBeGreaterThan(64 * 1024);

      const created = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data })
        .expect(201);
      expect(created.body).toMatchObject({ width: 1600, height: 1200 });
      const imageId = (created.body as { imageId: string }).imageId;
      expect(images.rows[0]).toMatchObject({ uploaderAccountId: EDITOR, state: 'clean' });
      // Three sizes, each as JPEG, WebP and AVIF (the shared photo pipeline).
      expect(store.objects.size).toBe(9);

      const listed = await http().get(base(PRODUCT)).set(headers(code, session)).expect(200);
      expect(listed.headers['cache-control']).toContain('no-store');
      expect((listed.body as { images: { imageId: string }[] }).images).toEqual([
        expect.objectContaining({ imageId }),
      ]);

      const served = await http()
        .get(`/catalog/admin/products/${PRODUCT}/images/${imageId}/thumb`)
        .set(headers(code, session))
        .expect(200);
      expect(served.headers['content-type']).toBe('image/jpeg');
      expect((await sharp(served.body as Buffer).metadata()).width).toBe(240);

      await http()
        .delete(`${base(PRODUCT)}/${imageId}`)
        .set(headers(code, session))
        .expect(200);
      expect(images.rows).toHaveLength(0);
      expect(store.objects.size).toBe(0);
    });

    it('refuses an admin without catalog.platform-product.edit on every route', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, NO_KEY, 2);
      await http().get(base(PRODUCT)).set(headers(code, session)).expect(403);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(403);
      await http()
        .delete(`${base(PRODUCT)}/${id<'ProductImage'>(0xd001)}`)
        .set(headers(code, session))
        .expect(403);
      expect(store.objects.size).toBe(0);
    });

    it('answers a SELLER product, a retired one and a malformed id as 404 product.not-found', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, EDITOR, 1);
      product = Product.restore(
        state(code, { scope: 'SELLER', ownerSellerId: SELLER, createdBySellerId: SELLER }),
      );
      const seller = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(404);
      expect(seller.body).toMatchObject({ code: 'product.not-found' });
      await http().get(base(PRODUCT)).set(headers(code, session)).expect(404);
      product = Product.restore(state(code, { status: 'retired', retiredAt: START }));
      await http().get(base(PRODUCT)).set(headers(code, session)).expect(404);
      await http().get(base('not-a-uuid')).set(headers(code, session)).expect(404);
      expect(store.objects.size).toBe(0);
    });

    it('keeps the 64 KiB parser without the CSRF header and refuses the request', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, EDITOR, 1);
      const noCsrf = Object.fromEntries(
        Object.entries(session).filter(([name]) => name !== 'x-csrf-token'),
      );
      const response = await http()
        .post(base(PRODUCT))
        .set(headers(code, noCsrf))
        .send({ data: await photo() });
      expect(response.status).toBe(413);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, noCsrf))
        .send({ data: 'AAAA' })
        .expect(403);
      expect(store.objects.size).toBe(0);
    });

    it('refuses an unknown field, a non-image, the ninth photo, a photo in use and a throttled account', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, EDITOR, 1);
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

      reserve = { code: 'request.throttled', retryAfterSeconds: 7 };
      const slow = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(429);
      expect(slow.headers['retry-after']).toBe('7');
      reserve = null;

      for (let n = 0; n < 8; n += 1) {
        images.rows.push({
          id: id<'ProductImage'>(0xd100 + n),
          productId: PRODUCT,
          uploaderAccountId: EDITOR,
          state: 'clean',
          width: 400,
          height: 400,
          uploadedBytes: 1,
          createdAt: START,
          renditions: [],
        } as unknown as ProductImage);
      }
      const full = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(400, 400) })
        .expect(409);
      expect(full.body).toMatchObject({ code: 'image.limit-reached' });

      images.deleteUnused = () => Promise.resolve(false);
      const held = await http()
        .delete(`${base(PRODUCT)}/${id<'ProductImage'>(0xd100)}`)
        .set(headers(code, session))
        .expect(409);
      expect(held.body).toMatchObject({ code: 'image.in-use' });
      expect(images.rows).toHaveLength(8);
    });

    it('answers 401 without a session or with a seller cookie, and 403 on a DELETE without CSRF', async () => {
      await boot();
      await seeded(code);
      await http().get(base(PRODUCT)).set(headers(code, {})).expect(401);
      await http()
        .get(base(PRODUCT))
        .set(headers(code, { cookie: `__Host-session-seller-${code}=not-a-session` }))
        .expect(401);
      const session = sessionOf(code, EDITOR, 1);
      images.rows.push({
        id: id<'ProductImage'>(0xd300),
        productId: PRODUCT,
        uploaderAccountId: EDITOR,
        state: 'clean',
        width: 400,
        height: 400,
        uploadedBytes: 1,
        createdAt: START,
        renditions: [],
      } as unknown as ProductImage);
      await http()
        .delete(`${base(PRODUCT)}/${id<'ProductImage'>(0xd300)}`)
        .set(headers(code, { cookie: session.cookie }))
        .expect(403);
      expect(images.rows).toHaveLength(1);
    });

    it('refuses a body over the photo limit with 413 and a picture too small with 422', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, EDITOR, 1);
      await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: 'A'.repeat(6_200_000) })
        .expect(413);
      const tiny = await http()
        .post(base(PRODUCT))
        .set(headers(code, session))
        .send({ data: await photo(64, 64) })
        .expect(422);
      expect(tiny.body).toMatchObject({ code: 'file.too-small' });
      expect(store.objects.size).toBe(0);
    });

    it('answers a discarded product as 404', async () => {
      await boot();
      await seeded(code);
      product = Product.restore(state(code, { status: 'discarded', discardedAt: START }));
      await http()
        .post(base(PRODUCT))
        .set(headers(code, sessionOf(code, EDITOR, 1)))
        .send({ data: 'AAAA' })
        .expect(404);
    });

    it('will not delete a taken-down photo', async () => {
      await boot();
      await seeded(code);
      images.rows.push({
        id: id<'ProductImage'>(0xd200),
        productId: PRODUCT,
        uploaderAccountId: EDITOR,
        state: 'taken-down',
        width: 400,
        height: 400,
        uploadedBytes: 1,
        createdAt: START,
        renditions: [],
      } as unknown as ProductImage);
      await http()
        .delete(`${base(PRODUCT)}/${id<'ProductImage'>(0xd200)}`)
        .set(headers(code, sessionOf(code, EDITOR, 1)))
        .expect(404);
      expect(images.rows).toHaveLength(1);
    });
  });
});
