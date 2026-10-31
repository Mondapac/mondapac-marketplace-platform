import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { BRAND_READER } from '../src/modules/catalog/application/ports/brand.reader';
import { BRAND_REPOSITORY } from '../src/modules/catalog/application/ports/brand.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { BRAND_ADMIN_STATUS } from '../src/modules/catalog/presentation/brand-admin.controller';
import { OWN_BRAND_STATUS } from '../src/modules/catalog/presentation/own-brand.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { brandState, MemoryBrands } from './support/catalog-brand-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The brand routes over HTTP (catalog brand package): the real guards, CSRF, closed bodies,
// controllers, the gate with the real role seed and the use cases; the brand store as an in-memory
// fake. Proved here, in both Market fixtures: the admin key gate (no session, no key, the Viewer
// reads but cannot edit), the admin write flow, a seller's proposal (refused without an own-brand
// product, a draft with one), and the public reads without a session.

const START = Temporal.Instant.from('2026-10-28T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR = id<'Account'>(0xb801);
const VIEWER = id<'Account'>(0xb802);
const MODERATOR = id<'Account'>(0xb803);
const SELLER_OWNER = id<'Account'>(0xb804);
const SELLER = id<'Seller'>(0xb820);
const EDITOR_ROLE = id<'Role'>(0xf811);
const BRAND_A = id<'Brand'>(0xc801);
const BRAND_B = id<'Brand'>(0xc802);
const DRAFT = id<'Brand'>(0xc803);
const ARCHIVED = id<'Brand'>(0xc804);
const MISSING = id<'Brand'>(0xc8ff);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('brand routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let eligible: boolean;
  const brands = new MemoryBrands();
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(BRAND_REPOSITORY)
          .useValue(brands)
          .overrideProvider(BRAND_READER)
          .useValue(brands)
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'brand-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (scope: 'platform' | 'seller', seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Brand editor',
      permissionKeys: ['catalog.brand.read', 'catalog.brand.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    const account = (
      accountId: Id<'Account'>,
      label: string,
      population: 'admin' | 'seller',
      roleId: Id<'Role'>,
    ) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
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
        id: id<'RoleAssignment'>(0xe980 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(EDITOR, 'editor', 'admin', EDITOR_ROLE);
    account(VIEWER, 'viewer', 'admin', roleOf('platform', 'viewer'));
    account(MODERATOR, 'moderator', 'admin', roleOf('platform', 'catalogue-moderator'));
    account(SELLER_OWNER, 'owner', 'seller', roleOf('seller', 'seller-owner'));
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
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf801),
      marketId,
      accountId: SELLER_OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    brands.seed(brandState(BRAND_A, 'Acme Tea', { version: 1 }));
    brands.seed(brandState(BRAND_B, 'Fuji Foods'));
    brands.seed(
      brandState(DRAFT, 'Draft Brand', {
        status: 'draft',
        proposedBySellerId: id<'Seller'>(0xb8ee),
      }),
    );
    brands.seed(brandState(ARCHIVED, 'Old Brand', { status: 'archived' }));
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

  function sellerSession(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf9a0),
        marketId: code as AccountState['marketId'],
        accountId: SELLER_OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'seller'),
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const ADMIN = '/catalog/admin/brands';

  beforeEach(() => {
    fakes.reset();
    brands.reset();
    clock = new FixedClock(START);
    eligible = true;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the brand routes to their status', () => {
    expect(BRAND_ADMIN_STATUS).toMatchObject({
      'brand.not-found': 404,
      'brand.slug-taken': 409,
      'brand.near-duplicate': 409,
      'brand.merge-into-itself': 422,
      'conflict.stale': 409,
    });
    expect(OWN_BRAND_STATUS).toMatchObject({
      'brand.own-brand-required': 403,
      'brand.proposal-limit': 422,
      'seller.not-eligible': 403,
    });
  });

  it('documents the brand routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(document.paths[ADMIN]).toHaveProperty('get');
    expect(document.paths[ADMIN]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/{brandId}`]).toHaveProperty('put');
    expect(document.paths[`${ADMIN}/{brandId}/archive`]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/{brandId}/approve`]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/{brandId}/merge`]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/merge-queue`]).toHaveProperty('get');
    expect(document.paths[`${ADMIN}/merge-queue/dismiss`]).toHaveProperty('post');
    expect(document.paths['/catalog/seller/brands']).toHaveProperty('post');
    expect(document.paths['/catalog/brands']).toHaveProperty('get');
    expect(document.paths['/catalog/brands/{slug}']).toHaveProperty('get');
    const create = document.paths[ADMIN]?.post?.responses;
    for (const status of ['201', '400', '403', '409']) expect(create).toHaveProperty(status);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    describe('admin routes: the key gate', () => {
      it('answers 401 without a session', async () => {
        await boot();
        await seeded(code);
        await http().get(ADMIN).set({ 'x-market-id': code }).expect(401);
        await http()
          .post(ADMIN)
          .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
          .send({ name: 'Nope' })
          .expect(401);
      });

      it('answers 403 access.denied to an admin without the key, on a read and a write', async () => {
        await boot();
        await seeded(code);
        const moderator = adminSession(code, MODERATOR, 1);
        const read = await http().get(ADMIN).set(moderator).expect(403);
        expect(read.body).toMatchObject({ code: 'access.denied' });
        const write = await http().post(ADMIN).set(moderator).send({ name: 'Nope' }).expect(403);
        expect(write.body).toMatchObject({ code: 'access.denied' });
        expect(brands.brands.size).toBe(4);
      });

      it('lets the Viewer read and refuses every write', async () => {
        await boot();
        await seeded(code);
        const viewer = adminSession(code, VIEWER, 2);
        const list = await http().get(ADMIN).set(viewer).expect(200);
        expect(list.headers['cache-control']).toContain('no-store');
        expect((list.body as { items: unknown[] }).items).toHaveLength(4);
        const one = await http().get(`${ADMIN}/${BRAND_A}`).set(viewer).expect(200);
        expect(one.body).toMatchObject({ id: BRAND_A, name: 'Acme Tea', aliases: [] });
        await http().get(`${ADMIN}/merge-queue`).set(viewer).expect(200);

        for (const [method, path, body] of [
          ['post', ADMIN, { name: 'New Brand' }],
          ['put', `${ADMIN}/${BRAND_A}`, { name: 'Renamed', version: 1 }],
          ['post', `${ADMIN}/${BRAND_A}/archive`, { version: 1 }],
          ['post', `${ADMIN}/${DRAFT}/approve`, { version: 1 }],
          ['post', `${ADMIN}/${BRAND_A}/merge`, { sourceBrandIds: [BRAND_B] }],
          ['post', `${ADMIN}/merge-queue/dismiss`, { groupKey: 'x' }],
        ] as const) {
          const refused = await http()[method](path).set(viewer).send(body).expect(403);
          expect(refused.body).toMatchObject({ code: 'access.denied' });
        }
        expect(brands.brands.get(BRAND_A)).toMatchObject({ name: 'Acme Tea', status: 'active' });
        expect(brands.brands.size).toBe(4);
      });

      it('needs the CSRF token on a write', async () => {
        await boot();
        await seeded(code);
        const editor = adminSession(code, EDITOR, 3);
        const withoutCsrf: Record<string, string> = { ...editor };
        delete withoutCsrf['x-csrf-token'];
        await http().post(ADMIN).set(withoutCsrf).send({ name: 'No Csrf' }).expect(403);
        expect(brands.brands.size).toBe(4);
      });
    });

    describe('admin routes: the write flow', () => {
      it('lists with a filter and a search, and reads one with its aliases and count', async () => {
        await boot();
        await seeded(code);
        brands.seedAlias(BRAND_A, 'Acme Co');
        brands.productCounts.set(`${code}:${BRAND_A}`, 3);
        const editor = adminSession(code, EDITOR, 4);
        const drafts = await http().get(`${ADMIN}?status=draft`).set(editor).expect(200);
        expect((drafts.body as { items: { id: string }[] }).items.map((b) => b.id)).toEqual([
          DRAFT,
        ]);
        const search = await http().get(`${ADMIN}?search=acme%20co`).set(editor).expect(200);
        expect((search.body as { items: { id: string }[] }).items.map((b) => b.id)).toEqual([
          BRAND_A,
        ]);
        const one = await http().get(`${ADMIN}/${BRAND_A}`).set(editor).expect(200);
        expect(one.body).toMatchObject({ aliases: ['Acme Co'], productCount: 3 });
        await http().get(`${ADMIN}/${MISSING}`).set(editor).expect(404);
        await http().get(`${ADMIN}?status=bogus`).set(editor).expect(400);
      });

      it('creates an active brand, refuses a look-alike and a taken slug, edits and archives it', async () => {
        await boot();
        await seeded(code);
        const editor = adminSession(code, EDITOR, 5);
        const created = await http()
          .post(ADMIN)
          .set(editor)
          .send({ name: 'Nori House', originCountry: 'JP' })
          .expect(201);
        expect(created.body).toMatchObject({
          brand: { name: 'Nori House', slug: 'nori-house', status: 'active', originCountry: 'JP' },
        });
        const createdId = (created.body as { brand: { id: string } }).brand.id;

        const twin = await http().post(ADMIN).set(editor).send({ name: 'NORI HOUSE!' }).expect(409);
        expect(twin.body).toMatchObject({ code: 'brand.near-duplicate' });
        const taken = await http()
          .post(ADMIN)
          .set(editor)
          .send({ name: 'Different Name', slug: 'nori-house' })
          .expect(409);
        expect(taken.body).toMatchObject({ code: 'brand.slug-taken' });
        await http().post(ADMIN).set(editor).send({ name: '' }).expect(400);
        const unknown = await http()
          .post(ADMIN)
          .set(editor)
          .send({ name: 'Extra Field', status: 'draft' })
          .expect(400);
        expect(unknown.body).toMatchObject({ code: 'validation.failed' });

        const edited = await http()
          .put(`${ADMIN}/${createdId}`)
          .set(editor)
          .send({ name: 'Nori House Ltd', summary: 'Seaweed', version: 1 })
          .expect(200);
        expect(edited.body).toMatchObject({
          brand: { name: 'Nori House Ltd', summary: 'Seaweed', version: 2 },
        });
        const stale = await http()
          .put(`${ADMIN}/${createdId}`)
          .set(editor)
          .send({ name: 'Again', version: 1 })
          .expect(409);
        expect(stale.body).toMatchObject({ code: 'conflict.stale' });

        const archived = await http()
          .post(`${ADMIN}/${createdId}/archive`)
          .set(editor)
          .send({ version: 2 })
          .expect(200);
        expect(archived.body).toMatchObject({ brand: { status: 'archived' } });
        await http()
          .post(`${ADMIN}/${createdId}/archive`)
          .set(editor)
          .send({ version: 3 })
          .expect(409);
      });

      it('approves a proposal once, making it active', async () => {
        await boot();
        await seeded(code);
        const editor = adminSession(code, EDITOR, 6);
        const approved = await http()
          .post(`${ADMIN}/${DRAFT}/approve`)
          .set(editor)
          .send({ version: 1 })
          .expect(200);
        expect(approved.body).toMatchObject({ brand: { id: DRAFT, status: 'active' } });
        const again = await http()
          .post(`${ADMIN}/${DRAFT}/approve`)
          .set(editor)
          .send({ version: 2 })
          .expect(409);
        expect(again.body).toMatchObject({ code: 'brand.not-draft' });
      });

      it('merges brands: aliases and products move, the source is archived; refuses a bad target', async () => {
        await boot();
        await seeded(code);
        brands.seedAlias(BRAND_B, 'Fuji');
        brands.productCounts.set(`${code}:${BRAND_B}`, 2);
        const editor = adminSession(code, EDITOR, 7);
        const itself = await http()
          .post(`${ADMIN}/${BRAND_A}/merge`)
          .set(editor)
          .send({ sourceBrandIds: [BRAND_A] })
          .expect(422);
        expect(itself.body).toMatchObject({ code: 'brand.merge-into-itself' });
        const notActive = await http()
          .post(`${ADMIN}/${ARCHIVED}/merge`)
          .set(editor)
          .send({ sourceBrandIds: [BRAND_A] })
          .expect(409);
        expect(notActive.body).toMatchObject({ code: 'brand.merge-target-not-active' });

        const merged = await http()
          .post(`${ADMIN}/${BRAND_A}/merge`)
          .set(editor)
          .send({ sourceBrandIds: [BRAND_B], aliases: ['Acme Tea Co'] })
          .expect(200);
        expect(merged.body).toMatchObject({
          brand: { id: BRAND_A },
          merged: [{ brandId: BRAND_B, productsMoved: 2 }],
        });
        expect(brands.brands.get(BRAND_B)).toMatchObject({
          status: 'archived',
          mergedIntoId: BRAND_A,
        });
        expect(brands.productCounts.get(`${code}:${BRAND_A}`)).toBe(2);
        const detail = await http().get(`${ADMIN}/${BRAND_A}`).set(editor).expect(200);
        expect((detail.body as { aliases: string[] }).aliases).toEqual(
          expect.arrayContaining(['Fuji', 'Fuji Foods', 'Acme Tea Co']),
        );
      });

      it('lists the merge queue and settles a group as kept separate', async () => {
        await boot();
        await seeded(code);
        brands.candidates.push(
          { groupKey: 'acmetea', brandId: BRAND_A, status: 'open' },
          { groupKey: 'acmetea', brandId: BRAND_B, status: 'open' },
        );
        const editor = adminSession(code, EDITOR, 8);
        const queue = await http().get(`${ADMIN}/merge-queue`).set(editor).expect(200);
        expect(queue.body).toMatchObject({
          groups: [{ groupKey: 'acmetea', brands: [{ id: BRAND_A }, { id: BRAND_B }] }],
        });
        const dismissed = await http()
          .post(`${ADMIN}/merge-queue/dismiss`)
          .set(editor)
          .send({ groupKey: 'acmetea' })
          .expect(200);
        expect(dismissed.body).toEqual({ resolved: 2 });
        const after = await http().get(`${ADMIN}/merge-queue`).set(editor).expect(200);
        expect(after.body).toEqual({ groups: [] });
        await http()
          .post(`${ADMIN}/merge-queue/dismiss`)
          .set(editor)
          .send({ groupKey: 'acmetea' })
          .expect(404);
      });
    });

    describe('seller proposal', () => {
      const SELLER_ROUTE = '/catalog/seller/brands';

      it('refuses a seller without an own-brand product, and creates nothing', async () => {
        await boot();
        await seeded(code);
        const refused = await http()
          .post(SELLER_ROUTE)
          .set(sellerSession(code))
          .send({ name: 'My Label' })
          .expect(403);
        expect(refused.body).toEqual({ statusCode: 403, code: 'brand.own-brand-required' });
        expect(brands.brands.size).toBe(4);
      });

      it('refuses a seller who may not sell, and a request without a session', async () => {
        await boot();
        await seeded(code);
        brands.ownBrandSellers.add(`${code}:${SELLER}`);
        eligible = false;
        const notEligible = await http()
          .post(SELLER_ROUTE)
          .set(sellerSession(code))
          .send({ name: 'My Label' })
          .expect(403);
        expect(notEligible.body).toMatchObject({ code: 'seller.not-eligible' });
        await http()
          .post(SELLER_ROUTE)
          .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
          .send({ name: 'My Label' })
          .expect(401);
        expect(brands.brands.size).toBe(4);
      });

      it('creates a draft proposal for a seller with an own-brand product; it is not public until approved', async () => {
        await boot();
        await seeded(code);
        brands.ownBrandSellers.add(`${code}:${SELLER}`);
        const created = await http()
          .post(SELLER_ROUTE)
          .set(sellerSession(code))
          .send({ name: 'My Label', originCountry: 'AU' })
          .expect(201);
        expect(created.body).toMatchObject({ slug: 'my-label', status: 'draft' });
        const brandId = (created.body as { brandId: string }).brandId;
        expect(brands.brands.get(brandId as Id<'Brand'>)).toMatchObject({
          status: 'draft',
          proposedBySellerId: SELLER,
          approvedBy: null,
        });
        await http().get('/catalog/brands/my-label').set({ 'x-market-id': code }).expect(404);

        const twin = await http()
          .post(SELLER_ROUTE)
          .set(sellerSession(code))
          .send({ name: 'Acme Tea' })
          .expect(409);
        expect(twin.body).toMatchObject({ code: 'brand.near-duplicate' });
        const body = twin.body as { details?: unknown };
        // The look-alike named is the live brand, never another seller's draft.
        expect(JSON.stringify(body)).not.toContain('Draft Brand');
        await http()
          .post(SELLER_ROUTE)
          .set(sellerSession(code))
          .send({ name: 'Other Label', status: 'active' })
          .expect(400);

        const editor = adminSession(code, EDITOR, 10);
        await http()
          .post(`${ADMIN}/${brandId}/approve`)
          .set(editor)
          .send({ version: 1 })
          .expect(200);
        await http().get('/catalog/brands/my-label').set({ 'x-market-id': code }).expect(200);
      });
    });

    describe('public reads', () => {
      const asVisitor = { 'x-market-id': code };

      it('reads an active brand by slug with the live product count, without a session', async () => {
        await boot();
        await seeded(code);
        brands.liveCounts.set(`${code}:${BRAND_A}`, 7);
        const response = await http().get('/catalog/brands/acme-tea').set(asVisitor).expect(200);
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.body).toEqual({
          slug: 'acme-tea',
          name: 'Acme Tea',
          summary: null,
          originCountry: null,
          logoImageId: null,
          logoAlt: null,
          headerImageId: null,
          productCount: 7,
        });
        // No private field leaks into the public answer.
        expect(Object.keys(response.body as object)).not.toEqual(
          expect.arrayContaining(['id', 'status', 'proposedBySellerId', 'approvedBy', 'version']),
        );
      });

      it('answers 404 for a draft, an archived and an unknown slug', async () => {
        await boot();
        await seeded(code);
        for (const slug of ['draft-brand', 'old-brand', 'no-such-brand']) {
          const response = await http().get(`/catalog/brands/${slug}`).set(asVisitor).expect(404);
          expect(response.body).toEqual({ statusCode: 404, code: 'brand.not-found' });
        }
        await http().get('/catalog/brands/Not_A_Slug').set(asVisitor).expect(404);
      });

      it('lists the active brands A to Z in sections', async () => {
        await boot();
        await seeded(code);
        brands.seed(brandState(id<'Brand'>(0xc810), 'Apple Orchard'));
        brands.seed(brandState(id<'Brand'>(0xc811), '7 Seas'));
        const response = await http().get('/catalog/brands').set(asVisitor).expect(200);
        expect(response.body).toEqual({
          sections: [
            {
              letter: 'A',
              brands: [
                expect.objectContaining({ slug: 'acme-tea', name: 'Acme Tea' }),
                expect.objectContaining({ slug: 'apple-orchard' }),
              ],
            },
            { letter: 'F', brands: [expect.objectContaining({ slug: 'fuji-foods' })] },
            { letter: '#', brands: [expect.objectContaining({ slug: '7-seas' })] },
          ],
          truncated: false,
        });
        await http().get('/catalog/brands?x=1').set(asVisitor).expect(400);
      });
    });
  });
});
