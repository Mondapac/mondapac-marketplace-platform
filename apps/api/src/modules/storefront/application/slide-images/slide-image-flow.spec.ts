import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../../test/support/pricing-fakes';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import { MemoryObjectStore } from '../../../../platform/storage/disk-object-store';
import type { SlideImageProcessor } from '../ports/slide-image-processor';
import type { StorefrontDependencies } from '../storefront-dependencies';
import { MemorySlideImageStore } from './memory-slide-image-store';
import { readSlideImage, uploadSlideImage } from './slide-image-flow';

// The slide image library flow (F9) on both Market fixtures, with a fake picture processor.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe.each([
  ['AU', 'ZZ'],
  ['ZZ', 'AU'],
] as const)('slide images in market %s (other market %s)', (code, otherCode) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(otherCode, 'default');
  const clock = new FixedClock(T0);
  const account = (() => {
    const parsed = parseId(`01990000-0000-7000-8000-0000000000ed`);
    if (!parsed.ok) throw new Error('bad id');
    return parsed.value as Id<'Account'>;
  })();
  const contextIn = (target: MarketContext, population: 'admin' | 'seller' = 'admin') =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId: account,
        sessionId: account as unknown as Id<'Session'>,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-000000000051' as Id<'Seller'>) : null,
      }),
      `img-${target.marketId.toLowerCase()}-abcdef`,
    );

  let store: MemorySlideImageStore;
  let objects: MemoryObjectStore;
  let audit: string[];
  let refusal: 'file.too-small' | 'file.busy' | null;
  let deps: StorefrontDependencies;

  const processor: SlideImageProcessor = {
    process: (form, bytes) => {
      if (refusal !== null) return Promise.resolve(err({ code: refusal }));
      const sizes =
        form === 'desktop'
          ? (['desktop', 'desktop-small'] as const)
          : (['mobile', 'mobile-small'] as const);
      return Promise.resolve(
        ok(
          sizes.map((size, index) => ({
            size,
            bytes: Buffer.from(`${size}:${bytes.toString()}`),
            width: 1920 / (index + 1),
            height: 720 / (index + 1),
          })),
        ),
      );
    },
  };

  beforeEach(() => {
    store = new MemorySlideImageStore();
    objects = new MemoryObjectStore();
    audit = [];
    refusal = null;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      pages: undefined as never,
      slides: undefined as never,
      targets: undefined as never,
      links: undefined as never,
      slideImages: store,
      imageProcessor: processor,
      objectStore: objects,
      audit: {
        record: (_c: CallContext, entry: { action: string }) => {
          audit.push(entry.action);
          return Promise.resolve();
        },
      },
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  const upload = (input: unknown, context = contextIn(market)) =>
    uploadSlideImage(deps, context, input);

  it('stores every size, the row and one audit entry', async () => {
    const result = await upload({ desktop: b64('wide'), mobile: b64('tall') });
    if (!result.ok) throw new Error('refused');
    expect(result.value).toMatchObject({ hasMobile: true, width: 1920, height: 720 });
    expect([...objects.objects.keys()].sort()).toEqual(
      ['desktop', 'desktop-small', 'mobile', 'mobile-small']
        .map((size) => `slide-images/${result.value.imageId}/${size}`)
        .sort(),
    );
    expect(store.images.size).toBe(1);
    expect(audit).toEqual(['storefront.slide-image.upload']);
  });

  it('works with a desktop picture alone', async () => {
    const result = await upload({ desktop: b64('wide') });
    if (!result.ok) throw new Error('refused');
    expect(result.value.hasMobile).toBe(false);
    expect(objects.objects.size).toBe(2);
  });

  it('refuses a caller who is not an admin', async () => {
    expect(await upload({ desktop: b64('wide') }, contextIn(market, 'seller'))).toEqual(
      err({ code: 'access.denied' }),
    );
    expect(objects.objects.size).toBe(0);
  });

  it('refuses bad bodies without writing anything', async () => {
    for (const input of [
      null,
      [],
      {},
      { desktop: 5 },
      { desktop: '***' },
      { desktop: b64('a'), x: 1 },
    ]) {
      const result = await upload(input);
      expect(result.ok ? 'allowed' : result.error.code).toBe('validation.failed');
    }
    expect(objects.objects.size).toBe(0);
    expect(store.images.size).toBe(0);
  });

  it('passes the picture refusals through and maps a busy pipeline to unavailable with a wait', async () => {
    refusal = 'file.too-small';
    expect(await upload({ desktop: b64('wide') })).toEqual(err({ code: 'file.too-small' }));
    refusal = 'file.busy';
    expect(await upload({ desktop: b64('wide') })).toEqual(
      err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS }),
    );
    expect(objects.objects.size).toBe(0);
  });

  it('removes the files when the row cannot be saved', async () => {
    store.insert = () => Promise.reject(new Error('db down'));
    expect(await upload({ desktop: b64('wide') })).toEqual(err({ code: 'access.unavailable' }));
    expect(objects.objects.size).toBe(0);
  });

  it('reads a rendition in this Market only, and anonymously', async () => {
    const result = await upload({ desktop: b64('wide') });
    if (!result.ok) throw new Error('refused');
    const imageId = result.value.imageId;
    const read = await readSlideImage(deps, testCallContext(market, 'anonymous'), {
      imageId,
      size: 'desktop',
    });
    expect(read).toEqual(ok({ bytes: Buffer.from('desktop:wide'), contentType: 'image/jpeg' }));
    const foreign = await readSlideImage(deps, testCallContext(other, 'anonymous'), {
      imageId,
      size: 'desktop',
    });
    expect(foreign).toEqual(err({ code: 'storefront.slide-image-not-found' }));
  });

  it('answers not found for a bad id, a bad size or a size that was not made', async () => {
    const result = await upload({ desktop: b64('wide') });
    if (!result.ok) throw new Error('refused');
    const anonymous = testCallContext(market, 'anonymous');
    const notFound = err({ code: 'storefront.slide-image-not-found' });
    expect(await readSlideImage(deps, anonymous, { imageId: 'x', size: 'desktop' })).toEqual(
      notFound,
    );
    expect(
      await readSlideImage(deps, anonymous, { imageId: result.value.imageId, size: 'huge' }),
    ).toEqual(notFound);
    expect(
      await readSlideImage(deps, anonymous, { imageId: result.value.imageId, size: 'mobile' }),
    ).toEqual(notFound);
  });

  it('refuses bytes that no longer match their hash', async () => {
    const result = await upload({ desktop: b64('wide') });
    if (!result.ok) throw new Error('refused');
    const key = `slide-images/${result.value.imageId}/desktop`;
    objects.objects.set(key, Buffer.from('tampered'));
    const read = await readSlideImage(deps, testCallContext(market, 'anonymous'), {
      imageId: result.value.imageId,
      size: 'desktop',
    });
    expect(read).toEqual(err({ code: 'access.unavailable' }));
  });
});
