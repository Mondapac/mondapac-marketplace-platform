import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { AuditEntry, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CertificationFacadeImplementation } from '../../presentation/certification.facade';
import type {
  CategoryRetirementRepository,
  PolicyNamedCategory,
} from '../ports/category-retirement.repository';
import { AssertCategoriesRetirableSystem } from './assert-categories-retirable-system.use-case';
import {
  AssertCategoriesRetirable,
  MAX_RETIRED_CATEGORY_IDS,
} from './assert-categories-retirable.use-case';
import { PlatformCategoriesRetired } from './platform-categories-retired.use-case';

// `assertCategoriesRetirable` (the anonymous and system pair) and the `platformCategoriesRetired`
// backstop in memory on both Market fixtures (design 3.7, 8.1; B2; C-4): the refusal carries the
// type codes; a failed read is `certification.unavailable`, never `ok` (fail closed); malformed or
// oversized calls are refused whole before any read; the backstop is system-only, audits each new
// flag once (relaxing or not) and maps a fault to `certification.unavailable`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const category = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

/** A unit of work that runs the work once, in memory. */
const inMemoryUnit: UnitOfWork = {
  run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  runOnce: () => Promise.reject(new Error('not used')),
};

describe.each(['AU', 'ZZ'] as const)('category retirement, Market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const asked: { market: string; ids: readonly string[] }[] = [];
  let blocking: () => Promise<readonly string[]>;
  let named: readonly PolicyNamedCategory[];
  let alreadyFlagged: Set<string>;
  let failWrite: boolean;
  const audits: AuditEntry[] = [];
  const repository: CategoryRetirementRepository = {
    blockingTypeCodes: (target, ids) => {
      asked.push({ market: target.marketId, ids });
      return blocking();
    },
    namedCategories: (_target, ids) => {
      if (failWrite) return Promise.reject(new Error('database down'));
      return Promise.resolve(named.filter((row) => ids.includes(row.categoryId)));
    },
    insertFlags: (_target, ids) => {
      const fresh = ids.filter((id) => !alreadyFlagged.has(id));
      for (const id of fresh) alreadyFlagged.add(id);
      return Promise.resolve(fresh);
    },
  };
  const backstop = new PlatformCategoriesRetired(gate, {
    unitOfWork: inMemoryUnit,
    repository,
    audit: {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    clock: new FixedClock(Temporal.Instant.from('2026-11-05T10:00:00Z')),
  });
  const facade = () =>
    new CertificationFacadeImplementation({
      assertCategoriesRetirable: new AssertCategoriesRetirable(gate, repository),
      assertCategoriesRetirableSystem: new AssertCategoriesRetirableSystem(gate, repository),
      platformCategoriesRetired: backstop,
    } as never);
  const admin = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: category(0xa1) as unknown as Id<'Account'>,
        sessionId: category(0x61) as unknown as Id<'Session'>,
        sellerId: null,
      }),
      'retire-abcdef12',
    );

  beforeEach(() => {
    asked.length = 0;
    audits.length = 0;
    blocking = () => Promise.resolve([]);
    named = [];
    alreadyFlagged = new Set();
    failWrite = false;
  });

  describe('assertCategoriesRetirable', () => {
    it('answers ok when no relaxing row names the ids, reading only the caller Market', async () => {
      const result = await facade().assertCategoriesRetirable(admin(), [category(1), category(2)]);

      expect(result).toEqual(ok(undefined));
      expect(asked).toEqual([{ market: code, ids: [category(1), category(2)] }]);
    });

    it('refuses with category.referenced-by-policy and the type codes', async () => {
      blocking = () => Promise.resolve(['halal', 'kosher']);

      expect(await facade().assertCategoriesRetirable(admin(), [category(1)])).toEqual({
        ok: false,
        error: { code: 'category.referenced-by-policy', typeCodes: ['halal', 'kosher'] },
      });
    });

    it('answers certification.unavailable when the read fails, never ok (fail closed)', async () => {
      blocking = () => Promise.reject(new Error('database down'));

      expect(await facade().assertCategoriesRetirable(admin(), [category(1)])).toEqual({
        ok: false,
        error: { code: 'certification.unavailable' },
      });
    });

    it('serves the system actor through its own use case with the same answer', async () => {
      blocking = () => Promise.resolve(['halal']);

      expect(
        await facade().assertCategoriesRetirable(testCallContext(market, 'system'), [category(3)]),
      ).toMatchObject({ ok: false, error: { code: 'category.referenced-by-policy' } });
      expect(asked).toHaveLength(1);
    });

    it('asks each id once and refuses an empty call without reading (fail closed)', async () => {
      await facade().assertCategoriesRetirable(admin(), [category(1), category(1), category(2)]);
      expect(asked[0]!.ids).toEqual([category(1), category(2)]);

      asked.length = 0;
      expect(await facade().assertCategoriesRetirable(admin(), [])).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'required' }] }),
      );
      expect(asked).toEqual([]);
    });

    it('refuses a malformed or oversized call whole, before any read', async () => {
      const tooMany = Array.from({ length: MAX_RETIRED_CATEGORY_IDS + 1 }, (_, i) =>
        category(i + 1),
      );

      expect(await facade().assertCategoriesRetirable(admin(), ['not-an-id'])).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'format' }] },
      });
      expect(await facade().assertCategoriesRetirable(admin(), tooMany)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'range' }] },
      });
      expect(
        await facade().assertCategoriesRetirable(
          admin(),
          Array.from({ length: MAX_RETIRED_CATEGORY_IDS }, (_, i) => category(i + 1)),
        ),
      ).toEqual(ok(undefined));
      expect(asked).toHaveLength(1);
    });
  });

  describe('platformCategoriesRetired', () => {
    it('flags each named id once and audits it by kind; a repeat writes nothing', async () => {
      named = [
        { categoryId: category(1), relaxingRowNamed: true },
        { categoryId: category(2), relaxingRowNamed: false },
      ];
      const system = testCallContext(market, 'system');
      const ids = [category(1), category(2), category(3)];

      expect(await facade().platformCategoriesRetired(system, ids)).toEqual(
        ok({ flagged: 2, relaxing: 1 }),
      );
      expect(audits.map((entry) => [entry.action, entry.targetId])).toEqual([
        ['certification.retired-category.flagged-relaxing', category(1)],
        ['certification.retired-category.flagged', category(2)],
      ]);

      audits.length = 0;
      expect(await facade().platformCategoriesRetired(system, ids)).toEqual(
        ok({ flagged: 0, relaxing: 0 }),
      );
      expect(audits).toEqual([]);
    });

    it('refuses a request actor: only catalog handlers call it', async () => {
      expect(await facade().platformCategoriesRetired(admin(), [category(1)])).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await facade().platformCategoriesRetired(testCallContext(market, 'anonymous'), [
          category(1),
        ]),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });

    it('answers certification.unavailable on a fault, so the handler retries', async () => {
      failWrite = true;

      expect(
        await facade().platformCategoriesRetired(testCallContext(market, 'system'), [category(1)]),
      ).toEqual({ ok: false, error: { code: 'certification.unavailable' } });
      expect(audits).toEqual([]);
    });
  });
});
