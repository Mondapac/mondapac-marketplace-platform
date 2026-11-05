import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ADMIN_CATEGORY_READER } from '../src/modules/catalog/application/ports/admin-category.reader';
import type { AdminCategoryReader } from '../src/modules/catalog/application/ports/admin-category.reader';
import { CATEGORY_ADMIN_STATUS } from '../src/modules/catalog/presentation/category-admin.controller';
import {
  CATEGORY_EDIT_STORE,
  CATEGORY_RESTRUCTURE_STORE,
} from '../src/modules/catalog/application/ports/category-edit.store';
import { CATEGORY_RETIREMENT_CHECK } from '../src/modules/catalog/application/ports/category-retirement-check';
import type { CategoryRetirementCheck } from '../src/modules/catalog/application/ports/category-retirement-check';
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
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  MemoryCategoryEditStore,
  MemoryCategoryRestructureStore,
  MemoryTreeVersion,
} from './support/catalog-category-editor-fakes';
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

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const editStore = new MemoryCategoryEditStore();
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
      restructureStore.products.clear();
      restructureStore.onlyHere.clear();
      restructureStore.relinked.length = 0;
      retirementChecked.length = 0;
      retirementAnswer = { ok: true, value: undefined };
      treeVersion.version = 1;
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
            .overrideProvider(CATEGORY_EDIT_STORE)
            .useValue(editStore)
            .overrideProvider(CATEGORY_RESTRUCTURE_STORE)
            .useValue(restructureStore)
            .overrideProvider(CATEGORY_RETIREMENT_CHECK)
            .useValue(retirement)
            .overrideProvider(PLATFORM_CATEGORY_REPOSITORY)
            .useValue(treeVersion)
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
      ]) {
        expect(document.paths[`${BASE}/{categoryId}/${action}`]).toHaveProperty('post');
      }
    });
  },
);
