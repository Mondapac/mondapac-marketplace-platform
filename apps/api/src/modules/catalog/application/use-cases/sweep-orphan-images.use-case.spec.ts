import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MemoryObjectStore } from '../../../../platform/storage/disk-object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ORPHAN_IMAGE_GRACE_HOURS } from '../images/image-limits';
import type { ProductImageRepository, UnattachedImage } from '../ports/product-image.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { SweepOrphanImages } from './sweep-orphan-images.use-case';

// The orphan sweep in memory, on both Market fixtures. The database behaviour (the foreign key, the
// grants) is in test/db/catalog-product-images.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const NOW = Temporal.Instant.from('2026-10-17T12:00:00Z');
const uuid = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('orphan image sweep in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const PRODUCT = uuid(1) as Id<'Product'>;
  const store = new MemoryObjectStore();
  let candidates: UnattachedImage[];
  let attached: Set<string>;
  let drafted: string[];
  let queries: { createdBefore: Temporal.Instant; afterId: string | null; limit: number }[];
  let deleted: string[];
  let unitsRun: number;

  const unitOfWork: UnitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      unitsRun += 1;
      return work();
    },
  } as UnitOfWork;
  const images = {
    listUnattached: (_m: MarketContext, query: (typeof queries)[number]) => {
      queries.push(query);
      return Promise.resolve(
        candidates
          .filter((c) => query.afterId === null || c.id > query.afterId)
          .slice(0, query.limit),
      );
    },
    deleteUnused: (_m: MarketContext, _p: unknown, imageId: string) => {
      if (attached.has(imageId)) return Promise.resolve(false);
      const index = candidates.findIndex((c) => c.id === imageId);
      if (index < 0) return Promise.resolve(false);
      candidates.splice(index, 1);
      deleted.push(imageId);
      return Promise.resolve(true);
    },
  } as unknown as ProductImageRepository;
  const workingCopies = {
    find: () => Promise.resolve({ content: { imageIds: drafted } }),
  } as unknown as WorkingCopyRepository;

  const sweep = new SweepOrphanImages(gate, {
    unitOfWork,
    images,
    workingCopies,
    objectStore: store,
    clock,
  });
  const system = (): CallContext => testCallContext(market, 'system', 'sweep-0001');
  const orphan = (n: number): UnattachedImage => ({
    id: uuid(0x100 + n) as Id<'ProductImage'>,
    productId: PRODUCT,
    objectKeys: ['thumb', 'medium', 'large'].map((size) => `${PRODUCT}/${uuid(0x100 + n)}/${size}`),
  });

  beforeEach(async () => {
    candidates = [orphan(1), orphan(2), orphan(3)];
    attached = new Set();
    drafted = [];
    queries = [];
    deleted = [];
    unitsRun = 0;
    store.objects.clear();
    for (const c of candidates)
      for (const key of c.objectKeys) await store.put(key, Buffer.from('x'));
  });

  it('deletes the rows and then the files of photos nobody holds, with the grace cut-off', async () => {
    const result = await sweep.execute(system(), {});
    expect(result).toEqual(ok({ deleted: 3, kept: 0 }));
    expect(store.objects.size).toBe(0);
    expect(queries[0]!.createdBefore.toString()).toBe(
      NOW.subtract({ hours: ORPHAN_IMAGE_GRACE_HOURS }).toString(),
    );
  });

  it('keeps a photo that the working copy names, and one a revision took meanwhile', async () => {
    const [first, second, third] = candidates;
    drafted = [first!.id];
    attached.add(second!.id);
    const result = await sweep.execute(system(), {});
    expect(result).toEqual(ok({ deleted: 1, kept: 2 }));
    expect(deleted).toEqual([third!.id]);
    expect([...store.objects.keys()].filter((key) => key.includes(first!.id))).toHaveLength(3);
    expect([...store.objects.keys()].filter((key) => key.includes(second!.id))).toHaveLength(3);
    expect([...store.objects.keys()].some((key) => key.includes(third!.id))).toBe(false);
  });

  it('is safe to run again: the second run finds nothing', async () => {
    await sweep.execute(system(), {});
    expect(await sweep.execute(system(), {})).toEqual(ok({ deleted: 0, kept: 0 }));
  });

  it('survives a failing file delete and still counts the row as deleted', async () => {
    const failing = {
      ...store,
      delete: () => Promise.reject(new Error('disk')),
    } as unknown as MemoryObjectStore;
    const broken = new SweepOrphanImages(gate, {
      unitOfWork,
      images,
      workingCopies,
      objectStore: failing,
      clock,
    });
    expect(await broken.execute(system(), {})).toEqual(ok({ deleted: 3, kept: 0 }));
  });

  it('refuses every actor but the system', async () => {
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: uuid(9) as Id<'Account'>,
        sessionId: uuid(10) as Id<'Session'>,
        sellerId: null,
      }),
    );
    const result = await sweep.execute(admin, {});
    expect(result.ok).toBe(false);
    expect(unitsRun).toBe(0);
  });
});
