import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ApproveBlogPost } from '../src/modules/blog/application/use-cases/approve-post.use-case';
import { CreateBlogPost } from '../src/modules/blog/application/use-cases/create-post.use-case';
import { ListBlogMedia } from '../src/modules/blog/application/use-cases/list-media.use-case';
import { ListBlogPosts } from '../src/modules/blog/application/use-cases/list-posts.use-case';
import { ExportBlogPosts } from '../src/modules/blog/application/use-cases/export-posts.use-case';
import { PauseBlogPost } from '../src/modules/blog/application/use-cases/pause-post.use-case';
import { PrepareBlogPostCopy } from '../src/modules/blog/application/use-cases/prepare-post-copy.use-case';
import { ScheduleBlogPost } from '../src/modules/blog/application/use-cases/schedule-post.use-case';
import { CreateOwnBlogPost } from '../src/modules/blog/application/use-cases/seller-create-post.use-case';
import { UploadBlogMedia } from '../src/modules/blog/application/use-cases/upload-media.use-case';
import { ViewBlogMediaFile } from '../src/modules/blog/application/use-cases/view-media-file.use-case';
import { ViewPublishedBlogPost } from '../src/modules/blog/application/use-cases/view-published-post.use-case';
import { ListPublishedBlogPosts } from '../src/modules/blog/application/use-cases/view-published-posts.use-case';
import { ViewUpcomingBlogEvents } from '../src/modules/blog/application/use-cases/view-upcoming-events.use-case';
import { BLOG_STATUS } from '../src/modules/blog/presentation/http-answers';
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

// The blog routes over HTTP: the real guards and controllers; the use cases are stubs, so this
// proves the admin session, the panel population, CSRF, the closed bodies, the status of each
// refusal, the shapes of the answers (an instant is a string), `no-store`, and that the buyer
// reads need no session. The use cases have their own specs.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const POST_ID = id<'BlogPost'>(0xb001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the blog routes to its exact status', () => {
  expect(BLOG_STATUS).toEqual({
    'validation.failed': 400,
    'batch.too-large': 413,
    'blog.post-not-found': 404,
    'blog.not-found': 404,
    'blog.category-not-found': 404,
    'blog.tag-not-found': 404,
    'blog.gone': 410,
    'blog.access-off': 403,
    'blog.seller-owned': 403,
    'blog.self-approval-refused': 403,
    'second-factor.required': 403,
    'second-factor.enrolment-required': 403,
    'blog.post-archived': 409,
    'blog.wrong-state': 409,
    'blog.slug-taken': 409,
    'blog.category-slug-taken': 409,
    'blog.category-in-use': 409,
    'blog.tag-slug-taken': 409,
    'blog.tag-in-use': 409,
    'blog.quota-used': 409,
    'blog.version-limit': 409,
    'conflict.stale': 409,
    'blog.checks-failed': 422,
    'blog.unavailable': 503,
    'blog.media-not-found': 404,
    'file.too-large': 413,
    'file.unsupported-type': 415,
    'file.too-many-pixels': 422,
    'file.too-small': 422,
    'file.unreadable': 422,
  });
});

describe.each(TEST_MARKETS)('blog routes over HTTP in market %s', (code) => {
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
          .overrideProvider(ListBlogPosts)
          .useValue(stub('list'))
          .overrideProvider(ExportBlogPosts)
          .useValue(stub('export'))
          .overrideProvider(CreateBlogPost)
          .useValue(stub('create'))
          .overrideProvider(ApproveBlogPost)
          .useValue(stub('approve'))
          .overrideProvider(ScheduleBlogPost)
          .useValue(stub('schedule'))
          .overrideProvider(PauseBlogPost)
          .useValue(stub('pause'))
          .overrideProvider(PrepareBlogPostCopy)
          .useValue(stub('copy'))
          .overrideProvider(CreateOwnBlogPost)
          .useValue(stub('seller-create'))
          .overrideProvider(ListPublishedBlogPosts)
          .useValue(stub('published-list'))
          .overrideProvider(ViewPublishedBlogPost)
          .useValue(stub('published-post'))
          .overrideProvider(ViewUpcomingBlogEvents)
          .useValue(stub('upcoming'))
          .overrideProvider(UploadBlogMedia)
          .useValue(stub('media-upload'))
          .overrideProvider(ListBlogMedia)
          .useValue(stub('media-list'))
          .overrideProvider(ViewBlogMediaFile)
          .useValue(stub('media-file')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'blog-seed-0001'), {});
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
    id: POST_ID,
    kind: 'news',
    slug: 'eid-gifts',
    status: 'draft',
    scheduledAt: START.add({ hours: 5 }),
    updatedAt: START,
    open: { versionNo: 1, state: 'draft', createdAt: START },
    live: null,
    versions: [{ id: id(0xc1), versionNo: 1, state: 'draft', createdAt: START }],
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(detail);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin create a post, approve, schedule, pause and ask for the copy package', async () => {
    await boot();
    const session = adminSession();
    const body = { kind: 'news', content: { title: 'Eid gifts' } };
    const made = await call('post', '/blog/admin/posts', session, body);
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body).toMatchObject({
      id: POST_ID,
      updatedAt: START.toString(),
      scheduledAt: START.add({ hours: 5 }).toString(),
      open: { createdAt: START.toString() },
    });
    const review = { versionNo: 1 };
    expect(
      (await call('post', `/blog/admin/posts/${POST_ID}/approve`, session, review)).status,
    ).toBe(200);
    const schedule = { versionNo: 1, scheduledAt: START.add({ hours: 5 }).toString() };
    expect(
      (await call('put', `/blog/admin/posts/${POST_ID}/schedule`, session, schedule)).status,
    ).toBe(200);
    const pause = { reason: 'Wrong price shown' };
    expect((await call('post', `/blog/admin/posts/${POST_ID}/pause`, session, pause)).status).toBe(
      200,
    );
    next = ok({ kind: 'news', content: { title: 'Eid gifts' }, left: [] });
    expect((await call('get', `/blog/admin/posts/${POST_ID}/copy-package`, session)).status).toBe(
      200,
    );
    expect(calls).toEqual([
      { name: 'create', input: { body } },
      { name: 'approve', input: { post: POST_ID, body: review } },
      { name: 'schedule', input: { post: POST_ID, body: schedule } },
      { name: 'pause', input: { post: POST_ID, body: pause } },
      { name: 'copy', input: { post: POST_ID } },
    ]);
  });

  it('passes the list query to the list, and streams the export from its own route before `:post`', async () => {
    await boot();
    const session = adminSession();
    next = ok({
      items: [],
      counts: {},
      total: 0,
      page: 1,
      pageSize: 25,
      hasMore: false,
      nextCursor: null,
    });
    const listed = await call('get', '/blog/admin/posts?view=draft&q=eid&page=2', session);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    next = ok({
      filename: 'blog-posts-2026-11-16.csv',
      contentType: 'text/csv; charset=utf-8',
      chunks: (async function* () {
        await Promise.resolve();
        yield 'Post ID,Title\r\n';
        yield `${POST_ID},Eid gifts\r\n`;
      })(),
    });
    const file = await call('get', '/blog/admin/posts/export?format=csv&view=all', session);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="blog-posts-2026-11-16.csv"',
    );
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.text).toContain('Eid gifts');
    next = { ok: false, error: { code: 'batch.too-large', max: 10_000, total: 12_000 } };
    const big = await call('get', '/blog/admin/posts/export', session);
    expect(big.status).toBe(413);
    expect(big.headers['cache-control']).toBe('no-store');
    expect(big.body).toEqual({
      statusCode: 413,
      code: 'batch.too-large',
      details: { max: 10_000, total: 12_000 },
    });
    expect(calls).toEqual([
      { name: 'list', input: { query: { view: 'draft', q: 'eid', page: '2' } } },
      { name: 'export', input: { query: { format: 'csv', view: 'all' } } },
      { name: 'export', input: { query: {} } },
    ]);
  });

  it('refuses an admin route with no session, a write without CSRF, a stray field and a non-JSON body', async () => {
    await boot();
    const session = adminSession();
    const body = { kind: 'news', content: { title: 'Eid gifts' } };
    // No session: the actor is anonymous and the gate of the real use case answers 401.
    expect((await call('get', `/blog/admin/posts/${POST_ID}`, {})).status).toBe(401);
    expect((await call('post', '/blog/admin/posts', { cookie: session.cookie }, body)).status).toBe(
      403,
    );
    const extra = await call('post', '/blog/admin/posts', session, { ...body, html: '<p>' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'html', code: 'unknown-field' }] },
    });
    const text = await http()
      .post('/blog/admin/posts')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('keeps the seller routes for a seller session: an admin session is refused', async () => {
    await boot();
    const session = adminSession();
    const refused = await call('post', '/blog/seller/posts', session, {
      kind: 'news',
      content: { title: 'x' },
    });
    expect([401, 403]).toContain(refused.status);
    expect(calls).toEqual([]);
  });

  it('maps the refusals of the admin routes', async () => {
    await boot();
    const session = adminSession();
    const approve = () =>
      call('post', `/blog/admin/posts/${POST_ID}/approve`, session, { versionNo: 1 });
    next = err({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'cover-missing', path: 'coverImageId' }],
    });
    expect((await approve()).body).toEqual({
      statusCode: 422,
      code: 'blog.checks-failed',
      details: { findings: [{ severity: 'error', code: 'cover-missing', path: 'coverImageId' }] },
    });
    next = err({ code: 'second-factor.required', actionKey: 'blog.post.self-approve' });
    const second = await approve();
    expect(second.status).toBe(403);
    expect(second.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'blog.post.self-approve' },
    });
    next = err({ code: 'blog.self-approval-refused' });
    expect((await approve()).status).toBe(403);
    next = err({ code: 'conflict.stale' });
    expect((await approve()).status).toBe(409);
    next = err({ code: 'blog.post-not-found' });
    expect((await approve()).status).toBe(404);
    next = err({ code: 'access.denied' });
    expect((await approve()).status).toBe(403);
    next = err({ code: 'access.unavailable' });
    expect((await approve()).status).toBe(503);
    next = err({ code: 'something.new' });
    expect((await approve()).status).toBe(500);
  });

  it('takes a picture upload as a large JSON body for an admin session with CSRF, and answers the library and a rendition', async () => {
    await boot();
    const session = adminSession();
    const MEDIA = id<'BlogMedia'>(0xd001);
    const view = { id: MEDIA, width: 1600, height: 900, createdAt: START, uploadedBy: ADMIN };
    // About 3 MB of base64: far past the 64 KiB of the ordinary JSON routes.
    const data = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    next = ok(view);
    const made = await call('post', '/blog/admin/media', session, { data });
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body).toEqual({ ...view, createdAt: START.toString() });

    next = ok({ items: [view], page: 1, pageSize: 40, hasMore: false });
    const list = await call('get', '/blog/admin/media?page=1', session);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      items: [{ ...view, createdAt: START.toString() }],
      page: 1,
      pageSize: 40,
      hasMore: false,
    });

    next = ok({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    const file = await call('get', `/blog/admin/media/${MEDIA}/thumb`, session);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe('sandbox');

    expect(calls).toEqual([
      { name: 'media-upload', input: { body: { data } } },
      { name: 'media-list', input: { query: { page: '1' } } },
      { name: 'media-file', input: { media: MEDIA, size: 'thumb' } },
    ]);
  });

  it('refuses a picture upload without CSRF, with a stray field or not as JSON, and maps its refusals', async () => {
    await boot();
    const session = adminSession();
    const data = Buffer.from('picture').toString('base64');
    // Without the CSRF header the large body is not read: the small parser refuses it first.
    const big = Buffer.alloc(200 * 1024, 7).toString('base64');
    expect(
      (await call('post', '/blog/admin/media', { cookie: session.cookie }, { data: big })).status,
    ).toBe(413);
    expect(
      (await call('post', '/blog/admin/media', { cookie: session.cookie }, { data })).status,
    ).toBe(403);
    const extra = await call('post', '/blog/admin/media', session, { data, alt: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'alt', code: 'unknown-field' }] },
    });
    const text = await http()
      .post('/blog/admin/media')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);

    const upload = () => call('post', '/blog/admin/media', session, { data });
    for (const [code, status] of [
      ['file.too-large', 413],
      ['file.unsupported-type', 415],
      ['file.too-small', 422],
      ['file.too-many-pixels', 422],
      ['file.unreadable', 422],
      ['validation.failed', 400],
    ] as const) {
      next = err({ code });
      expect((await upload()).status).toBe(status);
    }
    next = err({ code: 'blog.unavailable', retryAfterSeconds: 2 });
    const busy = await upload();
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('2');
    expect(busy.body).toEqual({ statusCode: 503, code: 'blog.unavailable' });

    next = err({ code: 'blog.media-not-found' });
    const missing = await call('get', `/blog/admin/media/${POST_ID}/large`, session);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'blog.media-not-found' });
  });

  it('answers the live posts to a buyer with no session, and 410 and 404 for an address that is gone or unknown', async () => {
    await boot();
    const card = { id: POST_ID, slug: 'eid-gifts', title: 'Eid gifts', publishedAt: START };
    next = ok({ items: [card], page: 1, pageSize: 12, hasMore: false });
    const list = await http().get('/blog/posts?kind=news&page=1').set({ 'x-market-id': code });
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      items: [{ ...card, publishedAt: START.toString() }],
      page: 1,
      pageSize: 12,
      hasMore: false,
    });

    next = ok({ kind: 'redirect', slug: 'eid-gifts' });
    const old = await http().get('/blog/posts/old-address').set({ 'x-market-id': code });
    expect(old.status).toBe(200);
    expect(old.body).toEqual({ kind: 'redirect', slug: 'eid-gifts' });

    next = err({ code: 'blog.gone' });
    const gone = await http().get('/blog/posts/taken-off').set({ 'x-market-id': code });
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({ statusCode: 410, code: 'blog.gone' });

    next = err({ code: 'blog.not-found' });
    const missing = await http().get('/blog/posts/nope').set({ 'x-market-id': code });
    expect(missing.status).toBe(404);

    next = ok({ items: [] });
    expect((await http().get('/blog/events/upcoming').set({ 'x-market-id': code })).status).toBe(
      200,
    );
    expect(calls).toEqual([
      { name: 'published-list', input: { query: { kind: 'news', page: '1' } } },
      { name: 'published-post', input: { slug: 'old-address' } },
      { name: 'published-post', input: { slug: 'taken-off' } },
      { name: 'published-post', input: { slug: 'nope' } },
      { name: 'upcoming', input: undefined },
    ]);
  });
});
