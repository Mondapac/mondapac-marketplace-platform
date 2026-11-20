import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { brandState, MemoryBrands } from '../../../../../test/support/catalog-brand-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BrandListQuery, BrandPageFilter, BrandPageQuery } from '../ports/brand.reader';
import { BrandList, type BrandListInput } from './brand-list.use-case';

// `brand.list` filters in memory, on both Market fixtures: origin country (exact), the creation
// window (from inclusive, to exclusive) and status, applied the same way to the count, the page and
// the older cursor read; malformed values are refused before any read.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-19T03:00:00Z');
const at = (iso: string) => Temporal.Instant.from(iso);

const brandId = (n: number): Id<'Brand'> =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Brand'>;

describe.each(['AU', 'ZZ'] as const)('brand list filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  function setup() {
    const brands = new MemoryBrands();
    brands.seed(
      brandState(brandId(1), 'Acme Tea', {
        originCountry: 'AU',
        createdAt: at('2026-10-01T00:00:00Z'),
      }),
    );
    brands.seed(
      brandState(brandId(2), 'Bondi Foods', {
        originCountry: 'AU',
        createdAt: at('2026-11-01T00:00:00Z'),
      }),
    );
    brands.seed(
      brandState(brandId(3), 'Kiwi Kitchen', {
        originCountry: 'NZ',
        createdAt: at('2026-11-10T00:00:00Z'),
      }),
    );
    brands.seed(
      brandState(brandId(4), 'Draft Brand', {
        status: 'draft',
        originCountry: 'AU',
        createdAt: at('2026-11-05T00:00:00Z'),
      }),
    );
    const check: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
    let units = 0;
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        units += 1;
        return work();
      },
    } as unknown as UnitOfWork;
    const seen: { counts: BrandPageFilter[]; pages: BrandPageQuery[]; lists: BrandListQuery[] } = {
      counts: [],
      pages: [],
      lists: [],
    };
    const [count, page, list] = [
      brands.count.bind(brands),
      brands.page.bind(brands),
      brands.list.bind(brands),
    ];
    brands.count = (m, filter) => (seen.counts.push(filter), count(m, filter));
    brands.page = (m, query) => (seen.pages.push(query), page(m, query));
    brands.list = (m, query) => (seen.lists.push(query), list(m, query));
    const useCase = new BrandList(createUseCaseGate(markets, check), {
      unitOfWork,
      brandReader: brands,
      brandEditProbe: { execute: () => Promise.resolve({ ok: true }) },
    });
    return { useCase, seen, units: () => units };
  }

  const namesOf = (result: Result<{ items: readonly { name: string }[] }, unknown>) => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.items.map((item) => item.name);
  };

  it('filters by origin country, exactly, in the count and the page', async () => {
    const { useCase, seen } = setup();
    const result = await useCase.execute(admin(), { originCountry: 'NZ' });
    expect(namesOf(result)).toEqual(['Kiwi Kitchen']);
    expect(result.ok && result.value.total).toBe(1);
    expect(seen.counts[0]).toMatchObject({
      originCountry: 'NZ',
      createdFrom: null,
      createdTo: null,
    });
    expect(seen.pages[0]).toMatchObject({ originCountry: 'NZ' });
  });

  it('filters by the creation window: createdFrom inclusive, createdTo exclusive', async () => {
    const { useCase, seen } = setup();
    const result = await useCase.execute(admin(), {
      createdFrom: '2026-11-01T10:00:00+10:00',
      createdTo: '2026-11-10T00:00:00Z',
    });
    // Bondi Foods is created exactly at createdFrom (in), Kiwi Kitchen exactly at createdTo (out).
    expect(namesOf(result)).toEqual(['Bondi Foods', 'Draft Brand']);
    expect(seen.pages[0]).toMatchObject({
      createdFrom: at('2026-11-01T00:00:00Z'),
      createdTo: at('2026-11-10T00:00:00Z'),
    });
  });

  it('combines the filters with status and the search, on the cursor read too', async () => {
    const { useCase, seen } = setup();
    const paged = await useCase.execute(admin(), {
      status: 'active',
      originCountry: 'AU',
      createdFrom: '2026-10-15T00:00:00Z',
    });
    expect(namesOf(paged)).toEqual(['Bondi Foods']);
    const cursor = await useCase.execute(admin(), { originCountry: 'AU', q: 'n', limit: 10 });
    expect(namesOf(cursor)).toEqual(['Bondi Foods', 'Draft Brand']);
    expect(seen.lists[0]).toMatchObject({ originCountry: 'AU', search: 'n', afterId: null });
  });

  it('treats empty values as no filter', async () => {
    const { useCase } = setup();
    const result = await useCase.execute(admin(), {
      originCountry: '',
      createdFrom: '',
      createdTo: '',
    });
    expect(namesOf(result)).toHaveLength(4);
  });

  it.each([
    [{ status: 'gone' }, 'status', 'unknown'],
    [{ originCountry: 'au' }, 'originCountry', 'format'],
    [{ originCountry: 'AUS' }, 'originCountry', 'format'],
    [{ originCountry: 'A\u0007' }, 'originCountry', 'format'],
    [{ originCountry: ['AU'] }, 'originCountry', 'type'],
    [{ createdFrom: '2026-11-01' }, 'createdFrom', 'format'],
    [{ createdFrom: '2026-11-01T00:00:00' }, 'createdFrom', 'format'],
    [{ createdTo: '2026-11-01T00:00:00Z\u0000' }, 'createdTo', 'format'],
    [{ createdTo: 7 }, 'createdTo', 'format'],
    [
      { createdFrom: '2026-11-02T00:00:00Z', createdTo: '2026-11-01T00:00:00Z' },
      'createdTo',
      'range',
    ],
    [{ createdAt: '2026-11-01T00:00:00Z' }, 'createdAt', 'unknown'],
  ])('refuses %j as validation.failed before any read', async (input, path, reason) => {
    const { useCase, units } = setup();
    expect(await useCase.execute(admin(), input as BrandListInput)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: reason }] },
    });
    expect(units()).toBe(0);
  });
});
