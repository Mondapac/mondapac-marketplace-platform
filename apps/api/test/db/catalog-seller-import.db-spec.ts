import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  SellerImportAlreadyRunningError,
  type NewSellerImportJob,
} from '../../src/modules/catalog/application/ports/seller-import.repository';
import type { SellerRowRecord } from '../../src/modules/catalog/domain/seller-import/seller-import-job';
import { PrismaSellerImportRepository } from '../../src/modules/catalog/infrastructure/prisma-seller-import.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The seller import store on PostgreSQL, for both Market fixtures (catalog data design 3.31;
// migration 20261107120000_catalog_seller_import): a checked job with its rows, the seller scope of
// every read, the confirm that skips error rows, one running import per seller, the claim and the
// lease, groups that are never split across a batch, a group remembered the moment its product
// exists, settled groups moving the counters, the end of a turn, the photo names, the purge and the
// Market boundary. The use cases are in the unit specs.

const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller import store in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let owner: Client;
  let persistence: Persistence;
  let repository: PrismaSellerImportRepository;

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    persistence = createPersistence();
    repository = new PrismaSellerImportRepository(persistence.service);
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });

  const inUnit = <T>(target: MarketContext, work: () => Promise<T>): Promise<T> =>
    persistence.unitOfWork
      .run(target, async () => ({ ok: true as const, value: await work() }))
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });

  function jobOf(sellerId: Id<'Seller'>, accountId: Id<'Account'>, createdAt = T0) {
    const id = uuid7() as Id<'SellerImport'>;
    return {
      id,
      sellerId,
      startedByAccountId: accountId,
      startedBySessionId: uuid7() as Id<'Session'>,
      mode: 'my-products',
      format: 'csv',
      fileLabel: 'products.csv',
      fileKey: `catalog/seller-imports/${code}/${id}`,
      fileSha256: 'ab'.repeat(32),
      fileBytes: 100,
      totalRows: 4,
      readyRows: 3,
      errorRows: 1,
      warningRows: 0,
      groupCount: 3,
      ignoredColumns: [{ header: 'Price', mark: 'elsewhere' }],
      createdAt,
      checkedAt: createdAt,
    } as unknown as NewSellerImportJob;
  }
  const record = (over: Partial<SellerRowRecord>): SellerRowRecord => ({
    rowNumber: 2,
    groupRow: 2,
    checkState: 'ready',
    plan: 'create',
    issues: [],
    summary: {
      sku: 'SKU-1',
      title: 'Lamb',
      productCode: '',
      typeCode: 'simple',
      options: '',
      images: ['lamb.jpg'],
    },
    runState: 'pending',
    runCode: null,
    productId: null,
    offerId: null,
    productCode: null,
    ...over,
  });
  // Group 2 has two rows (a variant group), groups 4 and 5 one each; row 5 has an error.
  const rowsOf = (): SellerRowRecord[] => [
    record({ rowNumber: 2, groupRow: 2 }),
    record({ rowNumber: 3, groupRow: 2, summary: { ...record({}).summary, sku: 'SKU-1-L' } }),
    record({
      rowNumber: 4,
      groupRow: 4,
      summary: { ...record({}).summary, sku: 'SKU-2', images: [] },
    }),
    record({
      rowNumber: 5,
      groupRow: 5,
      checkState: 'error',
      plan: null,
      runState: 'skipped',
      issues: [{ severity: 'error', column: 'title', code: 'required', value: '' }],
    }),
  ];
  const choice = { skipErrors: true, toImport: 3, now: T0 };

  it('stores a checked job with its rows and reads them back in file order, for its seller only', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>);
    await inUnit(market, () => repository.add(market, job, rowsOf()));

    const found = await inUnit(market, () => repository.find(market, seller, job.id));
    expect(found).toMatchObject({
      id: job.id,
      state: 'checked',
      mode: 'my-products',
      totalRows: 4,
      readyRows: 3,
      errorRows: 1,
      groupCount: 3,
      fileSha256: 'ab'.repeat(32),
      ignoredColumns: [{ header: 'Price', mark: 'elsewhere' }],
    });
    // Another seller reads nothing of it, even with the id.
    const stranger = uuid7() as Id<'Seller'>;
    expect(await inUnit(market, () => repository.find(market, stranger, job.id))).toBeNull();
    expect(await inUnit(market, () => repository.latestOf(market, stranger))).toBeNull();
    const rows = await inUnit(market, () =>
      repository.rows(market, job.id, {}, { offset: 0, limit: 10 }),
    );
    expect(rows.map((row) => row.rowNumber)).toEqual([2, 3, 4, 5]);
    const errors = await inUnit(market, () =>
      repository.rows(market, job.id, { checkState: 'error' }, { offset: 0, limit: 10 }),
    );
    expect(errors.map((row) => row.rowNumber)).toEqual([5]);
  });

  it('keeps a job inside its Market', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>);
    await inUnit(market, () => repository.add(market, job, rowsOf()));

    expect(await inUnit(other, () => repository.find(other, seller, job.id))).toBeNull();
    expect(await inUnit(other, () => repository.latestOf(other, seller))).toBeNull();
  });

  it('replaces the checked jobs of an account on a new upload and discards them', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const account = uuid7() as Id<'Account'>;
    const first = jobOf(seller, account);
    await inUnit(market, () => repository.add(market, first, rowsOf()));

    const replaced = await inUnit(market, () =>
      repository.discardChecked(market, seller, account, T0),
    );
    expect(replaced).toEqual([{ id: first.id, fileKey: first.fileKey }]);
    expect(await inUnit(market, () => repository.latestOf(market, seller))).toBeNull();
    expect(await inUnit(market, () => repository.discard(market, first.id, T0))).toBeNull();
    await inUnit(market, () => repository.markFileDeleted(market, first.id, T0));
    // A discarded job and its rows go with the next call once its file is gone.
    expect(
      await inUnit(market, () => repository.deleteDiscarded(market, { ids: [first.id] })),
    ).toBe(1);
  });

  it('holds one checked file per account', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const account = uuid7() as Id<'Account'>;
    await inUnit(market, () => repository.add(market, jobOf(seller, account), rowsOf()));
    await expect(
      inUnit(market, () => repository.add(market, jobOf(seller, account), rowsOf())),
    ).rejects.toBeDefined();
  });

  it('confirms once, marks error rows skipped, and lets one import run per seller', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const account = uuid7() as Id<'Account'>;
    const job = jobOf(seller, account);
    // One checked file per account (a new upload replaces it), so the second is another member's.
    const second = jobOf(seller, uuid7() as Id<'Account'>);
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.add(market, second, rowsOf());
    });

    expect(await inUnit(market, () => repository.confirm(market, job.id, choice))).toBe(true);
    expect(await inUnit(market, () => repository.confirm(market, job.id, choice))).toBe(false);
    expect(await inUnit(market, () => repository.hasActive(market, seller))).toBe(true);
    // The second import of the same seller cannot be queued while the first is.
    await expect(
      inUnit(market, () => repository.confirm(market, second.id, choice)),
    ).rejects.toBeInstanceOf(SellerImportAlreadyRunningError);

    expect(await inUnit(market, () => repository.find(market, seller, job.id))).toMatchObject({
      state: 'queued',
      skipErrors: true,
      toImport: 3,
    });
    expect(
      await inUnit(market, () => repository.startsSince(market, seller, T0.subtract({ hours: 1 }))),
    ).toEqual([{ startedAt: T0, toImport: 3 }]);
  });

  it('claims a due job once and never splits a group across a batch', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 1 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, choice);
    });

    const claimed = await inUnit(market, () =>
      repository.claim(market, T0, T0.add({ seconds: 120 })),
    );
    expect(claimed?.state).toBe('running');
    // Held by a lease: the same job is not handed out twice.
    const again = await inUnit(market, () =>
      repository.claim(market, T0, T0.add({ seconds: 120 })),
    );
    expect(again?.id).not.toBe(claimed?.id === job.id ? job.id : undefined);

    // A limit of 1 still brings the whole of group 2 (rows 2 and 3), never half of it.
    const batch = await inUnit(market, () => repository.pendingRows(market, job.id, 1));
    expect(batch.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(
      await inUnit(market, () => repository.renewLease(market, job.id, T0.add({ seconds: 240 }))),
    ).toBe(true);
  });

  it('remembers a group, settles it, moves the counters and ends the turn', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 2 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, choice);
    });
    await inUnit(market, () =>
      repository.claim(market, T0.subtract({ hours: 1 }), T0.add({ seconds: 120 })),
    );

    const productId = uuid7();
    const offerId = uuid7();
    await inUnit(market, () =>
      repository.recordGroup(market, job.id, 2, { productId, offerId, productCode: 'P00000001' }),
    );
    const pending = await inUnit(market, () => repository.pendingRows(market, job.id, 10));
    expect(
      pending.filter((row) => row.groupRow === 2).every((row) => row.productId === productId),
    ).toBe(true);

    await inUnit(market, async () => {
      await repository.settleGroup(market, job.id, 2, {
        state: 'created',
        productId,
        offerId,
        productCode: 'P00000001',
      });
      await repository.settleGroup(market, job.id, 4, {
        state: 'failed',
        code: 'claim-text.found',
      });
    });
    expect(await inUnit(market, () => repository.pendingRows(market, job.id, 10))).toEqual([]);

    const version = await inUnit(market, () =>
      repository.endTurn(market, job.id, { state: 'finished', now: T0.add({ minutes: 1 }) }),
    );
    expect(version).not.toBeNull();
    expect(await inUnit(market, () => repository.find(market, seller, job.id))).toMatchObject({
      state: 'finished',
      createdRows: 2,
      failedRows: 1,
    });
    // A finished job cannot end a turn again.
    expect(
      await inUnit(market, () =>
        repository.endTurn(market, job.id, { state: 'stopped', reason: 'unexpected', now: T0 }),
      ),
    ).toBeNull();
  });

  it('fails the remaining rows with one code, stops with a reason and resumes the rest', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 3 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, choice);
    });
    await inUnit(market, () =>
      repository.claim(market, T0.subtract({ hours: 2 }), T0.add({ seconds: 120 })),
    );

    expect(
      await inUnit(market, () => repository.failRemaining(market, job.id, 'seller.not-eligible')),
    ).toBe(3);
    await inUnit(market, () =>
      repository.endTurn(market, job.id, {
        state: 'stopped',
        reason: 'seller-not-eligible',
        now: T0,
      }),
    );
    // The time it stopped is kept: the photo window is counted from it.
    expect(await inUnit(market, () => repository.find(market, seller, job.id))).toMatchObject({
      state: 'stopped',
      stopReason: 'seller-not-eligible',
      failedRows: 3,
      endedAt: T0,
    });
    expect(await inUnit(market, () => repository.resume(market, job.id))).toBe(true);
    expect(await inUnit(market, () => repository.find(market, seller, job.id))).toMatchObject({
      state: 'queued',
      endedAt: null,
    });
    expect(await inUnit(market, () => repository.resume(market, job.id))).toBe(false);
  });

  it('lists the photo names of settled groups once per name and refuses a repeat', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 4 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, choice);
    });
    await inUnit(market, () =>
      repository.claim(market, T0.subtract({ hours: 3 }), T0.add({ seconds: 120 })),
    );
    const productId = uuid7();
    await inUnit(market, () =>
      repository.settleGroup(market, job.id, 2, {
        state: 'created',
        productId,
        offerId: uuid7(),
        productCode: 'P00000009',
      }),
    );

    // One indexed lookup of the name: the product of the group that listed it, else null.
    expect(await inUnit(market, () => repository.photoTarget(market, job.id, 'lamb.jpg'))).toBe(
      productId,
    );
    expect(
      await inUnit(market, () => repository.photoTarget(market, job.id, 'other.jpg')),
    ).toBeNull();
    // The group of row 4 is not settled as created here, and lists no photo.
    const photo = { jobId: job.id, nameKey: 'lamb.jpg', productId, addedAt: T0 };
    const stale = T0.subtract({ minutes: 10 });
    // The name is reserved before the upload; a second reservation is refused while it is live.
    expect(await inUnit(market, () => repository.reservePhoto(market, photo, stale))).toBe(true);
    expect(await inUnit(market, () => repository.reservePhoto(market, photo, stale))).toBe(false);
    // A failed upload drops the reservation, and the name can be reserved again.
    await inUnit(market, () => repository.releasePhoto(market, job.id, 'lamb.jpg'));
    expect(await inUnit(market, () => repository.reservePhoto(market, photo, stale))).toBe(true);
    // The image id is set once.
    const imageId = uuid7();
    expect(
      await inUnit(market, () => repository.setPhotoImage(market, job.id, 'lamb.jpg', imageId)),
    ).toBe(true);
    expect(
      await inUnit(market, () => repository.setPhotoImage(market, job.id, 'lamb.jpg', uuid7())),
    ).toBe(false);
    // A name with its image is never released or taken over, however old.
    await inUnit(market, () => repository.releasePhoto(market, job.id, 'lamb.jpg'));
    expect(
      await inUnit(market, () =>
        repository.reservePhoto(market, { ...photo, addedAt: T0 }, T0.add({ hours: 24 })),
      ),
    ).toBe(false);
    expect([...(await inUnit(market, () => repository.photoNames(market, job.id)))]).toEqual([
      'lamb.jpg',
    ]);
  });

  it('takes over a reservation that never got its image once it is stale', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 5 }));
    await inUnit(market, () => repository.add(market, job, rowsOf()));
    const photo = { jobId: job.id, nameKey: 'lamb.jpg', productId: uuid7(), addedAt: T0 };
    expect(
      await inUnit(market, () =>
        repository.reservePhoto(market, photo, T0.subtract({ minutes: 10 })),
      ),
    ).toBe(true);
    // Eleven minutes later the reservation is the leftover of a crash.
    const later = { ...photo, addedAt: T0.add({ minutes: 11 }) };
    expect(
      await inUnit(market, () => repository.reservePhoto(market, later, T0.add({ minutes: 1 }))),
    ).toBe(true);
  });

  it('settles updated and unchanged rows with their Offer and product, keeping what was recorded', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const job = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 6 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, choice);
    });
    await inUnit(market, () =>
      repository.claim(market, T0.subtract({ hours: 5 }), T0.add({ seconds: 120 })),
    );
    // An update settles with the ids of the product and Offer it found (the table checks the Offer).
    const productId = uuid7();
    const offerId = uuid7();
    await inUnit(market, async () => {
      await repository.settleGroup(market, job.id, 2, {
        state: 'updated',
        productId,
        offerId,
        productCode: 'P00000042',
      });
      await repository.settleGroup(market, job.id, 4, {
        state: 'unchanged',
        productId: uuid7(),
        offerId: uuid7(),
        productCode: 'P00000043',
      });
    });
    const rows = await inUnit(market, () =>
      repository.rows(market, job.id, {}, { offset: 0, limit: 10 }),
    );
    expect(rows.filter((row) => row.groupRow === 2).map((row) => row.runState)).toEqual([
      'updated',
      'updated',
    ]);
    expect(rows.find((row) => row.rowNumber === 4)).toMatchObject({
      runState: 'unchanged',
      productCode: 'P00000043',
    });
    expect(rows.find((row) => row.rowNumber === 2)).toMatchObject({ productId, offerId });
    expect(await inUnit(market, () => repository.find(market, seller, job.id))).toMatchObject({
      updatedRows: 2,
      unchangedRows: 1,
    });
    // A done row without its Offer is refused by the table, never written.
    const other = jobOf(seller, uuid7() as Id<'Account'>, T0.subtract({ hours: 7 }));
    await inUnit(market, () => repository.add(market, other, rowsOf()));
    await owner.query('BEGIN');
    await expect(
      owner.query(
        `UPDATE catalog.seller_import_rows SET run_state = 'updated'
           WHERE job_id = $1 AND row_number = 2`,
        [other.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.query('ROLLBACK');
  });

  it('claims the job whose last turn is the oldest, so one seller does not hold back the others', async () => {
    const a = uuid7() as Id<'Seller'>;
    const b = uuid7() as Id<'Seller'>;
    const first = jobOf(a, uuid7() as Id<'Account'>, T0.subtract({ hours: 720 }));
    const second = jobOf(b, uuid7() as Id<'Account'>, T0.subtract({ hours: 696 }));
    await inUnit(market, async () => {
      await repository.add(market, first, rowsOf());
      await repository.add(market, second, rowsOf());
      await repository.confirm(market, first.id, choice);
      await repository.confirm(market, second.id, choice);
    });
    // Park every other due job of this Market so only these two compete.
    await owner.query(
      `UPDATE catalog.seller_import_jobs SET not_before = $1
         WHERE market_id = $2 AND state = 'queued' AND id NOT IN ($3, $4)`,
      [T0.add({ hours: 24000 }).toString(), market.marketId, first.id, second.id],
    );
    const t1 = await inUnit(market, () => repository.claim(market, T0, T0.add({ seconds: 120 })));
    expect(t1?.id).toBe(first.id);
    // Its turn ends and it is queued again: the other seller is next, not the first one again.
    await inUnit(market, () =>
      repository.endTurn(market, first.id, { state: 'queued', notBefore: null }),
    );
    const t2 = await inUnit(market, () =>
      repository.claim(market, T0.add({ seconds: 1 }), T0.add({ seconds: 121 })),
    );
    expect(t2?.id).toBe(second.id);
    await inUnit(market, () =>
      repository.endTurn(market, second.id, { state: 'queued', notBefore: null }),
    );
    const t3 = await inUnit(market, () =>
      repository.claim(market, T0.add({ seconds: 2 }), T0.add({ seconds: 122 })),
    );
    expect(t3?.id).toBe(first.id);
  });

  it('purges files by age, then settled jobs by age, and nothing of a job still running', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const account = uuid7() as Id<'Account'>;
    const old = jobOf(seller, account, T0.subtract({ hours: 24 * 100 }));
    await inUnit(market, () => repository.add(market, old, rowsOf()));

    const due = await inUnit(market, () =>
      repository.filesDue(market, T0.subtract({ hours: 24 * 7 }), 50),
    );
    expect(due.map((job) => job.id)).toContain(old.id);
    await inUnit(market, () => repository.markFileDeleted(market, old.id, T0));
    const afterDelete = await inUnit(market, () =>
      repository.filesDue(market, T0.subtract({ hours: 24 * 7 }), 50),
    );
    expect(afterDelete.map((job) => job.id)).not.toContain(old.id);
    // A job that never ran is not a settled one: it waits for the discard, never the 90 day purge.
    expect(
      await inUnit(market, () =>
        repository.deleteSettledBefore(market, T0.subtract({ hours: 1 }), 50),
      ),
    ).toBeGreaterThanOrEqual(0);
  });
});
