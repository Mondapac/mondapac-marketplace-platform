import { Temporal } from '@mondapac/shared-kernel';
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
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerImportJob } from '../../domain/seller-import/seller-import-job';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import { photoWindowOpen } from '../seller-import/seller-import-support';
import { OwnImportAddPhoto, photoNameKey } from './own-import-add-photo.use-case';

// `own-import.add-photo` in memory, on both Market fixtures (catalog design 14c, "The photo step"):
// the product comes from the job's row record, a name is matched without case, the name is reserved
// before the upload and released when it fails, the photo counters (60 a minute, 2,000 a day)
// bound the step, the window closes seven days after the job ended (a stopped one included), and
// the interactive save budget is never spent.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-20T00:00:00Z');
const DAY = 86_400_000;
const uuid = (n: number): string => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const JOB = uuid(0xc1);
const SELLER = uuid(0xb1) as Id<'Seller'>;
const ACCOUNT = uuid(0xa1) as Id<'Account'>;
const PRODUCT = uuid(0xd1);
const IMAGE = uuid(0xe1);

describe('photoNameKey', () => {
  it('cleans a name the way the file label is cleaned, and lowers it', () => {
    expect(photoNameKey('Lamb.JPG')).toBe('lamb.jpg');
    expect(photoNameKey('C:\\photos\\Lamb Chop.JPG')).toBe('lamb chop.jpg');
    expect(photoNameKey('  lamb.jpg ')).toBe('lamb.jpg');
  });
  it('refuses what is not a name', () => {
    expect(photoNameKey(undefined)).toBeNull();
    expect(photoNameKey('   ')).toBeNull();
    expect(photoNameKey(42)).toBeNull();
  });
});

describe('photoWindowOpen', () => {
  const job = (over: Partial<SellerImportJob>) =>
    ({
      mode: 'my-products',
      state: 'finished',
      finishedAt: T0.subtract({ milliseconds: 6 * DAY }),
      endedAt: null,
      fileDeletedAt: null,
      ...over,
    }) as SellerImportJob;

  it('is open for seven days after a finish and closed after', () => {
    expect(photoWindowOpen(job({}), T0)).toBe(true);
    expect(photoWindowOpen(job({ finishedAt: T0.subtract({ milliseconds: 8 * DAY }) }), T0)).toBe(
      false,
    );
  });
  it('counts a stopped job from the time it stopped, not forever', () => {
    const stopped = (days: number) =>
      job({
        state: 'stopped',
        finishedAt: null,
        endedAt: T0.subtract({ milliseconds: days * DAY }),
      });
    expect(photoWindowOpen(stopped(3), T0)).toBe(true);
    expect(photoWindowOpen(stopped(8), T0)).toBe(false);
    // A stopped job without the time (not possible in the table) fails closed.
    expect(photoWindowOpen(job({ state: 'stopped', finishedAt: null, endedAt: null }), T0)).toBe(
      false,
    );
  });
  it('is closed for a running job, a checked one and the sell-from-catalogue mode', () => {
    expect(photoWindowOpen(job({ state: 'running' }), T0)).toBe(false);
    expect(photoWindowOpen(job({ state: 'checked' }), T0)).toBe(false);
    expect(photoWindowOpen(job({ mode: 'sell-from-catalogue' }), T0)).toBe(false);
  });
});

describe.each(['AU', 'ZZ'] as const)('own-import.add-photo in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const contextOf = (
    account: Id<'Account'> = ACCOUNT,
    seller: Id<'Seller'> = SELLER,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: account,
        sessionId: uuid(0xa2) as Id<'Session'>,
        sellerId: seller,
      }),
    );

  interface Options {
    readonly job?: Partial<SellerImportJob> | null;
    readonly target?: string | null;
    readonly added?: readonly string[];
    readonly reserveRefused?: boolean;
    readonly uploadFails?: boolean;
    readonly saveFails?: boolean;
    readonly eligible?: boolean;
    readonly count?: number;
  }

  function rig(options: Options = {}) {
    const clock = new FixedClock(T0);
    const job =
      options.job === null
        ? null
        : ({
            id: JOB,
            sellerId: SELLER,
            startedByAccountId: ACCOUNT,
            mode: 'my-products',
            state: 'finished',
            finishedAt: T0.subtract({ milliseconds: DAY }),
            endedAt: null,
            ...options.job,
          } as unknown as SellerImportJob);
    const log: string[] = [];
    const looked: string[] = [];
    const reserved: string[] = [];
    const sellerJobs = {
      find: (_m: unknown, sellerId: Id<'Seller'>) =>
        Promise.resolve(sellerId === SELLER ? job : null),
      photoTarget: (_m: unknown, _id: unknown, key: string) => {
        looked.push(key);
        return Promise.resolve(options.target === undefined ? PRODUCT : options.target);
      },
      photoNames: () => Promise.resolve(new Set(options.added ?? [])),
      reservePhoto: (_m: unknown, photo: { nameKey: string; productId: string }) => {
        log.push(`reserve:${photo.nameKey}:${photo.productId}`);
        return Promise.resolve(options.reserveRefused !== true);
      },
      setPhotoImage: (_m: unknown, _id: unknown, key: string, imageId: string) => {
        log.push(`set:${key}:${imageId}`);
        return Promise.resolve(true);
      },
      releasePhoto: (_m: unknown, _id: unknown, key: string) => {
        log.push(`release:${key}`);
        return Promise.resolve();
      },
    } as unknown as SellerImportRepository;
    const saves: unknown[] = [];
    const useCase = new OwnImportAddPhoto(gate, {
      unitOfWork: {
        run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork,
      sellerJobs,
      products: {
        findById: () =>
          Promise.resolve({
            state: { ownerSellerId: SELLER, publishedRevisionId: null },
            liveVariants: [{ id: uuid(0xf1) }],
          }),
      } as never,
      workingCopies: {
        find: () => Promise.resolve({ content: { imageIds: ['img-0'] } }),
      } as never,
      revisions: { find: () => Promise.resolve(null) } as never,
      saveDraft: {
        execute: (_c: unknown, input: unknown, opts: unknown) => {
          saves.push({ input, opts });
          return Promise.resolve(
            options.saveFails === true
              ? { ok: false as const, error: { code: 'access.unavailable' as const } }
              : { ok: true as const, value: { variantIds: [], refusedFields: [] } },
          );
        },
      } as never,
      ownImageUpload: {
        execute: (_c: unknown, input: { productId: string }) => {
          log.push(`upload:${input.productId}`);
          return Promise.resolve(
            options.uploadFails === true
              ? { ok: false as const, error: { code: 'image.type-unsupported' as const } }
              : { ok: true as const, value: { imageId: IMAGE } },
          );
        },
      } as never,
      eligibility: { isEligible: () => Promise.resolve(options.eligible !== false) },
      counters: {
        reserve: (_m: MarketContext, list: readonly { limit: { kind: string } }[]) => {
          reserved.push(...list.map((counter) => counter.limit.kind));
          return Promise.resolve(
            list.map((counter) => ({
              kind: counter.limit.kind,
              count: options.count ?? 1,
              windowStartedAt: T0,
            })),
          );
        },
        purgeStartedBefore: () => Promise.resolve(0),
      } as never,
      counterKeys: { keyOf: () => new Uint8Array(32) },
      clock,
    });
    return { useCase, log, looked, reserved, saves };
  }
  const add = (r: ReturnType<typeof rig>, input: object = {}, context = contextOf()) =>
    r.useCase.execute(context, {
      importId: JOB,
      name: 'Lamb.JPG',
      data: Buffer.from('x').toString('base64'),
      ...input,
    });

  it('reserves the name, uploads for the job’s product, saves the draft and sets the image', async () => {
    const r = rig();
    const result = await add(r);
    expect(result).toMatchObject({ ok: true, value: { productId: PRODUCT } });
    // The name key is what the file listed (lower case); the product is the job's row record.
    expect(r.looked).toEqual(['lamb.jpg']);
    expect(r.log).toEqual([
      `reserve:lamb.jpg:${PRODUCT}`,
      `upload:${PRODUCT}`,
      `set:lamb.jpg:${IMAGE}`,
    ]);
    expect(r.reserved.sort()).toEqual(['import-photo.seller.day', 'import-photo.seller.minute']);
    // The interactive save budget is not spent for a photo, and the image joins the gallery.
    expect(r.saves).toHaveLength(1);
    expect(r.saves[0]).toMatchObject({
      input: { content: { imageIds: ['img-0', IMAGE] } },
      opts: { spendSavesLimit: false },
    });
  });

  it('answers request.throttled over the minute or day photo count and drops the reservation', async () => {
    const r = rig({ count: 61 });
    expect(await add(r)).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    expect(r.log).toEqual([`reserve:lamb.jpg:${PRODUCT}`, 'release:lamb.jpg']);
  });

  it('drops the reservation when the upload or the draft save fails, so the name can be tried again', async () => {
    const upload = rig({ uploadFails: true });
    expect(await add(upload)).toMatchObject({
      ok: false,
      error: { code: 'image.type-unsupported' },
    });
    expect(upload.log).toEqual([
      `reserve:lamb.jpg:${PRODUCT}`,
      `upload:${PRODUCT}`,
      'release:lamb.jpg',
    ]);
    const save = rig({ saveFails: true });
    await add(save);
    expect(save.log.at(-1)).toBe('release:lamb.jpg');
  });

  it('refuses a second request for a name that is reserved or added, uploading nothing', async () => {
    const r = rig({ reserveRefused: true });
    expect(await add(r)).toEqual({ ok: false, error: { code: 'import.photo-already-added' } });
    expect(r.log).toEqual([`reserve:lamb.jpg:${PRODUCT}`]);
    const listed = rig({ added: ['lamb.jpg'] });
    expect(await add(listed)).toEqual({ ok: false, error: { code: 'import.photo-already-added' } });
    expect(listed.log).toEqual([]);
  });

  it('refuses a name no created or updated group listed, and a closed window', async () => {
    expect(await add(rig({ target: null }))).toEqual({
      ok: false,
      error: { code: 'import.photo-not-named' },
    });
    expect(await add(rig({ job: { finishedAt: T0.subtract({ milliseconds: 9 * DAY }) } }))).toEqual(
      { ok: false, error: { code: 'import.photos-closed' } },
    );
    expect(
      await add(
        rig({
          job: {
            state: 'stopped',
            finishedAt: null,
            endedAt: T0.subtract({ milliseconds: 9 * DAY }),
          },
        }),
      ),
    ).toEqual({ ok: false, error: { code: 'import.photos-closed' } });
  });

  it('answers import.not-found for another account’s job, another seller’s job and an unknown id', async () => {
    for (const context of [
      contextOf(uuid(0xa9) as Id<'Account'>),
      contextOf(ACCOUNT, uuid(0xb9) as Id<'Seller'>),
    ]) {
      const r = rig();
      expect(await add(r, {}, context)).toEqual({ ok: false, error: { code: 'import.not-found' } });
      expect(r.log).toEqual([]);
    }
    expect(await add(rig({ job: null }))).toEqual({
      ok: false,
      error: { code: 'import.not-found' },
    });
  });

  it('refuses a seller who may not sell and a malformed request before any work', async () => {
    expect(await add(rig({ eligible: false }))).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    for (const input of [
      { name: '' },
      { name: 7 },
      { importId: 'x' },
      { data: '' },
      { data: '!!' },
    ]) {
      const r = rig();
      expect(await add(r, input)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(r.log).toEqual([]);
    }
  });
});
