import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { OfferFeed } from './ports/offer-feed';
import type { IndexStamp, ReindexProgress, ReindexState } from './ports/reindex';
import type { ReindexDependencies } from './reindex-dependencies';
import { SYNC_BATCH } from './sync-offers';
import { RequestOfferReindex } from './use-cases/request-offer-reindex.use-case';
import { ReindexOfferAttributes } from './use-cases/reindex-offer-attributes.use-case';

// `search.reindex-offer-attributes` in memory on both Market fixtures: nothing happens while the
// catalog stamp is unchanged, a change re-reads every published Offer page by page with progress,
// and a failed run resumes after its cursor while the stamp is the same.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-04T10:00:00Z');
const offer = (n: number): Id<'Offer'> =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Offer'>;

class MemoryProgress implements ReindexProgress {
  state: ReindexState | null = null;
  readonly log: string[] = [];
  read(): Promise<ReindexState | null> {
    return Promise.resolve(this.state);
  }
  begin(_m: MarketContext, targetStamp: string): Promise<void> {
    this.log.push('begin');
    this.state = {
      doneStamp: this.state?.doneStamp ?? null,
      targetStamp,
      status: 'running',
      offersDone: 0,
      cursorOfferId: null,
    };
    return Promise.resolve();
  }
  advance(_m: MarketContext, offersDone: number, cursor: Id<'Offer'>): Promise<void> {
    this.log.push(`advance:${offersDone}`);
    if (this.state !== null) this.state = { ...this.state, offersDone, cursorOfferId: cursor };
    return Promise.resolve();
  }
  request(): Promise<void> {
    this.log.push('request');
    if (this.state !== null) this.state = { ...this.state, doneStamp: null, targetStamp: null };
    return Promise.resolve();
  }
  finish(_m: MarketContext, stamp: string): Promise<void> {
    this.log.push('finish');
    if (this.state !== null && this.state.targetStamp !== stamp) return Promise.resolve();
    this.state = {
      doneStamp: stamp,
      targetStamp: stamp,
      status: 'idle',
      offersDone: this.state?.offersDone ?? 0,
      cursorOfferId: null,
    };
    return Promise.resolve();
  }
  fail(): Promise<void> {
    this.log.push('fail');
    if (this.state !== null) this.state = { ...this.state, status: 'failed' };
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('attribute reindex in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const system: CallContext = testCallContext(market, 'system');
  let stamp: string | null;
  let total: number;
  let failAfterReads: number | null;
  let reads: number;
  const seen: Id<'Offer'>[] = [];
  let progress: MemoryProgress;
  let deps: ReindexDependencies;

  beforeEach(() => {
    stamp = 'stamp-1';
    total = SYNC_BATCH + 50;
    failAfterReads = null;
    reads = 0;
    seen.length = 0;
    progress = new MemoryProgress();
    const indexStamp: IndexStamp = { current: () => Promise.resolve(stamp) };
    const feed: OfferFeed = {
      publishedIds: (_c, input) => {
        const from = input.after === undefined ? 0 : Number(BigInt(`0x${input.after.slice(-12)}`));
        return Promise.resolve(
          Array.from({ length: Math.max(0, Math.min(input.limit, total - from)) }, (_, i) =>
            offer(from + i + 1),
          ),
        );
      },
      facts: (_c, ids) => {
        reads += 1;
        if (failAfterReads !== null && reads > failAfterReads) return Promise.resolve(null);
        seen.push(...ids);
        return Promise.resolve(new Map());
      },
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      documents: { upsert: () => Promise.resolve(), deleteMany: () => Promise.resolve(0) },
      feed,
      sellers: { eligible: () => Promise.resolve(new Set()) },
      storeDocuments: {
        upsertMany: () => Promise.resolve(),
        deleteMany: () => Promise.resolve(0),
      },
      categoryTree: { tree: () => Promise.resolve([]) },
      cultures: {
        visibleCodes: () => Promise.resolve(new Map()),
      },
      storeDirectory: { publicStores: () => Promise.resolve(new Map()) },
      policy: new ConfigSearchPolicy(markets),
      clock: new FixedClock(T0),
      progress,
      stamp: indexStamp,
    } as unknown as ReindexDependencies;
  });
  const run = () => new ReindexOfferAttributes(gate, deps).execute(system, {});

  it('declares the system rule under its own name', () => {
    expect(ReindexOfferAttributes.access).toEqual({
      name: 'search.reindex-offer-attributes',
      rule: { kind: 'system' },
    });
  });

  it('re-reads every published Offer on the first run and records progress by page', async () => {
    const result = await run();

    expect(result).toEqual({ ok: true, value: { state: 'done', offers: total, resumed: false } });
    expect(seen).toHaveLength(total);
    expect(progress.log).toEqual(['begin', `advance:${SYNC_BATCH}`, `advance:${total}`, 'finish']);
    expect(progress.state).toMatchObject({ doneStamp: 'stamp-1', status: 'idle' });
  });

  it('does nothing while the stamp is unchanged, and runs again when it changes', async () => {
    await run();
    seen.length = 0;

    expect(await run()).toEqual({ ok: true, value: { state: 'current' } });
    expect(seen).toEqual([]);

    stamp = 'stamp-2';
    const again = await run();
    expect(again).toMatchObject({ ok: true, value: { state: 'done', resumed: false } });
    expect(seen).toHaveLength(total);
  });

  it('records a failed page and resumes after the cursor on the next run', async () => {
    failAfterReads = 1;
    await expect(run()).rejects.toThrow();
    expect(progress.state).toMatchObject({ status: 'failed', offersDone: SYNC_BATCH });

    failAfterReads = null;
    seen.length = 0;
    const result = await run();

    expect(result).toEqual({ ok: true, value: { state: 'done', offers: total, resumed: true } });
    expect(seen).toHaveLength(50);
    expect(progress.state).toMatchObject({ doneStamp: 'stamp-1', status: 'idle' });
  });

  it('starts again from the top when the stamp changed since the failed run', async () => {
    failAfterReads = 1;
    await expect(run()).rejects.toThrow();
    failAfterReads = null;
    stamp = 'stamp-2';
    seen.length = 0;

    const result = await run();

    expect(result).toEqual({ ok: true, value: { state: 'done', offers: total, resumed: false } });
    expect(seen).toHaveLength(total);
  });

  it('runs again in full after a request, even with the same stamp (multi-culture package 3a)', async () => {
    await run();
    expect(await run()).toEqual({ ok: true, value: { state: 'current' } });
    await new RequestOfferReindex(gate, {
      unitOfWork: new FakeUnitOfWork(),
      progress,
      clock: new FixedClock(T0),
    }).execute(system, { reason: 'culture-status' });
    seen.length = 0;

    expect(await run()).toMatchObject({ ok: true, value: { state: 'done', resumed: false } });
    expect(seen).toHaveLength(total);
  });

  it('a request that comes in during a run keeps that run from marking itself done', async () => {
    failAfterReads = 1;
    await expect(run()).rejects.toThrow();
    // The request lands while the run is under way (here: between its failed page and its resume).
    await progress.request();
    failAfterReads = null;
    seen.length = 0;

    expect(await run()).toMatchObject({ ok: true, value: { state: 'done', resumed: false } });
    expect(seen).toHaveLength(total);
    expect(progress.state).toMatchObject({ doneStamp: 'stamp-1', status: 'idle' });
  });

  it('refuses an unknown reason before any write', async () => {
    const result = await new RequestOfferReindex(gate, {
      unitOfWork: new FakeUnitOfWork(),
      progress,
      clock: new FixedClock(T0),
    }).execute(system, { reason: 'because' as never });
    expect(result).toEqual({ ok: false, error: { code: 'validation.failed' } });
    expect(progress.log).toEqual([]);
  });

  it('fails when catalog cannot give its stamp, and writes nothing', async () => {
    stamp = null;

    await expect(run()).rejects.toThrow('stamp unavailable');
    expect(progress.log).toEqual([]);
  });
});
