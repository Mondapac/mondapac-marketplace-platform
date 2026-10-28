import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The blog tables as the application role, in both Market fixtures: the uniques and partial
// uniques (slug, version number, one live and one open version, one featured post), the CHECKs of
// posts, versions, events, links, taxonomy, redirects and quotas, the triggers (version lifecycle,
// frozen content, children only on a draft, event status after the draft, slug against redirect),
// the deferred pointer keys, the column grants and the sellers blog columns.

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const RESTRICT = '23001';
const DENIED = '42501';

describe.each(TEST_MARKETS)('blog schema in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const by = randomUUID();
  const sellerId = randomUUID();
  let sql: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
  });

  const errorCode = (work: Promise<unknown>) =>
    work.then(
      () => 'allowed',
      (error: { code?: string }) => error.code ?? 'no-code',
    );
  /** Runs the statements in one transaction (the post and version pointers are deferred keys). */
  const transaction = async (work: () => Promise<void>) => {
    await sql.query('BEGIN');
    try {
      await work();
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  };
  const slugOf = () => `p-${randomUUID().replace(/-/g, '')}`;

  interface PostOptions {
    readonly post?: Record<string, unknown>;
    readonly version?: Record<string, unknown>;
    readonly market?: typeof market;
  }
  interface Created {
    readonly postId: string;
    readonly versionId: string;
    readonly slug: string;
  }
  const insertPostRow = (id: string, versionId: string, slug: string, options: PostOptions) => {
    const r = {
      market_id: (options.market ?? market).marketId,
      tenant_id: (options.market ?? market).tenantId,
      kind: 'news',
      slug,
      owner_type: 'platform',
      seller_id: null,
      status: 'draft',
      live_version_id: null,
      draft_version_id: versionId,
      scheduled_at: null,
      published_at: null,
      unpublished_at: null,
      paused_reason: null,
      featured: false,
      quota_period: null,
      ...options.post,
    };
    return sql.query(
      `INSERT INTO blog.posts (id, market_id, tenant_id, kind, slug, owner_type, seller_id, status,
         live_version_id, draft_version_id, scheduled_at, published_at, unpublished_at, paused_reason,
         featured, quota_period, created_at, created_by, updated_at, updated_by, row_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), $17, now(), $17, 0)`,
      [
        id,
        r.market_id,
        r.tenant_id,
        r.kind,
        r.slug,
        r.owner_type,
        r.seller_id,
        r.status,
        r.live_version_id,
        r.draft_version_id,
        r.scheduled_at,
        r.published_at,
        r.unpublished_at,
        r.paused_reason,
        r.featured,
        r.quota_period,
        by,
      ],
    );
  };
  const insertVersionRow = (
    postId: string,
    versionId: string,
    versionNo: number,
    options: PostOptions = {},
  ) => {
    const v = {
      state: 'draft',
      title: 'Title',
      excerpt: 'Short',
      body: [],
      cover_alt: null,
      seo_title: null,
      seo_description: null,
      author_display: null,
      submitted_at: null,
      submitted_by: null,
      decided_at: null,
      decided_by: null,
      decision: null,
      decision_note: null,
      self_approved: false,
      published_at: null,
      published_by: null,
      ...options.version,
    };
    return sql.query(
      `INSERT INTO blog.post_versions (id, market_id, tenant_id, post_id, version_no, state, title,
         excerpt, body, cover_alt, seo_title, seo_description, author_display, created_at, created_by,
         updated_at, edited_by_reviewer, submitted_at, submitted_by, decided_at, decided_by, decision,
         decision_note, self_approved, published_at, published_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13, now(), $14, now(), false,
         $15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        versionId,
        (options.market ?? market).marketId,
        (options.market ?? market).tenantId,
        postId,
        versionNo,
        v.state,
        v.title,
        v.excerpt,
        JSON.stringify(v.body),
        v.cover_alt,
        v.seo_title,
        v.seo_description,
        v.author_display,
        by,
        v.submitted_at,
        v.submitted_by,
        v.decided_at,
        v.decided_by,
        v.decision,
        v.decision_note,
        v.self_approved,
        v.published_at,
        v.published_by,
      ],
    );
  };
  /** A draft post with its first draft version, in one transaction. */
  const createPost = async (options: PostOptions = {}): Promise<Created> => {
    const postId = randomUUID();
    const versionId = randomUUID();
    const slug = slugOf();
    await transaction(async () => {
      await insertPostRow(postId, versionId, slug, options);
      await insertVersionRow(postId, versionId, 1, options);
    });
    return { postId, versionId, slug };
  };
  const updateVersion = (versionId: string, set: string, values: unknown[] = []) =>
    sql.query(`UPDATE blog.post_versions SET ${set} WHERE id = $1`, [versionId, ...values]);
  const toState = async (created: Created, states: readonly string[]) => {
    for (const state of states) {
      const extra =
        state === 'in_review'
          ? ', submitted_at = now(), submitted_by = $2'
          : state === 'approved'
            ? ", decision = 'approved', decided_at = now(), decided_by = $2"
            : state === 'returned'
              ? ", decision = 'changes_requested', decision_note = 'Fix', decided_at = now(), decided_by = $2"
              : state === 'live'
                ? ', published_at = now(), published_by = $2'
                : '';
      await updateVersion(
        created.versionId,
        `state = '${state}'${extra}`,
        extra.includes('$2') ? [by] : [],
      );
    }
  };

  it('stores a post with its draft version and refuses a repeated slug in the same Market only', async () => {
    const first = await createPost();
    expect(await errorCode(createPost({ post: { slug: first.slug } }))).toBe(UNIQUE);
    // The other Market may use the same slug.
    expect(await errorCode(createPost({ market: other, post: { slug: first.slug } }))).toBe(
      'allowed',
    );
    const read = await sql.query(
      `SELECT status, row_version FROM blog.posts WHERE id = $1 AND market_id = $2`,
      [first.postId, market.marketId],
    );
    expect(read.rows[0]).toMatchObject({ status: 'draft', row_version: 0 });
  });

  it('keeps the post pointers as deferred keys into the post own versions', async () => {
    const postId = randomUUID();
    const versionId = randomUUID();
    // The version does not exist at commit: the deferred key refuses.
    await sql.query('BEGIN');
    await insertPostRow(postId, versionId, slugOf(), {});
    expect(await errorCode(sql.query('COMMIT'))).toBe(FOREIGN_KEY);
    await sql.query('ROLLBACK').catch(() => undefined);
    // A version of another post cannot be a pointer.
    const a = await createPost();
    const b = await createPost();
    expect(
      await errorCode(
        sql.query(`UPDATE blog.posts SET draft_version_id = $1 WHERE id = $2`, [
          b.versionId,
          a.postId,
        ]),
      ),
    ).toBe(FOREIGN_KEY);
  });

  describe('post CHECKs', () => {
    it.each([
      ['a kind outside the four', { kind: 'story' }],
      ['a slug of two characters', { slug: 'ab' }],
      ['a slug in capitals', { slug: 'Has-Capitals' }],
      ['a slug with a double hyphen', { slug: 'two--hyphens' }],
      ['a reserved slug', { slug: 'category' }],
      ['a slug over 80 characters', { slug: 'a'.repeat(81) }],
      ['a platform post with a seller', { seller_id: randomUUID() }],
      ['a seller post without a seller', { owner_type: 'seller' }],
      ['an unknown status', { status: 'live' }],
      ['a draft without a draft version', { draft_version_id: null }],
      ['a published post without a live version', { status: 'published' }],
      ['a scheduled post without a time', { status: 'scheduled' }],
      ['an unpublished post without a reason', { status: 'unpublished' }],
      ['a pause reason with markup', { paused_reason: '<b>x</b>' }],
      ['a featured draft', { featured: true }],
      ['a quota period on a platform post', { quota_period: '2026-10' }],
      ['a published_at without a live version', { published_at: '2026-10-01T00:00:00Z' }],
    ])('refuses %s', async (_label, post) => {
      expect(await errorCode(createPost({ post }))).toMatch(
        new RegExp(`^(${CHECK}|${FOREIGN_KEY})$`),
      );
    });

    it('accepts a seller post with a month and refuses a bad month', async () => {
      const seller = { owner_type: 'seller', seller_id: sellerId };
      expect(await errorCode(createPost({ post: { ...seller, quota_period: '2026-10' } }))).toBe(
        'allowed',
      );
      expect(await errorCode(createPost({ post: { ...seller, quota_period: '2026-13' } }))).toBe(
        CHECK,
      );
    });

    it('refuses a market id and a tenant id outside their forms', async () => {
      expect(
        await errorCode(createPost({ market: { ...market, marketId: 'bad mkt' } as never })),
      ).toBe(CHECK);
    });
  });

  describe('version CHECKs', () => {
    it.each([
      ['a title of markup', { title: 'a<b' }],
      ['an empty title', { title: '' }],
      ['a title over 120 characters', { title: 'x'.repeat(121) }],
      ['a title with a control character', { title: 'a\u0007b' }],
      ['an excerpt over 160 characters', { excerpt: 'x'.repeat(161) }],
      ['a body that is not a list', { body: { a: 1 } }],
      ['a body of more than 200 blocks', { body: Array.from({ length: 201 }, () => ({})) }],
      ['a body over 64 KiB', { body: [{ t: 'x'.repeat(70_000) }] }],
      ['an SEO title over 70 characters', { seo_title: 'x'.repeat(71) }],
      ['an SEO description over 160 characters', { seo_description: 'x'.repeat(161) }],
      ['an author display with markup', { author_display: '<i>x</i>' }],
      ['a state outside the list', { state: 'final' }],
      ['a draft that was submitted', { submitted_at: '2026-10-01T00:00:00Z', submitted_by: by }],
      ['a submitted time without a submitter', { submitted_at: '2026-10-01T00:00:00Z' }],
      ['an approved version without a decision', { state: 'approved' }],
      ['a self-approval without an approval', { self_approved: true }],
      [
        'a returned version without a note',
        {
          state: 'returned',
          submitted_at: '2026-10-01T00:00:00Z',
          submitted_by: by,
          decision: 'changes_requested',
          decided_at: '2026-10-02T00:00:00Z',
          decided_by: by,
        },
      ],
    ])('refuses %s', async (_label, version) => {
      expect(await errorCode(createPost({ version }))).toBe(CHECK);
    });

    it('refuses a version number outside 1 to 100 and a repeated one', async () => {
      const created = await createPost();
      expect(await errorCode(insertVersionRow(created.postId, randomUUID(), 0))).toBe(CHECK);
      expect(await errorCode(insertVersionRow(created.postId, randomUUID(), 101))).toBe(CHECK);
      expect(
        await errorCode(
          insertVersionRow(created.postId, randomUUID(), 1, { version: { state: 'retired' } }),
        ),
      ).toBe(UNIQUE);
    });
  });

  describe('version lifecycle trigger', () => {
    it('follows draft, in review, approved, live and retired, and nothing else', async () => {
      const created = await createPost();
      expect(await errorCode(toState(created, ['approved']))).toBe(RESTRICT);
      await toState(created, ['in_review', 'approved', 'live']);
      expect(await errorCode(updateVersion(created.versionId, `state = 'approved'`))).toBe(
        RESTRICT,
      );
      await toState(created, ['retired']);
      // Retired is final.
      expect(await errorCode(updateVersion(created.versionId, `state = 'draft'`))).toBe(RESTRICT);
    });

    it('lets a returned version only retire', async () => {
      const created = await createPost();
      await toState(created, ['in_review', 'returned']);
      expect(await errorCode(updateVersion(created.versionId, `state = 'in_review'`))).toBe(
        RESTRICT,
      );
      await toState(created, ['retired']);
    });

    it('freezes the content once the version left draft', async () => {
      const created = await createPost();
      expect(await errorCode(updateVersion(created.versionId, `title = 'Changed'`))).toBe(
        'allowed',
      );
      await toState(created, ['in_review']);
      for (const set of [
        `title = 'Again'`,
        `excerpt = 'Again'`,
        `body = '[]'::jsonb || '[{}]'::jsonb`,
        `cover_alt = 'x'`,
        `seo_title = 'x'`,
        `seo_description = 'x'`,
        `author_display = 'x'`,
        `category_id = NULL, title = 'x'`,
      ]) {
        expect(await errorCode(updateVersion(created.versionId, set))).toBe(RESTRICT);
      }
      // The decision columns still move.
      await toState(created, ['approved']);
    });
  });

  describe('one live and one open version', () => {
    it('refuses a second open version and a second live version', async () => {
      const created = await createPost();
      expect(await errorCode(insertVersionRow(created.postId, randomUUID(), 2))).toBe(UNIQUE);
      await toState(created, ['in_review', 'approved', 'live']);
      // The live version is no longer open: a new draft may start.
      const next = randomUUID();
      expect(await errorCode(insertVersionRow(created.postId, next, 2))).toBe('allowed');
      expect(await errorCode(insertVersionRow(created.postId, randomUUID(), 3))).toBe(UNIQUE);
      const stamps = {
        state: 'live',
        submitted_at: '2026-10-01T00:00:00Z',
        submitted_by: by,
        decision: 'approved',
        decided_at: '2026-10-02T00:00:00Z',
        decided_by: by,
        published_at: '2026-10-03T00:00:00Z',
        published_by: by,
      };
      expect(
        await errorCode(insertVersionRow(created.postId, randomUUID(), 4, { version: stamps })),
      ).toBe(UNIQUE);
    });
  });

  describe('children of a version', () => {
    const link = (versionId: string, type: string, position: number, target = randomUUID()) =>
      sql.query(
        `INSERT INTO blog.post_links (market_id, tenant_id, version_id, target_type, target_ref, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [market.marketId, market.tenantId, versionId, type, target, position],
      );
    const eventRow = (versionId: string, overrides: Record<string, unknown> = {}) => {
      const e = {
        starts_at: '2026-12-01T10:00:00Z',
        ends_at: '2026-12-01T12:00:00Z',
        time_zone: 'Australia/Sydney',
        attendance: 'offline',
        venue_name: 'Hall',
        address: null,
        registration_url: null,
        event_status: 'scheduled',
        status_message: null,
        ...overrides,
      };
      return sql.query(
        `INSERT INTO blog.post_events (market_id, tenant_id, version_id, starts_at, ends_at, time_zone,
           attendance, venue_name, address, registration_url, event_status, status_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          market.marketId,
          market.tenantId,
          versionId,
          e.starts_at,
          e.ends_at,
          e.time_zone,
          e.attendance,
          e.venue_name,
          e.address,
          e.registration_url,
          e.event_status,
          e.status_message,
        ],
      );
    };

    it('stores links of the five target types, unique per version and target, at most 30', async () => {
      const created = await createPost();
      const target = randomUUID();
      let position = 0;
      for (const type of ['product', 'seller', 'brand', 'category', 'page']) {
        expect(await errorCode(link(created.versionId, type, position++))).toBe('allowed');
      }
      expect(await errorCode(link(created.versionId, 'product', position++, target))).toBe(
        'allowed',
      );
      expect(await errorCode(link(created.versionId, 'product', position++, target))).toBe(UNIQUE);
      expect(await errorCode(link(created.versionId, 'video', position))).toBe(CHECK);
      expect(await errorCode(link(created.versionId, 'product', 30))).toBe(CHECK);
      expect(await errorCode(link(created.versionId, 'product', 0))).toBe(UNIQUE);
    });

    it('refuses to change the links and tags of a version that left draft', async () => {
      const created = await createPost();
      const tag = randomUUID();
      await sql.query(
        `INSERT INTO blog.tags (id, market_id, tenant_id, slug, name, created_at, created_by)
         VALUES ($1,$2,$3,$4,'Tag', now(), $5)`,
        [tag, market.marketId, market.tenantId, slugOf(), by],
      );
      const tagRow = () =>
        sql.query(
          `INSERT INTO blog.post_tags (market_id, tenant_id, version_id, tag_id) VALUES ($1,$2,$3,$4)`,
          [market.marketId, market.tenantId, created.versionId, tag],
        );
      expect(await errorCode(link(created.versionId, 'product', 0))).toBe('allowed');
      expect(await errorCode(tagRow())).toBe('allowed');
      await toState(created, ['in_review']);
      expect(await errorCode(link(created.versionId, 'product', 1))).toBe(RESTRICT);
      expect(
        await errorCode(
          sql.query(`DELETE FROM blog.post_links WHERE version_id = $1`, [created.versionId]),
        ),
      ).toBe(RESTRICT);
      expect(
        await errorCode(
          sql.query(`DELETE FROM blog.post_tags WHERE version_id = $1`, [created.versionId]),
        ),
      ).toBe(RESTRICT);
    });

    it('allows event details on an event post only, with the window, zone, venue and URL rules', async () => {
      const news = await createPost();
      expect(await errorCode(eventRow(news.versionId))).toBe(RESTRICT);
      const event = await createPost({ post: { kind: 'event' } });
      expect(await errorCode(eventRow(event.versionId, { ends_at: '2026-12-01T10:00:00Z' }))).toBe(
        CHECK,
      );
      expect(await errorCode(eventRow(event.versionId, { time_zone: 'not a zone' }))).toBe(CHECK);
      expect(await errorCode(eventRow(event.versionId, { attendance: 'hybrid' }))).toBe(CHECK);
      expect(await errorCode(eventRow(event.versionId, { venue_name: null }))).toBe(CHECK);
      expect(
        await errorCode(eventRow(event.versionId, { registration_url: 'http://x.example/r' })),
      ).toBe(CHECK);
      expect(await errorCode(eventRow(event.versionId, { event_status: 'moved' }))).toBe(CHECK);
      expect(
        await errorCode(
          eventRow(event.versionId, {
            attendance: 'online',
            venue_name: null,
            registration_url: 'https://x.example/r',
          }),
        ),
      ).toBe('allowed');
    });

    it('lets only the status of an event change after the draft', async () => {
      const event = await createPost({ post: { kind: 'event' } });
      await eventRow(event.versionId);
      const update = (set: string) =>
        sql.query(`UPDATE blog.post_events SET ${set} WHERE version_id = $1`, [event.versionId]);
      expect(await errorCode(update(`venue_name = 'Other hall'`))).toBe('allowed');
      await toState(event, ['in_review', 'approved', 'live']);
      expect(await errorCode(update(`venue_name = 'Third hall'`))).toBe(RESTRICT);
      expect(
        await errorCode(
          update(`starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day'`),
        ),
      ).toBe(RESTRICT);
      expect(await errorCode(update(`event_status = 'cancelled', status_message = 'Rain'`))).toBe(
        'allowed',
      );
      expect(
        await errorCode(
          sql.query(`DELETE FROM blog.post_events WHERE version_id = $1`, [event.versionId]),
        ),
      ).toBe(RESTRICT);
    });
  });

  describe('slugs and redirects', () => {
    const redirect = (from: string, postId: string, target = market) =>
      sql.query(
        `INSERT INTO blog.redirects (id, market_id, tenant_id, from_slug, post_id, created_at)
         VALUES ($1,$2,$3,$4,$5, now())`,
        [randomUUID(), target.marketId, target.tenantId, from, postId],
      );

    it('keeps a slug either a post slug or one old slug, never both', async () => {
      const a = await createPost();
      const b = await createPost();
      const old = slugOf();
      expect(await errorCode(redirect(old, a.postId))).toBe('allowed');
      expect(await errorCode(redirect(old, b.postId))).toBe(UNIQUE);
      expect(await errorCode(redirect(b.slug, a.postId))).toBe(UNIQUE);
      expect(
        await errorCode(
          sql.query(`UPDATE blog.posts SET slug = $1 WHERE id = $2`, [old, b.postId]),
        ),
      ).toBe(UNIQUE);
      expect(await errorCode(createPost({ post: { slug: old } }))).toBe(UNIQUE);
      // The post takes back its own old slug after deleting the redirect.
      await sql.query(`DELETE FROM blog.redirects WHERE from_slug = $1`, [old]);
      expect(
        await errorCode(
          sql.query(`UPDATE blog.posts SET slug = $1 WHERE id = $2`, [old, a.postId]),
        ),
      ).toBe('allowed');
    });

    it('refuses an old slug of a form that is not a slug and a post of another Market', async () => {
      const a = await createPost();
      expect(await errorCode(redirect('Bad Slug', a.postId))).toBe(CHECK);
      expect(await errorCode(redirect(slugOf(), a.postId, other))).toBe(FOREIGN_KEY);
    });
  });

  describe('taxonomy, quotas and the outbox', () => {
    it('keeps categories unique by slug per Market with one name per locale', async () => {
      const slug = slugOf();
      const category = (target = market, id = randomUUID(), s = slug) =>
        sql.query(
          `INSERT INTO blog.categories (id, market_id, tenant_id, slug, position, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4, 1, now(), $5, now(), $5)`,
          [id, target.marketId, target.tenantId, s, by],
        );
      const id = randomUUID();
      expect(await errorCode(category(market, id))).toBe('allowed');
      expect(await errorCode(category())).toBe(UNIQUE);
      expect(await errorCode(category(other))).toBe('allowed');
      expect(await errorCode(category(market, randomUUID(), 'Bad Slug'))).toBe(CHECK);
      const name = (locale: string, text: string) =>
        sql.query(
          `INSERT INTO blog.category_names (market_id, tenant_id, category_id, locale, name) VALUES ($1,$2,$3,$4,$5)`,
          [market.marketId, market.tenantId, id, locale, text],
        );
      expect(await errorCode(name('en', 'News'))).toBe('allowed');
      expect(await errorCode(name('en', 'Again'))).toBe(UNIQUE);
      expect(await errorCode(name('ar-AE', 'Akhbar'))).toBe('allowed');
      expect(await errorCode(name('e', 'x'))).toBe(CHECK);
      expect(await errorCode(name('fr', '<b>'))).toBe(CHECK);
      expect(await errorCode(name('de', ''))).toBe(CHECK);
    });

    it('keeps a quota row per seller and month, within 0 to 1000', async () => {
      const row = (period: string, used: number, seller = sellerId) =>
        sql.query(
          `INSERT INTO blog.seller_quotas (market_id, tenant_id, seller_id, period, used, updated_at) VALUES ($1,$2,$3,$4,$5, now())`,
          [market.marketId, market.tenantId, seller, period, used],
        );
      const seller = randomUUID();
      expect(await errorCode(row('2026-10', 1, seller))).toBe('allowed');
      expect(await errorCode(row('2026-10', 1, seller))).toBe(UNIQUE);
      expect(await errorCode(row('2026-9', 1, seller))).toBe(CHECK);
      expect(await errorCode(row('2026-11', -1, seller))).toBe(CHECK);
      expect(await errorCode(row('2026-12', 1001, seller))).toBe(CHECK);
    });

    it('keeps the outbox types in the blog namespace and one version per aggregate', async () => {
      const event = (type: string, aggregateId: string, version: number) =>
        sql.query(
          `INSERT INTO blog.outbox (event_id, market_id, tenant_id, type, aggregate_type, aggregate_id,
             aggregate_version, correlation_id, payload, occurred_at)
           VALUES ($1,$2,$3,$4,'post',$5,$6,'corr-0000001','{}'::jsonb, now())`,
          [randomUUID(), market.marketId, market.tenantId, type, aggregateId, version],
        );
      const aggregate = randomUUID();
      expect(await errorCode(event('blog.post-submitted.v1', aggregate, 1))).toBe('allowed');
      expect(await errorCode(event('blog.post-submitted.v1', aggregate, 1))).toBe(UNIQUE);
      expect(await errorCode(event('sellers.post-submitted.v1', randomUUID(), 1))).toBe(CHECK);
      expect(await errorCode(event('blog.post-submitted.v1', randomUUID(), 0))).toBe(CHECK);
    });
  });

  describe('one featured post and the grants', () => {
    it('allows one featured post per Market, only while published', async () => {
      // A published post needs a live version; build it through the lifecycle.
      const publish = async (featured: boolean, target = market) => {
        const created = await createPost({ market: target });
        await sql.query('BEGIN');
        try {
          await sql.query(
            `UPDATE blog.post_versions SET state = 'in_review', submitted_at = now(), submitted_by = $2 WHERE id = $1`,
            [created.versionId, by],
          );
          await sql.query(
            `UPDATE blog.post_versions SET state = 'approved', decision = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1`,
            [created.versionId, by],
          );
          await sql.query(
            `UPDATE blog.post_versions SET state = 'live', published_at = now(), published_by = $2 WHERE id = $1`,
            [created.versionId, by],
          );
          await sql.query(
            `UPDATE blog.posts SET status = 'published', live_version_id = $1, draft_version_id = NULL, published_at = now(), featured = $3 WHERE id = $2`,
            [created.versionId, created.postId, featured],
          );
          await sql.query('COMMIT');
        } catch (error) {
          await sql.query('ROLLBACK');
          throw error;
        }
        return created;
      };
      // Both Market fixtures share one database: clear what an earlier run left featured.
      for (const target of [market, other]) {
        await sql.query(
          `UPDATE blog.posts SET featured = false WHERE market_id = $1 AND featured`,
          [target.marketId],
        );
      }
      // Other Market's featured post does not count against this one.
      await publish(true, other);
      const first = await publish(true);
      expect(await errorCode(publish(true))).toBe(UNIQUE);
      await sql.query(`UPDATE blog.posts SET featured = false WHERE id = $1`, [first.postId]);
      expect(await errorCode(publish(true))).toBe('allowed');
    });

    it('lets the application role change only the granted columns and delete nothing but children', async () => {
      const created = await createPost();
      for (const statement of [
        `UPDATE blog.posts SET kind = 'event' WHERE id = $1`,
        `UPDATE blog.posts SET owner_type = 'seller' WHERE id = $1`,
        `UPDATE blog.posts SET market_id = 'ZZ' WHERE id = $1`,
        `DELETE FROM blog.posts WHERE id = $1`,
      ]) {
        expect(await errorCode(sql.query(statement, [created.postId]))).toBe(DENIED);
      }
      for (const statement of [
        `UPDATE blog.post_versions SET created_by = gen_random_uuid() WHERE id = $1`,
        `UPDATE blog.post_versions SET version_no = 9 WHERE id = $1`,
        `UPDATE blog.post_versions SET post_id = gen_random_uuid() WHERE id = $1`,
        `DELETE FROM blog.post_versions WHERE id = $1`,
      ]) {
        expect(await errorCode(sql.query(statement, [created.versionId]))).toBe(DENIED);
      }
      expect(
        await errorCode(sql.query(`UPDATE blog.categories SET slug = 'x-new' WHERE false`)),
      ).toBe(DENIED);
      expect(await errorCode(sql.query(`DELETE FROM blog.seller_quotas WHERE false`))).toBe(DENIED);
      expect(await errorCode(sql.query(`DELETE FROM blog.inbox WHERE false`))).toBe(DENIED);
    });
  });

  describe('sellers blog columns', () => {
    it('defaults the switch off and keeps its change stamps together', async () => {
      const columns = await sql.query(
        `SELECT column_name, column_default, is_nullable FROM information_schema.columns
          WHERE table_schema = 'sellers' AND table_name = 'seller_admin_settings'
            AND column_name IN ('blog_enabled', 'blog_enabled_by', 'blog_enabled_at')
          ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'blog_enabled', column_default: 'false', is_nullable: 'NO' },
        { column_name: 'blog_enabled_at', column_default: null, is_nullable: 'YES' },
        { column_name: 'blog_enabled_by', column_default: null, is_nullable: 'YES' },
      ]);
      const constraint = await sql.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'seller_admin_settings_blog_enabled_changed_check'`,
      );
      expect(constraint.rowCount).toBe(1);
    });
  });
});
