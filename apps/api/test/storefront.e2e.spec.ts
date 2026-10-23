import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { AddStorefrontModule } from '../src/modules/storefront/application/use-cases/add-module.use-case';
import { ApproveStorefrontNavigation } from '../src/modules/storefront/application/use-cases/approve-navigation.use-case';
import { CreateStorefrontPage } from '../src/modules/storefront/application/use-cases/create-page.use-case';
import { PublishStorefrontPage } from '../src/modules/storefront/application/use-cases/publish-page.use-case';
import { ReorderStorefrontModules } from '../src/modules/storefront/application/use-cases/reorder-modules.use-case';
import { ReplaceStorefrontNavigationDraft } from '../src/modules/storefront/application/use-cases/replace-navigation-draft.use-case';
import { ViewPublishedLandingPage } from '../src/modules/storefront/application/use-cases/view-published-landing-page.use-case';
import { ViewPublishedStorefrontNavigation } from '../src/modules/storefront/application/use-cases/view-published-navigation.use-case';
import { ViewPublishedStorefrontPage } from '../src/modules/storefront/application/use-cases/view-published-page.use-case';
import { ArchiveStorefrontSlide } from '../src/modules/storefront/application/use-cases/archive-slide.use-case';
import { CreateStorefrontSlide } from '../src/modules/storefront/application/use-cases/create-slide.use-case';
import { ListStorefrontSlides } from '../src/modules/storefront/application/use-cases/list-slides.use-case';
import { PrepareStorefrontSlideCopy } from '../src/modules/storefront/application/use-cases/prepare-slide-copy.use-case';
import { UpdateStorefrontSlideDraft } from '../src/modules/storefront/application/use-cases/update-slide-draft.use-case';
import { STOREFRONT_STATUS } from '../src/modules/storefront/presentation/http-answers';
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

// The storefront routes over HTTP: the real guards and controllers; the use cases are stubs, so
// this proves the admin session, the panel population, CSRF, the closed bodies, the status of
// each refusal, the answer shapes, `no-store`, and that the buyer reads need no session. The use
// cases have their own spec.

const START = Temporal.Instant.from('2026-10-17T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const PAGE_ID = id<'StorefrontPage'>(0xd001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the storefront routes to its exact status', () => {
  expect(STOREFRONT_STATUS).toEqual({
    'validation.failed': 400,
    'storefront.page-not-found': 404,
    'storefront.version-not-found': 404,
    'storefront.slot-not-found': 404,
    'storefront.placement-not-found': 404,
    'storefront.page-locked': 409,
    'storefront.page-archived': 409,
    'storefront.slot-full': 409,
    'storefront.slug-taken': 409,
    'storefront.nothing-to-publish': 409,
    'storefront.draft-changed': 409,
    'storefront.slide-not-found': 404,
    'storefront.slide-version-not-found': 404,
    'storefront.slide-archived': 409,
    'storefront.slide-version-limit': 409,
  });
});

describe.each(TEST_MARKETS)('storefront routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CreateStorefrontPage)
          .useValue(stub('create'))
          .overrideProvider(CreateStorefrontSlide)
          .useValue(stub('create-slide'))
          .overrideProvider(UpdateStorefrontSlideDraft)
          .useValue(stub('update-slide'))
          .overrideProvider(ArchiveStorefrontSlide)
          .useValue(stub('archive-slide'))
          .overrideProvider(ListStorefrontSlides)
          .useValue(stub('list-slides'))
          .overrideProvider(PrepareStorefrontSlideCopy)
          .useValue(stub('copy-slide'))
          .overrideProvider(AddStorefrontModule)
          .useValue(stub('add'))
          .overrideProvider(ReorderStorefrontModules)
          .useValue(stub('reorder'))
          .overrideProvider(PublishStorefrontPage)
          .useValue(stub('publish'))
          .overrideProvider(ReplaceStorefrontNavigationDraft)
          .useValue(stub('navigation-draft'))
          .overrideProvider(ApproveStorefrontNavigation)
          .useValue(stub('approve'))
          .overrideProvider(ViewPublishedStorefrontPage)
          .useValue(stub('published-page'))
          .overrideProvider(ViewPublishedLandingPage)
          .useValue(stub('landing'))
          .overrideProvider(ViewPublishedStorefrontNavigation)
          .useValue(stub('published-navigation')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'sf-seed-0001'), {});
    fakes.seedAccount({
      id: ADMIN,
      marketId,
      population: 'admin',
      email: { typed: 'admin@Example.com', normalized: 'admin@example.com' },
      displayName: 'admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
  }

  function adminSession() {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf101),
        marketId,
        accountId: ADMIN,
        population: 'admin',
        sellerId: null,
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

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const detail = {
    id: PAGE_ID,
    kind: 'dynamic',
    systemKey: null,
    slug: 'eid',
    path: '/l/eid',
    templateKey: 'campaign-landing',
    title: 'Eid',
    editLevel: 'full',
    status: 'draft',
    hasDraft: true,
    publishedVersionNo: null,
    publishedAt: null,
    updatedAt: START,
    seo: {},
    linked: null,
    startsAt: null,
    endsAt: null,
    archivedRedirect: null,
    slots: [],
    draft: { versionNo: 1, placements: { main: [] }, settings: null, updatedAt: START },
    published: null,
    versions: [{ id: id(0xe1), versionNo: 1, state: 'draft', createdAt: START, publishedAt: null }],
  };
  const layout = {
    kind: 'system',
    key: 'home',
    slug: null,
    templateKey: 'system.home',
    title: null,
    seo: {},
    linked: null,
    versionNo: 3,
    publishedAt: START,
    slots: [{ key: 'main', kind: 'modules', width: 'full', modules: [] }],
  };
  const newPage = { templateKey: 'campaign-landing', title: 'Eid', slug: 'eid' };
  const reviewed = { versionNo: 1, updatedAt: START.toString() };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(detail);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin create a page, add and reorder modules, publish, draft and approve the navigation', async () => {
    await boot();
    const session = adminSession();
    const made = await call('post', '/storefront/admin/pages', session, newPage);
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body).toMatchObject({
      id: PAGE_ID,
      updatedAt: START.toString(),
      draft: { versionNo: 1, updatedAt: START.toString() },
      versions: [{ versionNo: 1, createdAt: START.toString() }],
    });
    const module = { module: 'faq', config: { items: [] } };
    expect(
      (await call('post', `/storefront/admin/pages/home/slots/main/modules`, session, module))
        .status,
    ).toBe(201);
    expect(
      (
        await call('put', `/storefront/admin/pages/${PAGE_ID}/slots/main/order`, session, {
          placementIds: ['a'],
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('post', `/storefront/admin/pages/${PAGE_ID}/publish`, session, reviewed)).status,
    ).toBe(200);
    const slots = { slots: { rail: [] } };
    expect((await call('put', '/storefront/admin/navigation/draft', session, slots)).status).toBe(
      200,
    );
    expect(
      (await call('post', '/storefront/admin/navigation/approve', session, reviewed)).status,
    ).toBe(200);
    expect(calls).toEqual([
      { name: 'create', input: newPage },
      { name: 'add', input: { page: 'home', slot: 'main', body: module } },
      { name: 'reorder', input: { page: PAGE_ID, slot: 'main', placementIds: ['a'] } },
      { name: 'publish', input: { page: PAGE_ID, body: reviewed } },
      { name: 'navigation-draft', input: slots },
      { name: 'approve', input: { body: reviewed } },
    ]);
  });

  it('refuses an admin route with no session, a write without CSRF and a stray field', async () => {
    await boot();
    const session = adminSession();
    expect((await call('get', '/storefront/admin/pages', {})).status).toBe(401);
    expect(
      (await call('post', '/storefront/admin/pages', { cookie: session.cookie }, newPage)).status,
    ).toBe(403);
    expect(
      (await call('post', '/storefront/admin/navigation/approve', { cookie: session.cookie }))
        .status,
    ).toBe(403);
    const extra = await call('post', '/storefront/admin/pages', session, {
      ...newPage,
      kind: 'system',
    });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'kind', code: 'unknown-field' }] },
    });
    expect(calls).toEqual([]);
  });

  it('maps the refusals of the admin routes', async () => {
    await boot();
    const session = adminSession();
    const publish = () =>
      call('post', `/storefront/admin/pages/${PAGE_ID}/publish`, session, reviewed);
    next = err({
      code: 'validation.failed',
      fields: [{ path: 'slots.main', code: 'too-few-modules' }],
    });
    expect((await publish()).body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'slots.main', code: 'too-few-modules' }] },
    });
    next = err({ code: 'storefront.nothing-to-publish' });
    expect((await publish()).status).toBe(409);
    next = err({ code: 'storefront.draft-changed' });
    expect((await publish()).status).toBe(409);
    next = err({ code: 'storefront.page-not-found' });
    expect((await publish()).status).toBe(404);
    next = err({ code: 'access.denied' });
    expect((await publish()).status).toBe(403);
  });

  describe('slides', () => {
    const SLIDE_ID = id<'StorefrontSlide'>(0xd501);
    const slideBody = {
      kind: 'announcement',
      internalName: 'Eid',
      content: { title: 'Eid Mubarak' },
      startsAt: START.toString(),
      endsAt: START.add({ hours: 48 }).toString(),
      placements: [{ position: 'home.hero' }],
    };
    const slideView = {
      id: SLIDE_ID,
      kind: 'announcement',
      internalName: 'Eid',
      status: 'draft',
      startsAt: START,
      endsAt: START.add({ hours: 48 }),
      pinned: false,
      sponsored: false,
      hasDraft: true,
      positions: ['home.hero'],
      updatedAt: START,
      draft: null,
      live: null,
      pending: false,
      versions: [],
    };

    it('lets an admin create, change, list, copy out and archive slides', async () => {
      await boot();
      const session = adminSession();
      next = ok(slideView);
      const made = await call('post', '/storefront/admin/slides', session, slideBody);
      expect(made.status).toBe(201);
      expect(made.headers['cache-control']).toBe('no-store');
      expect(made.body).toMatchObject({ id: SLIDE_ID, startsAt: START.toString(), draft: null });
      const draftBody: Record<string, unknown> = { ...slideBody };
      delete draftBody.kind;
      expect(
        (await call('put', `/storefront/admin/slides/${SLIDE_ID}`, session, draftBody)).status,
      ).toBe(200);
      expect(
        (await call('post', `/storefront/admin/slides/${SLIDE_ID}/archive`, session)).status,
      ).toBe(200);
      next = ok([slideView]);
      const listed = await call(
        'get',
        '/storefront/admin/slides?state=draft&position=home.hero',
        session,
      );
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ slides: [{ id: SLIDE_ID, positions: ['home.hero'] }] });
      next = ok({
        ...draftBody,
        kind: 'announcement',
        pinned: false,
        sponsored: false,
        content: null,
        startsAt: 'a',
        endsAt: 'b',
        placements: [],
      });
      expect((await call('get', `/storefront/admin/slides/${SLIDE_ID}/copy`, session)).status).toBe(
        200,
      );
      expect(calls.map((c) => c.name)).toEqual([
        'create-slide',
        'update-slide',
        'archive-slide',
        'list-slides',
        'copy-slide',
      ]);
      expect(calls[3]!.input).toEqual({ state: 'draft', position: 'home.hero' });
    });

    it('refuses a slide route with no session, no CSRF, a cross-site origin and a stray field', async () => {
      await boot();
      const session = adminSession();
      // No session: the actor is anonymous and the gate of the real use case answers 401.
      next = err({ code: 'access.unauthenticated' });
      expect((await call('get', '/storefront/admin/slides', {})).status).toBe(401);
      calls = [];
      expect(
        (await call('post', '/storefront/admin/slides', { cookie: session.cookie }, slideBody))
          .status,
      ).toBe(403);
      expect(
        (
          await call(
            'post',
            '/storefront/admin/slides',
            { ...session, 'sec-fetch-site': 'cross-site' },
            slideBody,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            'post',
            '/storefront/admin/slides',
            { ...session, origin: 'https://evil.example' },
            slideBody,
          )
        ).status,
      ).toBe(403);
      const extra = await call('put', `/storefront/admin/slides/${SLIDE_ID}`, session, {
        ...slideBody,
      });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        details: { fields: [{ path: 'kind', code: 'unknown-field' }] },
      });
      expect(calls).toEqual([]);
    });

    it('maps the refusals of the slide routes', async () => {
      await boot();
      const session = adminSession();
      const view = () => call('get', `/storefront/admin/slides`, session);
      next = err({ code: 'storefront.slide-not-found' });
      expect((await view()).status).toBe(404);
      next = err({ code: 'storefront.slide-archived' });
      expect((await view()).status).toBe(409);
      next = err({ code: 'validation.failed', fields: [{ path: 'state', code: 'enum' }] });
      expect((await view()).body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'state', code: 'enum' }] },
      });
      next = err({ code: 'access.denied' });
      expect((await view()).status).toBe(403);
    });
  });

  it('answers the published layouts to a buyer with no session, and a redirect for an old slug', async () => {
    await boot();
    next = ok({ kind: 'page', page: layout });
    const home = await http().get('/storefront/pages/home').set({ 'x-market-id': code });
    expect(home.status).toBe(200);
    expect(home.headers['cache-control']).toBe('no-store');
    expect(home.body).toEqual({ kind: 'page', page: { ...layout, publishedAt: START.toString() } });

    next = ok({ kind: 'redirect', to: '/l/eid-2026' });
    const old = await http().get('/storefront/landing/eid').set({ 'x-market-id': code });
    expect(old.body).toEqual({ kind: 'redirect', to: '/l/eid-2026' });

    next = err({ code: 'storefront.page-not-found' });
    const gone = await http().get('/storefront/landing/nope').set({ 'x-market-id': code });
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ statusCode: 404, code: 'storefront.page-not-found' });

    next = ok({
      kind: 'page',
      page: { ...layout, key: 'navigation', versionNo: null, publishedAt: null },
    });
    expect((await http().get('/storefront/navigation').set({ 'x-market-id': code })).status).toBe(
      200,
    );
    expect(calls).toEqual([
      { name: 'published-page', input: { key: 'home' } },
      { name: 'landing', input: { slug: 'eid' } },
      { name: 'landing', input: { slug: 'nope' } },
      { name: 'published-navigation', input: {} },
    ]);
  });
});
