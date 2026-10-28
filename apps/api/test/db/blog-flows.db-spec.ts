import { randomBytes } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { BLOG_EVENTS } from '../../src/modules/blog/domain/events';
import { PrismaBlogRepository } from '../../src/modules/blog/infrastructure/prisma-blog.repository';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import {
  aCategory,
  approvedNews,
  content,
  createNews,
  eventDetails,
  liveNews,
  PUBLISHER,
  refusal,
  REVIEWER,
  SELLER_KEYS,
  unwrap,
  WRITER,
} from '../support/blog-fixtures';
import { blogHarness, PRODUCT_A, quietLogs } from '../support/blog-harness';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The blog use cases behind the real gate against the real tables, the real unit of work and the
// real outbox, in both Market fixtures: the lifecycle with its version pointers and partial
// uniques, a live post replaced by a newer version, the redirect of a renamed slug, pause and
// 410, the scheduled publish (once, idempotent), the seller quota under parallel submits, the
// live event status, the numbering of the outbox events and the wall between Markets. The rules
// themselves are in the in-memory specs under src/modules/blog; this is what only a database shows.

quietLogs();

type Row = Record<string, unknown>;

describe.each(TEST_MARKETS)('blog flows in market %s (database)', (code) => {
  let db: Persistence;
  let sql: Client;
  let h: ReturnType<typeof makeHarness>;

  const makeHarness = () => {
    const catalogue = new EventCatalogue();
    catalogue.register('blog', BLOG_EVENTS);
    catalogue.seal();
    const ids = new UuidV7IdGenerator(new SystemClock());
    return blogHarness(code, {
      posts: new PrismaBlogRepository(db.service),
      unitOfWork: db.unitOfWork,
      ids,
      outbox: new PrismaOutboxWriterFactory(
        modelOf(),
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('blog'),
    });
  };
  const modelOf = () => modelMap;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(() => {
    h = makeHarness();
  });

  const writer = () => h.admin('writer', WRITER);
  const reviewer = () => h.admin('reviewer', REVIEWER);
  const publisher = () => h.admin('publisher', PUBLISHER);
  const category = () => aCategory(h, `c-${randomBytes(6).toString('hex')}`);
  const rows = async (text: string, params: unknown[]): Promise<Row[]> =>
    (await sql.query<Row>(text, params)).rows;
  const one = async (text: string, params: unknown[]): Promise<Row> => {
    const [first] = await rows(text, params);
    if (first === undefined) throw new Error('no row');
    return first;
  };
  const eventTypes = async (postId: string) =>
    (
      await rows(
        `SELECT type, aggregate_version FROM blog.outbox WHERE aggregate_id = $1 ORDER BY aggregate_version`,
        [postId],
      )
    ).map((r) => String(r.type));

  it('takes a post from draft to live and writes one numbered event per step', async () => {
    const cat = await category();
    const created = await createNews(h, writer(), cat, 'Eid gifts');
    unwrap(await h.cases.submitPost.execute(writer(), { post: created.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(), { post: created.id, body: { versionNo: 1 } }),
    );
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug })).code,
    ).toBe('blog.not-found');
    const live = unwrap(
      await h.cases.publishPost.execute(publisher(), { post: created.id, body: { versionNo: 1 } }),
    );
    expect(live).toMatchObject({ status: 'published', open: null });
    expect(live.live).toMatchObject({ versionNo: 1, state: 'live' });

    const answer = unwrap(
      await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug }),
    );
    expect(answer).toMatchObject({ kind: 'post', post: { slug: created.slug } });
    const list = unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), {}));
    expect(list.items.map((i) => i.slug)).toContain(created.slug);

    const types = await eventTypes(created.id);
    expect(types).toEqual([
      'blog.post-submitted.v1',
      'blog.post-approved.v1',
      'blog.post-published.v1',
    ]);
    const row = await one(
      `SELECT status, live_version_id, draft_version_id, row_version FROM blog.posts WHERE id = $1`,
      [created.id],
    );
    expect(row.status).toBe('published');
    expect(row.draft_version_id).toBeNull();
    expect(row.row_version).toBeGreaterThanOrEqual(3);
    const states = await rows(
      `SELECT version_no, state FROM blog.post_versions WHERE post_id = $1 ORDER BY version_no`,
      [created.id],
    );
    expect(states).toEqual([{ version_no: 1, state: 'live' }]);
  });

  it('replaces a live version by a newer one: the old one is retired, buyers never see a gap', async () => {
    const cat = await category();
    const live = await liveNews(h, cat, 'First wording');
    const edited = unwrap(
      await h.cases.updateDraft.execute(writer(), {
        post: live.id,
        body: { content: content({ categoryId: cat, title: 'Second wording' }) },
      }),
    );
    expect(edited.open).toMatchObject({ versionNo: 2, state: 'draft' });
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toMatchObject({ post: { title: 'First wording' } });
    unwrap(await h.cases.submitPost.execute(writer(), { post: live.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(), { post: live.id, body: { versionNo: 2 } }),
    );
    unwrap(
      await h.cases.publishPost.execute(publisher(), { post: live.id, body: { versionNo: 2 } }),
    );
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toMatchObject({ post: { title: 'Second wording' } });
    const states = await rows(
      `SELECT version_no, state FROM blog.post_versions WHERE post_id = $1 ORDER BY version_no`,
      [live.id],
    );
    expect(states).toEqual([
      { version_no: 1, state: 'retired' },
      { version_no: 2, state: 'live' },
    ]);
  });

  it('keeps the old address as a redirect and answers 410 once the post is paused, then resumes', async () => {
    const cat = await category();
    const live = await liveNews(h, cat, 'Seasonal picks');
    const renamed = unwrap(
      await h.cases.renamePostSlug.execute(publisher(), {
        post: live.id,
        body: { slug: `renamed-${randomBytes(4).toString('hex')}` },
      }),
    );
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toEqual({ kind: 'redirect', slug: renamed.slug });
    // Another post cannot take the old address, whether renamed or created.
    const other = await createNews(h, writer(), cat, 'Another piece');
    expect(
      refusal(
        await h.cases.updateDraft.execute(writer(), {
          post: other.id,
          body: { content: content({ categoryId: cat }), slug: live.slug },
        }),
      ).code,
    ).toBe('blog.slug-taken');

    const pauser = h.admin('pauser', ['blog.post.pause']);
    unwrap(
      await h.cases.pausePost.execute(pauser, { post: live.id, body: { reason: 'Wrong price' } }),
    );
    for (const slug of [live.slug, renamed.slug]) {
      expect(refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug })).code).toBe(
        'blog.gone',
      );
    }
    unwrap(await h.cases.resumePost.execute(publisher(), { post: live.id }));
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: renamed.slug })),
    ).toMatchObject({ kind: 'post' });
  });

  it('publishes at the scheduled time once, and repeated or parallel runs change nothing more', async () => {
    const cat = await category();
    const approved = await approvedNews(h, cat, 'Scheduled piece');
    const when = h.clock.now().add({ hours: 2 });
    unwrap(
      await h.cases.schedulePost.execute(publisher(), {
        post: approved.id,
        body: { versionNo: 1, scheduledAt: when.toString() },
      }),
    );
    // Other posts of this Market share the database: assert on this post only.
    const state = () =>
      one(
        `SELECT p.status, p.live_version_id, p.scheduled_at, p.scheduled_by, v.published_by
           FROM blog.posts p LEFT JOIN blog.post_versions v
             ON v.market_id = p.market_id AND v.id = p.live_version_id
          WHERE p.id = $1`,
        [approved.id],
      );
    const scheduler = publisher().actor;
    const schedulerId = scheduler.kind === 'authenticated' ? scheduler.accountId : null;
    await h.cases.publishDue.execute(h.system(), undefined);
    expect(await state()).toMatchObject({ status: 'scheduled', live_version_id: null });
    h.clock.advance(Temporal.Duration.from({ hours: 2, minutes: 1 }));
    const runs = await Promise.all([
      h.cases.publishDue.execute(h.system(), undefined),
      h.cases.publishDue.execute(h.system(), undefined),
      h.cases.publishDue.execute(h.system(), undefined),
    ]);
    for (const run of runs) unwrap(run);
    unwrap(await h.cases.publishDue.execute(h.system(), undefined));
    const after = await state();
    expect(after).toMatchObject({
      status: 'published',
      live_version_id: approved.open?.id,
      scheduled_at: null,
      scheduled_by: null,
    });
    // The publisher of record is the admin who set the schedule.
    expect(after.published_by).toBe(schedulerId);
    expect(
      (await eventTypes(approved.id)).filter((t) => t === 'blog.post-published.v1'),
    ).toHaveLength(1);
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: approved.slug })),
    ).toMatchObject({ kind: 'post' });
  });

  it('changes the status of a live event at once and lists upcoming events', async () => {
    const cat = await category();
    const created = unwrap(
      await h.cases.createPost.execute(writer(), {
        body: {
          kind: 'event',
          content: content({ categoryId: cat, title: 'Open day', event: eventDetails(h) }),
        },
      }),
    );
    unwrap(await h.cases.submitPost.execute(writer(), { post: created.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(), { post: created.id, body: { versionNo: 1 } }),
    );
    unwrap(
      await h.cases.publishPost.execute(publisher(), { post: created.id, body: { versionNo: 1 } }),
    );
    const upcoming = () => h.cases.viewUpcomingEvents.execute(h.anonymous(), undefined);
    expect(unwrap(await upcoming()).items.map((i) => i.slug)).toContain(created.slug);
    const changed = unwrap(
      await h.cases.changeEventStatus.execute(writer(), {
        post: created.id,
        body: { status: 'cancelled', message: 'The venue is closed.' },
      }),
    );
    expect(changed.versions).toHaveLength(1);
    expect(changed.live?.content.event).toMatchObject({ eventStatus: 'cancelled' });
    const event = await one(
      `SELECT e.event_status, e.status_message FROM blog.post_events e
         JOIN blog.post_versions v ON v.market_id = e.market_id AND v.id = e.version_id
        WHERE v.post_id = $1`,
      [created.id],
    );
    expect(event).toEqual({ event_status: 'cancelled', status_message: 'The venue is closed.' });
  });

  it('counts the seller quota in the database and lets exactly one of two parallel submits take the last place', async () => {
    const cat = await category();
    const sellerId = h.ids.next<'Seller'>();
    h.links.sellerAccess.set(sellerId, true);
    h.links.onSale.set(PRODUCT_A, new Set([sellerId]));
    const seller = h.seller(sellerId, SELLER_KEYS);
    const limit = h.deps.policy.of(h.market)!.sellerPostsPerMonth;
    const draft = async (title: string) =>
      unwrap(
        await h.cases.sellerCreatePost.execute(seller, {
          body: {
            kind: 'product',
            content: content({
              categoryId: cat,
              title,
              links: [{ type: 'product', id: PRODUCT_A }],
            }),
          },
        }),
      );
    for (let n = 0; n < limit - 1; n += 1) {
      const created = await draft(`Seller post ${n}`);
      unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: created.id }));
    }
    const a = await draft('Last place A');
    const b = await draft('Last place B');
    const results = await Promise.all([
      h.cases.sellerSubmitPost.execute(seller, { post: a.id }),
      h.cases.sellerSubmitPost.execute(seller, { post: b.id }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const losing = results.find((r) => !r.ok);
    expect(losing && refusal(losing)).toEqual({ code: 'blog.quota-used' });
    const quota = await one(
      `SELECT used FROM blog.seller_quotas WHERE market_id = $1 AND seller_id = $2`,
      [h.market.marketId, sellerId],
    );
    expect(quota.used).toBe(limit);
    // The refused post stays a draft with no month taken.
    const losingId = results[0]?.ok ? b.id : a.id;
    const left = await one(`SELECT status, quota_period FROM blog.posts WHERE id = $1`, [losingId]);
    expect(left).toEqual({ status: 'draft', quota_period: null });
  });

  it('refuses a post to its own writer as approver and keeps a post inside its Market', async () => {
    const cat = await category();
    const created = await createNews(h, writer(), cat, 'Mine alone');
    unwrap(await h.cases.submitPost.execute(writer(), { post: created.id }));
    const selfKeys = h.admin('writer', [...WRITER, ...REVIEWER]);
    const refused = refusal(
      await h.cases.approvePost.execute(selfKeys, { post: created.id, body: { versionNo: 1 } }),
    );
    expect((refused as { code: string }).code).toBe(
      code === 'AU' ? 'second-factor.required' : 'blog.self-approval-refused',
    );
    const post = await one(`SELECT market_id FROM blog.posts WHERE id = $1`, [created.id]);
    expect(post.market_id).toBe(h.market.marketId);
    // The other Market's reads do not find it.
    const otherCode = code === 'AU' ? 'ZZ' : 'AU';
    const crossed = await one(
      `SELECT count(*)::int AS n FROM blog.posts WHERE id = $1 AND market_id = $2`,
      [created.id, otherCode],
    );
    expect(crossed.n).toBe(0);
  });
  it('pages the due queue past more than a batch of blocked posts and publishes the one after them', async () => {
    const cat = await category();
    const blocked: string[] = [];
    const sellers = Array.from({ length: 52 }, () => h.ids.next<'Seller'>());
    h.links.onSale.set(PRODUCT_A, new Set(sellers));
    const reviewerContext = reviewer();
    const publisherContext = publisher();
    // 52 seller posts (more than one batch of 50), due first, whose sellers lose blog access.
    for (const [index, sellerId] of sellers.entries()) {
      h.links.sellerAccess.set(sellerId, true);
      const seller = h.seller(sellerId, SELLER_KEYS);
      const created = unwrap(
        await h.cases.sellerCreatePost.execute(seller, {
          body: {
            kind: 'product',
            content: content({
              categoryId: cat,
              title: `Blocked ${index}`,
              links: [{ type: 'product', id: PRODUCT_A }],
            }),
          },
        }),
      );
      unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: created.id }));
      unwrap(
        await h.cases.approvePost.execute(reviewerContext, {
          post: created.id,
          body: { versionNo: 1 },
        }),
      );
      unwrap(
        await h.cases.schedulePost.execute(publisherContext, {
          post: created.id,
          body: { versionNo: 1, scheduledAt: h.clock.now().add({ hours: 1 }).toString() },
        }),
      );
      blocked.push(created.id);
    }
    const good = await approvedNews(h, cat, 'After the queue');
    unwrap(
      await h.cases.schedulePost.execute(publisherContext, {
        post: good.id,
        body: { versionNo: 1, scheduledAt: h.clock.now().add({ hours: 2 }).toString() },
      }),
    );
    for (const sellerId of sellers) h.links.sellerAccess.set(sellerId, false);
    h.clock.advance(Temporal.Duration.from({ hours: 3 }));

    const run = unwrap(await h.cases.publishDue.execute(h.system(), undefined));
    expect(run.skipped).toBeGreaterThanOrEqual(blocked.length);
    expect(await one(`SELECT status FROM blog.posts WHERE id = $1`, [good.id])).toEqual({
      status: 'published',
    });
    const left = await rows(
      `SELECT count(*)::int AS n FROM blog.posts WHERE id = ANY($1::uuid[]) AND status = 'scheduled'`,
      [blocked],
    );
    expect(left).toEqual([{ n: blocked.length }]);
  });

  it('lets two parallel features end with one featured post and a conflict, never an error', async () => {
    const cat = await category();
    const a = await liveNews(h, cat, 'Feature A');
    const b = await liveNews(h, cat, 'Feature B');
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all(
        [a, b].map((post) =>
          h.cases.featurePost.execute(publisher(), { post: post.id, body: { featured: true } }),
        ),
      );
      for (const result of results) {
        if (!result.ok) expect(result.error).toEqual({ code: 'conflict.stale' });
      }
      expect(results.some((r) => r.ok)).toBe(true);
      expect(
        await one(`SELECT count(*)::int AS n FROM blog.posts WHERE market_id = $1 AND featured`, [
          h.market.marketId,
        ]),
      ).toEqual({ n: 1 });
    }
  });
});
