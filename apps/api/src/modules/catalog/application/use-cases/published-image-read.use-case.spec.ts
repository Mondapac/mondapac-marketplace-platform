import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MemoryObjectStore } from '../../../../platform/storage/disk-object-store';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { PublishedImagesReader } from '../ports/published-images.reader';
import { PublishedImageRead } from './published-image-read.use-case';

// `catalog.published-image-read` on both Market fixtures: one read-only unit asks the reader for
// the stored key, which the use case never builds from the request, and every case that is not a
// public photo answers the same not-found. What counts as public is the reader's (test/db).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const PRODUCT = '01990000-0000-7000-8000-000000000001' as Id<'Product'>;
const IMAGE = '01990000-0000-7000-8000-000000000701' as Id<'ProductImage'>;
const KEY = `${PRODUCT}/${IMAGE}/thumb`;
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe.each(TEST_MARKETS)('catalog.published-image-read in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const asked: { market: string; productId: string; imageId: string; size: string }[] = [];
  let key: string | null = KEY;
  let store: MemoryObjectStore;
  let throwing = false;
  const unitOfWork = {
    run: <T, E>(
      unitMarket: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push({ market: unitMarket.marketId, options });
      if (throwing) return Promise.resolve({ ok: false, error: { code: 'unit.failed' } });
      return work();
    },
  } as unknown as UnitOfWork;
  const reader: PublishedImagesReader = {
    imagesOf: () => Promise.resolve(new Map()),
    renditionKey: (readMarket, productId, imageId, size) => {
      asked.push({ market: readMarket.marketId, productId, imageId, size });
      return Promise.resolve(key);
    },
  };
  const anonymous = testCallContext(market, 'anonymous');
  const run = (input: { productId: string; imageId: string; size: string }, context = anonymous) =>
    new PublishedImageRead(gate, {
      unitOfWork,
      publishedImagesReader: reader,
      objectStore: store,
    }).execute(context, input);

  beforeEach(async () => {
    units.length = 0;
    asked.length = 0;
    key = KEY;
    throwing = false;
    store = new MemoryObjectStore();
    await store.put(KEY, BYTES);
  });

  it('declares the anonymous rule under its own name', () => {
    expect(PublishedImageRead.access).toEqual({
      name: 'catalog.published-image-read',
      rule: { kind: 'anonymous' },
    });
  });

  it('serves the stored bytes as image/jpeg, from the key the reader returned, in one read-only unit', async () => {
    const result = await run({ productId: PRODUCT, imageId: IMAGE, size: 'thumb' });

    expect(result).toEqual(ok({ bytes: BYTES, contentType: 'image/jpeg' }));
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(asked).toEqual([{ market: code, productId: PRODUCT, imageId: IMAGE, size: 'thumb' }]);
  });

  it.each([
    ['a malformed product id', { productId: 'x', imageId: IMAGE, size: 'thumb' }],
    ['a malformed image id', { productId: PRODUCT, imageId: '../../etc', size: 'thumb' }],
    ['an unknown size', { productId: PRODUCT, imageId: IMAGE, size: 'huge' }],
    ['an original-size request', { productId: PRODUCT, imageId: IMAGE, size: 'original' }],
    ['a non-string size', { productId: PRODUCT, imageId: IMAGE, size: 7 as unknown as string }],
  ])('answers image.not-found for %s without reading anything', async (_name, input) => {
    expect(await run(input)).toEqual({ ok: false, error: { code: 'image.not-found' } });
    expect(units).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('answers image.not-found when the reader says the photo is not public', async () => {
    key = null;

    expect(await run({ productId: PRODUCT, imageId: IMAGE, size: 'thumb' })).toEqual({
      ok: false,
      error: { code: 'image.not-found' },
    });
  });

  it('answers image.not-found when the object is missing from the store', async () => {
    key = `${PRODUCT}/${IMAGE}/medium`;

    expect(await run({ productId: PRODUCT, imageId: IMAGE, size: 'medium' })).toEqual({
      ok: false,
      error: { code: 'image.not-found' },
    });
  });

  it('answers image.unavailable when the unit or the store fails, never a partial answer', async () => {
    throwing = true;
    expect(await run({ productId: PRODUCT, imageId: IMAGE, size: 'thumb' })).toEqual({
      ok: false,
      error: { code: 'image.unavailable' },
    });
    throwing = false;
    store.get = () => Promise.reject(new Error('disk'));
    expect(await run({ productId: PRODUCT, imageId: IMAGE, size: 'thumb' })).toEqual({
      ok: false,
      error: { code: 'image.unavailable' },
    });
  });

  it('is not for the system actor (rule anonymous)', async () => {
    const system = testCallContext(market, 'system', 'image-system-abcd');

    const result = await run({ productId: PRODUCT, imageId: IMAGE, size: 'thumb' }, system);

    expect(result.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});
