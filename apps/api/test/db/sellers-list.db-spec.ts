import { randomUUID } from 'node:crypto';
import { Temporal, ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  ListPageQuery,
  ListedSeller,
} from '../../src/modules/sellers/application/ports/seller-list.repository';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaSellerListRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-list.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The admin seller list on PostgreSQL (sellers data design 7 A3 to A7; slice 6), for both Market
// fixtures, as the application role: the three tabs and their order, keyset paging, the filters,
// the counts, the search ranges, the Market scope, and the partial index of A4 (migration 7).

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1';
const envelope = (length: number): string => `v1.${'A'.repeat(length - 3)}`;
const at = (seconds: number): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + seconds * 1000);

const BASE: ListPageQuery = {
  kind: null,
  outsideArea: false,
  openAreaCodes: ['open'],
  onlyIds: null,
  after: null,
  take: 50,
};

describe.each(TEST_MARKETS)('the admin seller list in market %s', (code) => {
  const market = marketOf(code);
  const other = otherMarketOf(code);
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let files: PrismaSellerFileRepository;
  let list: PrismaSellerListRepository;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    list = new PrismaSellerListRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await db.close();
  });

  const read = async <T>(work: () => Promise<T>, marketCode: string = code): Promise<T> => {
    const result = await db.unitOfWork.run(marketOf(marketCode), async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  /** A committed file in `marketCode`, created and last changed `seconds` after T0. */
  async function newFile(
    seconds: number,
    patch: {
      storeName?: string;
      complete?: boolean;
      address?: string | null;
      area?: string | null;
      marketCode?: string;
      slug?: string;
    } = {},
  ): Promise<Id<'Seller'>> {
    const marketCode = patch.marketCode ?? code;
    // A new millisecond for each id: a v7 id orders by time only across milliseconds.
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    const m = marketOf(marketCode);
    const created = await db.unitOfWork.run(m, async () =>
      ok(
        await files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: at(seconds),
          }),
        ),
      ),
    );
    if (!created.ok) throw new Error('unreachable');
    if (patch.storeName !== undefined) {
      await owner.query(
        'UPDATE sellers.seller_files SET store_name = $3, store_name_key = lower($3) WHERE market_id = $1 AND seller_id = $2',
        [marketCode, sellerId, patch.storeName],
      );
    }
    if (patch.complete === true) {
      await owner.query(
        'UPDATE sellers.seller_files SET draft_complete = true WHERE market_id = $1 AND seller_id = $2',
        [marketCode, sellerId],
      );
    }
    if (patch.address !== undefined || patch.area !== undefined) {
      await owner.query(
        'UPDATE sellers.seller_files SET address_ciphertext = $3, service_area_code = $4 WHERE market_id = $1 AND seller_id = $2',
        [marketCode, sellerId, patch.address ?? null, patch.area ?? null],
      );
    }
    if (patch.slug !== undefined) {
      await owner.query(
        `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state, ever_public, held_at, version, created_at)
         VALUES ($1, $2, $3, $4, $5, 'held', false, $6, 1, $6)`,
        [randomUUID(), marketCode, m.tenantId, patch.slug, sellerId, at(seconds).toString()],
      );
    }
    madeHere.push(sellerId);
    return sellerId;
  }

  async function pending(
    sellerId: Id<'Seller'>,
    seconds: number,
    kind: 'onboarding' | 'identity-change' = 'onboarding',
    marketCode: string = code,
  ): Promise<string> {
    const id = ids.next<'BusinessFileRevision'>();
    await owner.query(
      `INSERT INTO sellers.business_file_revisions
        (id, market_id, tenant_id, seller_id, kind, revision_no, status, author_kind, author_account_id,
         content_ciphertext, content_schema_version, content_hash, operating_timezone, service_area_code,
         register_outcome, register_mismatches, created_at, status_changed_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'pending', 'seller', $6, $7, 1, $8, 'Australia/Brisbane', 'open',
               'not-performed', '{}', $9, $9)`,
      [
        id,
        marketCode,
        marketOf(marketCode).tenantId,
        sellerId,
        kind,
        ACCOUNT,
        envelope(80),
        `hmac-sha256:${'1'.padStart(64, '0')}`,
        at(seconds).toString(),
      ],
    );
    return id;
  }

  async function approve(sellerId: Id<'Seller'>, seconds: number): Promise<void> {
    const id = ids.next<'BusinessFileRevision'>();
    await owner.query(
      `INSERT INTO sellers.business_file_revisions
        (id, market_id, tenant_id, seller_id, kind, revision_no, status, author_kind, author_account_id,
         content_ciphertext, content_schema_version, content_hash, operating_timezone, service_area_code,
         register_outcome, register_mismatches, created_at, status_changed_at, decided_at)
       VALUES ($1, $2, $3, $4, 'onboarding', 1, 'approved', 'seller', $5, $6, 1, $7, 'Australia/Brisbane', 'open',
               'not-performed', '{}', $8, $8, $8)`,
      [
        id,
        code,
        market.tenantId,
        sellerId,
        ACCOUNT,
        envelope(80),
        `hmac-sha256:${'2'.padStart(64, '0')}`,
        at(seconds).toString(),
      ],
    );
    await owner.query(
      'UPDATE sellers.seller_files SET approved_revision_id = $3 WHERE market_id = $1 AND seller_id = $2',
      [code, sellerId, id],
    );
  }

  /**
   * The database is shared with the other spec files, so every page read is limited to the
   * sellers this test made (`onlyIds`, the same filter a search uses); the Market is still the
   * query's, so a foreign seller in the list stays out.
   */
  let madeHere: Id<'Seller'>[] = [];
  const q = (over: Partial<ListPageQuery> = {}): ListPageQuery => ({
    ...BASE,
    onlyIds: madeHere,
    ...over,
  });
  /** A name prefix no other file uses, so a search finds only this test's sellers. */
  const tag = `list${randomUUID().slice(0, 8)}`;

  const idsOf = (rows: readonly ListedSeller[]) => rows.map((row) => row.sellerId);

  beforeEach(() => {
    madeHere = [];
  });

  describe('awaiting review', () => {
    it('lists pending submissions oldest first, filters by kind, and pages by keyset', async () => {
      const a = await newFile(1, { storeName: 'Alpha' });
      const b = await newFile(2, { storeName: 'Bravo' });
      const c = await newFile(3, { storeName: 'Charlie' });
      await newFile(4);
      await pending(c, 30);
      const revisionB = await pending(b, 20, 'identity-change');
      await pending(a, 10);

      const all = await read(() => list.awaitingReview(market, q()));
      const changes = await read(() => list.awaitingReview(market, q({ kind: 'identity-change' })));
      const first = await read(() => list.awaitingReview(market, q({ take: 2 })));
      const second = await read(() =>
        list.awaitingReview(market, {
          ...q(),
          after: {
            tab: 'awaiting-review',
            createdAt: first[1]!.pending!.submittedAt,
            revisionId: first[1]!.pending!.revisionId,
          },
        }),
      );

      expect(idsOf(all)).toEqual([a, b, c]);
      expect(all[0]).toMatchObject({
        storeName: 'Alpha',
        origin: 'self',
        hasApprovedRevision: false,
        pending: { kind: 'onboarding', revisionNo: 1, submittedAt: at(10) },
      });
      expect(idsOf(changes)).toEqual([b]);
      expect(changes[0]!.pending!.revisionId).toBe(revisionB);
      expect(idsOf(first)).toEqual([a, b]);
      expect(idsOf(second)).toEqual([c]);
    });

    it('never lists a submission of another Market', async () => {
      const mine = await newFile(1);
      await pending(mine, 10);
      const foreign = await newFile(2, { marketCode: other });
      await pending(foreign, 11, 'onboarding', other);

      const rows = await read(() => list.awaitingReview(market, q()));
      const theirs = await read(() => list.awaitingReview(marketOf(other), q()), other);

      expect(idsOf(rows)).toEqual([mine]);
      expect(idsOf(theirs)).toEqual([foreign]);
    });
  });

  describe('incomplete', () => {
    it('lists never-approved files with an incomplete draft and no pending submission, newest change first', async () => {
      const old = await newFile(1);
      const recent = await newFile(5);
      const complete = await newFile(3, { complete: true });
      const submitted = await newFile(4);
      await pending(submitted, 40);
      const approved = await newFile(6);
      await approve(approved, 60);

      const rows = await read(() => list.incomplete(market, q()));

      expect(idsOf(rows)).toEqual([recent, old]);
      expect(idsOf(rows)).not.toContain(complete);
      expect(idsOf(rows)).not.toContain(submitted);
      expect(idsOf(rows)).not.toContain(approved);
    });

    it('pages by keyset on (last change, seller id) and ties break on the id', async () => {
      const tie1 = await newFile(5);
      const tie2 = await newFile(5);
      const older = await newFile(1);

      const first = await read(() => list.incomplete(market, q({ take: 2 })));
      const second = await read(() =>
        list.incomplete(market, {
          ...q(),
          after: {
            tab: 'incomplete',
            changedAt: first[1]!.lastChangedAt,
            sellerId: first[1]!.sellerId,
          },
        }),
      );

      expect(idsOf(first)).toEqual([tie2, tie1]);
      expect(idsOf(second)).toEqual([older]);
    });

    it('filters on an address outside every area that takes new sellers', async () => {
      const inside = await newFile(1, { address: envelope(60), area: 'open' });
      const closed = await newFile(2, { address: envelope(60), area: 'closed' });
      const noArea = await newFile(3, { address: envelope(60), area: null });
      const noAddress = await newFile(4);

      const outside = await read(() => list.incomplete(market, q({ outsideArea: true })));
      const everyone = await read(() => list.incomplete(market, q()));

      expect(idsOf(outside)).toEqual([noArea, closed]);
      expect(new Set(idsOf(everyone))).toEqual(new Set([inside, closed, noArea, noAddress]));
      expect(everyone.find((row) => row.sellerId === inside)).toMatchObject({
        hasAddress: true,
        serviceAreaCode: 'open',
      });
      expect(everyone.find((row) => row.sellerId === noAddress)?.hasAddress).toBe(false);
    });

    it('uses the partial index of migration 7 (data design A4)', async () => {
      await newFile(1);
      const plan = await owner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT seller_id FROM sellers.seller_files
          WHERE market_id = $1 AND approved_revision_id IS NULL AND draft_complete = false
          ORDER BY last_changed_at DESC, seller_id DESC LIMIT 26`,
        [code],
      );

      // A one-row table prefers a sequential scan; the index exists and is the one this order
      // reads backwards, which `enable_seqscan = off` proves.
      await owner.query('SET enable_seqscan = off');
      const forced = await owner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT seller_id FROM sellers.seller_files
          WHERE market_id = $1 AND approved_revision_id IS NULL AND draft_complete = false
          ORDER BY last_changed_at DESC, seller_id DESC LIMIT 26`,
        [code],
      );
      await owner.query('RESET enable_seqscan');
      const text = forced.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan.rows.length).toBeGreaterThan(0);
      expect(text).toContain('seller_files_market_id_last_changed_at_seller_id_unapproved_idx');
      expect(text).toContain('Backward');
    });
  });

  describe('all', () => {
    it('lists every file newest first, pages by id, and adds the held slug', async () => {
      const first = await newFile(1, { slug: `first-${tag.toLowerCase()}` });
      const second = await newFile(2);
      const third = await newFile(3);
      await newFile(9, { marketCode: other });

      const page1 = await read(() => list.all(market, q({ take: 2 })));
      const page2 = await read(() =>
        list.all(market, q({ after: { tab: 'all', sellerId: page1[1]!.sellerId } })),
      );

      expect(idsOf(page1)).toEqual([third, second]);
      expect(idsOf(page2)).toEqual([first]);
      expect(page2[0]).toMatchObject({ heldSlug: `first-${tag.toLowerCase()}` });
      expect(page1[0]!.heldSlug).toBeNull();
    });

    it('restricts to the ids a search named, still inside the Market', async () => {
      const wanted = await newFile(1);
      await newFile(2);
      const foreign = await newFile(3, { marketCode: other });

      const rows = await read(() => list.all(market, q({ onlyIds: [wanted, foreign] })));

      expect(idsOf(rows)).toEqual([wanted]);
    });
  });

  describe('counts', () => {
    it('counts the tabs of the Market only: the difference this test makes', async () => {
      const before = await read(() => list.counts(market));
      const a = await newFile(1);
      const b = await newFile(2);
      await newFile(3);
      await newFile(4, { complete: true });
      await pending(a, 10);
      await pending(b, 11, 'identity-change');
      await newFile(5, { marketCode: other });

      const after = await read(() => list.counts(market));

      expect({
        onboarding: after.awaitingReview.onboarding - before.awaitingReview.onboarding,
        identityChange: after.awaitingReview.identityChange - before.awaitingReview.identityChange,
        incomplete: after.incomplete - before.incomplete,
        all: after.all - before.all,
      }).toEqual({ onboarding: 1, identityChange: 1, incomplete: 1, all: 4 });
    });
  });

  describe('search candidates', () => {
    const slugTag = tag.toLowerCase();

    it('matches a store-name prefix and a held-slug prefix, only in the Market', async () => {
      const byName = await newFile(1, { storeName: `${slugTag} noor grocer` });
      const bySlug = await newFile(2, { storeName: 'zed', slug: `${slugTag}-amin-foods` });
      await newFile(3, { storeName: 'bravo', slug: 'bravo-shop' });
      await newFile(4, { storeName: `${slugTag} noor other market`, marketCode: other });

      const name = await read(() =>
        list.searchCandidates(market, { nameKey: `${slugTag} no`, slug: null }, 10),
      );
      const both = await read(() =>
        list.searchCandidates(market, { nameKey: `${slugTag}-`, slug: `${slugTag}-` }, 10),
      );
      const none = await read(() =>
        list.searchCandidates(market, { nameKey: `${slugTag}zzz`, slug: `${slugTag}zzz` }, 10),
      );

      expect(name).toEqual({ ids: [byName], overflow: false });
      expect(both).toEqual({ ids: [bySlug], overflow: false });
      expect(none).toEqual({ ids: [], overflow: false });
    });

    it('reports overflow instead of cutting silently when the term names more than the cap', async () => {
      await newFile(1, { storeName: `${slugTag} cap one` });
      await newFile(2, { storeName: `${slugTag} cap two` });
      await newFile(3, { storeName: `${slugTag} cap three` });

      const result = await read(() =>
        list.searchCandidates(market, { nameKey: `${slugTag} cap`, slug: null }, 2),
      );

      expect(result.overflow).toBe(true);
      expect(result.ids).toHaveLength(2);
    });

    it('does not treat LIKE wildcards in the term as wildcards', async () => {
      await newFile(1, { storeName: `${slugTag} abc` });

      const result = await read(() =>
        list.searchCandidates(market, { nameKey: `${slugTag} a%`, slug: null }, 10),
      );

      expect(result.ids).toEqual([]);
    });
  });
});
