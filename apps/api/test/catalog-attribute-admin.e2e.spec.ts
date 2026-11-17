import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import { ATTRIBUTE_ADMIN_STATUS } from '../src/modules/catalog/presentation/attribute-admin.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
  featureSetRecord,
} from './support/catalog-attribute-admin-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin attribute reads over HTTP (attributes plan, package A1): the real guards, controllers,
// the gate with the real role seed and the use cases; the reader as an in-memory fake. Proved in
// both Market fixtures: 401 without a session, 403 for a default role without the key (Finance)
// and for a seller, 200 for each role the seed gives the key to (Viewer, Catalogue Moderator,
// Operations), the closed query, 404 for an unknown id, `no-store` and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xa701);
const MODERATOR = id<'Account'>(0xa702);
const OPERATIONS = id<'Account'>(0xa703);
const FINANCE = id<'Account'>(0xa704);
const BRAND = id<'AttributeDefinition'>(0xa801);
const PACK = id<'AttributeDefinition'>(0xa802);
const FAMILY = id<'AttributeFamily'>(0xa901);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('admin attribute reads over HTTP (integration)', () => {
  let app: NestExpressApplication;
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
          .overrideProvider(ATTRIBUTE_ADMIN_READER)
          .useValue(reader),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'attr-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    let n = 0;
    for (const [accountId, label, seedCode] of [
      [VIEWER, 'viewer', 'viewer'],
      [MODERATOR, 'moderator', 'catalogue-moderator'],
      [OPERATIONS, 'operations', 'operations-support'],
      [FINANCE, 'finance', 'finance'],
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
        id: id<'RoleAssignment'>(0xe700 + n),
        marketId,
        accountId,
        roleId: roleOf(seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
    reader.seedDefinition(code, definitionRecord(BRAND, 'brand', { names: { [locale]: 'Brand' } }));
    reader.seedDefinition(
      code,
      definitionRecord(PACK, 'pack-size', {
        dataType: 'select',
        isVariantOption: true,
        names: { [locale]: 'Pack size' },
        values: [{ code: 'g250', labels: { [locale]: '250 g' }, active: true, position: 0 }],
      }),
    );
    reader.seedFeatureSet(
      code,
      featureSetRecord(FAMILY, 'default', [
        {
          groupCode: 'general',
          attributes: [
            { code: 'brand', required: true, isVariantOption: false },
            { code: 'pack-size', required: false, isVariantOption: true },
          ],
        },
      ]),
    );
    reader.counts.set(`${code}:brand`, 2);
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf700 + n),
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

  const ATTRIBUTES = '/catalog/admin/attributes';
  const FEATURE_SETS = '/catalog/admin/feature-sets';

  beforeEach(() => {
    fakes.reset();
    reader.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the attribute reads to their status', () => {
    expect(ATTRIBUTE_ADMIN_STATUS).toEqual({
      'validation.failed': 400,
      'attribute-definition.code-invalid': 400,
      'attribute-definition.data-type-invalid': 400,
      'attribute-definition.locale-invalid': 400,
      'attribute.not-found': 404,
      'feature-set.not-found': 404,
      'category.not-found': 404,
      'category.not-active': 409,
      'category-links.stale': 409,
      'category-links.feature-set-unknown': 422,
      'category-links.feature-set-not-active': 422,
      'category-links.filter-unknown': 422,
      'category-links.filter-not-filterable': 422,
      'category-links.filter-invalid': 422,
      'category-links.filter-repeated': 422,
      'category-links.too-many-filters': 422,
      'feature-set.code-taken': 409,
      'feature-set.stale': 409,
      'feature-set.material-removal-needs-request': 409,
      'feature-set.attribute-unknown': 422,
      'feature-set.attribute-not-active': 422,
      'feature-set.too-many-variant-attributes': 422,
      'attribute-family.code-invalid': 400,
      'attribute-family.group-invalid': 400,
      'attribute-family.locale-invalid': 400,
      'attribute-family.archived': 409,
      'attribute-family.group-repeated': 422,
      'attribute-family.attribute-invalid': 422,
      'attribute-family.attribute-repeated': 422,
      'attribute-family.default-name-required': 422,
      'attribute-family.text-invalid': 422,
      'attribute-family.too-many': 422,
      'attribute-family.level-invalid': 422,
      'attribute-family.core-invalid': 422,
      'attribute.code-taken': 409,
      'attribute.stale': 409,
      'attribute-definition.archived': 409,
      'attribute-definition.not-draft': 409,
      'attribute-definition.option-removed': 409,
      'attribute-definition.variant-locked': 409,
      'attribute-definition.material-relaxation-required': 409,
      'attribute-definition.measure-locked': 409,
      'attribute.claim-word': 422,
      'attribute.locale-uncheckable': 422,
      'attribute-definition.name-required': 422,
      'attribute-definition.text-invalid': 422,
      'attribute-definition.bounds-invalid': 422,
      'attribute-definition.measure-invalid': 422,
      'attribute-definition.options-required': 422,
      'attribute-definition.options-not-allowed': 422,
      'attribute-definition.option-invalid': 422,
      'attribute-definition.option-repeated': 422,
      'attribute-definition.variant-option-needs-select': 422,
      'attribute-definition.options-too-many': 422,
      'attribute-definition.help-invalid': 422,
      'attribute-definition.note-invalid': 422,
      'attribute-definition.position-invalid': 422,
      'attribute-definition.default-name-required': 422,
      'attribute-definition.default-label-required': 422,
      'attribute-definition.active-option-required': 422,
      'access.unavailable': 503,
      'missing-details-email.unconfigured': 503,
      'claim-text.check-unavailable': 503,
    });
  });

  it('documents the four routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const path of [
      ATTRIBUTES,
      `${ATTRIBUTES}/{attributeId}`,
      FEATURE_SETS,
      `${FEATURE_SETS}/{featureSetId}`,
    ]) {
      expect(document.paths[path]).toHaveProperty('get');
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session', async () => {
      await boot();
      await seeded(code);
      await http().get(ATTRIBUTES).set({ 'x-market-id': code }).expect(401);
      await http().get(FEATURE_SETS).set({ 'x-market-id': code }).expect(401);
    });

    it('answers 403 access.denied to a default role without the key (Finance)', async () => {
      await boot();
      await seeded(code);
      const finance = adminSession(code, FINANCE, 1);
      for (const path of [
        ATTRIBUTES,
        `${ATTRIBUTES}/${BRAND}`,
        FEATURE_SETS,
        `${FEATURE_SETS}/${FAMILY}`,
      ]) {
        const refused = await http().get(path).set(finance).expect(403);
        expect(refused.body).toMatchObject({ code: 'access.denied' });
      }
    });

    it.each([
      ['Viewer', VIEWER],
      ['Catalogue Moderator', MODERATOR],
      ['Operations', OPERATIONS],
    ] as const)('lets the %s read every route', async (_label, account) => {
      await boot();
      await seeded(code);
      const session = adminSession(code, account, 2);
      const list = await http().get(ATTRIBUTES).set(session).expect(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).toMatchObject({
        total: 2,
        totalAll: 2,
        nextAfterId: null,
        featureSets: [{ id: FAMILY, code: 'default' }],
      });
      expect((list.body as { items: { code: string; productCount: number }[] }).items).toEqual([
        expect.objectContaining({ code: 'brand', productCount: 2, featureSetCount: 1 }),
        expect.objectContaining({ code: 'pack-size', productCount: 0, featureSetCount: 1 }),
      ]);
      const one = await http().get(`${ATTRIBUTES}/${PACK}`).set(session).expect(200);
      expect(one.headers['cache-control']).toContain('no-store');
      expect(one.body).toMatchObject({
        code: 'pack-size',
        options: [{ code: 'g250', productCount: 0 }],
        usedIn: [{ featureSetId: FAMILY, groupCode: 'general', isVariantOption: true }],
        history: [{ revisionNo: 1, authorKind: 'seed', changes: [] }],
      });
      const sets = await http().get(FEATURE_SETS).set(session).expect(200);
      expect(sets.body).toEqual({
        items: [
          {
            id: FAMILY,
            code: 'default',
            status: 'active',
            revisionNo: 1,
            names: {},
            groupCount: 1,
            attributeCount: 2,
            productCount: 0,
          },
        ],
        truncated: false,
      });
      const set = await http().get(`${FEATURE_SETS}/${FAMILY}`).set(session).expect(200);
      expect(set.body).toMatchObject({ code: 'default', groups: [{ groupCode: 'general' }] });
    });

    it('filters and pages the list from the query string', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, VIEWER, 3);
      const page = await http().get(`${ATTRIBUTES}?limit=1`).set(viewer).expect(200);
      expect(page.body).toMatchObject({ items: [{ code: 'brand' }], nextAfterId: BRAND, total: 2 });
      const next = await http()
        .get(`${ATTRIBUTES}?limit=1&afterId=${BRAND}`)
        .set(viewer)
        .expect(200);
      expect(next.body).toMatchObject({ items: [{ code: 'pack-size' }], nextAfterId: null });
      const typed = await http()
        .get(`${ATTRIBUTES}?type=select&search=PACK`)
        .set(viewer)
        .expect(200);
      expect((typed.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('refuses a malformed query with 400 and an unknown id with 404', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, VIEWER, 4);
      for (const query of ['limit=0', 'limit=abc', 'type=image', 'colour=red', 'missing=xx-XX']) {
        const refused = await http().get(`${ATTRIBUTES}?${query}`).set(viewer).expect(400);
        expect(refused.body).toMatchObject({ code: 'validation.failed' });
      }
      await http().get(`${FEATURE_SETS}?x=1`).set(viewer).expect(400);
      for (const path of [`${ATTRIBUTES}/nope`, `${ATTRIBUTES}/${id(0xa8ff)}`]) {
        const missing = await http().get(path).set(viewer).expect(404);
        expect(missing.body).toMatchObject({ code: 'attribute.not-found' });
      }
      const missingSet = await http()
        .get(`${FEATURE_SETS}/${id(0xa9ff)}`)
        .set(viewer)
        .expect(404);
      expect(missingSet.body).toMatchObject({ code: 'feature-set.not-found' });
    });
  });
});
