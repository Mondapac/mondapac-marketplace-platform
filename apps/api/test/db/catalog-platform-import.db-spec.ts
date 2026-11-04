import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaPlatformImportRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-import.repository';
import type { NewImportJob } from '../../src/modules/catalog/application/ports/platform-import.repository';
import type { ImportRowRecord } from '../../src/modules/catalog/domain/platform-import/platform-import-job';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The platform import store on PostgreSQL, for both Market fixtures (catalog data design 3.28;
// migration 20261031120000_catalog_platform_import): a checked job with its rows, the confirm that
// skips error rows, one running import per admin, the claim and the lease, a row remembered the
// moment its product exists, settled rows moving the counters, the end of a turn, the file purge
// and the Market boundary. The use cases are in the unit specs.

const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('platform import store in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let owner: Client;
  let persistence: Persistence;
  let repository: PrismaPlatformImportRepository;

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    persistence = createPersistence();
    repository = new PrismaPlatformImportRepository(persistence.service);
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

  function jobOf(accountId: Id<'Account'>, createdAt = T0): NewImportJob {
    const id = uuid7() as Id<'PlatformImport'>;
    return {
      id,
      startedByAccountId: accountId,
      startedBySessionId: uuid7() as Id<'Session'>,
      format: 'csv',
      fileLabel: 'products.csv',
      fileKey: `catalog/imports/${code}/${id}`,
      fileSha256: 'ab'.repeat(32),
      fileBytes: 100,
      totalRows: 3,
      readyRows: 2,
      errorRows: 1,
      warningRows: 0,
      ignoredColumns: [{ header: 'Halal', certification: true }],
      createdAt,
      checkedAt: createdAt,
    } as unknown as NewImportJob;
  }
  const rowsOf = (): ImportRowRecord[] => [
    {
      rowNumber: 2,
      checkState: 'ready',
      issues: [
        {
          severity: 'warning',
          column: 'taxCategory',
          code: 'tax-category.default-used',
          value: 'taxable',
        },
      ],
      summary: { title: 'Lamb', category: 'Meat', typeCode: 'simple', brand: 'Farms' },
      runState: 'pending',
      runCode: null,
      productId: null,
      productCode: null,
    },
    {
      rowNumber: 3,
      checkState: 'ready',
      issues: [],
      summary: { title: 'Beef', category: 'Meat', typeCode: 'simple', brand: 'Farms' },
      runState: 'pending',
      runCode: null,
      productId: null,
      productCode: null,
    },
    {
      rowNumber: 4,
      checkState: 'error',
      issues: [
        { severity: 'error', column: 'category', code: 'category.unknown', value: 'Nowhere' },
      ],
      summary: { title: 'Pork', category: 'Nowhere', typeCode: 'simple', brand: 'Farms' },
      runState: 'skipped',
      runCode: null,
      productId: null,
      productCode: null,
    },
  ];

  it('stores a checked job with its rows and reads them back in file order', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin);
    await inUnit(market, () => repository.add(market, job, rowsOf()));

    const found = await inUnit(market, () => repository.find(market, job.id));
    expect(found).toMatchObject({
      id: job.id,
      state: 'checked',
      totalRows: 3,
      readyRows: 2,
      errorRows: 1,
      fileSha256: 'ab'.repeat(32),
      ignoredColumns: [{ header: 'Halal', certification: true }],
    });
    const rows = await inUnit(market, () =>
      repository.rows(market, job.id, {}, { offset: 0, limit: 10 }),
    );
    expect(rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    expect(rows[0]!.issues[0]).toMatchObject({ code: 'tax-category.default-used' });
    const errors = await inUnit(market, () =>
      repository.rows(market, job.id, { checkState: 'error' }, { offset: 0, limit: 10 }),
    );
    expect(errors.map((row) => row.rowNumber)).toEqual([4]);
  });

  it('keeps a job inside its Market', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin);
    await inUnit(market, () => repository.add(market, job, rowsOf()));

    expect(await inUnit(other, () => repository.find(other, job.id))).toBeNull();
    expect(await inUnit(other, () => repository.latestOf(other, admin))).toBeNull();
  });

  it('confirms once, marks error rows skipped, and lets one import run per admin', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin);
    const second = jobOf(admin);
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.add(market, second, rowsOf());
    });
    const choice = { startAs: 'inactive' as const, skipErrors: true, toImport: 2, now: T0 };

    expect(await inUnit(market, () => repository.confirm(market, job.id, choice))).toBe(true);
    expect(await inUnit(market, () => repository.confirm(market, job.id, choice))).toBe(false);
    expect(await inUnit(market, () => repository.hasActive(market, admin))).toBe(true);
    // The second import of the same admin cannot be queued while the first is.
    await expect(
      inUnit(market, () => repository.confirm(market, second.id, choice)),
    ).rejects.toBeDefined();

    const queued = await inUnit(market, () => repository.find(market, job.id));
    expect(queued).toMatchObject({
      state: 'queued',
      startAs: 'inactive',
      skipErrors: true,
      toImport: 2,
    });
  });

  it('claims a due job once, remembers a product, settles rows and ends the turn', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin, T0.subtract({ hours: 1 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, {
        startAs: 'active',
        skipErrors: true,
        toImport: 2,
        now: T0,
      });
    });

    const claimed = await inUnit(market, () =>
      repository.claim(market, T0, T0.add({ seconds: 120 })),
    );
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe('running');
    // Held by a lease: nobody else takes it (another admin's due job, if any, is not this one).
    const again = await inUnit(market, () =>
      repository.claim(market, T0, T0.add({ seconds: 120 })),
    );
    expect(again?.id).not.toBe(job.id);

    const pending = await inUnit(market, () => repository.pendingRows(market, job.id, 10));
    expect(pending.map((row) => row.rowNumber)).toEqual([2, 3]);

    const productId = uuid7();
    await inUnit(market, () =>
      repository.recordProduct(market, job.id, 2, { productId, productCode: 'P00000001' }),
    );
    await inUnit(market, async () => {
      await repository.settleRow(market, job.id, 2, {
        state: 'added',
        productId,
        productCode: 'P00000001',
      });
      await repository.settleRow(market, job.id, 3, { state: 'failed', code: 'claim-text.found' });
    });

    const version = await inUnit(market, () =>
      repository.endTurn(market, job.id, { state: 'finished', now: T0.add({ minutes: 1 }) }),
    );
    expect(version).not.toBeNull();
    const done = await inUnit(market, () => repository.find(market, job.id));
    expect(done).toMatchObject({ state: 'finished', addedRows: 1, failedRows: 1 });
    expect(await inUnit(market, () => repository.pendingRows(market, job.id, 10))).toEqual([]);
    // A finished job cannot end a turn again.
    expect(
      await inUnit(market, () =>
        repository.endTurn(market, job.id, { state: 'stopped', reason: 'unexpected' }),
      ),
    ).toBeNull();
  });

  it('stops with a reason and resumes the rest', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin, T0.subtract({ hours: 1 }));
    await inUnit(market, async () => {
      await repository.add(market, job, rowsOf());
      await repository.confirm(market, job.id, {
        startAs: 'inactive',
        skipErrors: true,
        toImport: 2,
        now: T0,
      });
    });
    await inUnit(market, () => repository.claim(market, T0, T0.add({ seconds: 120 })));
    await inUnit(market, () =>
      repository.endTurn(market, job.id, { state: 'stopped', reason: 'access-lost' }),
    );

    expect(await inUnit(market, () => repository.find(market, job.id))).toMatchObject({
      state: 'stopped',
      stopReason: 'access-lost',
    });
    expect(await inUnit(market, () => repository.resume(market, job.id))).toBe(true);
    expect(await inUnit(market, () => repository.resume(market, job.id))).toBe(false);
  });

  it('purges files by age, deletes a discarded check as soon as its file is gone, settled jobs by age', async () => {
    const admin = uuid7() as Id<'Account'>;
    const old = jobOf(admin, T0.subtract({ hours: 24 * 100 }));
    await inUnit(market, () => repository.add(market, old, rowsOf()));

    const due = await inUnit(market, () =>
      repository.filesDue(market, T0.subtract({ hours: 24 * 7 }), 100),
    );
    expect(due.map((entry) => entry.id)).toContain(old.id);
    // An unconfirmed check whose file is gone cannot be imported: it is discarded, and then deleted
    // at once, with its rows, whatever its age (Mojtaba B2).
    await inUnit(market, () => repository.markFileDeleted(market, old.id, T0));
    const after = await inUnit(market, () =>
      repository.filesDue(market, T0.subtract({ hours: 24 * 7 }), 100),
    );
    expect(after.map((entry) => entry.id)).not.toContain(old.id);
    expect(await inUnit(market, () => repository.find(market, old.id))).toMatchObject({
      state: 'discarded',
    });
    await inUnit(market, () => repository.deleteDiscarded(market, { limit: 100 }));
    expect(await inUnit(market, () => repository.find(market, old.id))).toBeNull();
    expect(await inUnit(market, () => repository.pendingRows(market, old.id, 10))).toEqual([]);

    // A fresh discard: its file is due at once, and the job stays until the file is gone.
    const fresh = jobOf(admin);
    await inUnit(market, () => repository.add(market, fresh, rowsOf()));
    const dropped = await inUnit(market, () => repository.discard(market, fresh.id, T0));
    expect(dropped).toEqual({ fileKey: fresh.fileKey });
    expect(await inUnit(market, () => repository.discard(market, fresh.id, T0))).toBeNull();
    const dueNow = await inUnit(market, () =>
      repository.filesDue(market, T0.subtract({ hours: 24 * 7 }), 100),
    );
    expect(dueNow.map((entry) => entry.id)).toContain(fresh.id);
    expect(
      await inUnit(market, () => repository.deleteDiscarded(market, { ids: [fresh.id] })),
    ).toBe(0);
    expect(await inUnit(market, () => repository.find(market, fresh.id))).not.toBeNull();
    await inUnit(market, () => repository.markFileDeleted(market, fresh.id, T0));
    expect(
      await inUnit(market, () => repository.deleteDiscarded(market, { ids: [fresh.id] })),
    ).toBe(1);
    expect(await inUnit(market, () => repository.find(market, fresh.id))).toBeNull();
    // The rows went with the job (cascade).
    const left = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM catalog.platform_import_rows WHERE job_id = $1',
      [fresh.id],
    );
    expect(left.rows[0]?.n).toBe(0);

    // A finished import is kept for 90 days, a discarded one is not part of that rule.
    const finished = jobOf(admin, T0.subtract({ hours: 24 * 100 }));
    await inUnit(market, async () => {
      await repository.add(market, finished, rowsOf());
      await repository.confirm(market, finished.id, {
        startAs: 'inactive',
        skipErrors: true,
        toImport: 2,
        now: T0.subtract({ hours: 24 * 100 }),
      });
    });
    const claimed = await inUnit(market, () =>
      repository.claim(market, T0, T0.add({ seconds: 120 })),
    );
    expect(claimed?.id).toBe(finished.id);
    await inUnit(market, () =>
      repository.endTurn(market, finished.id, { state: 'finished', now: T0 }),
    );
    // Its file is still stored: kept. Once gone, the 90 days apply.
    expect(
      await inUnit(market, () =>
        repository.deleteSettledBefore(market, T0.subtract({ hours: 24 * 90 }), 5),
      ),
    ).toBe(0);
    await inUnit(market, () => repository.markFileDeleted(market, finished.id, T0));
    expect(
      await inUnit(market, () =>
        repository.deleteSettledBefore(market, T0.subtract({ hours: 24 * 90 }), 5),
      ),
    ).toBe(1);
    expect(await inUnit(market, () => repository.find(market, finished.id))).toBeNull();
  });

  it('refuses a lease on a job that is not running and a delayed start on a job that is not queued', async () => {
    const admin = uuid7() as Id<'Account'>;
    const job = jobOf(admin);
    await inUnit(market, () => repository.add(market, job, rowsOf()));
    await expect(
      owner.query(
        "UPDATE catalog.platform_import_jobs SET lease_until = now() WHERE id = $1 AND state = 'checked'",
        [job.id],
      ),
    ).rejects.toThrow(/platform_import_jobs_lease_check/);
    await expect(
      owner.query(
        "UPDATE catalog.platform_import_jobs SET not_before = now() WHERE id = $1 AND state = 'checked'",
        [job.id],
      ),
    ).rejects.toThrow(/platform_import_jobs_not_before_check/);
    await expect(
      owner.query(
        "UPDATE catalog.platform_import_jobs SET state = 'running' WHERE id = $1 AND state = 'checked'",
        [job.id],
      ),
    ).rejects.toThrow(/platform_import_jobs_(lease|confirmed)_check/);
  });
});
