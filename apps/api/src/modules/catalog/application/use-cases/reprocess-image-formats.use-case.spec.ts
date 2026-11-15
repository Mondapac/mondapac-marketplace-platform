import { createHash } from 'node:crypto';
import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import sharp from 'sharp';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MemoryObjectStore } from '../../../../platform/storage/disk-object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  ImageMissingFormats,
  ProductImageRepository,
  StoredRendition,
} from '../ports/product-image.repository';
import { ReprocessImageFormats } from './reprocess-image-formats.use-case';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const uuid = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PRODUCT = uuid(1) as Id<'Product'>;

describe.each(['AU', 'ZZ'] as const)('reprocess of image formats in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  let store: MemoryObjectStore;
  let candidates: ImageMissingFormats[];
  let added: { imageId: string; renditions: readonly StoredRendition[] }[];
  let failRows: boolean;
  let takenDown: boolean;

  const unitOfWork = {
    run: async <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: { readOnly?: boolean },
    ) => {
      if (failRows && options?.readOnly !== true) throw new Error('db down');
      return work();
    },
  } as unknown as UnitOfWork;
  const images = {
    listMissingFormats: (_m: MarketContext, q: { afterId: string | null; limit: number }) =>
      Promise.resolve(
        candidates.filter((c) => q.afterId === null || c.id > q.afterId).slice(0, q.limit),
      ),
    addRenditions: (
      _m: MarketContext,
      _p: unknown,
      imageId: string,
      renditions: StoredRendition[],
    ) => {
      added.push({ imageId, renditions });
      return Promise.resolve(!takenDown);
    },
  } as unknown as ProductImageRepository;
  const run = (context = testCallContext(market, 'system')) =>
    new ReprocessImageFormats(gate, { unitOfWork, images, objectStore: store }).execute(
      context,
      {},
    );

  async function photo(n: number, put = true): Promise<ImageMissingFormats> {
    const id = uuid(100 + n) as Id<'ProductImage'>;
    const objectKey = `${PRODUCT}/${id}/medium`;
    if (put) {
      await store.put(
        objectKey,
        await sharp({ create: { width: 300, height: 200, channels: 3, background: '#2a7' } })
          .jpeg()
          .toBuffer(),
      );
    }
    return {
      id,
      productId: PRODUCT,
      jpegs: [{ size: 'medium', objectKey }],
      missing: [
        { size: 'medium', format: 'webp' },
        { size: 'medium', format: 'avif' },
      ],
    };
  }

  beforeEach(() => {
    store = new MemoryObjectStore();
    candidates = [];
    added = [];
    failRows = false;
    takenDown = false;
  });

  it('declares the system rule under its own name and refuses any other actor', async () => {
    expect(ReprocessImageFormats.access).toEqual({
      name: 'catalog.reprocess-image-formats',
      rule: { kind: 'system' },
    });
    const actor = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: uuid(9) as Id<'Account'>,
        sessionId: uuid(10) as Id<'Session'>,
        sellerId: null,
      }),
    );
    expect(await run(actor)).toEqual({ ok: false, error: { code: 'access.denied' } });
  });

  it('writes the missing WebP and AVIF files at the stored size, and a row for each', async () => {
    candidates = [await photo(1), await photo(2)];

    expect(await run()).toEqual(ok({ scanned: 2, completed: 2, failed: 0 }));

    expect(added).toHaveLength(2);
    const [first] = added;
    expect(first!.renditions.map((r) => [r.size, r.format, r.width, r.height])).toEqual([
      ['medium', 'webp', 300, 200],
      ['medium', 'avif', 300, 200],
    ]);
    for (const rendition of first!.renditions) {
      expect(rendition.objectKey).toBe(`${PRODUCT}/${first!.imageId}/medium-${rendition.format}`);
      const bytes = (await store.get(rendition.objectKey))!;
      expect(rendition.byteSize).toBe(bytes.length);
      expect(rendition.sha256.equals(createHash('sha256').update(bytes).digest())).toBe(true);
    }
  });

  it('leaves a photo whose JPEG file is gone for a second run and goes on with the rest', async () => {
    candidates = [await photo(1, false), await photo(2)];

    expect(await run()).toEqual(ok({ scanned: 2, completed: 1, failed: 1 }));
    expect(added.map((a) => a.imageId)).toEqual([candidates[1]!.id]);
  });

  it('removes the files it wrote when the rows cannot be saved', async () => {
    candidates = [await photo(1)];
    failRows = true;

    expect(await run()).toEqual(ok({ scanned: 1, completed: 0, failed: 1 }));
    expect((await store.list('', { after: null, limit: 10 })).objects.map((o) => o.key)).toEqual([
      candidates[0]!.jpegs[0]!.objectKey,
    ]);
  });

  it('replaces a file an earlier run left without its row, and counts it as done', async () => {
    candidates = [await photo(1)];
    await store.put(`${PRODUCT}/${candidates[0]!.id}/medium-webp`, Buffer.from('half'));

    expect(await run()).toEqual(ok({ scanned: 1, completed: 1, failed: 0 }));
    const webp = added[0]!.renditions.find((r) => r.format === 'webp')!;
    expect(webp.byteSize).toBe((await store.get(webp.objectKey))!.length);
    expect(webp.byteSize).toBeGreaterThan(4);
  });

  it('removes its files and counts a failure when the photo was taken down meanwhile', async () => {
    candidates = [await photo(1)];
    takenDown = true;

    expect(await run()).toEqual(ok({ scanned: 1, completed: 0, failed: 1 }));
    expect((await store.list('', { after: null, limit: 10 })).objects).toHaveLength(1);
  });

  it('does nothing when no photo lacks a format', async () => {
    expect(await run()).toEqual(ok({ scanned: 0, completed: 0, failed: 0 }));
  });
});
