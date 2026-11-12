import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CATEGORY_TREE_READER } from '../src/modules/catalog/application/ports/category-tree.reader';
import { CLAIM_EVALUATOR } from '../src/modules/catalog/application/ports/claim-evaluator';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { CULTURE_READER } from '../src/modules/catalog/application/ports/culture.reader';
import { CULTURE_REPOSITORY } from '../src/modules/catalog/application/ports/culture.repository';
import type { CultureState } from '../src/modules/catalog/domain/culture';
import type { CultureCategoryRow } from '../src/modules/catalog/domain/culture-category';
import { CULTURE_ADMIN_STATUS } from '../src/modules/catalog/presentation/culture-admin.controller';
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

// The culture routes over HTTP (multi-culture package 1): the real guards, CSRF, closed bodies,
// controllers, the gate with the real role seed and the use cases; the culture store, the category
// tree, the claim matcher and the certification types as fakes. Proved in both Market fixtures:
// the key gate (no session, no key, a reader cannot write, the Platform Administrator holds both),
// the create / edit / default flow, the category marks, and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-11T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ACCOUNT = id<'Account'>(0xc901);
const READER = id<'Account'>(0xc902);
const VIEWER = id<'Account'>(0xc903);
const READER_ROLE = id<'Role'>(0xf911);
const CATEGORY = id<'Category'>(0xc9a1);
const CHILD = id<'Category'>(0xc9a2);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

class MemoryCultures {
  readonly rows = new Map<string, CultureState>();
  readonly marks = new Map<string, CultureCategoryRow>();
  reset(): void {
    this.rows.clear();
    this.marks.clear();
  }
  add(_m: unknown, state: CultureState) {
    this.rows.set(state.id, state);
    return Promise.resolve(null);
  }
  findById(_m: unknown, cultureId: string) {
    return Promise.resolve(this.rows.get(cultureId) ?? null);
  }
  codeTaken(_m: unknown, code: string) {
    return Promise.resolve([...this.rows.values()].some((r) => r.code === code));
  }
  defaultId() {
    return Promise.resolve([...this.rows.values()].find((r) => r.isDefault)?.id ?? null);
  }
  count() {
    return Promise.resolve(this.rows.size);
  }
  save(_m: unknown, state: CultureState) {
    this.rows.set(state.id, state);
    return Promise.resolve(null);
  }
  clearDefaultExcept(_m: unknown, exceptId: string) {
    for (const [key, row] of this.rows) {
      if (row.isDefault && row.id !== exceptId) this.rows.set(key, { ...row, isDefault: false });
    }
    return Promise.resolve();
  }
  categoryRows() {
    return Promise.resolve([...this.marks.values()]);
  }
  setCategoryRow(_m: unknown, _c: unknown, row: CultureCategoryRow) {
    this.marks.set(row.categoryId, row);
    return Promise.resolve();
  }
  clearCategoryRow(_m: unknown, _c: unknown, categoryId: string) {
    return Promise.resolve(this.marks.delete(categoryId));
  }
  list() {
    return Promise.resolve([...this.rows.values()]);
  }
}

describe('culture routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const cultures = new MemoryCultures();
  const http = () => request(app.getHttpServer());
  const ADMIN = '/catalog/admin/cultures';
  const nameOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const names = (code: string, name: string) => ({
    [nameOf(code)]: { name, description: `About ${name}` },
  });

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(CULTURE_REPOSITORY)
          .useValue(cultures)
          .overrideProvider(CULTURE_READER)
          .useValue(cultures)
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue({
            match: (_c: unknown, texts: readonly { text: string }[]) =>
              Promise.resolve(
                ok(
                  texts.map((t) =>
                    t.text.includes('Halal')
                      ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
                      : [],
                  ),
                ),
              ),
          })
          .overrideProvider(CLAIM_EVALUATOR)
          .useValue({
            activeTypeCodes: () => Promise.resolve(ok(new Set(['halal']))),
          })
          .overrideProvider(CATEGORY_TREE_READER)
          .useValue({
            nodes: (market: { marketId: string }) =>
              Promise.resolve([
                {
                  id: CATEGORY,
                  parentId: null,
                  status: 'active',
                  mergedIntoId: null,
                  slug: 'pantry',
                  position: 0,
                  names: [{ locale: nameOf(market.marketId), name: 'Pantry' }],
                },
                {
                  id: CHILD,
                  parentId: CATEGORY,
                  status: 'active',
                  mergedIntoId: null,
                  slug: 'rice',
                  position: 0,
                  names: [{ locale: nameOf(market.marketId), name: 'Rice' }],
                },
              ]),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'culture-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: READER_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Culture reader',
      permissionKeys: ['catalog.culture.read'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    const account = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
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
        id: id<'RoleAssignment'>(0xe9a0 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(ADMIN_ACCOUNT, 'culture-admin', roleOf('platform-administrator'));
    account(READER, 'culture-reader', READER_ROLE);
    account(VIEWER, 'culture-viewer', roleOf('viewer'));
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf9c0 + n),
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

  beforeEach(() => {
    fakes.reset();
    cultures.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the culture routes to their status', () => {
    expect(CULTURE_ADMIN_STATUS).toMatchObject({
      'culture.not-found': 404,
      'culture.code-taken': 409,
      'culture.default-must-stay-active': 409,
      'conflict.stale': 409,
      'culture.claim-word': 422,
    });
  });

  it('documents the culture routes in OpenAPI, with no delete route for a culture', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(document.paths[ADMIN]).toHaveProperty('get');
    expect(document.paths[ADMIN]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/{cultureId}`]).toHaveProperty('get');
    expect(document.paths[`${ADMIN}/{cultureId}`]).toHaveProperty('patch');
    expect(document.paths[`${ADMIN}/{cultureId}`]).not.toHaveProperty('delete');
    expect(document.paths[`${ADMIN}/{cultureId}/categories`]).toHaveProperty('get');
    expect(document.paths[`${ADMIN}/{cultureId}/categories/{categoryId}`]).toHaveProperty('put');
    expect(document.paths[`${ADMIN}/{cultureId}/categories/{categoryId}`]).toHaveProperty('delete');
    for (const status of ['201', '400', '403', '409', '422']) {
      expect(document.paths[ADMIN]?.post?.responses).toHaveProperty(status);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session, 403 without the key, and a reader cannot write', async () => {
      await boot();
      await seeded(code);
      await http().get(ADMIN).set({ 'x-market-id': code }).expect(401);

      const viewer = adminSession(code, VIEWER, 1);
      expect((await http().get(ADMIN).set(viewer).expect(403)).body).toMatchObject({
        code: 'access.denied',
      });

      const reader = adminSession(code, READER, 2);
      await http().get(ADMIN).set(reader).expect(200);
      const body = { code: 'nope', names: names(code, 'Nope') };
      expect((await http().post(ADMIN).set(reader).send(body).expect(403)).body).toMatchObject({
        code: 'access.denied',
      });
      expect(cultures.rows.size).toBe(0);

      const withoutCsrf: Record<string, string> = { ...adminSession(code, ADMIN_ACCOUNT, 3) };
      delete withoutCsrf['x-csrf-token'];
      await http().post(ADMIN).set(withoutCsrf).send(body).expect(403);
      expect(cultures.rows.size).toBe(0);
    });

    it('lets the Platform Administrator create, edit, make default and mark categories', async () => {
      await boot();
      await seeded(code);
      const admin = adminSession(code, ADMIN_ACCOUNT, 4);

      const created = await http()
        .post(ADMIN)
        .set(admin)
        .send({ code: 'first', names: names(code, 'First'), requiredCertificationType: 'halal' })
        .expect(201);
      const culture = (created.body as { culture: { id: string; version: number } }).culture;
      expect(created.body).toMatchObject({
        culture: { code: 'first', status: 'draft', isDefault: false, version: 1 },
      });

      const refused = await http()
        .post(ADMIN)
        .set(admin)
        .send({ code: 'second', names: names(code, 'Halal folk') })
        .expect(422);
      expect(refused.body).toMatchObject({ code: 'culture.claim-word' });
      await http()
        .post(ADMIN)
        .set(admin)
        .send({ code: 'first', names: names(code, 'Other') })
        .expect(409);
      await http()
        .post(ADMIN)
        .set(admin)
        .send({ code: 'x', names: names(code, 'X'), extra: true })
        .expect(400);

      const edited = await http()
        .patch(`${ADMIN}/${culture.id}`)
        .set(admin)
        .send({ version: 1, status: 'active', isDefault: true, displayOrder: 2 })
        .expect(200);
      expect(edited.body).toMatchObject({
        culture: { status: 'active', isDefault: true, displayOrder: 2, version: 2 },
      });
      const inactive = await http()
        .patch(`${ADMIN}/${culture.id}`)
        .set(admin)
        .send({ version: 2, status: 'inactive' })
        .expect(409);
      expect(inactive.body).toMatchObject({ code: 'culture.default-must-stay-active' });
      await http().patch(`${ADMIN}/${culture.id}`).set(admin).send({ version: 1 }).expect(409);

      const one = await http().get(`${ADMIN}/${culture.id}`).set(admin).expect(200);
      expect(one.headers['cache-control']).toContain('no-store');
      const list = await http().get(`${ADMIN}?status=active`).set(admin).expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1);
      await http()
        .get(`${ADMIN}/${id<'Culture'>(0xdead)}`)
        .set(admin)
        .expect(404);

      const mark = await http()
        .put(`${ADMIN}/${culture.id}/categories/${CATEGORY}`)
        .set(admin)
        .send({ visible: true, certificationMark: 'neutral' })
        .expect(200);
      expect(mark.body).toMatchObject({
        mark: { categoryId: CATEGORY, own: { visible: true, certificationMark: 'neutral' } },
      });
      const marks = await http().get(`${ADMIN}/${culture.id}/categories`).set(admin).expect(200);
      const child = (
        marks.body as {
          items: { categoryId: string; effective: { certificationMark: string } }[];
        }
      ).items.find((item) => item.categoryId === CHILD);
      expect(child?.effective.certificationMark).toBe('neutral');
      await http()
        .put(`${ADMIN}/${culture.id}/categories/${CATEGORY}`)
        .set(admin)
        .send({ certificationMark: 'REQUIRED' })
        .expect(400);
      await http().delete(`${ADMIN}/${culture.id}/categories/${CATEGORY}`).set(admin).expect(200);
      await http().delete(`${ADMIN}/${culture.id}/categories/${CATEGORY}`).set(admin).expect(404);
      await http().delete(`${ADMIN}/${culture.id}`).set(admin).expect(404);
    });
  });
});
