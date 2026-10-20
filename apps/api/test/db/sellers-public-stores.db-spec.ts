import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { PrismaPublishedStoreRepository } from '../../src/modules/sellers/infrastructure/prisma-published-store.repository';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The public store reads on PostgreSQL (slice 12), for both Market fixtures, as the application
// role: only a file with an approved pointer, an `approved` revision of its own and a `held` slug
// is a store; its area and zone come from the approved revision; "first approved" is the earliest
// decision of a revision that was ever approved; a retired slug and another Market's store are
// never found.

const T0 = Temporal.Instant.from('2026-10-15T01:00:00Z');
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKETS)('public store reads in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let owner: Client;
  let files: PrismaSellerFileRepository;
  let stores: PrismaPublishedStoreRepository;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    stores = new PrismaPublishedStoreRepository(db.service);
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const inUnit = async <T>(work: () => Promise<T>, m: MarketContext = market): Promise<T> => {
    const result = await db.unitOfWork.run(m, async () => ok(await work()), { readOnly: true });
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  async function newSeller(m: MarketContext = market): Promise<Id<'Seller'>> {
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    const created = await db.unitOfWork.run(m, async () =>
      ok(
        await files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: T0,
          }),
        ),
      ),
    );
    if (!created.ok) throw new Error('unreachable');
    return sellerId;
  }

  async function addRevision(
    sellerId: Id<'Seller'>,
    revisionNo: number,
    status: string,
    decidedAt: string | null,
    area: string,
    m: MarketContext = market,
  ): Promise<string> {
    const revisionId = ids.next<'BusinessFileRevision'>();
    await owner.query(
      `INSERT INTO sellers.business_file_revisions
        (id, market_id, tenant_id, seller_id, kind, revision_no, status, author_kind, author_account_id,
         content_ciphertext, content_schema_version, content_hash, operating_timezone, service_area_code,
         register_outcome, register_mismatches, created_at, status_changed_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seller', $8, $9, 1, $10, 'Australia/Brisbane', $11,
               'not-performed', '{}', $12, $12, $13)`,
      [
        revisionId,
        m.marketId,
        m.tenantId,
        sellerId,
        revisionNo === 1 ? 'onboarding' : 'identity-change',
        revisionNo,
        status,
        ACCOUNT,
        `v1.${'A'.repeat(77)}`,
        `hmac-sha256:${revisionNo.toString().padStart(64, '0')}`,
        area,
        T0.toString(),
        decidedAt,
      ],
    );
    return revisionId;
  }

  const approve = (sellerId: Id<'Seller'>, revisionId: string, name: string, m = market) =>
    owner.query(
      'UPDATE sellers.seller_files SET approved_revision_id = $3, public_store_name = $4 WHERE market_id = $1 AND seller_id = $2',
      [m.marketId, sellerId, revisionId, name],
    );

  const holdSlug = (sellerId: Id<'Seller'>, slug: string, state = 'held', m = market) =>
    owner.query(
      `INSERT INTO sellers.shop_slugs
        (id, market_id, tenant_id, slug, seller_id, state, ever_public, held_at, retired_at, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, 1, $7)`,
      [
        ids.next<'ShopSlug'>(),
        m.marketId,
        m.tenantId,
        slug,
        sellerId,
        state,
        T0.toString(),
        state === 'retired' ? T0.toString() : null,
      ],
    );

  const suffix = code.toLowerCase();

  it('reads an approved store with a held slug, from its approved revision', async () => {
    const sellerId = await newSeller();
    const first = await addRevision(sellerId, 1, 'superseded', '2025-02-01T00:00:00Z', 'area-old');
    void first;
    const current = await addRevision(sellerId, 2, 'approved', '2026-03-01T00:00:00Z', 'area-new');
    await approve(sellerId, current, 'Kedron Halal');
    await holdSlug(sellerId, `kedron-${suffix}`);

    const found = await inUnit(() => stores.approvedStoreBySlug(market, `kedron-${suffix}`));

    expect(found).toEqual({
      sellerId,
      slug: `kedron-${suffix}`,
      name: 'Kedron Halal',
      serviceAreaCode: 'area-new',
      operatingTimezone: 'Australia/Brisbane',
      firstApprovedAt: Temporal.Instant.from('2025-02-01T00:00:00Z'),
    });
    expect(
      (await inUnit(() => stores.approvedStores(market, 1000))).map((s) => s.sellerId),
    ).toContain(sellerId);
  });

  it('leaves out a seller with no approved revision, or with no held slug', async () => {
    const pending = await newSeller();
    await addRevision(pending, 1, 'pending', null, 'area-1');
    await holdSlug(pending, `pending-${suffix}`);
    const noSlug = await newSeller();
    const revision = await addRevision(noSlug, 1, 'approved', '2026-01-01T00:00:00Z', 'area-1');
    await approve(noSlug, revision, 'No Slug');

    const all = (await inUnit(() => stores.approvedStores(market, 1000))).map((s) => s.sellerId);

    expect(all).not.toContain(pending);
    expect(all).not.toContain(noSlug);
    expect(await inUnit(() => stores.approvedStoreBySlug(market, `pending-${suffix}`))).toBeNull();
  });

  it('never resolves a retired slug', async () => {
    const sellerId = await newSeller();
    const revision = await addRevision(sellerId, 1, 'approved', '2026-01-01T00:00:00Z', 'area-1');
    await approve(sellerId, revision, 'Moved');
    await holdSlug(sellerId, `old-name-${suffix}`, 'retired');
    await holdSlug(sellerId, `new-name-${suffix}`);

    expect(await inUnit(() => stores.approvedStoreBySlug(market, `old-name-${suffix}`))).toBeNull();
    expect(
      (await inUnit(() => stores.approvedStoreBySlug(market, `new-name-${suffix}`)))?.slug,
    ).toBe(`new-name-${suffix}`);
  });

  it("never answers another Market's store", async () => {
    const sellerId = await newSeller(other);
    const revision = await addRevision(sellerId, 1, 'approved', '2026-01-01T00:00:00Z', 'a', other);
    await approve(sellerId, revision, 'Elsewhere', other);
    await holdSlug(sellerId, `elsewhere-${suffix}`, 'held', other);

    expect(
      await inUnit(() => stores.approvedStoreBySlug(market, `elsewhere-${suffix}`)),
    ).toBeNull();
    expect(
      (await inUnit(() => stores.approvedStores(market, 1000))).map((s) => s.sellerId),
    ).not.toContain(sellerId);
  });

  it('bounds the list by the limit, in seller id order', async () => {
    for (const n of [1, 2, 3]) {
      const sellerId = await newSeller();
      const revision = await addRevision(sellerId, 1, 'approved', '2026-01-01T00:00:00Z', 'a');
      await approve(sellerId, revision, `Bounded ${n}`);
      await holdSlug(sellerId, `bounded-${n}-${suffix}`);
    }

    const two = await inUnit(() => stores.approvedStores(market, 2));

    expect(two).toHaveLength(2);
    expect([...two].map((s) => s.sellerId)).toEqual([...two].map((s) => s.sellerId).sort());
  });
});
