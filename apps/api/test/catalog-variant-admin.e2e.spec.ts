import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import {
  VARIANT_ADMIN_READER,
  type VariantAdminReader,
  type VariantRow,
  type VariantTypeRecord,
} from '../src/modules/catalog/application/ports/variant-admin.reader';
import {
  VARIANT_TYPE_SETTINGS_STORE,
  type VariantTypeSettingsStore,
} from '../src/modules/catalog/application/ports/variant-type-settings.store';
import {
  DEFAULT_VARIANT_TYPE_SETTINGS,
  type VariantTypeSettings,
} from '../src/modules/catalog/domain/variant-type-settings';
import { VARIANT_ADMIN_STATUS } from '../src/modules/catalog/presentation/variant-admin.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { cleanClaimTextMatcher } from './support/clean-claim-text-matcher.fake';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin Catalogue > Variants routes over HTTP (variants V6): the real guards, controller,
// gate with the real role seed and use cases; the reader and the settings store as in-memory
// fakes. Both Market fixtures: 401 without a session, 403 for Finance (no key) on the reads and
// for the Viewer (view key only) on the edit, 200 for the roles the seed gives the view key, the
// edit by the Platform Administrator (the protected key), 403 without the CSRF token, 415 for a
// body that is not JSON, the status of each refusal, and the export's headers.

const START = Temporal.Instant.from('2026-11-06T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xb701);
const MODERATOR = id<'Account'>(0xb702);
const OPERATIONS = id<'Account'>(0xb703);
const FINANCE = id<'Account'>(0xb704);
const ADMIN = id<'Account'>(0xb705);
const SIZE = id<'AttributeDefinition'>(0xb801);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

class MemoryVariantAdmin implements VariantAdminReader, VariantTypeSettingsStore {
  types = new Map<string, VariantTypeRecord[]>();
  rows = new Map<string, VariantRow[]>();
  stored = new Map<string, VariantTypeSettings>();

  reset() {
    this.types.clear();
    this.rows.clear();
    this.stored.clear();
  }
  #typesOf(marketId: string): VariantTypeRecord[] {
    return (this.types.get(marketId) ?? []).map((type) => {
      const settings = this.stored.get(`${marketId}:${type.id}`);
      return settings === undefined
        ? type
        : {
            ...type,
            settings: {
              displayStyle: settings.state.displayStyle,
              optionOrder: settings.state.optionOrder,
              swatches: settings.state.swatches,
              sellerHelp: settings.state.sellerHelp,
            },
            settingsVersion: settings.state.version,
          };
    });
  }
  variantTypes: VariantAdminReader['variantTypes'] = (m, limit) =>
    Promise.resolve(this.#typesOf(m.marketId).slice(0, limit));
  variantType: VariantAdminReader['variantType'] = (m, typeId) =>
    Promise.resolve(this.#typesOf(m.marketId).find((t) => t.id === typeId) ?? null);
  typeCounts: VariantAdminReader['typeCounts'] = (_m, codes) =>
    Promise.resolve(new Map(codes.map((c) => [c, { products: 1, liveVariants: 2 }])));
  optionProductCounts: VariantAdminReader['optionProductCounts'] = (_m, _c, codes) =>
    Promise.resolve(new Map(codes.map((c) => [c, 1])));
  featureSetsUsing: VariantAdminReader['featureSetsUsing'] = () => Promise.resolve(new Map());
  variantsPage: VariantAdminReader['variantsPage'] = (m, query) => {
    const all = this.rows.get(m.marketId) ?? [];
    const start = query.after === null ? 0 : all.findIndex((r) => r.variantId === query.after) + 1;
    const rows = all.slice(start, start + query.limit);
    const more = start + query.limit < all.length;
    return Promise.resolve({ rows, nextAfter: more ? rows.at(-1)!.variantId : null });
  };
  issueCounts: VariantAdminReader['issueCounts'] = () =>
    Promise.resolve({
      'no-seller-selling': 0,
      'missing-gtin': 1,
      'duplicate-gtin': 0,
      'no-image': 0,
      'missing-language': 0,
    });
  find: VariantTypeSettingsStore['find'] = (m, definitionId) =>
    Promise.resolve(this.stored.get(`${m.marketId}:${definitionId}`) ?? null);
  add: VariantTypeSettingsStore['add'] = (m, settings) => {
    this.stored.set(`${m.marketId}:${settings.state.definitionId}`, settings);
    return Promise.resolve();
  };
  saveRevision: VariantTypeSettingsStore['saveRevision'] = (m, settings) => {
    this.stored.set(`${m.marketId}:${settings.state.definitionId}`, settings);
    return Promise.resolve();
  };
}

describe('admin Variants routes over HTTP (integration, V6)', () => {
  let app: NestExpressApplication;
  const memory = new MemoryVariantAdmin();
  const http = () => request(app.getHttpServer());
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(VARIANT_ADMIN_READER)
          .useValue(memory)
          .overrideProvider(VARIANT_TYPE_SETTINGS_STORE)
          .useValue(memory)
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(cleanClaimTextMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              Promise.resolve({ ok: true, value: localesOf(context.market.marketId) }),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'var-0001'), {});
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
      [ADMIN, 'admin', 'platform-administrator'],
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
        id: id<'RoleAssignment'>(0xe800 + n),
        marketId,
        accountId,
        roleId: roleOf(seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    const locale = localeOf(code);
    memory.types.set(code, [
      {
        id: SIZE,
        code: 'size',
        status: 'active',
        names: { [locale]: 'Size' },
        options: [
          { code: 'kg1', labels: { [locale]: '1 kg' }, active: true, position: 0 },
          { code: 'g500', labels: { [locale]: '500 g' }, active: true, position: 1 },
        ],
        settings: DEFAULT_VARIANT_TYPE_SETTINGS,
        settingsVersion: 0,
      },
    ]);
    memory.rows.set(code, [
      {
        productId: id<'Product'>(0xb901),
        productCode: 'MP-000901',
        productName: '=Rice',
        productScope: 'PLATFORM',
        productPaused: false,
        variantId: id<'Variant'>(0xba01),
        variantNo: 1,
        variantCode: 'MP-000901-01',
        labels: { [locale]: '1 kg' },
        gtin: null,
        duplicateGtin: false,
        sellers: 1,
        ownImages: 0,
        productImages: 1,
        missingLocales: [],
      },
    ]);
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf800 + n),
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

  const TYPES = '/catalog/admin/variant-types';
  const VARIANTS = '/catalog/admin/variants';
  const settingsOf = (typeId: string) => `${TYPES}/${typeId}/settings`;
  const body = (over: Record<string, unknown> = {}) => ({
    version: 0,
    displayStyle: 'swatches',
    optionOrder: 'by-size',
    swatches: { kg1: '#AA0000' },
    ...over,
  });

  beforeEach(() => {
    fakes.reset();
    memory.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the Variants routes to their status', () => {
    expect(VARIANT_ADMIN_STATUS).toEqual({
      'validation.failed': 400,
      'variant-type.not-found': 404,
      'variant-type.stale': 409,
      'variant-type.invalid': 422,
      'attribute.claim-word': 422,
      'attribute.locale-uncheckable': 422,
      'batch.too-large': 413,
      'access.unavailable': 503,
      'claim-text.check-unavailable': 503,
    });
  });

  it('documents the six routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[TYPES]).toHaveProperty('get');
    expect(document.paths[`${TYPES}/{variantTypeId}`]).toHaveProperty('get');
    expect(document.paths[`${TYPES}/{variantTypeId}/settings`]).toHaveProperty('put');
    expect(document.paths[VARIANTS]).toHaveProperty('get');
    expect(document.paths[`${VARIANTS}/issue-counts`]).toHaveProperty('get');
    expect(document.paths[`${VARIANTS}/export`]).toHaveProperty('get');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session', async () => {
      await boot();
      await seeded(code);
      await http().get(TYPES).set({ 'x-market-id': code }).expect(401);
      await http().get(VARIANTS).set({ 'x-market-id': code }).expect(401);
    });

    it('answers 403 access.denied to Finance on every read', async () => {
      await boot();
      await seeded(code);
      const finance = adminSession(code, FINANCE, 1);
      for (const path of [
        TYPES,
        `${TYPES}/${SIZE}`,
        VARIANTS,
        `${VARIANTS}/issue-counts`,
        `${VARIANTS}/export`,
      ]) {
        const refused = await http().get(path).set(finance).expect(403);
        expect(refused.body).toMatchObject({ code: 'access.denied' });
      }
    });

    it.each([
      ['Viewer', VIEWER],
      ['Catalogue Moderator', MODERATOR],
      ['Operations', OPERATIONS],
    ] as const)('lets the %s read every route, never store the answer', async (_l, account) => {
      await boot();
      await seeded(code);
      const session = adminSession(code, account, 2);
      const types = await http().get(TYPES).set(session).expect(200);
      expect(types.headers['cache-control']).toContain('no-store');
      expect(types.body).toMatchObject({
        items: [{ id: SIZE, code: 'size', options: 2, products: 1, liveVariants: 2 }],
      });
      const one = await http().get(`${TYPES}/${SIZE}`).set(session).expect(200);
      expect(one.body).toMatchObject({ variantType: { settingsVersion: 0 } });
      const list = await http().get(`${VARIANTS}?limit=10&q=rice`).set(session).expect(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).toMatchObject({
        items: [{ variantCode: 'MP-000901-01', issues: ['missing-gtin'] }],
        nextAfter: null,
      });
      const counts = await http().get(`${VARIANTS}/issue-counts`).set(session).expect(200);
      expect(counts.body).toMatchObject({ counts: { 'missing-gtin': 1 } });
    });

    it('streams the export as an attachment, with a formula guard', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, VIEWER, 3);
      const csv = await http().get(`${VARIANTS}/export`).set(viewer).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toBe(
        'attachment; filename="variants-2026-11-06.csv"',
      );
      expect(csv.headers['cache-control']).toContain('no-store');
      expect(csv.headers['x-content-type-options']).toBe('nosniff');
      expect(csv.text).toContain(`'=Rice`);
      const refused = await http().get(`${VARIANTS}/export?format=pdf`).set(viewer).expect(400);
      expect(refused.body).toMatchObject({ code: 'validation.failed' });
    });

    it('refuses a malformed query with 400 and an unknown type with 404', async () => {
      await boot();
      await seeded(code);
      const viewer = adminSession(code, VIEWER, 4);
      for (const query of ['limit=0', 'limit=abc', 'issue=out-of-stock', 'colour=red']) {
        const refused = await http().get(`${VARIANTS}?${query}`).set(viewer).expect(400);
        expect(refused.body).toMatchObject({ code: 'validation.failed' });
      }
      await http().get(`${TYPES}?x=1`).set(viewer).expect(400);
      for (const path of [`${TYPES}/nope`, `${TYPES}/${id(0xb8ff)}`]) {
        const missing = await http().get(path).set(viewer).expect(404);
        expect(missing.body).toMatchObject({ code: 'variant-type.not-found' });
      }
    });

    it('refuses the settings edit to every default role (403), the key being protected', async () => {
      await boot();
      await seeded(code);
      for (const [n, account] of [VIEWER, MODERATOR, OPERATIONS, FINANCE].entries()) {
        const refused = await http()
          .put(settingsOf(SIZE))
          .set(adminSession(code, account, 10 + n))
          .send(body())
          .expect(403);
        expect(refused.body).toMatchObject({ code: 'access.denied' });
      }
      expect(memory.stored.size).toBe(0);
    });

    it('lets the Platform Administrator save the settings, then answers stale for the old version', async () => {
      await boot();
      await seeded(code);
      const admin = adminSession(code, ADMIN, 20);
      const saved = await http()
        .put(settingsOf(SIZE))
        .set(admin)
        .send(body({ sellerHelp: { [localeOf(code)]: 'Pick the weight.' } }))
        .expect(200);
      expect(saved.body).toEqual({
        variantType: {
          id: SIZE,
          settingsVersion: 1,
          displayStyle: 'swatches',
          optionOrder: 'by-size',
        },
      });
      const read = await http().get(`${TYPES}/${SIZE}`).set(admin).expect(200);
      expect(read.body).toMatchObject({
        variantType: { settingsVersion: 1, displayStyle: 'swatches' },
      });
      const stale = await http().put(settingsOf(SIZE)).set(admin).send(body()).expect(409);
      expect(stale.body).toMatchObject({ code: 'variant-type.stale' });
    });

    it('answers 422 for an unknown swatch option, 404 for an unknown type, 400 for a bad body', async () => {
      await boot();
      await seeded(code);
      const admin = adminSession(code, ADMIN, 30);
      const invalid = await http()
        .put(settingsOf(SIZE))
        .set(admin)
        .send(body({ swatches: { pink: '#000000' } }))
        .expect(422);
      expect(invalid.body).toMatchObject({ code: 'variant-type.invalid' });
      await http()
        .put(settingsOf(id(0xb8ff)))
        .set(admin)
        .send(body())
        .expect(404);
      const bad = await http()
        .put(settingsOf(SIZE))
        .set(admin)
        .send(body({ extra: true }))
        .expect(400);
      expect(bad.body).toMatchObject({ code: 'validation.failed' });
    });

    it('refuses the edit without the CSRF token (403) and a body that is not JSON (415)', async () => {
      await boot();
      await seeded(code);
      const noCsrf: Record<string, string> = { ...adminSession(code, ADMIN, 40) };
      delete noCsrf['x-csrf-token'];
      await http().put(settingsOf(SIZE)).set(noCsrf).send(body()).expect(403);
      await http()
        .put(settingsOf(SIZE))
        .set(adminSession(code, ADMIN, 41))
        .set('content-type', 'text/plain')
        .send('displayStyle=buttons')
        .expect(415);
      expect(memory.stored.size).toBe(0);
    });
  });
});
