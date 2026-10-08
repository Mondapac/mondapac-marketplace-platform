import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../platform/unit-of-work/unit-of-work';
import type { PublishedTypesReader } from '../application/ports/published-types.reader';
import type { ApprovedSellerZonesReader } from '../../sellers/contracts/approved-seller-zones.contract';
import { SellersZonesSource } from './sellers-zones.source';
import { UnitPublishedTypesReader } from './unit-published-types.reader';

interface Run {
  readonly market: MarketContext;
  readonly options: UnitOfWorkOptions | undefined;
}

/** A unit that records how it was opened and runs the work once. */
function recordingUnit(runs: Run[]): UnitOfWork {
  return {
    async run<T, E>(
      market: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) {
      runs.push({ market, options });
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
}

describe.each(['AU', 'ZZ'] as const)('UnitPublishedTypesReader, Market %s', (code) => {
  const market = testMarketContext(code, 'default');

  it('opens one read-only unit for the asked Market around each read', async () => {
    const runs: Run[] = [];
    const inner: PublishedTypesReader = {
      claimVocabulary: () => Promise.resolve([]),
      types: () => Promise.resolve([]),
    };
    const reader = new UnitPublishedTypesReader(recordingUnit(runs), inner);
    await reader.claimVocabulary(market);
    await reader.types(market, { status: 'active' });
    expect(runs).toEqual([
      { market, options: { readOnly: true } },
      { market, options: { readOnly: true } },
    ]);
  });

  it('rejects when the inner reader throws, never answering an empty list', async () => {
    const inner: PublishedTypesReader = {
      claimVocabulary: () => Promise.reject(new Error('type x has no claim term')),
      types: () => Promise.reject(new Error('unreadable')),
    };
    const reader = new UnitPublishedTypesReader(recordingUnit([]), inner);
    await expect(reader.claimVocabulary(market)).rejects.toThrow('no claim term');
    await expect(reader.types(market, {})).rejects.toThrow('unreadable');
  });

  it('rejects when the unit answers an error', async () => {
    const unit: UnitOfWork = {
      run: <T, E>() => Promise.resolve(err('boom') as unknown as Result<T, E>),
      runOnce: () => Promise.reject(new Error('not used')),
    };
    const inner: PublishedTypesReader = {
      claimVocabulary: () => Promise.resolve([]),
      types: () => Promise.resolve([]),
    };
    await expect(new UnitPublishedTypesReader(unit, inner).types(market, {})).rejects.toThrow(
      'error',
    );
  });

  describe('SellersZonesSource', () => {
    const context = testCallContext(market, 'system');
    const seller = '0192b3c4-0000-7000-8000-000000000001' as Id<'Seller'>;

    it('passes the context unchanged and returns the zones', async () => {
      const seen: unknown[] = [];
      const zones = new Map([[seller, { zone: 'Australia/Brisbane', addressZone: null }]]);
      const source = new SellersZonesSource({
        approvedSellerZones: (c, ids) => {
          seen.push(c, ids);
          return Promise.resolve(ok(zones));
        },
      });
      expect(await source.zonesOf(context, [seller])).toBe(zones);
      expect(seen[0]).toBe(context);
    });

    it('rejects on any refusal, so evaluateClaims fails closed', async () => {
      const source = new SellersZonesSource({
        approvedSellerZones: () => Promise.resolve(err({ code: 'sellers.unavailable' })),
      } as unknown as ApprovedSellerZonesReader);
      await expect(source.zonesOf(context, [seller])).rejects.toThrow('refused');
    });
  });
});
