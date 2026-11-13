import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ADMIN_CATEGORY_READER } from '../src/modules/catalog/application/ports/admin-category.reader';
import type { AdminCategoryReader } from '../src/modules/catalog/application/ports/admin-category.reader';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import {
  CATEGORY_ATTRIBUTE_LINK_STORE,
  type StoredLinkFact,
} from '../src/modules/catalog/application/ports/category-attribute-link.store';
import { CATEGORY_ADMIN_STATUS } from '../src/modules/catalog/presentation/category-admin.controller';
import {
  CATEGORY_EDIT_STORE,
  CATEGORY_RESTRUCTURE_STORE,
} from '../src/modules/catalog/application/ports/category-edit.store';
import { CATEGORY_RETIREMENT_CHECK } from '../src/modules/catalog/application/ports/category-retirement-check';
import type { CategoryRetirementCheck } from '../src/modules/catalog/application/ports/category-retirement-check';
import { CATEGORY_IMAGE_STORE } from '../src/modules/catalog/application/ports/category-image.store';
import { IMAGE_PROCESSOR } from '../src/modules/catalog/application/ports/image-processor';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { PLATFORM_CATEGORY_REPOSITORY } from '../src/modules/catalog/application/ports/platform-category.repository';
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
import {
  MemoryCategoryEditStore,
  MemoryCategoryRestructureStore,
  MemoryTreeVersion,
} from './support/catalog-category-editor-fakes';
import { MemoryCategoryImages } from './support/catalog-category-image-fakes';
import {
  featureSetRecord,
  MemoryAttributeAdminReader,
} from './support/catalog-attribute-admin-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin category read routes over HTTP (categories package C1): the real guards, the gate with
// the real role seed and the use cases; the category store as a fixed fake. Proved here, in both
// Market fixtures: no session is 401, an admin without the view key is 403, the Viewer reads but
// is told it cannot edit, the Catalogue Moderator is told it can edit but not restructure, an
// unknown and a malformed id are the same 404, the impact needs a known action, and the three
// routes are in OpenAPI.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOKEY = id<'Account'>(0xca01);
const VIEWER = id<'Account'>(0xca02);
const MODERATOR = id<'Account'>(0xca03);
const NOKEY_ROLE = id<'Role'>(0xcf11);
const RESTRUCTURER = id<'Account'>(0xca04);
const RESTRUCTURE_ROLE = id<'Role'>(0xcf12);
const ROOT = id<'Category'>(0xcc01);
const LEAF = id<'Category'>(0xcc02);
const MISSING = id<'Category'>(0xccff);
const SET_PANTRY = id<'AttributeFamily'>(0xfa01);

/** The links of each Market: the root holds a feature set, the leaf inherits it. */
let linkFacts = new Map<string, StoredLinkFact[]>();
const linkStore = {
  all: (market: { marketId: string }, limit: number) =>
    Promise.resolve((linkFacts.get(market.marketId) ?? []).slice(0, limit)),
};
const featureSets = new MemoryAttributeAdminReader();

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const editStore = new MemoryCategoryEditStore();
const categoryImages = new MemoryCategoryImages();
let imageFiles = new MemoryObjectStore();
/** Decodes nothing: three fixed renditions for any upload. */
const imageProcessor = {
  process: () =>
    Promise.resolve({
      ok: true as const,
      value: (['thumb', 'medium', 'large'] as const).map((size, index) => ({
        size,
        bytes: Buffer.from(`${size}-jpeg`),
        width: 400 * (index + 1),
        height: 300 * (index + 1),
      })),
    }),
};
const restructureStore = new MemoryCategoryRestructureStore();
let retirementAnswer: Awaited<ReturnType<CategoryRetirementCheck['assertRetirable']>>;
const retirementChecked: string[][] = [];
const retirement: CategoryRetirementCheck = {
  assertRetirable: (_context, ids) => {
    retirementChecked.push([...ids]);
    return Promise.resolve(retirementAnswer);
  },
  retired: () => Promise.resolve({ ok: true, value: undefined }),
};
const treeVersion = new MemoryTreeVersion();
const halalOnlyMatcher = {
  match: (_context: unknown, texts: readonly { text: string }[]) =>
    Promise.resolve({
      ok: true as const,
      value: texts.map((t) =>
        /halal/i.test(t.text) ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }] : [],
      ),
    }),
};

const reader: AdminCategoryReader = {
  categories: () =>
    Promise.resolve([
      {
        id: ROOT,
        parentId: null,
        slug: 'pantry',
        status: 'active' as const,
        mergedIntoId: null,
        names: [{ locale: 'en', name: 'Pantry' }],
        revisionNo: 1,
        version: 1,
        position: 0,
        showInMenu: true,
      },
      {
        id: LEAF,
        parentId: ROOT,
        slug: 'rice',
        status: 'active' as const,
        mergedIntoId: null,
        names: [{ locale: 'en', name: 'Rice' }],
        revisionNo: 1,
        version: 1,
        position: 0,
        showInMenu: true,
      },
    ]),
  treeVersion: () => Promise.resolve(4),
  productFacts: () =>
    Promise.resolve({
      facts: [{ categoryIds: [LEAF], offers: 2, listedOffers: 1, offersWithActiveTag: 1 }],
      complete: true,
    }),
  detail: () =>
    Promise.resolve({
      texts: [],
      seo: { title: null, description: null, noindex: false },
      showInMenu: true,
      imageId: null,
      hiddenById: null,
    }),
  revisions: (_m, categoryId) =>
    Promise.resolve(
      categoryId === ROOT || categoryId === LEAF
        ? [
            {
              revisionNo: 1,
              changeKind: 'created',
              authorKind: 'seed' as const,
              authorAccountId: null,
              parentId: null,
              names: [{ locale: 'en', name: 'Pantry' }],
              createdAt: START,
            },
          ]
        : [],
    ),
};

describe.each(TEST_MARKETS)(
  'admin category routes over HTTP in market %s (integration)',
  (code) => {
    let app: NestExpressApplication;
    const clock = new FixedClock(START);
    const http = () => request(app.getHttpServer());
    const market = testMarketContext(code, PLATFORM_TENANT_ID);

    beforeEach(async () => {
      fakes.reset();
      editStore.reset();
      categoryImages.reset();
      imageFiles = new MemoryObjectStore();
      restructureStore.products.clear();
      restructureStore.archiveOthers.clear();
      restructureStore.relinked.length = 0;
      retirementChecked.length = 0;
      retirementAnswer = { ok: true, value: undefined };
      treeVersion.version = 1;
      linkFacts = new Map([[code, [{ categoryId: ROOT, familyId: SET_PANTRY, filters: [] }]]]);
      featureSets.reset();
      featureSets.seedFeatureSet(
        code,
        featureSetRecord(SET_PANTRY, `pantry-${code.toLowerCase()}`, []),
      );
      ({ app } = await createTestApp({
        env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
        panelOrigins: true,
        override: (builder) =>
          fakes
            .override(builder)
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(ADMIN_CATEGORY_READER)
            .useValue(reader)
            .overrideProvider(CATEGORY_ATTRIBUTE_LINK_STORE)
            .useValue(linkStore)
            .overrideProvider(ATTRIBUTE_ADMIN_READER)
            .useValue(featureSets)
            .overrideProvider(CATEGORY_EDIT_STORE)
            .useValue(editStore)
            .overrideProvider(CATEGORY_RESTRUCTURE_STORE)
            .useValue(restructureStore)
            .overrideProvider(CATEGORY_RETIREMENT_CHECK)
            .useValue(retirement)
            .overrideProvider(PLATFORM_CATEGORY_REPOSITORY)
            .useValue(treeVersion)
            .overrideProvider(CATEGORY_IMAGE_STORE)
            .useValue(categoryImages)
            .overrideProvider(OBJECT_STORE)
            .useValue(imageFiles)
            .overrideProvider(IMAGE_PROCESSOR)
            .useValue(imageProcessor)
            .overrideProvider(CLAIM_TEXT_MATCHER)
            .useValue(halalOnlyMatcher)
            .overrideProvider(CLAIM_TERM_LOCALES)
            .useValue({
              covered: () =>
                Promise.resolve({ ok: true, value: ['en-AU', 'en-US', 'ja-JP', 'fa', 'ar'] }),
            }),
      }));
      await app.get(SeedRoles).execute(testCallContext(market, 'system', 'category-0001'), {});
      const marketId = code as AccountState['marketId'];
      const roleOf = (seedCode: string) =>
        [...fakes.roles.values()].find(
          (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
        )!.id;
      fakes.seedRole({
        id: NOKEY_ROLE,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Brand reader',
        permissionKeys: ['catalog.brand.read'],
        version: 1,
        createdAt: START,
      });
      fakes.seedRole({
        id: RESTRUCTURE_ROLE,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Tree restructurer',
        permissionKeys: [
          'catalog.category-tree.view',
          'catalog.category-tree.edit',
          'catalog.category-tree.restructure',
        ],
        version: 1,
        createdAt: START,
      });
      let n = 0;
      for (const [accountId, label, roleId] of [
        [NOKEY, 'nokey', NOKEY_ROLE],
        [RESTRUCTURER, 'restructurer', RESTRUCTURE_ROLE],
        [VIEWER, 'viewer', roleOf('viewer')],
        [MODERATOR, 'moderator', roleOf('catalogue-moderator')],
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
          id: id<'RoleAssignment'>(0xea80 + n),
          marketId,
          accountId,
          roleId,
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
      }
    });
    afterEach(async () => {
      await app?.close();
    });

    function adminSession(account: Id<'Account'>, n: number) {
      const issued = tokens.issue();
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: id<'Session'>(0xfa00 + n),
          marketId: code as AccountState['marketId'],
          accountId: account,
          population: 'admin',
          sellerId: null,
          transport: 'cookie',
          lifetime: LIFETIME,
          now: clock.now(),
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

    const BASE = '/catalog/admin/categories';

    it('maps the refusals of the routes to their status', () => {
      expect(CATEGORY_ADMIN_STATUS).toMatchObject({
        'category.not-found': 404,
        'validation.failed': 400,
        'catalog.categories-unavailable': 503,
      });
    });

    it('refuses no session with 401 and an admin without the view key with 403', async () => {
      await http()
        .get(BASE)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .expect(401);
      await http().get(BASE).set(adminSession(NOKEY, 1)).expect(403);
      await http().get(`${BASE}/${ROOT}`).set(adminSession(NOKEY, 2)).expect(403);
      await http()
        .get(`${BASE}/${ROOT}/impact?action=move`)
        .set(adminSession(NOKEY, 3))
        .expect(403);
    });

    it('lists the tree for the Viewer, who is told it cannot edit, import or export', async () => {
      const response = await http().get(BASE).set(adminSession(VIEWER, 4)).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as {
        treeVersion: number;
        complete: boolean;
        categories: { slug: string; depth: number; counts: { liveProducts: number } }[];
        actions: Record<string, { allowed: boolean; denial?: string }>;
      };
      expect(body.treeVersion).toBe(4);
      expect(body.complete).toBe(true);
      expect(body.categories.map((c) => [c.slug, c.depth, c.counts.liveProducts])).toEqual([
        ['pantry', 0, 1],
        ['rice', 1, 1],
      ]);
      expect(body.actions['platform-category.create']).toEqual({
        allowed: false,
        denial: 'access.permission-missing',
      });
      expect(body.actions['platform-category.import']?.allowed).toBe(false);
    });

    it('gives each row its effective feature set and filters by it', async () => {
      const response = await http().get(BASE).set(adminSession(VIEWER, 40)).expect(200);
      const rows = (
        response.body as {
          categories: {
            slug: string;
            featureSetId: string | null;
            featureSetCode: string | null;
            featureSetFromCategoryId: string | null;
            inherited: boolean;
          }[];
        }
      ).categories.map((c) => [
        c.slug,
        c.featureSetId,
        c.featureSetCode,
        c.featureSetFromCategoryId,
        c.inherited,
      ]);
      const setCode = `pantry-${code.toLowerCase()}`;
      expect(rows).toEqual([
        ['pantry', SET_PANTRY, setCode, ROOT, false],
        ['rice', SET_PANTRY, setCode, ROOT, true],
      ]);
      const other = await http()
        .get(`${BASE}?featureSetId=${id<'AttributeFamily'>(0xfa02)}`)
        .set(adminSession(VIEWER, 41))
        .expect(200);
      expect((other.body as { categories: unknown[] }).categories).toEqual([]);
      const same = await http()
        .get(`${BASE}?featureSetId=${SET_PANTRY}`)
        .set(adminSession(VIEWER, 42))
        .expect(200);
      expect((same.body as { categories: unknown[] }).categories).toHaveLength(2);
      const bad = await http()
        .get(`${BASE}?featureSetId=nope`)
        .set(adminSession(VIEWER, 43))
        .expect(400);
      expect(bad.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'featureSetId', code: 'format' }] },
      });
      await http().get(`${BASE}?status=active`).set(adminSession(VIEWER, 44)).expect(400);
    });

    it("reads another Market's links as none", async () => {
      linkFacts = new Map([['OTHER', [{ categoryId: ROOT, familyId: SET_PANTRY, filters: [] }]]]);
      const response = await http().get(BASE).set(adminSession(VIEWER, 45)).expect(200);
      const body = response.body as { categories: { featureSetId: string | null }[] };
      expect(body.categories.map((c) => c.featureSetId)).toEqual([null, null]);
    });

    it('tells the Catalogue Moderator it can edit but not restructure', async () => {
      const response = await http()
        .get(`${BASE}/${LEAF}`)
        .set(adminSession(MODERATOR, 5))
        .expect(200);
      const body = response.body as {
        category: { slug: string };
        path: { slug: string }[];
        missingLocales: string[];
        revisions: unknown[];
        actions: Record<string, { allowed: boolean; denial?: string }>;
      };
      expect(body.category.slug).toBe('rice');
      expect(body.path.map((p) => p.slug)).toEqual(['pantry', 'rice']);
      expect(body.revisions).toHaveLength(1);
      expect(body.actions['platform-category.rename']).toEqual({ allowed: true });
      expect(body.actions['platform-category.move']).toEqual({
        allowed: false,
        denial: 'access.permission-missing',
      });
    });

    it('answers the same 404 for an unknown and a malformed id', async () => {
      const session = adminSession(VIEWER, 6);
      const unknown = await http().get(`${BASE}/${MISSING}`).set(session).expect(404);
      const malformed = await http().get(`${BASE}/not-an-id`).set(session).expect(404);
      expect(malformed.text).toBe(unknown.text);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'category.not-found' });
      const impact = await http()
        .get(`${BASE}/${MISSING}/impact?action=move`)
        .set(session)
        .expect(404);
      expect(impact.body).toEqual({ statusCode: 404, code: 'category.not-found' });
    });

    it('reports the impact and refuses a missing or unknown action with 400', async () => {
      const session = adminSession(VIEWER, 7);
      const response = await http()
        .get(`${BASE}/${ROOT}/impact?action=archive`)
        .set(session)
        .expect(200);
      expect(response.body).toEqual({
        action: 'archive',
        products: 1,
        directProducts: 0,
        offers: 2,
        listedOffers: 1,
        offersWithActiveTag: 1,
        descendants: 1,
        complete: true,
      });
      await http().get(`${BASE}/${ROOT}/impact`).set(session).expect(400);
      await http().get(`${BASE}/${ROOT}/impact?action=delete`).set(session).expect(400);
    });

    describe('the editor routes (C3a)', () => {
      const english = code === 'AU' ? 'en-AU' : 'ja-JP';
      const body = (over: Record<string, unknown> = {}) => ({
        slug: 'rice',
        texts: { [english]: { name: 'Rice' } },
        treeVersion: treeVersion.version,
        ...over,
      });

      it('maps the refusals of the editor to their status', () => {
        expect(CATEGORY_ADMIN_STATUS).toMatchObject({
          'conflict.stale': 409,
          'category.slug-taken': 409,
          'category.reorder-edge': 409,
          'category.depth-exceeded': 422,
          'category.claim-word': 422,
          'claim-text.check-unavailable': 503,
        });
      });

      it('refuses no session with 401, a Viewer with 403, a missing CSRF token with 403, a body that is not JSON with 415', async () => {
        await http()
          .post(BASE)
          .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
          .send(body())
          .expect(401);
        await http().post(BASE).set(adminSession(VIEWER, 20)).send(body()).expect(403);
        const moderator = adminSession(MODERATOR, 21);
        const withoutCsrf: Record<string, string> = { ...moderator };
        delete withoutCsrf['x-csrf-token'];
        await http().post(BASE).set(withoutCsrf).send(body()).expect(403);
        await http()
          .post(BASE)
          .set({ ...moderator, 'content-type': 'text/plain' })
          .send('x')
          .expect(415);
        expect(editStore.rows.size).toBe(0);
      });

      it('refuses a Viewer with 403 on every write route, and writes nothing', async () => {
        const viewer = adminSession(VIEWER, 24);
        const target = '01990000-0000-7000-8000-0000000000c9';
        await http()
          .patch(`${BASE}/${target}`)
          .set(viewer)
          .send({ version: 1, texts: {} })
          .expect(403);
        const posts: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
          ['reorder', { direction: 'up', treeVersion: 1 }],
          ['hide', { treeVersion: 1 }],
          ['show', { treeVersion: 1 }],
          ['change-slug', { slug: 'other', treeVersion: 1 }],
          ['discard', { treeVersion: 1 }],
        ];
        for (const [action, payload] of posts) {
          await http().post(`${BASE}/${target}/${action}`).set(viewer).send(payload).expect(403);
        }
        expect(editStore.rows.size).toBe(0);
      });

      it('adds a category (201, hidden), shows it, saves its details and reorders', async () => {
        const session = adminSession(MODERATOR, 22);
        const created = await http().post(BASE).set(session).send(body()).expect(201);
        const {
          id: newId,
          status,
          treeVersion: afterCreate,
        } = (created.body as { category: { id: string; status: string; treeVersion: number } })
          .category;
        expect(status).toBe('hidden');
        expect(afterCreate).toBe(2);

        const shown = await http()
          .post(`${BASE}/${newId}/show`)
          .set(session)
          .send({ treeVersion: afterCreate })
          .expect(200);
        expect(shown.body).toMatchObject({ category: { status: 'active', treeVersion: 3 } });

        const saved = await http()
          .patch(`${BASE}/${newId}`)
          .set(session)
          .send({
            version: 2,
            texts: { [english]: { name: 'Basmati', keywords: ['rice'] } },
            showInMenu: false,
          })
          .expect(200);
        expect(saved.body).toMatchObject({ category: { version: 3, revisionNo: 3 } });

        await http()
          .post(`${BASE}/${newId}/reorder`)
          .set(session)
          .send({ direction: 'up', treeVersion: 3 })
          .expect(409)
          .expect((response) => {
            expect((response.body as { code: string }).code).toBe('category.reorder-edge');
          });
      });

      it('answers 409 for a stale tree and a taken slug, 422 for a claim word, 400 for an unknown field', async () => {
        const session = adminSession(MODERATOR, 23);
        await http().post(BASE).set(session).send(body()).expect(201);
        const stale = await http()
          .post(BASE)
          .set(session)
          .send(body({ slug: 'rice-2', treeVersion: 1 }))
          .expect(409);
        expect(stale.body).toEqual({ statusCode: 409, code: 'conflict.stale' });
        const taken = await http()
          .post(BASE)
          .set(session)
          .send(body({ treeVersion: treeVersion.version, texts: { [english]: { name: 'Other' } } }))
          .expect(409);
        expect(taken.body).toEqual({ statusCode: 409, code: 'category.slug-taken' });
        const claim = await http()
          .post(BASE)
          .set(session)
          .send(
            body({
              slug: 'halal-corner',
              treeVersion: treeVersion.version,
              texts: { [english]: { name: 'Halal corner' } },
            }),
          )
          .expect(422);
        expect(claim.body).toMatchObject({ code: 'category.claim-word' });
        expect(JSON.stringify(claim.body)).not.toMatch(/halal corner/i);
        await http()
          .post(BASE)
          .set(session)
          .send(body({ colour: 'red' }))
          .expect(400);
        await http().post(BASE).set(session).send({ slug: 'x' }).expect(400);
      });

      it('answers 404 for an unknown category and 400 for a malformed body of hide', async () => {
        const session = adminSession(MODERATOR, 24);
        await http()
          .post(`${BASE}/${MISSING}/hide`)
          .set(session)
          .send({ treeVersion: treeVersion.version })
          .expect(404);
        await http().post(`${BASE}/${MISSING}/hide`).set(session).send({}).expect(400);
      });
    });

    describe('the image routes (C3c)', () => {
      const DATA = 'AAAA';

      it('maps the refusals of the image routes to their status', () => {
        expect(CATEGORY_ADMIN_STATUS).toMatchObject({
          'image.not-found': 404,
          'file.too-large': 413,
          'file.unsupported-type': 415,
          'file.unreadable': 422,
        });
      });

      it('sets, serves, replaces and removes the image of a category', async () => {
        categoryImages.rows.set(LEAF, { status: 'active', version: 3, image: null });
        const session = adminSession(MODERATOR, 30);
        const set = await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(session)
          .send({ version: 3, data: DATA })
          .expect(200);
        const first = set.body as {
          category: { version: number; treeVersion: number };
          image: { imageId: string; width: number; height: number };
        };
        expect(first.category.version).toBe(4);
        expect(first.image).toMatchObject({ width: 1200, height: 900 });

        const served = await http()
          .get(`${BASE}/${LEAF}/images/${first.image.imageId}/medium`)
          .set(adminSession(VIEWER, 31))
          .expect(200);
        expect(served.headers['content-type']).toBe('image/jpeg');
        expect(served.headers['cache-control']).toBe('private, no-store');
        expect(served.headers['content-security-policy']).toBe('sandbox');
        expect(Buffer.from(served.body as Buffer).toString()).toBe('medium-jpeg');

        const replaced = await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(session)
          .send({ version: 4, data: DATA })
          .expect(200);
        const second = replaced.body as { image: { imageId: string } };
        expect(second.image.imageId).not.toBe(first.image.imageId);
        await http()
          .get(`${BASE}/${LEAF}/images/${first.image.imageId}/medium`)
          .set(adminSession(VIEWER, 32))
          .expect(404);

        const removed = await http()
          .post(`${BASE}/${LEAF}/image/remove`)
          .set(session)
          .send({ version: 5 })
          .expect(200);
        expect(removed.body).toMatchObject({ category: { version: 6 }, image: null });
        expect(imageFiles.objects.size).toBe(0);
      });

      it('answers 409 for a stale version and 404 for an unknown category, and writes no file', async () => {
        categoryImages.rows.set(LEAF, { status: 'active', version: 3, image: null });
        const session = adminSession(MODERATOR, 33);
        const stale = await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(session)
          .send({ version: 2, data: DATA })
          .expect(409);
        expect(stale.body).toEqual({ statusCode: 409, code: 'conflict.stale' });
        await http()
          .put(`${BASE}/${MISSING}/image`)
          .set(session)
          .send({ version: 1, data: DATA })
          .expect(404);
        await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(session)
          .send({ version: 3, data: DATA, colour: 'red' })
          .expect(400);
        expect(imageFiles.objects.size).toBe(0);
      });

      it('refuses a Viewer with 403 on both image writes and no session with 401', async () => {
        categoryImages.rows.set(LEAF, { status: 'active', version: 3, image: null });
        const viewer = adminSession(VIEWER, 34);
        await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(viewer)
          .send({ version: 3, data: DATA })
          .expect(403);
        await http()
          .post(`${BASE}/${LEAF}/image/remove`)
          .set(viewer)
          .send({ version: 3 })
          .expect(403);
        await http()
          .put(`${BASE}/${LEAF}/image`)
          .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
          .send({ version: 3, data: DATA })
          .expect(401);
        await http()
          .get(`${BASE}/${LEAF}/images/${MISSING}/thumb`)
          .set(adminSession(NOKEY, 35))
          .expect(403);
        expect(categoryImages.rows.get(LEAF)?.version).toBe(3);
      });

      it('takes a picture larger than the 64 KiB JSON limit on the image route only', async () => {
        categoryImages.rows.set(LEAF, { status: 'active', version: 3, image: null });
        const session = adminSession(MODERATOR, 36);
        // 200 KB of base64: over the JSON parser's limit, under the image route's.
        const large = 'A'.repeat(200 * 1024);
        await http()
          .put(`${BASE}/${LEAF}/image`)
          .set(session)
          .send({ version: 3, data: large })
          .expect(200);
        await http()
          .post(`${BASE}/${LEAF}/image/remove`)
          .set(session)
          .send({ version: 4, data: large })
          .expect(413);
      });
    });

    describe('the restructure routes (C4a)', () => {
      const REASON = 'Pantry aisle reorganised';
      const stored = (n: number, parent: number | null, position = n) => ({
        id: id<'Category'>(n),
        parentId: parent === null ? null : id<'Category'>(parent),
        slug: `c${n.toString(16)}`,
        status: 'active' as const,
        hiddenById: null,
        position,
        version: 1,
        revisionNo: 1,
        createdByKind: 'admin' as const,
        showInMenu: true,
        imageId: null,
        seo: { title: null, description: null, noindex: false },
        texts: [
          { locale: 'en', name: `Category ${n}`, shortDescription: null, keywords: [] as string[] },
        ],
      });
      // 0xd1 > 0xd2 > 0xd3, and a second department 0xd4 > 0xd5.
      const seedTree = () => {
        editStore.put(stored(0xd1, null, 0));
        editStore.put(stored(0xd2, 0xd1, 0));
        editStore.put(stored(0xd3, 0xd2, 0));
        editStore.put(stored(0xd4, null, 1));
        editStore.put(stored(0xd5, 0xd4, 0));
      };

      it('maps the refusals of a move, merge and archive to their status', () => {
        expect(CATEGORY_ADMIN_STATUS).toMatchObject({
          'category.target-not-found': 404,
          'category.move-unchanged': 409,
          'category.has-subcategories': 409,
          'category.referenced-by-policy': 409,
          'category.cycle': 422,
          'category.only-platform-category': 422,
          'category.products-on-upper-level': 422,
          'category.impact-too-large': 422,
          'category.check-unavailable': 503,
        });
      });

      it('refuses the Catalogue Moderator (no restructure key) with 403 on all three routes', async () => {
        seedTree();
        const moderator = adminSession(MODERATOR, 30);
        const target = id<'Category'>(0xd3);
        for (const [action, payload] of [
          ['move', { treeVersion: 1, parentId: id<'Category'>(0xd5), reason: REASON }],
          ['merge', { treeVersion: 1, targetId: id<'Category'>(0xd5), reason: REASON }],
          ['archive', { treeVersion: 1, reason: REASON }],
        ] as const) {
          await http().post(`${BASE}/${target}/${action}`).set(moderator).send(payload).expect(403);
        }
        expect(retirementChecked).toEqual([]);
        expect(editStore.revisions).toEqual([]);
      });

      it('moves a category for a holder of the key and answers the new tree version', async () => {
        seedTree();
        const session = adminSession(RESTRUCTURER, 31);
        const moved = await http()
          .post(`${BASE}/${id<'Category'>(0xd3)}/move`)
          .set(session)
          .send({ treeVersion: 1, parentId: id<'Category'>(0xd5), reason: REASON })
          .expect(200);
        expect(moved.body).toMatchObject({
          category: { id: id<'Category'>(0xd3), version: 2, treeVersion: 2 },
        });
        expect(retirementChecked).toEqual([
          [id<'Category'>(0xd3), id<'Category'>(0xd2), id<'Category'>(0xd1)],
        ]);
      });

      it('answers 409 with the type codes when a certificate rule names the category, 503 when the check is down', async () => {
        seedTree();
        const session = adminSession(RESTRUCTURER, 32);
        retirementAnswer = {
          ok: false,
          error: { code: 'category.referenced-by-policy', typeCodes: ['halal', 'kosher'] },
        };
        const refused = await http()
          .post(`${BASE}/${id<'Category'>(0xd3)}/archive`)
          .set(session)
          .send({ treeVersion: 1, reason: REASON })
          .expect(409);
        expect(refused.body).toEqual({
          statusCode: 409,
          code: 'category.referenced-by-policy',
          details: { typeCodes: ['halal', 'kosher'] },
        });
        retirementAnswer = { ok: false, error: { code: 'category.check-unavailable' } };
        await http()
          .post(`${BASE}/${id<'Category'>(0xd3)}/archive`)
          .set(session)
          .send({ treeVersion: 1, reason: REASON })
          .expect(503);
        expect(editStore.revisions).toEqual([]);
      });

      it('answers 400 for a short reason, 404 for an unknown target, 409 for subcategories, 422 for a cycle', async () => {
        seedTree();
        const session = adminSession(RESTRUCTURER, 33);
        await http()
          .post(`${BASE}/${id<'Category'>(0xd3)}/move`)
          .set(session)
          .send({ treeVersion: 1, parentId: id<'Category'>(0xd5), reason: 'too short' })
          .expect(400);
        await http()
          .post(`${BASE}/${id<'Category'>(0xd3)}/merge`)
          .set(session)
          .send({ treeVersion: 1, targetId: MISSING, reason: REASON })
          .expect(404);
        await http()
          .post(`${BASE}/${id<'Category'>(0xd2)}/archive`)
          .set(session)
          .send({ treeVersion: 1, reason: REASON })
          .expect(409);
        await http()
          .post(`${BASE}/${id<'Category'>(0xd1)}/move`)
          .set(session)
          .send({ treeVersion: 1, parentId: id<'Category'>(0xd3), reason: REASON })
          .expect(422);
        expect(retirementChecked).toEqual([]);
      });
    });

    it('documents the routes in OpenAPI', async () => {
      const document = (await http().get('/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };
      expect(document.paths[BASE]).toHaveProperty('get');
      const list = (
        document.paths[BASE] as unknown as {
          get: { parameters: { name: string; in: string }[]; responses: Record<string, unknown> };
        }
      ).get;
      expect(list.parameters).toContainEqual(
        expect.objectContaining({ name: 'featureSetId', in: 'query' }),
      );
      expect(list.responses).toHaveProperty('400');
      const schemas = (
        document as unknown as {
          components: { schemas: Record<string, { properties: Record<string, unknown> }> };
        }
      ).components.schemas;
      expect(Object.keys(schemas['CategoryTreeRowBody']!.properties)).toEqual(
        expect.arrayContaining([
          'featureSetId',
          'featureSetCode',
          'featureSetFromCategoryId',
          'inherited',
        ]),
      );
      expect(document.paths[`${BASE}/{categoryId}`]?.get?.responses).toHaveProperty('404');
      expect(document.paths[`${BASE}/{categoryId}/impact`]?.get?.responses).toHaveProperty('400');
      expect(document.paths[BASE]).toHaveProperty('post');
      expect(document.paths[`${BASE}/{categoryId}`]).toHaveProperty('patch');
      for (const action of [
        'reorder',
        'hide',
        'show',
        'change-slug',
        'discard',
        'move',
        'merge',
        'archive',
        'image/remove',
      ]) {
        expect(document.paths[`${BASE}/{categoryId}/${action}`]).toHaveProperty('post');
      }
      expect(document.paths[`${BASE}/{categoryId}/image`]?.put?.responses).toHaveProperty('413');
      expect(
        document.paths[`${BASE}/{categoryId}/images/{imageId}/{size}`]?.get?.responses,
      ).toHaveProperty('404');
    });
  },
);
