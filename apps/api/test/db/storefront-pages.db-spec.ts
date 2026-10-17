import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { PageRecord } from '../../src/modules/storefront/application/ports/page.repository';
import { PrismaPageRepository } from '../../src/modules/storefront/infrastructure/prisma-page.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The storefront page store as the application role, in both Market fixtures: pages, their
// draft, published and retired versions, and old slugs; at most one draft and one published
// version per page (the partial unique indexes); the system/dynamic split, key formats and
// states (CHECKs); no page is ever deleted; and never a read across Markets.

const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const CHECK = '23514';
// Prisma reports a violated unique index as P2002.
const UNIQUE = 'P2002';

describe.each(TEST_MARKETS)('storefront page store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const by = ids.next<'Account'>();
  const stamp = (hours: number) => ({ at: T0.add({ hours }), by });
  let db: Persistence;
  let pages: PrismaPageRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    pages = new PrismaPageRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  let n = 0;
  const dynamicPage = (overrides: Partial<PageRecord> = {}): PageRecord => ({
    id: ids.next<'StorefrontPage'>(),
    kind: 'dynamic',
    systemKey: null,
    slug: `page-${code.toLowerCase()}-${(n += 1)}-${Date.now().toString(36)}`,
    templateKey: 'campaign-landing',
    title: 'Eid',
    seo: { title: 'Eid sale' },
    linked: { type: 'category', id: ids.next() },
    startsAt: T0,
    endsAt: T0.add({ hours: 48 }),
    archivedAt: null,
    archivedRedirect: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
  const insert = (page: PageRecord) => value(market, () => pages.insertPage(market, page, by));
  const draft = (pageId: Id<'StorefrontPage'>, versionNo: number) => {
    const versionId = ids.next<'StorefrontPageVersion'>();
    return value(market, () =>
      pages.insertDraft(
        market,
        { id: versionId, pageId, versionNo, placements: { main: [] } },
        stamp(versionNo),
      ),
    ).then(() => versionId);
  };

  it('stores and reads a page with its settings, and never across Markets', async () => {
    const page = dynamicPage();
    await insert(page);
    const read = await value(market, () => pages.findPage(market, page.id));
    expect(read).toMatchObject({
      id: page.id,
      kind: 'dynamic',
      slug: page.slug,
      seo: { title: 'Eid sale' },
      linked: page.linked,
    });
    expect(read?.endsAt?.toString()).toBe(T0.add({ hours: 48 }).toString());
    expect((await value(market, () => pages.findBySlug(market, page.slug!)))?.id).toBe(page.id);
    expect(await value(other, () => pages.findPage(other, page.id))).toBeNull();
    expect(await value(other, () => pages.findBySlug(other, page.slug!))).toBeNull();
    expect((await value(market, () => pages.lockPage(market, page.id)))?.id).toBe(page.id);
    expect(await value(other, () => pages.lockPage(other, page.id))).toBeNull();

    await value(market, () =>
      pages.updatePage(
        market,
        page.id,
        { title: 'Eid 2026', linked: null, endsAt: null },
        stamp(1),
      ),
    );
    expect(await value(market, () => pages.findPage(market, page.id))).toMatchObject({
      title: 'Eid 2026',
      linked: null,
      endsAt: null,
    });
  });

  it('keeps one draft and one published version per page, and retires the one it replaces', async () => {
    const page = dynamicPage();
    await insert(page);
    const v1 = await draft(page.id, 1);
    expect(await code_(draft(page.id, 2))).toBe(UNIQUE);
    await value(market, () => pages.publishDraft(market, page.id, v1, stamp(2)));
    const v2 = await draft(page.id, 2);
    await value(market, () =>
      pages.updateDraft(market, v2, { main: [{ id: 'a', module: 'faq' }] }, stamp(3)),
    );
    expect((await value(market, () => pages.findDraft(market, page.id)))?.placements).toEqual({
      main: [{ id: 'a', module: 'faq' }],
    });
    await value(market, () => pages.publishDraft(market, page.id, v2, stamp(4)));
    const versions = await value(market, () => pages.versions(market, page.id, 10));
    expect(versions.map((v) => [v.versionNo, v.state])).toEqual([
      [2, 'published'],
      [1, 'retired'],
    ]);
    expect(await value(market, () => pages.lastVersionNo(market, page.id))).toBe(2);
    expect(await value(market, () => pages.findDraft(market, page.id))).toBeNull();
    expect((await value(market, () => pages.findPublished(market, page.id)))?.id).toBe(v2);
    expect(await value(other, () => pages.findPublished(other, page.id))).toBeNull();
    const summaries = await value(market, () => pages.summaries(market));
    expect(summaries.find((s) => s.pageId === page.id)).toMatchObject({
      draftVersionNo: null,
      publishedVersionNo: 2,
    });
  });

  it('keeps slugs, system keys and old slugs unique per Market', async () => {
    const page = dynamicPage();
    await insert(page);
    expect(await code_(insert(dynamicPage({ slug: page.slug })))).toBe(UNIQUE);
    // The other Market may use the same slug.
    const elsewhere = { ...dynamicPage({ slug: page.slug }), linked: null };
    expect(await code_(value(other, () => pages.insertPage(other, elsewhere, by)))).toBe('allowed');

    const key = `home-${code.toLowerCase()}-${Date.now().toString(36)}`;
    const system = (): PageRecord =>
      dynamicPage({
        kind: 'system',
        systemKey: key,
        slug: null,
        linked: null,
        startsAt: null,
        endsAt: null,
        templateKey: 'system.home',
      });
    await insert(system());
    expect(await code_(insert(system()))).toBe(UNIQUE);
    expect((await value(market, () => pages.findSystemPage(market, key)))?.systemKey).toBe(key);

    const from = `old-${page.slug}`;
    const redirect = { id: ids.next<'StorefrontRedirect'>(), fromSlug: from, pageId: page.id };
    await value(market, () => pages.insertRedirect(market, redirect, T0));
    expect(await value(market, () => pages.findRedirect(market, from))).toBe(page.id);
    expect(await value(other, () => pages.findRedirect(other, from))).toBeNull();
    expect(
      await code_(
        value(market, () =>
          pages.insertRedirect(market, { ...redirect, id: ids.next<'StorefrontRedirect'>() }, T0),
        ),
      ),
    ).toBe(UNIQUE);
    await value(market, () => pages.deleteRedirect(market, from));
    expect(await value(market, () => pages.findRedirect(market, from))).toBeNull();
  });

  it('refuses a bad kind split, slug, state and scope at the database, and never deletes a page', async () => {
    const insertRow = (
      kind: string,
      systemKey: string | null,
      slug: string | null,
      marketId: string = market.marketId,
    ) =>
      code_(
        sql.query(
          `INSERT INTO storefront.pages (id, market_id, tenant_id, kind, system_key, slug, template_key, title, seo, created_at, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'info-page', 'T', '{}'::jsonb, now(), now(), $7)`,
          [ids.next(), marketId, market.tenantId, kind, systemKey, slug, by],
        ),
      );
    expect(await insertRow('dynamic', null, null)).toBe(CHECK);
    expect(await insertRow('system', null, 'x')).toBe(CHECK);
    expect(await insertRow('dynamic', 'home', 'x')).toBe(CHECK);
    expect(await insertRow('dynamic', null, 'Bad Slug')).toBe(CHECK);
    expect(await insertRow('landing', null, 'x')).toBe(CHECK);
    expect(await insertRow('dynamic', null, 'x', 'bad mkt')).toBe(CHECK);

    const page = dynamicPage();
    await insert(page);
    const versionId = await draft(page.id, 1);
    expect(
      await code_(
        sql.query(`UPDATE storefront.page_versions SET state = 'live' WHERE id = $1`, [versionId]),
      ),
    ).toBe(CHECK);
    // A draft carries no publication stamp; a published version must carry one.
    expect(
      await code_(
        sql.query(`UPDATE storefront.page_versions SET state = 'published' WHERE id = $1`, [
          versionId,
        ]),
      ),
    ).toBe(CHECK);
    // Kind, key and template never change, and the application role cannot delete a page.
    expect(
      await code_(
        sql.query(`UPDATE storefront.pages SET template_key = 'info-page' WHERE id = $1`, [
          page.id,
        ]),
      ),
    ).toBe('42501');
    expect(await code_(sql.query(`DELETE FROM storefront.pages WHERE id = $1`, [page.id]))).toBe(
      '42501',
    );
    expect(
      await code_(sql.query(`DELETE FROM storefront.page_versions WHERE id = $1`, [versionId])),
    ).toBe('42501');
  });
});
