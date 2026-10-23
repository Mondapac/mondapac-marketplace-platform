import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  PlacementRow,
  SlideRecord,
} from '../../src/modules/storefront/application/ports/slide.repository';
import { PrismaSlideRepository } from '../../src/modules/storefront/infrastructure/prisma-slide.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The slide store as the application role, in both Market fixtures: slides, insert-only versions,
// the live placement projection and the position locks; the window, kind, state, scope and
// autoplay CHECKs; the grants (a version's content is never updated, nothing is deleted but
// placements); and never a read across Markets.

const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const CHECK = '23514';
const DENIED = '42501';
const UNIQUE = 'P2002';
const HOURS_90_DAYS = 24 * 90;

describe.each(TEST_MARKETS)('storefront slide store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const by = ids.next<'Account'>();
  const stamp = (hours: number) => ({ at: T0.add({ hours }), by });
  let db: Persistence;
  let slides: PrismaSlideRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    slides = new PrismaSlideRepository(db.service);
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
  const slideRecord = (overrides: Partial<SlideRecord> = {}): SlideRecord => ({
    id: ids.next<'StorefrontSlide'>(),
    kind: 'announcement',
    internalName: 'Eid',
    state: 'draft',
    startsAt: T0,
    endsAt: T0.add({ hours: 48 }),
    pinned: false,
    sponsored: false,
    liveVersionId: null,
    draftVersionId: null,
    submittedVersionId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
  const content = { title: 'Eid Mubarak', body: 'Dates', link: null };
  const version = (slideId: Id<'StorefrontSlide'>, versionNo: number) => ({
    id: ids.next<'StorefrontSlideVersion'>(),
    slideId,
    versionNo,
    internalName: 'Eid',
    content,
    placements: [{ position: 'home.hero' }],
    startsAt: T0,
    endsAt: T0.add({ hours: 48 }),
    pinned: false,
    sponsored: false,
    createdAt: T0.add({ hours: versionNo }),
    createdBy: by,
  });
  const row = (
    slideId: Id<'StorefrontSlide'>,
    overrides: Partial<PlacementRow> = {},
  ): PlacementRow => ({
    id: ids.next<'StorefrontSlidePlacement'>(),
    slideId,
    position: 'home.hero',
    scope: 'all',
    scopeId: null,
    includeSubcategories: false,
    sortOrder: 0,
    autoplay: false,
    startsAt: T0,
    endsAt: T0.add({ hours: 48 }),
    ...overrides,
  });
  const insert = (slide: SlideRecord) => value(market, () => slides.insertSlide(market, slide, by));

  it('stores a slide and reads it back, never across Markets', async () => {
    const slide = slideRecord({ pinned: true });
    await insert(slide);
    const read = await value(market, () => slides.findSlide(market, slide.id));
    expect(read).toMatchObject({
      id: slide.id,
      kind: 'announcement',
      state: 'draft',
      pinned: true,
    });
    expect(read?.endsAt.toString()).toBe(T0.add({ hours: 48 }).toString());
    expect(await value(other, () => slides.findSlide(other, slide.id))).toBeNull();
    expect((await value(market, () => slides.lockSlide(market, slide.id)))?.id).toBe(slide.id);
    expect(await value(other, () => slides.lockSlide(other, slide.id))).toBeNull();
    expect((await value(market, () => slides.listSlides(market, 1000))).map((s) => s.id)).toContain(
      slide.id,
    );
    expect(
      (await value(other, () => slides.listSlides(other, 1000))).map((s) => s.id),
    ).not.toContain(slide.id);

    const v1 = version(slide.id, 1);
    await value(market, () => slides.insertVersion(market, v1));
    await value(market, () =>
      slides.updateSlide(
        market,
        slide.id,
        { draftVersionId: v1.id, internalName: 'Eid 2' },
        stamp(1),
      ),
    );
    expect(await value(market, () => slides.findSlide(market, slide.id))).toMatchObject({
      draftVersionId: v1.id,
      internalName: 'Eid 2',
    });
    // Another Market's update touches nothing.
    await value(other, () =>
      slides.updateSlide(other, slide.id, { internalName: 'Hijack' }, stamp(2)),
    );
    expect((await value(market, () => slides.findSlide(market, slide.id)))?.internalName).toBe(
      'Eid 2',
    );
  });

  it('keeps insert-only versions, numbered per slide, and stamps the approver once', async () => {
    const slide = slideRecord();
    await insert(slide);
    const v1 = version(slide.id, 1);
    const v2 = version(slide.id, 2);
    await value(market, () => slides.insertVersion(market, v1));
    await value(market, () => slides.insertVersion(market, v2));
    expect(
      await code_(value(market, () => slides.insertVersion(market, version(slide.id, 2)))),
    ).toBe(UNIQUE);
    expect(await value(market, () => slides.lastVersionNo(market, slide.id))).toBe(2);
    expect(await value(other, () => slides.lastVersionNo(other, slide.id))).toBe(0);
    expect(
      (await value(market, () => slides.versions(market, slide.id, 10))).map((v) => v.versionNo),
    ).toEqual([2, 1]);
    expect(await value(other, () => slides.versions(other, slide.id, 10))).toEqual([]);
    expect(
      (await value(market, () => slides.findVersion(market, slide.id, v1.id)))?.content,
    ).toEqual(content);
    expect(await value(other, () => slides.findVersion(other, slide.id, v1.id))).toBeNull();
    expect(await value(other, () => slides.versionsByIds(other, [v1.id, v2.id]))).toEqual([]);
    expect(await value(market, () => slides.versionsByIds(market, [v1.id, v2.id]))).toHaveLength(2);

    await value(market, () => slides.markApproved(market, v1.id, stamp(5)));
    const approved = await value(market, () => slides.findVersion(market, slide.id, v1.id));
    expect(approved?.approvedBy).toBe(by);
    expect(approved?.approvedAt?.toString()).toBe(T0.add({ hours: 5 }).toString());
    // The first approval stays; another Market stamps nothing.
    await value(market, () =>
      slides.markApproved(market, v1.id, { at: T0.add({ hours: 9 }), by: ids.next() }),
    );
    expect(
      (await value(market, () => slides.findVersion(market, slide.id, v1.id)))?.approvedBy,
    ).toBe(by);
    await value(other, () => slides.markApproved(other, v2.id, stamp(6)));
    expect(
      (await value(market, () => slides.findVersion(market, slide.id, v2.id)))?.approvedBy,
    ).toBeNull();
  });

  it('replaces the live projection of a slide and finds the placements of a position in a window', async () => {
    const slide = slideRecord();
    const peer = slideRecord();
    await insert(slide);
    await insert(peer);
    const hero = row(slide.id, { autoplay: true, sortOrder: 2 });
    const category = row(slide.id, {
      position: 'category.top',
      scope: 'category',
      scopeId: ids.next(),
      includeSubcategories: true,
    });
    await value(market, () => slides.replacePlacements(market, slide.id, [hero, category]));
    await value(market, () =>
      slides.replacePlacements(market, peer.id, [row(peer.id, { endsAt: T0.add({ hours: 10 }) })]),
    );
    const mine = await value(market, () => slides.placementsOf(market, slide.id));
    expect(mine.map((p) => [p.position, p.scope, p.autoplay])).toEqual([
      ['category.top', 'category', false],
      ['home.hero', 'all', true],
    ]);
    expect(await value(other, () => slides.placementsOf(other, slide.id))).toEqual([]);

    const at = (from: number, to: number, target = market) =>
      value(target, () =>
        slides.placedAt(target, 'home.hero', T0.add({ hours: from }), T0.add({ hours: to })),
      );
    expect((await at(0, 5)).map((p) => p.slideId).sort()).toEqual([slide.id, peer.id].sort());
    expect((await at(20, 30)).map((p) => p.slideId)).toEqual([slide.id]);
    expect(await at(48, 60)).toEqual([]);
    const elsewhere = (await at(0, 5, other)).map((p) => p.slideId);
    expect(elsewhere).not.toContain(slide.id);
    expect(elsewhere).not.toContain(peer.id);

    await value(market, () => slides.replacePlacements(market, slide.id, [row(slide.id)]));
    expect(await value(market, () => slides.placementsOf(market, slide.id))).toHaveLength(1);
    await value(market, () => slides.replacePlacements(market, slide.id, []));
    expect(await value(market, () => slides.placementsOf(market, slide.id))).toEqual([]);
    expect(await value(market, () => slides.placementsOf(market, peer.id))).toHaveLength(1);
    // Another Market's replace removes nothing of this one.
    await value(other, () => slides.replacePlacements(other, peer.id, []));
    expect(await value(market, () => slides.placementsOf(market, peer.id))).toHaveLength(1);
  });

  it('locks position rows, created on first use and again without error', async () => {
    const keys = ['home.hero', 'home.mid', 'home.hero'];
    await value(market, () => slides.lockPositions(market, keys, T0));
    await value(market, () => slides.lockPositions(market, keys, T0.add({ hours: 1 })));
    await value(other, () => slides.lockPositions(other, ['home.hero'], T0));
    const { rows } = await sql.query(
      `SELECT market_id, position_key FROM storefront.slide_position_locks WHERE market_id = $1 AND position_key = ANY($2) ORDER BY position_key`,
      [market.marketId, ['home.hero', 'home.mid']],
    );
    expect(rows.map((r: { position_key: string }) => r.position_key)).toEqual([
      'home.hero',
      'home.mid',
    ]);
  });

  it('refuses a bad kind, state, window, content and placement at the database', async () => {
    const insertSlideRow = (overrides: Record<string, unknown> = {}) => {
      const r = {
        kind: 'announcement',
        state: 'draft',
        starts_at: T0.toString(),
        ends_at: T0.add({ hours: 24 }).toString(),
        live_version_id: null,
        market_id: market.marketId,
        ...overrides,
      };
      return code_(
        sql.query(
          `INSERT INTO storefront.slides (id, market_id, tenant_id, kind, internal_name, state, starts_at, ends_at, pinned, sponsored, live_version_id, created_at, created_by, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, 'N', $5, $6, $7, false, false, $8, now(), $9, now(), $9)`,
          [
            ids.next(),
            r.market_id,
            market.tenantId,
            r.kind,
            r.state,
            r.starts_at,
            r.ends_at,
            r.live_version_id,
            by,
          ],
        ),
      );
    };
    expect(await insertSlideRow()).toBe('allowed');
    expect(await insertSlideRow({ kind: 'banner' })).toBe(CHECK);
    expect(await insertSlideRow({ state: 'live' })).toBe(CHECK);
    expect(await insertSlideRow({ market_id: 'bad mkt' })).toBe(CHECK);
    // The 90-day rule is 2160 hours exactly, and the end is required and after the start.
    expect(await insertSlideRow({ ends_at: T0.add({ hours: HOURS_90_DAYS }).toString() })).toBe(
      'allowed',
    );
    expect(
      await insertSlideRow({ ends_at: T0.add({ hours: HOURS_90_DAYS, seconds: 1 }).toString() }),
    ).toBe(CHECK);
    expect(await insertSlideRow({ ends_at: T0.toString() })).toBe(CHECK);
    expect(await insertSlideRow({ ends_at: null })).toBe('23502');
    // An approved or paused slide has a live version; a draft has none.
    expect(await insertSlideRow({ state: 'approved' })).toBe(CHECK);
    expect(await insertSlideRow({ state: 'draft', live_version_id: ids.next() })).toBe(CHECK);

    const slide = slideRecord();
    await insert(slide);
    const insertVersionRow = (overrides: Record<string, unknown> = {}, versionNo = 90) => {
      const r = {
        content: JSON.stringify(content),
        placements: JSON.stringify([{ position: 'home.hero' }]),
        ends_at: T0.add({ hours: 24 }).toString(),
        approved_by: null,
        approved_at: null,
        ...overrides,
      };
      return code_(
        sql.query(
          `INSERT INTO storefront.slide_versions (id, market_id, tenant_id, slide_id, version_no, internal_name, content, placements, starts_at, ends_at, pinned, sponsored, created_at, created_by, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, $5, 'N', $6::jsonb, $7::jsonb, $8, $9, false, false, now(), $10, $11, $12)`,
          [
            ids.next(),
            market.marketId,
            market.tenantId,
            slide.id,
            versionNo + Math.floor(Math.random() * 1e6),
            r.content,
            r.placements,
            T0.toString(),
            r.ends_at,
            by,
            r.approved_by,
            r.approved_at,
          ],
        ),
      );
    };
    expect(await insertVersionRow()).toBe('allowed');
    expect(
      await insertVersionRow({ ends_at: T0.add({ hours: HOURS_90_DAYS + 1 }).toString() }),
    ).toBe(CHECK);
    expect(await insertVersionRow({ content: JSON.stringify({ title: 'x'.repeat(61) }) })).toBe(
      CHECK,
    );
    expect(
      await insertVersionRow({ content: JSON.stringify({ title: 'ok', body: 'y'.repeat(161) }) }),
    ).toBe(CHECK);
    expect(
      await insertVersionRow({
        content: JSON.stringify({ title: 'ok', ctaLabel: 'z'.repeat(25) }),
      }),
    ).toBe(CHECK);
    expect(await insertVersionRow({ content: JSON.stringify([]) })).toBe(CHECK);
    expect(await insertVersionRow({ placements: JSON.stringify([]) })).toBe(CHECK);
    expect(await insertVersionRow({ approved_by: by })).toBe(CHECK);

    const insertPlacementRow = (overrides: Record<string, unknown> = {}) => {
      const r = {
        position_key: 'home.hero',
        scope: 'all',
        scope_id: null,
        include_subcategories: false,
        autoplay: false,
        sort_order: 0,
        ...overrides,
      };
      return code_(
        sql.query(
          `INSERT INTO storefront.slide_placements (id, market_id, tenant_id, slide_id, position_key, scope, scope_id, include_subcategories, sort_order, autoplay, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            ids.next(),
            market.marketId,
            market.tenantId,
            slide.id,
            r.position_key,
            r.scope,
            r.scope_id,
            r.include_subcategories,
            r.sort_order,
            r.autoplay,
            T0.toString(),
            T0.add({ hours: 24 }).toString(),
          ],
        ),
      );
    };
    expect(await insertPlacementRow()).toBe('allowed');
    expect(await insertPlacementRow({ autoplay: true })).toBe('allowed');
    expect(await insertPlacementRow({ position_key: 'landing.top', autoplay: true })).toBe(
      'allowed',
    );
    // Autoplay only at the hero and the top of a landing page.
    expect(await insertPlacementRow({ position_key: 'home.mid', autoplay: true })).toBe(CHECK);
    expect(await insertPlacementRow({ position_key: 'Home Hero' })).toBe(CHECK);
    expect(await insertPlacementRow({ scope: 'galaxy', scope_id: ids.next() })).toBe(CHECK);
    expect(await insertPlacementRow({ scope: 'category' })).toBe(CHECK);
    expect(await insertPlacementRow({ scope: 'all', scope_id: ids.next() })).toBe(CHECK);
    expect(await insertPlacementRow({ include_subcategories: true })).toBe(CHECK);
    expect(
      await insertPlacementRow({
        scope: 'product',
        scope_id: ids.next(),
        include_subcategories: true,
      }),
    ).toBe(CHECK);
    expect(await insertPlacementRow({ sort_order: 5000 })).toBe(CHECK);
  });

  it("grants the application role no delete of slides and versions, and no update of a version's content", async () => {
    const slide = slideRecord();
    await insert(slide);
    const v1 = version(slide.id, 1);
    await value(market, () => slides.insertVersion(market, v1));
    for (const statement of [
      [`DELETE FROM storefront.slides WHERE id = $1`, [slide.id]],
      [`DELETE FROM storefront.slide_versions WHERE id = $1`, [v1.id]],
      [`UPDATE storefront.slides SET kind = 'link' WHERE id = $1`, [slide.id]],
      [
        `UPDATE storefront.slide_versions SET content = '{"title":"x"}'::jsonb WHERE id = $1`,
        [v1.id],
      ],
      [`UPDATE storefront.slide_versions SET placements = '[{}]'::jsonb WHERE id = $1`, [v1.id]],
      [
        `UPDATE storefront.slide_versions SET ends_at = ends_at + interval '1 hour' WHERE id = $1`,
        [v1.id],
      ],
      [`UPDATE storefront.slide_placements SET sort_order = 1 WHERE slide_id = $1`, [slide.id]],
      [`DELETE FROM storefront.slide_position_locks WHERE market_id = $1`, [market.marketId]],
    ] as const) {
      expect(await code_(sql.query(statement[0], [...statement[1]]))).toBe(DENIED);
    }
  });
});
