import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { SheetWriter } from '../../../platform/list-export';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { Refund } from '../domain/refund';
import type { AccountRefundQuery, RefundRepository } from './ports/refund.repository';
import { AdminCustomerRefundsExport } from './use-cases/admin-customer-refunds-export.use-case';
import { AdminCustomerRefundsList } from './use-cases/admin-customer-refunds-list.use-case';

// The customer page's Refunds super list in memory on both Market fixtures (AU in AUD, ZZ in
// JPY): the keys, the closed filters, both sorts, both paging modes, another customer's and
// another Market's refunds never shown, and the export (step-up spent, audit row, cap).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T09:00:00Z');
const VIEW = 'ordering.order.view';
const CUSTOMER_VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
/** What a customer-page tab needs: the owning module's key and customers' view key. */
const READ = [VIEW, CUSTOMER_VIEW];
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const BUYER = id<'Account'>(0xb1);
const OTHER = id<'Account'>(0xb2);

/** Refunds by Market with the account that placed the order, filtered as the database does. */
class AccountRefunds {
  readonly rows: { market: string; accountId: string; refund: Refund }[] = [];

  #match(market: MarketContext, query: AccountRefundQuery) {
    return this.rows.filter(
      (row) =>
        row.market === market.marketId &&
        row.accountId === query.accountId &&
        (query.states === null || query.states.includes(row.refund.state)) &&
        (query.reasons === null || query.reasons.includes(row.refund.reason)) &&
        (query.from === null ||
          Temporal.Instant.compare(row.refund.requestedAt, query.from) >= 0) &&
        (query.to === null || Temporal.Instant.compare(row.refund.requestedAt, query.to) < 0),
    );
  }

  readonly repository = {
    pageForAccount: (
      market: MarketContext,
      query: AccountRefundQuery,
      order: { sort: 'requested' | 'amount'; direction: 'asc' | 'desc' },
      window: { offset: number; limit: number },
    ) => {
      const sign = order.direction === 'asc' ? 1 : -1;
      const sorted = this.#match(market, query).sort((a, b) => {
        const by =
          order.sort === 'amount'
            ? Number(a.refund.gross - b.refund.gross)
            : Temporal.Instant.compare(a.refund.requestedAt, b.refund.requestedAt);
        return sign * (by !== 0 ? by : a.refund.id < b.refund.id ? -1 : 1);
      });
      return Promise.resolve(
        sorted
          .slice(window.offset, window.offset + window.limit)
          .map((row) => ({ refund: row.refund, creditNoteId: null })),
      );
    },
    countForAccount: (market: MarketContext, query: AccountRefundQuery) =>
      Promise.resolve(this.#match(market, query).length),
  } as unknown as RefundRepository;
}

describe.each(['AU', 'ZZ'] as const)('the customer refunds super list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  let n = 0;
  const refund = (over: Partial<Refund>): Refund => {
    n += 1;
    return {
      id: id<'Refund'>(0x1000 + n),
      orderId: id<'Order'>(0x2000 + n),
      sellerOrderId: id<'SellerOrder'>(0x3000 + n),
      sellerId: id<'Seller'>(0x51),
      currency,
      gross: 1000n,
      tax: 91n,
      shipping: null,
      reason: 'damaged',
      lossBearer: 'seller',
      lossReasonCode: null,
      actor: { population: 'admin', accountId: id<'Account'>(0xad) },
      state: 'succeeded',
      stripeIdempotencyKey: `refund-${n}`,
      stripeRefundId: 're_secret',
      attempts: 1,
      requestedAt: NOW.subtract({ hours: n }),
      settledAt: NOW,
      lines: [],
      ...over,
    };
  };

  function setup() {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const keys =
          context.actor.kind === 'authenticated' ? (held.get(context.actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const store = new AccountRefunds();
    const audits: AuditEntry[] = [];
    const stepUp = { refuse: false };
    const consumer: StepUpProofConsumer = {
      consume: (_context: CallContext, actionKey: string) =>
        Promise.resolve(
          stepUp.refuse
            ? err({ code: 'second-factor.required', actionKey })
            : ok({ sessionId: id<'Session'>(0x99), verifiedAt: NOW }),
        ),
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const deps = {
      unitOfWork,
      refunds: store.repository,
      audit: { record: (_c: CallContext, e: AuditEntry) => (audits.push(e), Promise.resolve()) },
      stepUp: consumer,
      sheetWriter,
      clock: new FixedClock(NOW),
    };
    let admins = 0;
    const admin = (keys: readonly string[], inMarket: MarketContext = market) => {
      admins += 1;
      const accountId = id<'Account'>(0xa000 + admins);
      held.set(accountId, keys);
      return testCallContext(
        inMarket,
        testAuthenticatedActor(inMarket, {
          population: 'admin',
          accountId,
          sessionId: id<'Session'>(0xc000 + admins),
          sellerId: null,
        }),
      );
    };
    return {
      store,
      audits,
      stepUp,
      admin,
      list: new AdminCustomerRefundsList(gate, deps),
      export: new AdminCustomerRefundsExport(gate, deps),
    };
  }

  const seeded = () => {
    const t = setup();
    t.store.rows.push(
      { market: code, accountId: BUYER, refund: refund({ gross: 500n }) },
      { market: code, accountId: BUYER, refund: refund({ state: 'failed', gross: 3000n }) },
      { market: code, accountId: BUYER, refund: refund({ reason: 'not-received', gross: 2000n }) },
      { market: code, accountId: OTHER, refund: refund({}) },
      { market: other.marketId, accountId: BUYER, refund: refund({}) },
    );
    return t;
  };

  const ids = (result: Result<{ items: readonly { refundId: string }[] }, unknown>) =>
    result.ok ? result.value.items.map((item) => item.refundId) : result;

  it('declares the order and customers view keys, and the customers export key on the export', () => {
    expect(AdminCustomerRefundsList.access.rule).toEqual({
      kind: 'permissions',
      allOf: [VIEW, CUSTOMER_VIEW],
    });
    expect(AdminCustomerRefundsExport.access.rule).toEqual({
      kind: 'permissions',
      allOf: [VIEW, CUSTOMER_VIEW, EXPORT],
    });
  });

  it('refuses an admin who holds the order view key but not the customers view key', async () => {
    const t = setup();
    const read = await t.list.execute(t.admin([VIEW]), { accountId: BUYER });
    const exported = await t.export.execute(t.admin([VIEW, EXPORT]), { accountId: BUYER });
    expect([read, exported].map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'access.denied',
      'access.denied',
    ]);
  });

  it('lists only this customer’s refunds of this Market, newest first, with a total', async () => {
    const t = seeded();
    const read = await t.list.execute(t.admin(READ), { accountId: BUYER });
    expect(read.ok && read.value.total).toBe(3);
    expect(read.ok && read.value.items.map((item) => item.amount)).toEqual([
      { amount: 500n, currency },
      { amount: 3000n, currency },
      { amount: 2000n, currency },
    ]);
    expect(
      JSON.stringify(read, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('re_secret');
  });

  it('filters by state, reason and instants, sorts by amount and pages both ways', async () => {
    const t = seeded();
    const ctx = t.admin(READ);
    const all = t.store.rows.filter((r) => r.market === code && r.accountId === BUYER);
    expect(
      ids(await t.list.execute(ctx, { accountId: BUYER, filters: { state: ['failed'] } })),
    ).toEqual([all[1]!.refund.id]);
    expect(
      ids(await t.list.execute(ctx, { accountId: BUYER, filters: { reason: ['not-received'] } })),
    ).toEqual([all[2]!.refund.id]);
    expect(
      ids(
        await t.list.execute(ctx, {
          accountId: BUYER,
          filters: { from: all[1]!.refund.requestedAt.toString() },
        }),
      ),
    ).toEqual([all[0]!.refund.id, all[1]!.refund.id]);
    expect(
      ids(await t.list.execute(ctx, { accountId: BUYER, sort: 'amount', direction: 'asc' })),
    ).toEqual([all[0]!.refund.id, all[2]!.refund.id, all[1]!.refund.id]);
    const first = await t.list.execute(ctx, { accountId: BUYER, pageSize: 2, paging: 'prev-next' });
    expect(first.ok && { total: first.value.total, hasNext: first.value.hasNext }).toEqual({
      total: null,
      hasNext: true,
    });
    const second = await t.list.execute(ctx, { accountId: BUYER, pageSize: 2, page: 2 });
    expect(second.ok && { total: second.value.total, hasNext: second.value.hasNext }).toEqual({
      total: 3,
      hasNext: false,
    });
  });

  it('refuses a closed-body violation, a bad filter and callers without the key', async () => {
    const t = seeded();
    const ctx = t.admin(READ);
    const code = async (input: object) => {
      const read = await t.list.execute(ctx, input);
      return read.ok ? 'ok' : read.error.code;
    };
    expect(await code({ accountId: BUYER, filters: { state: ['lost'] } })).toBe(
      'validation.failed',
    );
    expect(await code({ accountId: BUYER, filters: { from: '2026-11-01' } })).toBe(
      'validation.failed',
    );
    expect(await code({ accountId: BUYER, filters: { nope: 1 } })).toBe('validation.failed');
    expect(await code({ accountId: 'nope' })).toBe('validation.failed');
    expect(await code({ accountId: BUYER, sort: 'state' })).toBe('validation.failed');
    const denied = await t.list.execute(t.admin([]), { accountId: BUYER });
    expect(denied.ok ? 'ok' : denied.error.code).toBe('access.denied');
  });

  it('exports behind the export key and a fresh proof, audited without refund data', async () => {
    const t = seeded();
    const noKey = await t.export.execute(t.admin(READ), { accountId: BUYER });
    expect(noKey.ok ? 'ok' : noKey.error.code).toBe('access.denied');
    const exporter = t.admin([...READ, EXPORT]);
    t.stepUp.refuse = true;
    const stale = await t.export.execute(exporter, { accountId: BUYER });
    expect(stale.ok ? 'ok' : stale.error.code).toBe('second-factor.required');
    expect(t.audits).toHaveLength(0);
    t.stepUp.refuse = false;
    const file = await t.export.execute(exporter, { accountId: BUYER, format: 'csv' });
    if (!file.ok) throw new Error('export failed');
    let text = '';
    for await (const chunk of file.value.chunks) text += String(chunk);
    expect(file.value.filename).toBe('customer-refunds-2026-11-16.csv');
    expect(text.trim().split('\n')).toHaveLength(4);
    expect(text).not.toContain('re_secret');
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({
      action: 'ordering.customer-refunds.exported',
      targetId: BUYER,
      after: { format: 'csv', rowCount: 3 },
    });
  });
});
