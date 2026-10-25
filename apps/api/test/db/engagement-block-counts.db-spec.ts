import { randomBytes } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PurgeExpiredBlockCounts } from '../../src/modules/engagement/application/use-cases/purge-expired-block-counts.use-case';
import { RecordBlockEvents } from '../../src/modules/engagement/application/use-cases/record-block-events.use-case';
import { FacadeServedPlacements } from '../../src/modules/engagement/infrastructure/facade-served-placements';
import { PrismaBlockCountRepository } from '../../src/modules/engagement/infrastructure/prisma-block-count.repository';
import type { PageRecord } from '../../src/modules/storefront/application/ports/page.repository';
import type { StorefrontDependencies } from '../../src/modules/storefront/application/storefront-dependencies';
import { ViewServedPlacements } from '../../src/modules/storefront/application/use-cases/view-served-placements.use-case';
import { PrismaPageRepository } from '../../src/modules/storefront/infrastructure/prisma-page.repository';
import { StorefrontFacadeImplementation } from '../../src/modules/storefront/presentation/storefront.facade';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The block counts as the application role, in both Market fixtures, with the real storefront
// pages behind the served-placement check: a count is added to in the database (so requests at
// once lose none), a Market never sees another's, a placement that is not served on a published,
// live page makes no row, the CHECKs refuse negative counts, the table holds no personal column,
// and the purge deletes only rows older than 13 months.

const T0 = Temporal.Instant.from('2026-10-25T09:00:00Z');
const CHECK = '23514';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('block counts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const by = ids.next<'Account'>();
  const anonymous = testCallContext(market, 'anonymous', 'blocks-db-abcd');
  const system = testCallContext(market, 'system', 'blocks-db-sys-abcd');
  const quiet = { globalPrivacyControl: false };
  let db: Persistence;
  let pages: PrismaPageRepository;
  let counts: PrismaBlockCountRepository;
  let sql: Client;
  let owner: Client;
  let n = 0;

  beforeAll(async () => {
    db = createPersistence();
    pages = new PrismaPageRepository(db.service);
    counts = new PrismaBlockCountRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });
  beforeEach(() => clock.set(T0));

  const record = () => {
    const storefrontDeps = {
      unitOfWork: db.unitOfWork,
      pages,
      clock,
    } as unknown as StorefrontDependencies;
    const facade = new StorefrontFacadeImplementation(
      new ViewServedPlacements(gate, storefrontDeps),
    );
    return new RecordBlockEvents(gate, {
      unitOfWork: db.unitOfWork,
      counts,
      served: new FacadeServedPlacements(facade),
      clock,
    });
  };
  const purge = () =>
    new PurgeExpiredBlockCounts(gate, { unitOfWork: db.unitOfWork, counts, clock });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const stamp = { at: T0, by };
  const placement = (enabled = true) => ({
    id: ids.next<'StorefrontPlacement'>(),
    module: 'banner',
    enabled,
    config: { title: 'Eid', image: { ref: 'campaign-default', alt: 'Eid' } },
  });

  /** A landing page with a published version holding `hero` placements (in this Market). */
  async function publishedPage(
    hero: ReturnType<typeof placement>[],
    overrides: Partial<PageRecord> = {},
    target: MarketContext = market,
    slot = 'hero',
  ): Promise<Id<'StorefrontPage'>> {
    n += 1;
    const page: PageRecord = {
      id: ids.next<'StorefrontPage'>(),
      kind: 'dynamic',
      systemKey: null,
      slug: `blocks-${code.toLowerCase()}-${n}-${randomBytes(6).toString('hex')}`,
      templateKey: 'campaign-landing',
      title: 'Eid',
      seo: {},
      linked: null,
      startsAt: null,
      endsAt: null,
      archivedAt: null,
      archivedRedirect: null,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    };
    const draftId = ids.next<'StorefrontPageVersion'>();
    await value(target, async () => {
      await pages.insertPage(target, page, by);
      await pages.insertDraft(
        target,
        { id: draftId, pageId: page.id, versionNo: 1, placements: { [slot]: hero } },
        stamp,
      );
      await pages.publishDraft(target, page.id, draftId, stamp);
    });
    return page.id;
  }
  const rowsOf = async (pageId: string) =>
    (
      await sql.query<{
        market_id: string;
        placement_id: string;
        day: string;
        impressions: number;
        clicks: number;
      }>(
        `SELECT market_id, placement_id, to_char(day, 'YYYY-MM-DD') AS day, impressions, clicks
           FROM engagement.block_counts WHERE page_id = $1 ORDER BY market_id, placement_id, day`,
        [pageId],
      )
    ).rows;
  const event = (pageId: string, placementId: string, type: 'impression' | 'click') => ({
    pageId,
    placementId,
    type,
  });

  it('adds to one row per block and UTC day, and starts a new row after midnight UTC', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);

    await record().execute(anonymous, {
      events: [event(pageId, hero.id, 'impression'), event(pageId, hero.id, 'click')],
      ...quiet,
    });
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'impression')], ...quiet });
    clock.set(Temporal.Instant.from('2026-10-26T00:00:05Z'));
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'click')], ...quiet });

    expect(await rowsOf(pageId)).toEqual([
      { market_id: code, placement_id: hero.id, day: '2026-10-25', impressions: 2, clicks: 1 },
      { market_id: code, placement_id: hero.id, day: '2026-10-26', impressions: 0, clicks: 1 },
    ]);
    const stored = await sql.query<{ tenant_id: string; updated_at: Date }>(
      'SELECT tenant_id, updated_at FROM engagement.block_counts WHERE page_id = $1 ORDER BY day',
      [pageId],
    );
    expect(stored.rows[0]!.tenant_id).toBe(market.tenantId);
    expect(stored.rows[1]!.updated_at.toISOString()).toBe('2026-10-26T00:00:05.000Z');
  });

  it('loses no count when requests arrive at once', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        record().execute(anonymous, {
          events: [event(pageId, hero.id, index % 3 === 0 ? 'click' : 'impression')],
          ...quiet,
        }),
      ),
    );

    expect(await rowsOf(pageId)).toEqual([
      { market_id: code, placement_id: hero.id, day: '2026-10-25', impressions: 8, clicks: 4 },
    ]);
  });

  it('keeps two Markets apart: a page and its counts exist only where they were made', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);
    const otherCaller = testCallContext(other, 'anonymous', 'blocks-db-other-abcd');

    // The other Market does not serve this page, so its call counts nothing.
    await record().execute(otherCaller, {
      events: [event(pageId, hero.id, 'impression')],
      ...quiet,
    });
    expect(await rowsOf(pageId)).toEqual([]);

    // The same ids published in the other Market count there, in their own row.
    const twin = await publishedPage([hero], {}, other);
    await record().execute(otherCaller, { events: [event(twin, hero.id, 'impression')], ...quiet });
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'click')], ...quiet });
    expect(await rowsOf(twin)).toEqual([
      {
        market_id: other.marketId,
        placement_id: hero.id,
        day: '2026-10-25',
        impressions: 1,
        clicks: 0,
      },
    ]);
    expect(await rowsOf(pageId)).toEqual([
      { market_id: code, placement_id: hero.id, day: '2026-10-25', impressions: 0, clicks: 1 },
    ]);
  });

  it('makes no row for a placement that is not served: unknown, switched off, draft, not live', async () => {
    const hero = placement();
    const off = placement(false);
    const pageId = await publishedPage([hero, off], {}, market, 'main');
    const lateId = await publishedPage([placement()], { startsAt: T0.add({ hours: 24 }) });
    const lateHero = (await value(market, () => pages.findPublished(market, lateId)))!;
    const archivedId = await publishedPage([placement()], { archivedAt: T0 });
    const draftOnly = ids.next<'StorefrontPage'>();
    await value(market, async () => {
      await pages.insertPage(
        market,
        {
          id: draftOnly,
          kind: 'dynamic',
          systemKey: null,
          slug: `draft-${code.toLowerCase()}-${randomBytes(6).toString('hex')}`,
          templateKey: 'campaign-landing',
          title: 'Draft',
          seo: {},
          linked: null,
          startsAt: null,
          endsAt: null,
          archivedAt: null,
          archivedRedirect: null,
          createdAt: T0,
          updatedAt: T0,
        },
        by,
      );
      await pages.insertDraft(
        market,
        {
          id: ids.next<'StorefrontPageVersion'>(),
          pageId: draftOnly,
          versionNo: 1,
          placements: { hero: [hero] },
        },
        stamp,
      );
    });
    const lateBlock = (lateHero.placements as { hero: { id: string }[] }).hero[0]!.id;

    // A request names at most 2 pages, so the cases go in separate requests.
    const answers = await Promise.all(
      [
        [
          event(pageId, ids.next<'StorefrontPlacement'>(), 'impression'),
          event(pageId, off.id, 'impression'),
        ],
        [event(draftOnly, hero.id, 'impression'), event(lateId, lateBlock, 'impression')],
        [
          event(archivedId, ids.next<'StorefrontPlacement'>(), 'click'),
          event(ids.next<'StorefrontPage'>(), hero.id, 'click'),
        ],
      ].map((events) => record().execute(anonymous, { events, ...quiet })),
    );

    for (const answer of answers) expect(answer).toEqual({ ok: true, value: { recorded: false } });
    for (const page of [pageId, draftOnly, lateId, archivedId]) {
      expect(await rowsOf(page)).toEqual([]);
    }
    // Served on its own page only: the same placement id on another page makes no row.
    const second = await publishedPage([placement()]);
    await record().execute(anonymous, { events: [event(second, hero.id, 'impression')], ...quiet });
    expect(await rowsOf(second)).toEqual([]);
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'impression')], ...quiet });
    expect((await rowsOf(pageId)).map((row) => row.placement_id)).toEqual([hero.id]);
  });

  it('counts nothing with Global Privacy Control', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);

    await record().execute(anonymous, {
      events: [event(pageId, hero.id, 'impression')],
      globalPrivacyControl: true,
    });

    expect(await rowsOf(pageId)).toEqual([]);
  });

  it('refuses a negative count and a malformed scope; the table has no personal column', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'impression')], ...quiet });
    const code_ = async (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: { code?: string }) => error.code,
      );

    expect(
      await code_(
        sql.query('UPDATE engagement.block_counts SET impressions = -1 WHERE page_id = $1', [
          pageId,
        ]),
      ),
    ).toBe(CHECK);
    expect(
      await code_(
        sql.query('UPDATE engagement.block_counts SET clicks = -1 WHERE page_id = $1', [pageId]),
      ),
    ).toBe(CHECK);
    expect(
      await code_(
        owner.query("UPDATE engagement.block_counts SET market_id = 'au' WHERE page_id = $1", [
          pageId,
        ]),
      ),
    ).toBe(CHECK);

    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'engagement' AND table_name = 'block_counts' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'clicks',
      'day',
      'impressions',
      'market_id',
      'page_id',
      'placement_id',
      'tenant_id',
      'updated_at',
    ]);
  });

  /** Inserts one count row per (Market, day) for the page, as the owner (the purge's input). */
  const seed = async (pageId: string, placementId: string, marketIds: string[], days: string[]) => {
    for (const marketId of marketIds) {
      for (const day of days) {
        await owner.query(
          `INSERT INTO engagement.block_counts
             (market_id, tenant_id, page_id, placement_id, day, impressions, clicks, updated_at)
           VALUES ($1, 'default', $2, $3, $4, 1, 0, now())`,
          [marketId, pageId, placementId, day],
        );
      }
    }
  };
  const daysOf = async (pageId: string) =>
    (await rowsOf(pageId)).map((row) => `${row.market_id}:${row.day}`);

  it('purges this Market’s rows older than 13 months, and leaves the other Market’s', async () => {
    const hero = placement();
    const pageId = ids.next<'StorefrontPage'>();
    // Other suites may hold old rows too, so only this test's own page is asserted on.
    await seed(pageId, hero.id, [code, other.marketId], ['2025-09-24', '2025-09-25', '2026-10-25']);

    const first = await purge().execute(system, {});
    const second = await purge().execute(system, {});

    expect(first.ok && first.value.blockCounts).toBeGreaterThanOrEqual(1);
    expect(second.ok).toBe(true);
    expect(await daysOf(pageId)).toEqual(
      [code, other.marketId]
        .sort()
        .flatMap((marketId) =>
          marketId === code
            ? [`${marketId}:2025-09-25`, `${marketId}:2026-10-25`]
            : [`${marketId}:2025-09-24`, `${marketId}:2025-09-25`, `${marketId}:2026-10-25`],
        ),
    );
  });

  it('clamps the edge at a month end: on 2026-03-31 the row of 2025-02-27 goes, 2025-02-28 stays', async () => {
    const pageId = ids.next<'StorefrontPage'>();
    await seed(pageId, placement().id, [code], ['2025-02-27', '2025-02-28', '2025-03-01']);
    clock.set(Temporal.Instant.from('2026-03-31T12:00:00Z'));

    await purge().execute(system, {});

    expect(await daysOf(pageId)).toEqual([`${code}:2025-02-28`, `${code}:2025-03-01`]);
  });

  it('moves the purge edge at midnight UTC: 23:59:59Z keeps 2025-09-25, 00:00:00Z removes it', async () => {
    const pageId = ids.next<'StorefrontPage'>();
    await seed(pageId, placement().id, [code], ['2025-09-25']);
    clock.set(Temporal.Instant.from('2026-10-25T23:59:59Z'));
    await purge().execute(system, {});
    expect(await daysOf(pageId)).toEqual([`${code}:2025-09-25`]);

    clock.set(Temporal.Instant.from('2026-10-26T00:00:00Z'));
    await purge().execute(system, {});
    expect(await daysOf(pageId)).toEqual([]);
  });

  it('counts 23:59:59.999Z and 00:00:00.000Z on different UTC days', async () => {
    const hero = placement();
    const pageId = await publishedPage([hero]);

    clock.set(Temporal.Instant.from('2026-10-25T23:59:59.999Z'));
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'impression')], ...quiet });
    clock.set(Temporal.Instant.from('2026-10-26T00:00:00.000Z'));
    await record().execute(anonymous, { events: [event(pageId, hero.id, 'click')], ...quiet });

    expect((await rowsOf(pageId)).map((row) => [row.day, row.impressions, row.clicks])).toEqual([
      ['2026-10-25', 1, 0],
      ['2026-10-26', 0, 1],
    ]);
  });

  it('adds exactly when requests carrying the same two blocks in opposite order race on a new day', async () => {
    const [a, b] = [placement(), placement()];
    const pageId = await publishedPage([a, b], {}, market, 'main');
    // A day nobody has counted on, so every request races to create the same two rows.
    clock.set(Temporal.Instant.from('2026-12-24T10:00:00Z'));
    const forward = [event(pageId, a.id, 'impression'), event(pageId, b.id, 'click')];

    const answers = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        record().execute(anonymous, {
          events: index % 2 === 0 ? forward : [...forward].reverse(),
          ...quiet,
        }),
      ),
    );

    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(await rowsOf(pageId)).toEqual(
      [a.id, b.id].sort().map((placementId) => ({
        market_id: code,
        placement_id: placementId,
        day: '2026-12-24',
        impressions: placementId === a.id ? 16 : 0,
        clicks: placementId === b.id ? 16 : 0,
      })),
    );
  });
});
