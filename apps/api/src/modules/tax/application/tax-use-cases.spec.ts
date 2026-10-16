import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { TAX_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigTaxPolicy } from '../infrastructure/config-tax-policy';
import type { StrategyRecord, StrategyRepository } from './ports/strategy.repository';
import type { TaxDependencies } from './tax-dependencies';
import { ActivateTaxStrategy } from './use-cases/activate-tax-strategy.use-case';
import { CalculateTax } from './use-cases/calculate-tax.use-case';
import { CreateTaxStrategy } from './use-cases/create-tax-strategy.use-case';
import { DeleteTaxStrategy } from './use-cases/delete-tax-strategy.use-case';
import { ListTaxStrategies } from './use-cases/list-tax-strategies.use-case';
import { UpdateTaxStrategy } from './use-cases/update-tax-strategy.use-case';

// Tax strategies in memory on both Market fixtures (AU: prices with GST, built-in 10 %; ZZ: prices
// without tax, built-in 15 %): the built-in strategy, an admin's own strategies, the one in force,
// every change audited, and the tax of order lines under whichever strategy applies.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const GHOST = id<'TaxStrategy'>(0xfff);

const ACTIONS = new Set<string>(TAX_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** Like the table: at most one active row (the partial unique index). */
class MemoryStrategies implements StrategyRepository {
  readonly rows = new Map<string, StrategyRecord>();
  readonly locked: Id<'TaxStrategy'>[] = [];
  list() {
    return Promise.resolve([...this.rows.values()].reverse());
  }
  find(_m: MarketContext, strategyId: Id<'TaxStrategy'>) {
    return Promise.resolve(this.rows.get(strategyId) ?? null);
  }
  findActive() {
    return Promise.resolve([...this.rows.values()].find((row) => row.active) ?? null);
  }
  findForUpdate(m: MarketContext, strategyId: Id<'TaxStrategy'>) {
    this.locked.push(strategyId);
    return this.find(m, strategyId);
  }
  insert(_m: MarketContext, record: Parameters<StrategyRepository['insert']>[1]) {
    this.rows.set(record.id, { ...record, active: false, updatedAt: record.createdAt });
    return Promise.resolve();
  }
  update(_m: MarketContext, record: Parameters<StrategyRepository['update']>[1]) {
    const row = this.rows.get(record.id)!;
    this.rows.set(record.id, {
      ...row,
      name: record.name,
      params: record.params,
      updatedAt: record.updatedAt,
    });
    return Promise.resolve();
  }
  deactivateAll() {
    let changed = false;
    for (const [key, row] of this.rows) {
      if (row.active) {
        this.rows.set(key, { ...row, active: false });
        changed = true;
      }
    }
    return Promise.resolve(changed);
  }
  activate(_m: MarketContext, strategyId: Id<'TaxStrategy'>) {
    if ([...this.rows.values()].some((row) => row.active)) throw new Error('two active');
    this.rows.set(strategyId, { ...this.rows.get(strategyId)!, active: true });
    return Promise.resolve();
  }
  remove(_m: MarketContext, strategyId: Id<'TaxStrategy'>) {
    return Promise.resolve(this.rows.delete(strategyId));
  }
}

describe.each([['AU'], ['ZZ']] as const)('tax strategies in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const builtIn = config.tax!.defaultRateBps;
  const inclusive = config.pricesIncludeTax;
  const categories = config.catalog!.taxCategories.map((category) => category.code);
  const [standard, , free] = [categories[0]!, categories[1]!, categories[categories.length - 1]!];
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `tax-${population}-abcd`,
    );
  const admin = actor('admin');
  const seller = actor('seller');
  const customer = actor('customer');

  let strategies: MemoryStrategies;
  let audit: RecordingAudit;
  let deps: TaxDependencies;

  beforeEach(() => {
    strategies = new MemoryStrategies();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      strategies,
      policy: new ConfigTaxPolicy(markets),
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  const create = (body: unknown, context: CallContext = admin) =>
    new CreateTaxStrategy(gate, deps).execute(context, body);
  const list = (context: CallContext = admin) =>
    new ListTaxStrategies(gate, deps).execute(context, {});
  const activate = (strategyId: unknown, context: CallContext = admin) =>
    new ActivateTaxStrategy(gate, deps).execute(context, { strategyId });
  const line = (amount: bigint, categoryCode: string | null = null) => ({
    amount,
    taxInclusive: inclusive,
    categoryCode,
  });
  const calculate = (lines: unknown, context: CallContext = customer) =>
    new CalculateTax(gate, deps).execute(context, { lines });

  const byCategory = {
    name: 'By category',
    kind: 'by-category',
    defaultRateBps: builtIn,
    categoryRatesBps: { [free]: 0 },
  };

  it('uses the built-in flat strategy of the Market while none is active', async () => {
    expect(await list()).toEqual(
      ok({
        builtInRateBps: builtIn,
        activeStrategyId: null,
        categoryCodes: categories,
        strategies: [],
      }),
    );
    const answer = await calculate([line(1100n)]);
    expect(answer.ok && answer.value.strategyId).toBeNull();
    expect(answer.ok && answer.value.lines[0]).toMatchObject({ rateBps: builtIn });
  });

  it('defines a strategy inactive, audits it without its name, and does not use it yet', async () => {
    const made = await create(byCategory);
    expect(made.ok && made.value).toMatchObject({ name: 'By category', active: false });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'tax.strategy.create',
        after: { kind: 'by-category', rateBps: builtIn, categoryCount: 1 },
      }),
    ]);
    const answer = await calculate([line(1000n, free)]);
    expect(answer.ok && answer.value.lines[0]!.rateBps).toBe(builtIn);
  });

  it('applies the activated strategy to new calculations and back to the built-in one', async () => {
    const made = await create(byCategory);
    if (!made.ok) throw new Error('create failed');
    const switched = await activate(made.value.id);
    expect(switched.ok && switched.value.activeStrategyId).toBe(made.value.id);

    const answer = await calculate([line(1000n, free), line(1000n, standard)]);
    expect(answer.ok && answer.value.strategyId).toBe(made.value.id);
    expect(answer.ok && answer.value.lines.map((l) => l.rateBps)).toEqual([0, builtIn]);
    expect(answer.ok && answer.value.lines[0]!.tax).toBe(0n);

    const back = await activate(null);
    expect(back.ok && back.value.activeStrategyId).toBeNull();
    const again = await calculate([line(1000n, free)]);
    expect(again.ok && again.value.lines[0]!.rateBps).toBe(builtIn);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'tax.strategy.create',
      'tax.strategy.activate',
      'tax.strategy.deactivate',
    ]);
  });

  it('keeps one active strategy: activating another switches the first off', async () => {
    const a = await create({ name: 'A', kind: 'flat-rate', rateBps: 500 });
    const b = await create({ name: 'B', kind: 'flat-rate', rateBps: 700 });
    if (!a.ok || !b.ok) throw new Error('create failed');
    await activate(a.value.id);
    const switched = await activate(b.value.id);
    expect(switched.ok && switched.value.activeStrategyId).toBe(b.value.id);
    expect([...strategies.rows.values()].filter((row) => row.active)).toHaveLength(1);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'tax.strategy.activate',
      before: { replacedActive: true },
    });
  });

  it('changes a strategy under its row lock and audits the old and new values', async () => {
    const made = await create({ name: 'A', kind: 'flat-rate', rateBps: 500 });
    if (!made.ok) throw new Error('create failed');
    const changed = await new UpdateTaxStrategy(gate, deps).execute(admin, {
      strategyId: made.value.id,
      body: { name: 'A2', kind: 'flat-rate', rateBps: 800 },
    });
    expect(changed.ok && changed.value).toMatchObject({ name: 'A2', updatedAt: T0 });
    expect(strategies.locked).toEqual([made.value.id]);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'tax.strategy.update',
      before: { kind: 'flat-rate', rateBps: 500, categoryCount: 0 },
      after: { kind: 'flat-rate', rateBps: 800, categoryCount: 0 },
    });
  });

  it('refuses to delete the active strategy, and deletes an inactive one', async () => {
    const made = await create({ name: 'A', kind: 'flat-rate', rateBps: 500 });
    if (!made.ok) throw new Error('create failed');
    await activate(made.value.id);
    const remove = (strategyId: unknown) =>
      new DeleteTaxStrategy(gate, deps).execute(admin, { strategyId });
    expect(await remove(made.value.id)).toEqual(err({ code: 'tax.strategy-active' }));
    await activate(null);
    expect(await remove(made.value.id)).toEqual(ok({ deleted: true }));
    expect(await remove(made.value.id)).toEqual(err({ code: 'tax.strategy-not-found' }));
    expect(audit.entries.at(-1)).toMatchObject({ action: 'tax.strategy.delete' });
  });

  it('answers not-found and format errors for a strategy id', async () => {
    expect(await activate(GHOST)).toEqual(err({ code: 'tax.strategy-not-found' }));
    expect(await activate('nope')).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'strategyId', code: 'format' }] }),
    );
    const update = await new UpdateTaxStrategy(gate, deps).execute(admin, {
      strategyId: GHOST,
      body: { name: 'A', kind: 'flat-rate', rateBps: 1 },
    });
    expect(update).toEqual(err({ code: 'tax.strategy-not-found' }));
  });

  it('refuses a category the Market does not have, listing the field', async () => {
    expect(await create({ ...byCategory, categoryRatesBps: { alcohol: 0 } })).toEqual(
      err({
        code: 'validation.failed',
        fields: [{ path: 'categoryRatesBps.alcohol', code: 'unknown-category' }],
      }),
    );
    expect(audit.entries).toEqual([]);
  });

  it('rounds each line half up under the active strategy', async () => {
    await create({ name: 'Flat', kind: 'flat-rate', rateBps: 1000 });
    const made = [...strategies.rows.values()][0]!;
    await activate(made.id);
    const answer = await calculate([line(1005n), line(1010n)]);
    const tax = answer.ok ? answer.value.lines.map((l) => l.tax) : [];
    // Inclusive prices (AU): 91 and 92 cents inside; exclusive prices (ZZ): 101 (100.5) and 101.
    expect(tax).toEqual(inclusive ? [91n, 92n] : [101n, 101n]);
  });

  it('refuses callers without the right actor and bad lines', async () => {
    expect(await calculate([line(1n)], admin)).toEqual(err({ code: 'access.denied' }));
    expect(await calculate([line(1n)], seller)).toEqual(err({ code: 'access.denied' }));
    expect(await list(customer)).toMatchObject({ ok: false });
    expect(await create(byCategory, customer)).toMatchObject({ ok: false });

    const bad = await calculate([
      { amount: -1n, taxInclusive: true, categoryCode: null },
      { amount: 5n, taxInclusive: 'yes', categoryCode: null },
      { amount: 5n, taxInclusive: true, categoryCode: 'alcohol' },
      { amount: 5n, taxInclusive: true },
    ]);
    expect(bad).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'lines.0.amount', code: 'range' },
          { path: 'lines.1.taxInclusive', code: 'type' },
          { path: 'lines.2.categoryCode', code: 'unknown-category' },
          { path: 'lines.3.categoryCode', code: 'unknown-category' },
        ],
      }),
    );
    expect(await calculate('x')).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'lines', code: 'range' }] }),
    );
  });
});
