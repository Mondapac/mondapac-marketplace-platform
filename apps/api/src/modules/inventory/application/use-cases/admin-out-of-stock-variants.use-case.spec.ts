import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { OutOfStockVariantPage, VariantStockReader } from '../ports/variant-stock.reader';
import { AdminOutOfStockVariants } from './admin-out-of-stock-variants.use-case';

// `inventory.admin-out-of-stock-variants` in memory on both Market fixtures. The query itself
// (which Variants count) is in test/db/inventory-out-of-stock-variants.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const clock = new FixedClock(Temporal.Instant.from('2026-11-11T01:00:00Z'));

class FakeReader implements VariantStockReader {
  all: Id<'Variant'>[] = [];
  pages: { market: string; page: OutOfStockVariantPage }[] = [];
  listOutOfStockEverywhere(market: MarketContext, page: OutOfStockVariantPage) {
    this.pages.push({ market: market.marketId, page });
    return Promise.resolve(
      this.all.filter((id) => page.after === null || id > page.after).slice(0, page.limit),
    );
  }
  countOutOfStockEverywhere() {
    return Promise.resolve(this.all.length);
  }
}

function setUp(allowed = true) {
  const ids = new SequenceIdGenerator(clock);
  const reader = new FakeReader();
  const units: UnitOfWorkOptions[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      o: UnitOfWorkOptions = {},
    ) => {
      units.push(o);
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const check: AuthorisationCheck = {
    check: () => Promise.resolve(allowed ? { allowed: true } : { allowed: false }),
  } as AuthorisationCheck;
  const run = new AdminOutOfStockVariants(createUseCaseGate(markets, check), {
    unitOfWork,
    variantStock: reader,
  });
  return { ids, reader, units, run };
}

describe.each(['AU', 'ZZ'] as const)(
  'inventory.admin-out-of-stock-variants in market %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    const actor = (t: ReturnType<typeof setUp>, population: 'admin' | 'seller') =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: population === 'seller' ? t.ids.next<'Seller'>() : null,
        }),
      );

    it('returns the ids with the total in one read-only unit of the Market, and pages', async () => {
      const t = setUp();
      t.reader.all = [1, 2, 3].map(() => t.ids.next<'Variant'>());
      const first = await t.run.execute(actor(t, 'admin'), { limit: 2 });
      expect(first).toEqual({
        ok: true,
        value: { variantIds: t.reader.all.slice(0, 2), nextCursor: t.reader.all[1], total: 3 },
      });
      expect(t.units).toEqual([{ readOnly: true }]);
      expect(t.reader.pages[0]).toMatchObject({ market: code, page: { limit: 3, after: null } });
      const next = await t.run.execute(actor(t, 'admin'), { limit: 2, cursor: t.reader.all[1] });
      expect(next).toEqual({
        ok: true,
        value: { variantIds: [t.reader.all[2]], nextCursor: null, total: 3 },
      });
    });

    it('refuses a seller and a caller without the key', async () => {
      const t = setUp();
      expect(await t.run.execute(actor(t, 'seller'), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const denied = setUp(false);
      const result = await denied.run.execute(actor(denied, 'admin'), {});
      expect(result.ok).toBe(false);
      expect(denied.reader.pages).toHaveLength(0);
    });

    it('refuses a bad limit and a bad cursor with codes only', async () => {
      const t = setUp();
      for (const input of [{ limit: 0 }, { limit: 501 }, { limit: '5' }, { cursor: 'x' }]) {
        const result = await t.run.execute(actor(t, 'admin'), input);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
      expect(t.reader.pages).toHaveLength(0);
    });
  },
);
