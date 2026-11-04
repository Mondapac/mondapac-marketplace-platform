import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import { CATEGORY_ATTRIBUTE_LINK_STORE } from '../src/modules/catalog/application/ports/category-attribute-link.store';
import { CATEGORY_TREE_READER } from '../src/modules/catalog/application/ports/category-tree.reader';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryCategoryAttributeLinkStore,
  MemoryCategoryTree,
} from './support/catalog-category-links-fakes';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
  featureSetRecord,
} from './support/catalog-attribute-admin-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The category attribute links over HTTP (attributes plan, package A4; categories C8): the real
// guards, controller, gate with the real role seed and use cases; the link store, the category tree
// and the definitions as in-memory fakes. Proved in both Market fixtures: the protected edit key is
// in no default role; an admin holding it sets a link, children inherit the feature set and the
// filters, a stale version is refused (409), a filter that is unknown, a draft, not filterable or
// repeated is refused (422), an unknown or archived feature set or category is refused, and the
// CSRF token, JSON and closed bodies are required.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xb701);
const EDITOR = id<'Account'>(0xb702);
const EDITOR_ROLE = id<'Role'>(0xb801);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const dId = (n: number) => `01990000-0000-7000-8000-${(0xd000 + n).toString(16).padStart(12, '0')}`;

describe('category attribute links over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const tree = new MemoryCategoryTree();
  const links = new MemoryCategoryAttributeLinkStore(tree);
  const reader = new MemoryAttributeAdminReader();
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
          .overrideProvider(CATEGORY_ATTRIBUTE_LINK_STORE)
          .useValue(links)
          .overrideProvider(CATEGORY_TREE_READER)
          .useValue(tree)
          .overrideProvider(ATTRIBUTE_ADMIN_READER)
          .useValue(reader),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');

  const CAT_P = id<'Category'>(0xc001);
  const CAT_C = id<'Category'>(0xc002);
  const CAT_G = id<'Category'>(0xc003);
  const CAT_ARCHIVED = id<'Category'>(0xc004);
  const SET_A = id<'AttributeFamily'>(0xa001);
  const SET_ARCHIVED = id<'AttributeFamily'>(0xa002);

  function seedWorld(code: string) {
    const locale = localeOf(code);
    const names = (name: string) => ({ names: { [locale]: name } });
    const select = { dataType: 'select' as const };
    reader.seedDefinition(
      code,
      definitionRecord(dId(1), 'colour', { ...select, ...names('Colour'), canBeFilter: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(2), 'size', { ...select, ...names('Size'), canBeFilter: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(3), 'pack-size', { ...select, ...names('Pack') }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(4), 'notes', { ...names('Notes'), canBeFilter: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(5), 'draft-one', {
        ...select,
        ...names('Draft'),
        canBeFilter: true,
        status: 'draft',
      }),
    );
    reader.seedFeatureSet(code, featureSetRecord(SET_A, 'pantry', []));
    reader.seedFeatureSet(code, featureSetRecord(SET_ARCHIVED, 'old', [], 'archived'));
    tree.seed(code, { id: CAT_P, parentId: null, status: 'active' });
    tree.seed(code, { id: CAT_C, parentId: CAT_P, status: 'active' });
    tree.seed(code, { id: CAT_G, parentId: CAT_C, status: 'active' });
    tree.seed(code, { id: CAT_ARCHIVED, parentId: null, status: 'archived' });
  }

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
    seedWorld(code);
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

  const linksOf = (category: string) => `/catalog/admin/categories/${category}/attribute-links`;

  beforeEach(() => {
    fakes.reset();
    links.reset();
    tree.reset();
    reader.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the two attribute-link routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    const path = document.paths['/catalog/admin/categories/{categoryId}/attribute-links'];
    expect(path).toHaveProperty('get');
    expect(path).toHaveProperty('put');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('keeps the protected edit key out of every default role; a moderator cannot write', async () => {
      await boot();
      await seeded(code);
      const refused = await http()
        .put(linksOf(CAT_P))
        .set(adminSession(code, MODERATOR, 1))
        .send({ featureSetId: SET_A, filters: ['colour'] })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(links.rows.size).toBe(0);
    }, 30_000);

    it('sets a link, lets the children inherit it, and refuses a stale version', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 2);
      const first = await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ featureSetId: SET_A, filters: ['colour'] })
        .expect(200);
      expect(first.body).toEqual({
        links: {
          categoryId: CAT_P,
          featureSetId: SET_A,
          filters: ['colour'],
          revisionNo: 1,
          version: 1,
        },
      });
      expect(links.authors.map((a) => a.author)).toEqual([EDITOR]);

      await http()
        .put(linksOf(CAT_G))
        .set(editor)
        .send({ featureSetId: null, filters: ['size'] })
        .expect(200);
      const read = await http().get(linksOf(CAT_G)).set(editor).expect(200);
      expect(read.body).toMatchObject({
        categoryId: CAT_G,
        own: { featureSetId: null, filters: ['size'], version: 1 },
        effective: {
          featureSet: { id: SET_A, code: 'pantry', fromCategoryId: CAT_P, inherited: true },
          filters: [
            { code: 'colour', fromCategoryId: CAT_P, inherited: true },
            { code: 'size', fromCategoryId: CAT_G, inherited: false },
          ],
        },
      });
      // The middle category has no link of its own and still inherits from above.
      const middle = await http().get(linksOf(CAT_C)).set(editor).expect(200);
      expect(middle.body).toMatchObject({
        own: null,
        effective: { featureSet: { fromCategoryId: CAT_P }, filters: [{ code: 'colour' }] },
      });

      const saved = await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ version: 1, featureSetId: SET_A, filters: ['size', 'colour'] })
        .expect(200);
      expect(saved.body).toMatchObject({ links: { version: 2, revisionNo: 2 } });
      const stale = await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ version: 1, featureSetId: SET_A, filters: [] })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'category-links.stale' });
      // A link that exists needs its version; omitting it reads as a stale write.
      await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ featureSetId: SET_A, filters: [] })
        .expect(409);

      // An attribute archived after the save drops out of what buyers get, not out of the saved list.
      reader.seedDefinition(
        code,
        definitionRecord(dId(2), 'size', {
          dataType: 'select',
          names: { [localeOf(code)]: 'Size' },
          canBeFilter: true,
          status: 'archived',
        }),
      );
      const after = await http().get(linksOf(CAT_G)).set(editor).expect(200);
      expect(
        (after.body as { own: { filters: string[] }; effective: { filters: unknown[] } }).own
          .filters,
      ).toEqual(['size']);
      expect(
        (after.body as { effective: { filters: { code: string }[] } }).effective.filters.map(
          (f) => f.code,
        ),
      ).toEqual(['colour']);
    }, 30_000);

    it('refuses filters that are unknown, drafts, not filterable or repeated', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 3);
      const put = (filters: string[], featureSetId: string | null = null) =>
        http().put(linksOf(CAT_P)).set(editor).send({ featureSetId, filters });
      const unknown = await put(['nope']).expect(422);
      expect(unknown.body).toMatchObject({
        code: 'category-links.filter-unknown',
        details: { fields: [{ path: 'filters[0]', code: 'unknown' }] },
      });
      await put(['draft-one']).expect(422);
      const notFilterable = await put(['colour', 'pack-size', 'notes']).expect(422);
      expect(notFilterable.body).toMatchObject({
        code: 'category-links.filter-not-filterable',
        details: {
          fields: [
            { path: 'filters[1]', code: 'not-filterable' },
            { path: 'filters[2]', code: 'not-filterable' },
          ],
        },
      });
      const repeated = await put(['colour', 'colour']).expect(422);
      expect(repeated.body).toMatchObject({ code: 'category-links.filter-repeated' });
      await put(['Colour']).expect(400);
      expect(links.rows.size).toBe(0);
    }, 30_000);

    it('refuses an unknown or archived feature set, and an unknown or archived category', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 4);
      const missing = await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ featureSetId: id<'AttributeFamily'>(0xa999), filters: [] })
        .expect(422);
      expect(missing.body).toMatchObject({ code: 'category-links.feature-set-unknown' });
      const archived = await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ featureSetId: SET_ARCHIVED, filters: [] })
        .expect(422);
      expect(archived.body).toMatchObject({ code: 'category-links.feature-set-not-active' });
      const inactive = await http()
        .put(linksOf(CAT_ARCHIVED))
        .set(editor)
        .send({ featureSetId: null, filters: [] })
        .expect(409);
      expect(inactive.body).toMatchObject({ code: 'category.not-active' });
      await http()
        .put(linksOf(id<'Category'>(0xc999)))
        .set(editor)
        .send({ featureSetId: null, filters: [] })
        .expect(404);
      await http()
        .get(linksOf(id<'Category'>(0xc999)))
        .set(editor)
        .expect(404);
      await http().get(linksOf('not-an-id')).set(editor).expect(404);
    }, 30_000);

    it('needs the CSRF token, JSON and a closed body', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 5);
      const noCsrf: Record<string, string> = { ...editor };
      delete noCsrf['x-csrf-token'];
      await http()
        .put(linksOf(CAT_P))
        .set(noCsrf)
        .send({ featureSetId: null, filters: [] })
        .expect(403);
      await http()
        .put(linksOf(CAT_P))
        .set(editor)
        .send({ featureSetId: null, filters: [], extra: 1 })
        .expect(400);
      await http().put(linksOf(CAT_P)).set(editor).send({ filters: [] }).expect(400);
      await http()
        .put(linksOf(CAT_P))
        .set({ ...editor, 'content-type': 'text/plain' })
        .send('x')
        .expect(415);
    }, 30_000);
  });
});
