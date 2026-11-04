import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import type { ProductImageRepository } from '../ports/product-image.repository';
import { SweepOrphanImageFiles } from './sweep-orphan-image-files.use-case';

// The file sweep in memory, on both Market fixtures: what it deletes and, above all, what it never
// touches. The query itself is covered in test/db/catalog-product-images.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const NOW = Temporal.Instant.from('2026-10-17T12:00:00Z');
const OLD = NOW.subtract({ hours: ORPHAN_IMAGE_GRACE_HOURS + 1 });
const YOUNG = NOW.subtract({ hours: ORPHAN_IMAGE_GRACE_HOURS - 1 });
const uuid = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const photoKey = (product: number, image: number, size = 'medium') =>
  `${uuid(product)}/${uuid(image)}/${size}`;

describe.each(['AU', 'ZZ'] as const)('orphan image file sweep in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  let store: MemoryObjectStore;
  let rows: Set<string>;
  let products: Set<string>;
  let asked: string[][];

  const unitOfWork = {
    run: async (_m: MarketContext, work: () => Promise<unknown>) => work(),
  } as unknown as UnitOfWork;
  const images = {
    unreferencedObjectKeys: (_m: MarketContext, keys: readonly string[]) => {
      asked.push([...keys]);
      return Promise.resolve(
        keys.filter((key) => products.has(key.split('/')[0] ?? '') && !rows.has(key)),
      );
    },
  } as unknown as ProductImageRepository;
  const sweep = () =>
    new SweepOrphanImageFiles(gate, {
      unitOfWork,
      images,
      objectStore: store,
      clock: new FixedClock(NOW),
    });
  const system = (): CallContext => testCallContext(market, 'system', 'sweep-0002');
  const put = async (key: string, at: Temporal.Instant) => {
    store.now = () => at;
    await store.put(key, Buffer.from('x'));
  };

  beforeEach(() => {
    store = new MemoryObjectStore();
    rows = new Set();
    products = new Set([uuid(1)]);
    asked = [];
  });

  it('deletes an old photo file that no row names', async () => {
    await put(photoKey(1, 10), OLD);
    const result = await sweep().execute(system(), {});
    expect(result).toEqual({ ok: true, value: { deleted: 1, kept: 0, partial: false } });
    expect(await store.get(photoKey(1, 10))).toBeNull();
  });

  it('keeps a file a row names, a young file, and a file of another Market', async () => {
    rows.add(photoKey(1, 10));
    await put(photoKey(1, 10), OLD);
    await put(photoKey(1, 11), YOUNG);
    await put(photoKey(2, 12), OLD);
    const result = await sweep().execute(system(), {});
    expect(result).toEqual({ ok: true, value: { deleted: 0, kept: 3, partial: false } });
    expect(store.objects.size).toBe(3);
    expect(asked.flat()).not.toContain(photoKey(1, 11));
  });

  it('never looks at keys that are not photo files', async () => {
    const others = [
      `certification/${uuid(1)}/${uuid(20)}`,
      `${uuid(1)}/store-images/${uuid(21)}/medium`,
      `catalog/imports/${code}/${uuid(22)}`,
      `${uuid(1)}/${uuid(23)}/huge`,
    ];
    for (const key of others) await put(key, OLD);
    const result = await sweep().execute(system(), {});
    expect(result).toEqual({ ok: true, value: { deleted: 0, kept: 0, partial: false } });
    expect(asked).toEqual([]);
    expect(store.objects.size).toBe(others.length);
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
    expect((await sweep().execute(admin, {})).ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it('answers unavailable when the object store fails', async () => {
    store.list = () => Promise.reject(new Error('down'));
    const result = await sweep().execute(system(), {});
    expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });
});
