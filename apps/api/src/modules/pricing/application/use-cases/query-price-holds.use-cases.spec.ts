import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  InMemoryWriteRateCounters,
  RecordingAuditWriter,
  RecordingOutbox,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../../platform/list-export';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { EMPTY_HOLD_FILTER } from '../../domain/hold-list';
import { HOLD_ROW_KEYS, type AdminHoldListDependencies } from '../admin-hold-list-flow';
import type { HeldUnitLabel } from '../ports/held-labels';
import { ExportPriceHolds } from './export-price-holds.use-case';
import { QueryPriceHolds } from './query-price-holds.use-case';
import { SetRegularPrice } from './set-regular-price.use-case';

// The held-price super list (list 19) and its export in memory, on both Market fixtures. The
// Prisma twin of the filters and sorts is in test/db/pricing-hold-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const T0 = Temporal.Instant.from('2026-10-10T10:00:00Z');

const FIXTURES = {
  AU: { currency: 'AUD', base: 10_000n },
  ZZ: { currency: 'JPY', base: 1_000n },
} as const;

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe.each(['AU', 'ZZ'] as const)('held-price list and export in market %s', (code) => {
  const fixture = FIXTURES[code];
  const market: MarketContext = testMarketContext(code, 'default');
  const foreign: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  function setup(options: { mayDecide?: boolean } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const offers = new FakeOfferSellUnits();
    const set = new SetRegularPrice(gate, {
      unitOfWork,
      series,
      audit: new RecordingAuditWriter(),
      outbox: new RecordingOutbox(),
      clock,
      throttles: new InMemoryRefusalThrottles(),
      counters: new InMemoryWriteRateCounters(),
      offers,
      policies,
      ids,
    });
    const names = new Map<string, HeldUnitLabel>();
    const stores = new Map<Id<'Seller'>, string>();
    const deps: AdminHoldListDependencies = {
      unitOfWork,
      series,
      unitLabels: { labelsOf: () => Promise.resolve(names) },
      storeNames: { namesOf: () => Promise.resolve(stores) },
      probes: {
        [HOLD_ROW_KEYS[0]]: {
          execute: () => Promise.resolve({ ok: options.mayDecide ?? true }),
        },
      },
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    };
    const list = new QueryPriceHolds(gate, deps);
    const exporter = new ExportPriceHolds(gate, deps);
    const admin = (m: MarketContext = market): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );

    /** A seller whose first price is in force and whose second, `held`, is above the jump limit. */
    async function hold(heldAmount: bigint, label: string | null = null, m = market) {
      const sellerId = ids.next<'Seller'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      offers.put(m, offerId, {
        sellerId,
        productId: ids.next<'Product'>(),
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const context = testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
      const priced = FIXTURES[m.marketId as 'AU' | 'ZZ'];
      const input = (amount: bigint, expectedVersion: number | null) => ({
        offerId,
        variantId,
        price: { amount: amount.toString(), currency: priced.currency },
        expectedVersion,
      });
      await set.execute(context, input(priced.base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      const second = await set.execute(context, input(heldAmount, 2));
      if (!second.ok || second.value.recordId === null) throw new Error('setup: no hold');
      clock.set(clock.now().add({ seconds: 5 }));
      if (label !== null) {
        names.set(`${offerId}:${variantId}`, { productName: label, variantLabel: null });
      }
      return { sellerId, offerId, recordId: second.value.recordId };
    }

    return { clock, deps, list, exporter, admin, hold };
  }

  const big = fixture.base * 3n;

  it('lists oldest first with counts, total, labels and the row actions', async () => {
    const t = setup();
    const a = await t.hold(big, 'Almonds');
    const b = await t.hold(big + 7n, 'Bananas');
    const page = await t.list.execute(t.admin(), {});
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items.map((row) => row.recordId)).toEqual([a.recordId, b.recordId]);
    expect(page.value.items[0]?.productName).toBe('Almonds');
    expect(page.value.items[0]?.actions).toEqual(['open', 'decide']);
    expect(page.value).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: false,
      counts: { all: 2, regular: 2, special: 0, up: 2, down: 0 },
    });
  });

  it('offers only Open to a caller who may not decide', async () => {
    const t = setup({ mayDecide: false });
    await t.hold(big);
    const page = await t.list.execute(t.admin(), {});
    expect(page.ok && page.value.items[0]?.actions).toEqual(['open']);
  });

  it('sorts by amount and filters by view, seller, id and amount range', async () => {
    const t = setup();
    const a = await t.hold(big);
    const b = await t.hold(big + 100n);
    const c = await t.hold(big + 50n);
    const ids = async (input: Record<string, unknown>) => {
      const page = await t.list.execute(t.admin(), input);
      if (!page.ok) throw new Error(JSON.stringify(page.error));
      return page.value.items.map((row) => row.recordId);
    };
    expect(await ids({ sort: 'amount', direction: 'desc' })).toEqual([
      b.recordId,
      c.recordId,
      a.recordId,
    ]);
    expect(await ids({ view: 'down' })).toEqual([]);
    expect(await ids({ view: 'special' })).toEqual([]);
    expect(await ids({ view: 'up', sort: 'amount' })).toEqual([a.recordId, c.recordId, b.recordId]);
    expect(await ids({ sellerId: c.sellerId })).toEqual([c.recordId]);
    expect(await ids({ q: b.offerId })).toEqual([b.recordId]);
    expect(await ids({ q: a.recordId.toUpperCase() })).toEqual([a.recordId]);
    expect(
      await ids({ minAmount: (big + 50n).toString(), maxAmount: (big + 99n).toString() }),
    ).toEqual([c.recordId]);
    expect(await ids({ from: T0.add({ seconds: 15 }).toString() })).toEqual([
      b.recordId,
      c.recordId,
    ]);
  });

  it('pages by number and by Previous/Next, ties broken by the record id', async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) await t.hold(big);
    const first = await t.list.execute(t.admin(), { pageSize: 2 });
    const second = await t.list.execute(t.admin(), { pageSize: 2, page: 2 });
    expect(first.ok && first.value).toMatchObject({ total: 3, hasNext: true });
    expect(second.ok && second.value).toMatchObject({ total: 3, hasNext: false });
    const seen = [first, second].flatMap((p) => (p.ok ? p.value.items.map((r) => r.recordId) : []));
    expect(new Set(seen).size).toBe(3);

    const next = await t.list.execute(t.admin(), { paging: 'prev-next', pageSize: 2 });
    expect(next.ok && next.value).toMatchObject({ total: null, hasNext: true });
    expect(next.ok && next.value.items).toHaveLength(2);
  });

  it('refuses what it does not understand, naming the field', async () => {
    const t = setup();
    const refused = async (input: Record<string, unknown>) => {
      const result = await t.list.execute(t.admin(), input);
      return result.ok ? null : result.error;
    };
    expect(await refused({ nope: 1 })).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'nope', code: 'unknown' }],
    });
    expect(await refused({ sort: 'price' })).toMatchObject({ fields: [{ path: 'sort' }] });
    expect(await refused({ view: 'x' })).toMatchObject({ fields: [{ path: 'view' }] });
    expect(await refused({ q: 'not-an-id' })).toMatchObject({ fields: [{ path: 'q' }] });
    expect(await refused({ minAmount: '1.5' })).toMatchObject({ fields: [{ path: 'minAmount' }] });
    expect(await refused({ minAmount: '9', maxAmount: '2' })).toMatchObject({
      fields: [{ path: 'maxAmount', code: 'range' }],
    });
    expect(await refused({ page: 401, pageSize: 100 })).toMatchObject({
      fields: [{ path: 'page' }],
    });
    expect(await refused({ pageSize: 101 })).toMatchObject({ fields: [{ path: 'pageSize' }] });
  });

  it('never shows a record of another Market', async () => {
    const t = setup();
    await t.hold(FIXTURES[foreign.marketId as 'AU' | 'ZZ'].base * 3n, null, foreign);
    const page = await t.list.execute(t.admin(), {});
    expect(page.ok && page.value.items).toEqual([]);
    expect(page.ok && page.value.counts.all).toBe(0);
  });

  it('exports CSV with the always columns, the chosen ones, and a guarded formula cell', async () => {
    const t = setup();
    const a = await t.hold(big, '=HYPERLINK("x")');
    const result = await t.exporter.execute(t.admin(), { columns: 'record-id,offer-id' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe('price-holds-2026-10-10.csv');
    const body = await text(result.value);
    const [header, row] = body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    expect(header).toBe(
      'Product,Variant,Store,Kind,Direction,Held amount,Reference amount,Reference,Currency,Submitted (UTC),Record ID,Offer ID',
    );
    expect(row).toContain("'=HYPERLINK");
    expect(row).toContain(a.recordId);
    expect(row).toContain('Regular,Increase');
    expect(row).toContain(',Previous price,');
  });

  it('exports chosen ids, refuses an unknown one whole, and an XLSX is a file of its own', async () => {
    const t = setup();
    const a = await t.hold(big);
    await t.hold(big + 1n);
    const chosen = await t.exporter.execute(t.admin(), { ids: a.recordId });
    expect(chosen.ok && (await text(chosen.value)).trim().split(/\r?\n/)).toHaveLength(2);
    const unknown = await t.exporter.execute(t.admin(), {
      ids: `${a.recordId},00000000-0000-4000-8000-000000000000`,
    });
    expect(unknown).toEqual({ ok: false, error: { code: 'pricing.hold.not-found' } });
    const xlsx = await t.exporter.execute(t.admin(), { format: 'xlsx' });
    expect(xlsx.ok && xlsx.value.filename).toBe('price-holds-2026-10-10.xlsx');
    const bad = await t.exporter.execute(t.admin(), { columns: 'nope' });
    expect(bad.ok).toBe(false);
    const stray = await t.exporter.execute(t.admin(), { page: 2 });
    expect(stray.ok).toBe(false);
  });

  it('refuses list and export to a caller without pricing.price-hold.view, reading nothing', async () => {
    const t = setup();
    const denyAll: AuthorisationCheck = {
      check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } } as const),
    };
    const denied = createUseCaseGate(markets, denyAll);
    let reads = 0;
    const series = new Proxy(t.deps.series, {
      get: (target, key, receiver) => {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const deps = { ...t.deps, series };
    const list = await new QueryPriceHolds(denied, deps).execute(t.admin(), {});
    const file = await new ExportPriceHolds(denied, deps).execute(t.admin(), {});
    expect(list).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(file).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(reads).toBe(0);
  });

  it('answers an empty list, and a page past the end, without rows or actions', async () => {
    const t = setup();
    const empty = await t.list.execute(t.admin(), {});
    expect(empty.ok && empty.value).toMatchObject({
      items: [],
      total: 0,
      counts: { all: 0, regular: 0, special: 0, up: 0, down: 0 },
    });
    await t.hold(big);
    const past = await t.list.execute(t.admin(), { page: 3 });
    expect(past.ok && past.value).toMatchObject({ items: [], total: 1, hasNext: false });
  });

  it('refuses a range that ends before it starts and a seller id that is not one', async () => {
    const t = setup();
    const refused = async (input: Record<string, unknown>) => {
      const result = await t.list.execute(t.admin(), input);
      return result.ok ? null : result.error;
    };
    expect(
      await refused({ from: '2026-10-11T00:00:00Z', to: '2026-10-10T00:00:00Z' }),
    ).toMatchObject({ code: 'validation.failed' });
    expect(await refused({ sellerId: 'seller-1' })).toMatchObject({
      fields: [{ path: 'sellerId', code: 'format' }],
    });
  });

  it('refuses an export of more than 10,000 rows with the total, and more than 200 ids', async () => {
    const t = setup();
    const a = await t.hold(big);
    const [row] = await t.deps.series.queryPendingHolds(
      market,
      EMPTY_HOLD_FILTER,
      { key: 'submitted', direction: 'asc' },
      0,
      1,
    );
    const many = Array.from({ length: 10_001 }, () => row!);
    const series = new Proxy(t.deps.series, {
      get: (target, key, receiver) => {
        if (key === 'queryPendingHolds') return () => Promise.resolve(many);
        if (key === 'countPendingHoldsWhere') return () => Promise.resolve(12_345);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const capped = await new ExportPriceHolds(gate, { ...t.deps, series }).execute(t.admin(), {});
    expect(capped).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: 10_000, total: 12_345 },
    });
    const ids = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const tooMany = await t.exporter.execute(t.admin(), { ids: ids.join(',') });
    expect(tooMany).toMatchObject({ ok: false, error: { code: 'batch.too-large', max: 200 } });
    expect(a.recordId).toBeDefined();
  });
});
