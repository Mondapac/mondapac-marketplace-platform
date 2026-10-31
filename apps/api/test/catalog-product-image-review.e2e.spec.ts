import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  PRODUCT_IMAGE_REPOSITORY,
  type ProductImage,
  type ProductImageRepository,
  type RevisionImage,
  type TakedownMark,
} from '../src/modules/catalog/application/ports/product-image.repository';
import { PRODUCT_REVISION_REPOSITORY } from '../src/modules/catalog/application/ports/product-revision.repository';
import { PRODUCT_IMAGE_REVIEW_STATUS } from '../src/modules/catalog/presentation/product-image-review.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { MemoryObjectStore } from '../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../src/platform/storage/object-store';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The reviewer's photo routes over HTTP (catalog slice 13 leftovers): the photos of a revision, a
// rendition of one photo and the takedown. Real guards, controller, gate and use cases; identity's
// ports, the photo and revision stores and the object store are in-memory fakes. Proved here: the
// admin session, the CSRF token, the two keys (the seeded Moderator and Viewer roles), the closed
// body, the status of each refusal, the headers of a served photo and the takedown's effects.

const START = Temporal.Instant.from('2026-10-17T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const NO_KEY = id<'Account'>(0xa003);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);
const PRODUCT = id<'Product'>(0xc101);
const OTHER_PRODUCT = id<'Product'>(0xc102);
const REVISION = id<'ProductRevision'>(0xd101);
const IMAGE_A = id<'ProductImage'>(0x1a01);
const IMAGE_B = id<'ProductImage'>(0x1a02);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the admin photo routes to its exact status', () => {
  expect(PRODUCT_IMAGE_REVIEW_STATUS).toEqual({
    'validation.failed': 400,
    'image.not-found': 404,
    'revision.not-found': 404,
    'access.unavailable': 503,
  });
});

class MemoryImages implements ProductImageRepository {
  rows: ProductImage[] = [];
  marks = new Map<string, TakedownMark>();
  revisionImages: RevisionImage[] = [];
  add() {
    return Promise.resolve();
  }
  list() {
    return Promise.resolve(this.rows);
  }
  find(_m: unknown, productId: string, imageId: string) {
    return Promise.resolve(
      this.rows.find((row) => row.id === imageId && row.productId === productId) ?? null,
    );
  }
  cleanIdsOf() {
    return Promise.resolve(new Set<string>());
  }
  listForRevision() {
    return Promise.resolve(
      this.revisionImages.map((image) => ({
        ...image,
        state: this.rows.find((row) => row.id === image.imageId)!.state,
      })),
    );
  }
  takeDown(_m: unknown, productId: string, imageId: string, mark: TakedownMark) {
    const index = this.rows.findIndex(
      (row) => row.id === imageId && row.productId === productId && row.state === 'clean',
    );
    if (index < 0) return Promise.resolve(false);
    this.rows[index] = { ...this.rows[index]!, state: 'taken-down' };
    this.marks.set(imageId, mark);
    return Promise.resolve(true);
  }
  unreferencedObjectKeys() {
    return Promise.resolve([]);
  }
  listUnattached() {
    return Promise.resolve([]);
  }
  deleteUnused() {
    return Promise.resolve(false);
  }
}

describe('reviewer photo routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let images: MemoryImages;
  let store: MemoryObjectStore;
  let events: PendingEvent[];
  const http = () => request(app.getHttpServer());

  const imageRow = (imageId: Id<'ProductImage'>, productId = PRODUCT): ProductImage => ({
    id: imageId,
    productId,
    uploaderAccountId: id<'Account'>(0xa900),
    state: 'clean',
    width: 600,
    height: 400,
    uploadedBytes: 1000,
    createdAt: START,
    renditions: (['thumb', 'medium', 'large'] as const).map((size) => ({
      size,
      objectKey: `${productId}/${imageId}/${size}`,
      sha256: Buffer.alloc(32),
      byteSize: 5,
      width: 100,
      height: 60,
    })),
  });

  async function boot() {
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
          .overrideProvider(OUTBOX_WRITER)
          .useValue({
            append: (_c: CallContext, pending: readonly PendingEvent[]) => {
              events.push(...pending);
              return Promise.resolve();
            },
          })
          .overrideProvider(PRODUCT_IMAGE_REPOSITORY)
          .useValue(images)
          .overrideProvider(OBJECT_STORE)
          .useValue(store)
          .overrideProvider(PRODUCT_REVISION_REPOSITORY)
          .useValue({
            find: (
              _m: MarketContext,
              productId: Id<'Product'>,
              revisionId: Id<'ProductRevision'>,
            ) =>
              Promise.resolve(
                productId === PRODUCT && revisionId === REVISION
                  ? ({ id: revisionId } as never)
                  : null,
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'image-0001'), {});
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
    const seedRole = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    let n = 0;
    const admin = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
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
    };
    admin(MODERATOR, 'moderator', seedRole('catalogue-moderator'));
    admin(VIEWER, 'viewer', seedRole('viewer'));
    admin(NO_KEY, 'nokey', NO_KEY_ROLE);
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

  const base = (code: string) => ({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
  const get = (code: string, path: string, session: Record<string, string> | null) =>
    http()
      .get(`/catalog/admin/products/${path}`)
      .set({ ...base(code), ...(session === null ? {} : { cookie: session.cookie! }) });
  const post = (code: string, path: string, session: Record<string, string>, payload?: unknown) =>
    http()
      .post(`/catalog/admin/products/${path}`)
      .set({ ...base(code), ...session })
      .send(payload ?? {});
  const listPath = `${PRODUCT}/revisions/${REVISION}/images`;
  const readPath = (imageId = IMAGE_A, size = 'medium', productId = PRODUCT) =>
    `${productId}/images/${imageId}/${size}`;
  const takeDownPath = (imageId = IMAGE_A, productId = PRODUCT) =>
    `${productId}/images/${imageId}/take-down`;

  beforeEach(async () => {
    fakes.reset();
    clock = new FixedClock(START);
    events = [];
    store = new MemoryObjectStore();
    images = new MemoryImages();
    images.rows = [imageRow(IMAGE_A), imageRow(IMAGE_B)];
    images.revisionImages = [
      { imageId: IMAGE_B, position: 1, state: 'clean', width: 600, height: 400 },
      { imageId: IMAGE_A, position: 2, state: 'clean', width: 600, height: 400 },
    ];
    for (const row of images.rows) {
      for (const rendition of row.renditions) {
        await store.put(rendition.objectKey, Buffer.from('jpeg'));
      }
    }
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the routes and their error codes in OpenAPI', async () => {
    await boot();
    await app.close();
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const listed =
      document.paths['/catalog/admin/products/{productId}/revisions/{revisionId}/images'];
    const read = document.paths['/catalog/admin/products/{productId}/images/{imageId}/{size}'];
    const down = document.paths['/catalog/admin/products/{productId}/images/{imageId}/take-down'];
    for (const status of ['200', '400', '403', '404', '503']) {
      expect(listed?.get?.responses).toHaveProperty(status);
      expect(read?.get?.responses).toHaveProperty(status);
      expect(down?.post?.responses).toHaveProperty(status);
    }
    // Boots the application twice: allow for a loaded machine.
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the photos of a revision in order for a viewer, with no-store', async () => {
      await boot();
      await seeded(code);
      const response = await get(code, listPath, sessionOf(code, VIEWER, 1));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        images: [
          { imageId: IMAGE_B, position: 1, state: 'clean', width: 600, height: 400 },
          { imageId: IMAGE_A, position: 2, state: 'clean', width: 600, height: 400 },
        ],
      });
    });

    it('refuses no session, a role without the key and bad ids; an unknown revision is 404', async () => {
      await boot();
      await seeded(code);
      expect((await get(code, listPath, null)).status).toBe(401);
      expect((await get(code, listPath, sessionOf(code, NO_KEY, 2))).status).toBe(403);
      const viewer = sessionOf(code, VIEWER, 3);
      expect((await get(code, `${PRODUCT}/revisions/not-an-id/images`, viewer)).status).toBe(400);
      const unknown = await get(code, `${PRODUCT}/revisions/${id(0xd999)}/images`, viewer);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'revision.not-found' });
      const other = await get(code, `${OTHER_PRODUCT}/revisions/${REVISION}/images`, viewer);
      expect(other.status).toBe(404);
    });

    it('serves a rendition with the seller route headers and refuses what is not a rendition', async () => {
      await boot();
      await seeded(code);
      const viewer = sessionOf(code, VIEWER, 1);
      const response = await get(code, readPath(), viewer);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe('sandbox');
      expect((await get(code, readPath(IMAGE_A, 'huge'), viewer)).status).toBe(400);
      expect((await get(code, readPath(id(0x1abc)), viewer)).status).toBe(404);
      expect((await get(code, readPath(IMAGE_A, 'medium', OTHER_PRODUCT), viewer)).status).toBe(
        404,
      );
      expect((await get(code, readPath(), null)).status).toBe(401);
      expect((await get(code, readPath(), sessionOf(code, NO_KEY, 2))).status).toBe(403);
    });

    it('takes a photo down: forbidden for a viewer, needs CSRF, closed body, one event, files gone', async () => {
      await boot();
      await seeded(code);
      const moderator = sessionOf(code, MODERATOR, 1);

      const viewerTry = await post(code, takeDownPath(), sessionOf(code, VIEWER, 2), {
        reasonCode: 'misleading',
      });
      expect(viewerTry.status).toBe(403);
      const noCsrf = await http()
        .post(`/catalog/admin/products/${takeDownPath()}`)
        .set({ ...base(code), cookie: moderator.cookie })
        .send({ reasonCode: 'misleading' });
      expect(noCsrf.status).toBe(403);
      expect((await post(code, takeDownPath(), moderator, { reasonCode: 'nope' })).status).toBe(
        400,
      );
      expect(
        (await post(code, takeDownPath(), moderator, { reasonCode: 'rights', extra: 1 })).status,
      ).toBe(400);
      expect(
        (await post(code, takeDownPath(id(0x1abc)), moderator, { reasonCode: 'rights' })).status,
      ).toBe(404);
      expect(events).toHaveLength(0);

      const done = await post(code, takeDownPath(), moderator, {
        reasonCode: 'certification-mark',
      });
      expect(done.status).toBe(200);
      expect(done.body).toEqual({ takenDown: true });
      expect(images.marks.get(IMAGE_A)).toMatchObject({
        byAccountId: MODERATOR,
        reasonCode: 'certification-mark',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.image-taken-down.v1',
        aggregateId: IMAGE_A,
        payload: { productId: PRODUCT, imageId: IMAGE_A, reasonCode: 'certification-mark' },
      });
      expect([...store.objects.keys()].some((key) => key.includes(IMAGE_A))).toBe(false);
      expect([...store.objects.keys()].some((key) => key.includes(IMAGE_B))).toBe(true);

      // Repeating succeeds and writes no second event.
      const again = await post(code, takeDownPath(), moderator, { reasonCode: 'other' });
      expect(again.status).toBe(200);
      expect(events).toHaveLength(1);

      // The photo is no longer served, but the revision list still shows it as taken down.
      const viewer = sessionOf(code, VIEWER, 4);
      expect((await get(code, readPath(), viewer)).status).toBe(404);
      const listed = await get(code, listPath, viewer);
      expect((listed.body as { images: { imageId: string; state: string }[] }).images).toEqual([
        expect.objectContaining({ imageId: IMAGE_B, state: 'clean' }),
        expect.objectContaining({ imageId: IMAGE_A, state: 'taken-down' }),
      ]);
    });
  });
});
