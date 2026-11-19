import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../../platform/list-export';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerHealthMetric } from '../../domain/seller-health';
import type { HealthQueueListDependencies } from '../health-queue-list-flow';
import type { SellerHealthStore, SellerHealthSummary } from '../ports/seller-health.store';
import type { ListedSeller, SellerListRepository } from '../ports/seller-list.repository';
import { SellerHealthQueueExport } from './seller-health-queue-export.use-case';
import { SellerHealthQueueQuery } from './seller-health-queue-query.use-case';

// The "Needs a look" super list (list 16) and its export in memory, on both Market fixtures.

const NOW = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe.each(['AU', 'ZZ'] as const)('"Needs a look" list and export in market %s', (code) => {
  const market = testMarketContext(code, 'default');

  function setup(authorisation: AuthorisationCheck = admitAll) {
    const clock = new FixedClock(NOW);
    const ids = new SequenceIdGenerator(clock);
    const unhealthy: (SellerHealthSummary & { sellerId: Id<'Seller'> })[] = [];
    const files = new Map<
      string,
      Pick<ListedSeller, 'sellerId' | 'storeName' | 'heldSlug' | 'draftSlug'>
    >();
    let truncated = false;
    let failing = false;
    const healthStore = {
      unhealthy: () =>
        failing
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ sellers: unhealthy, truncated }),
    } as unknown as SellerHealthStore;
    const list = {
      all: (_m: MarketContext, query: { onlyIds: readonly Id<'Seller'>[] | null }) =>
        Promise.resolve(
          (query.onlyIds ?? []).flatMap((one) => {
            const file = files.get(one);
            return file === undefined ? [] : [file as ListedSeller];
          }),
        ),
    } as unknown as SellerListRepository;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      runOnce: noRunOnce,
    };
    const deps: HealthQueueListDependencies = {
      unitOfWork,
      healthStore,
      list,
      clock,
      sheetWriter: new ExceljsSheetWriter(),
    };
    const gate = createUseCaseGate(markets, authorisation);
    const query = new SellerHealthQueueQuery(gate, deps);
    const exporter = new SellerHealthQueueExport(gate, deps);
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
    function add(
      storeName: string,
      score: number,
      metric: SellerHealthMetric = 'late-ready',
      slug: string | null = null,
    ) {
      const sellerId = ids.next<'Seller'>();
      unhealthy.push({
        sellerId,
        day: Temporal.PlainDate.from('2026-11-10'),
        kind: 'scored',
        band: 'unhealthy',
        score,
        lowestMetric: metric,
      });
      files.set(sellerId, { sellerId, storeName, heldSlug: slug, draftSlug: null });
      return sellerId;
    }
    const ask = async (input: Record<string, unknown>) => {
      const result = await query.execute(admin(), input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    return {
      query,
      exporter,
      admin,
      add,
      ask,
      setTruncated: (value: boolean) => {
        truncated = value;
      },
      setFailing: (value: boolean) => {
        failing = value;
      },
    };
  }

  it('lists worst score first with counts per metric and the Open action', async () => {
    const { ask, add } = setup();
    const better = add('Better Shop', 30, 'late-ready');
    const worst = add('Worst Shop', 10, 'customer-rating', 'worst-shop');
    const page = await ask({});
    expect(page.items.map((r) => r.sellerId)).toEqual([worst, better]);
    expect(page.items[0]).toMatchObject({
      storeName: 'Worst Shop',
      slug: 'worst-shop',
      lowestMetric: 'customer-rating',
      actions: ['open'],
    });
    expect(page.counts).toMatchObject({
      all: 2,
      'customer-rating': 1,
      'late-ready': 1,
      reports: 0,
    });
    expect(page).toMatchObject({ total: 2, truncated: false });
  });

  it('filters by view, metric, name or slug prefix, seller and score range', async () => {
    const { ask, add } = setup();
    const a = add('Alpha Foods', 5, 'reports', 'alpha-foods');
    const b = add('Beta Deli', 20, 'late-ready', 'bd');
    const c = add('Gamma', 33, 'late-ready');
    const idsOf = async (input: Record<string, unknown>) =>
      (await ask(input)).items.map((r) => r.sellerId);
    expect(await idsOf({ view: 'reports' })).toEqual([a]);
    expect(await idsOf({ metric: 'late-ready' })).toEqual([b, c]);
    expect(await idsOf({ q: 'BE' })).toEqual([b]);
    expect(await idsOf({ q: 'alpha-' })).toEqual([a]);
    expect(await idsOf({ sellerId: c })).toEqual([c]);
    expect(await idsOf({ minScore: '10', maxScore: '25' })).toEqual([b]);
  });

  it('sorts by name and day with the seller id as the tie-break', async () => {
    const { ask, add } = setup();
    const b = add('Beta', 10);
    const a = add('alpha', 20);
    const idsOf = async (input: Record<string, unknown>) =>
      (await ask(input)).items.map((r) => r.sellerId);
    expect(await idsOf({ sort: 'name' })).toEqual([a, b]);
    expect(await idsOf({ sort: 'name', direction: 'desc' })).toEqual([b, a]);
    expect(await idsOf({ sort: 'score', direction: 'desc' })).toEqual([a, b]);
    const sameDay = await idsOf({ sort: 'day', direction: 'asc' });
    expect([...sameDay].sort()).toEqual([a, b].sort());
  });

  it('pages with a total, or Previous/Next without one, and refuses bad input', async () => {
    const { ask, add, query, admin } = setup();
    for (let i = 0; i < 5; i += 1) add(`Shop ${i}`, i);
    expect(await ask({ page: 2, pageSize: 2 })).toMatchObject({ total: 5, hasNext: true });
    const prevNext = await ask({ page: 3, pageSize: 2, paging: 'prev-next' });
    expect(prevNext).toMatchObject({ total: null, hasNext: false });
    expect(prevNext.items).toHaveLength(1);
    expect(await ask({ page: 9, pageSize: 2 })).toMatchObject({ items: [], hasNext: false });
    for (const input of [
      { page: 10_000, pageSize: 100 },
      { pageSize: 101 },
      { paging: 'x' },
      { nope: 1 },
      { q: 'a' },
      { q: 'bad\u0000text' },
      { metric: 'speed' },
      { view: 'done' },
      { sellerId: 'abc' },
      { minScore: '101' },
      { minScore: '50', maxScore: '10' },
      { sort: 'orders' },
      { view: 'reports', metric: 'late-ready' },
    ]) {
      expect(await query.execute(admin(), input)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    }
  });

  it('says when the queue was cut, and answers unavailable when the read fails', async () => {
    const { ask, add, setTruncated, setFailing, query, admin } = setup();
    add('Shop', 1);
    setTruncated(true);
    expect(await ask({})).toMatchObject({ truncated: true });
    setFailing(true);
    expect(await query.execute(admin(), {})).toMatchObject({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  it('exports the list or the chosen ids as CSV with formula-safe cells', async () => {
    const { exporter, admin, add } = setup();
    const a = add('=HYPERLINK("x")', 5, 'reports', 'alpha');
    const b = add('Beta', 7);
    const all = await exporter.execute(admin(), { columns: 'seller-id,day' });
    if (!all.ok) throw new Error(JSON.stringify(all.error));
    expect(all.value.filename).toBe('sellers-needing-attention-2026-11-10.csv');
    const body = await text(all.value);
    expect(body).toContain('Store,Slug,Score,Lowest metric,Seller ID,Measured on');
    expect(body).toContain(`'=HYPERLINK`);
    expect(body).toContain(a);
    const some = await exporter.execute(admin(), { ids: b });
    if (!some.ok) throw new Error(JSON.stringify(some.error));
    expect((await text(some.value)).trim().split('\n')).toHaveLength(2);
  });

  it('refuses bad exports whole, and a selector export when the queue was cut', async () => {
    const { exporter, admin, add, setTruncated } = setup();
    const mine = add('Shop', 1);
    const run = (input: Record<string, unknown>) => exporter.execute(admin(), input);
    expect(await run({ ids: `${mine},01990000-0000-7000-8000-0000000000ff` })).toMatchObject({
      ok: false,
      error: { code: 'file.not-found' },
    });
    for (const input of [
      { ids: `${mine},${mine}` },
      { ids: mine, sort: 'name' },
      { ids: mine, q: 'sh' },
      { format: 'pdf' },
      { columns: 'orders' },
      { page: 2 },
    ]) {
      expect(await run(input)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    const many = Array.from(
      { length: 201 },
      (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    expect(await run({ ids: many })).toMatchObject({
      ok: false,
      error: { code: 'batch.too-large', max: 200 },
    });
    setTruncated(true);
    expect(await run({})).toMatchObject({
      ok: false,
      error: { code: 'batch.too-large', max: 200 },
    });
    expect((await run({ ids: mine })).ok).toBe(true);
  });

  it('keeps score boundaries, ties and desc sorts in order', async () => {
    const { ask, add } = setup();
    const low = add('Low', 0);
    const high = add('High', 100);
    const tieA = add('Tie A', 50);
    const tieB = add('Tie B', 50);
    const idsOf = async (input: Record<string, unknown>) =>
      (await ask(input)).items.map((r) => r.sellerId);
    expect(await idsOf({ minScore: '0', maxScore: '0' })).toEqual([low]);
    expect(await idsOf({ minScore: '100' })).toEqual([high]);
    const asc = await idsOf({});
    expect(asc[0]).toBe(low);
    expect(asc[3]).toBe(high);
    expect(asc.slice(1, 3)).toEqual([tieA, tieB].sort());
    expect((await idsOf({ sort: 'score', direction: 'desc' }))[0]).toBe(high);
  });

  it('exports in the chosen ids order and the chosen column order', async () => {
    const { exporter, admin, add } = setup();
    const a = add('Alpha', 5);
    const b = add('Beta', 7);
    const done = await exporter.execute(admin(), { ids: `${b},${a}`, columns: 'day,seller-id' });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const lines = (await text(done.value)).trim().split('\n');
    expect(lines[0]).toContain('Measured on,Seller ID');
    expect(lines[1]).toContain('Beta');
    expect(lines[2]).toContain('Alpha');
  });

  it('turns away a caller without the permission', async () => {
    const { query, admin } = setup(denyAll);
    expect(await query.execute(admin(), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
