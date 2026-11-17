import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryDisputeStore } from '../../../../test/support/payments-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { SheetWriter } from '../../../platform/list-export';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerPaymentsDependencies } from './customer-payments-flow';
import { AdminCustomerDisputesExport } from './use-cases/admin-customer-disputes-export.use-case';
import { AdminCustomerDisputes } from './use-cases/admin-customer-disputes.use-case';
import { AdminCustomerPaymentsExport } from './use-cases/admin-customer-payments-export.use-case';
import { AdminCustomerPayments } from './use-cases/admin-customer-payments.use-case';

// One customer's payments and disputes for the customer page, in memory on both Market fixtures
// (AU in AUD, ZZ in JPY): the key, the closed filters, both paging modes, "Paid" from the captured
// orders, disputes of this customer's orders only and without provider ids, and both exports
// behind the customers export key and a fresh proof, audited without payment data.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T09:00:00Z');
const VIEW = 'payments.customer-payment.view';
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
/** A customer with more orders than the disputes scan takes, and one with exactly that many. */
const BULK_BUYER = id<'Account'>(0xb2);
const FULL_BUYER = id<'Account'>(0xb3);
const ORDER_A = id<'Order'>(0x2001);
const ORDER_B = id<'Order'>(0x2002);
const FOREIGN_ORDER = id<'Order'>(0x2009);

describe.each(['AU', 'ZZ'] as const)('a customer’s payments and disputes in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;

  function setup(orderingDenies = false) {
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
    const asked: unknown[] = [];
    const facts = [
      {
        orderId: ORDER_A,
        status: 'confirmed' as const,
        paymentState: 'captured' as const,
        amount: money(4500n, currency),
        providerPaymentId: 'pi_a',
        createdAt: NOW.subtract({ hours: 48 }),
        confirmedAt: NOW.subtract({ hours: 47 }),
      },
      {
        orderId: ORDER_B,
        status: 'cancelled' as const,
        paymentState: 'none' as const,
        amount: money(900n, currency),
        providerPaymentId: null,
        createdAt: NOW.subtract({ hours: 2 }),
        confirmedAt: null,
      },
    ];
    const ordering: CustomerPaymentsDependencies['ordering'] = {
      adminCustomerPayments: (_context, request) => {
        asked.push(request);
        if (orderingDenies) return Promise.resolve(err({ code: 'access.denied' }));
        const rows = facts.filter(
          (f) =>
            request.query.accountId === BUYER &&
            (request.query.paymentStates === null ||
              request.query.paymentStates.includes(f.paymentState)) &&
            (request.query.statuses === null || request.query.statuses.includes(f.status)) &&
            (request.query.from === null ||
              Temporal.Instant.compare(f.createdAt, request.query.from) >= 0) &&
            (request.query.to === null ||
              Temporal.Instant.compare(f.createdAt, request.query.to) < 0),
        );
        return Promise.resolve(
          ok({
            rows: rows.slice(request.window.offset, request.window.offset + request.window.limit),
            total: request.withTotal ? rows.length : null,
            paid: [money(4500n, currency)],
          }),
        );
      },
      adminCustomerOrderIds: (_context, request) => {
        const many = (count: number) =>
          Array.from({ length: Math.min(count, request.limit) }, (_, i) =>
            id<'Order'>(0x10000 + i),
          );
        if (request.accountId === BULK_BUYER) return Promise.resolve(ok(many(10_001)));
        if (request.accountId === FULL_BUYER) return Promise.resolve(ok(many(10_000)));
        return Promise.resolve(ok(request.accountId === BUYER ? [ORDER_B, ORDER_A] : []));
      },
    };
    const disputes = new MemoryDisputeStore();
    const dispute = (n: number, orderId: string, market: string, status = 'needs_response') =>
      disputes.rows.set(`d${n}`, {
        id: id<'Dispute'>(0x3000 + n),
        providerDisputeId: `dp_secret_${n}`,
        orderId,
        paymentIntentRef: `pi_secret_${n}`,
        amountMinor: 1000n * BigInt(n),
        currency,
        status: status as never,
        reason: 'fraudulent',
        evidenceDueBy: NOW.add({ hours: 24 * n }),
        fundsWithdrawn: true,
        fundsWithdrawnAt: NOW,
        fundsReinstated: false,
        fundsReinstatedAt: null,
        outcome: null,
        openedAt: NOW.subtract({ hours: n }),
        createdAt: NOW,
        updatedAt: NOW,
        lastReadAt: NOW,
        version: 1,
        market,
      });
    dispute(1, ORDER_A, code);
    dispute(2, ORDER_A, code, 'won');
    dispute(3, FOREIGN_ORDER, code);
    dispute(4, ORDER_A, code === 'AU' ? 'ZZ' : 'AU');
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
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const deps: CustomerPaymentsDependencies = {
      unitOfWork: {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork,
      ordering,
      disputes,
      audit: { record: (_c, e) => (audits.push(e), Promise.resolve()) },
      stepUp: consumer,
      sheetWriter,
      clock: new FixedClock(NOW),
    };
    let n = 0;
    const admin = (keys: readonly string[]) => {
      n += 1;
      const accountId = id<'Account'>(0xa000 + n);
      held.set(accountId, keys);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: id<'Session'>(0xc000 + n),
          sellerId: null,
        }),
      );
    };
    return {
      asked,
      audits,
      stepUp,
      admin,
      payments: new AdminCustomerPayments(gate, deps),
      paymentsExport: new AdminCustomerPaymentsExport(gate, deps),
      disputes: new AdminCustomerDisputes(gate, deps),
      disputesExport: new AdminCustomerDisputesExport(gate, deps),
    };
  }

  const text = async (chunks: AsyncIterable<string | Uint8Array>) => {
    let all = '';
    for await (const chunk of chunks) {
      all += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    }
    return all;
  };

  it('declares the payments and customers view keys, and the customers export key on the exports', () => {
    for (const useCase of [AdminCustomerPayments, AdminCustomerDisputes]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW, CUSTOMER_VIEW] });
    }
    for (const useCase of [AdminCustomerPaymentsExport, AdminCustomerDisputesExport]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [VIEW, CUSTOMER_VIEW, EXPORT],
      });
    }
  });

  it('refuses an admin who holds the payments key but not the customers view key', async () => {
    const t = setup();
    const payments = await t.payments.execute(t.admin([VIEW]), { accountId: BUYER });
    const disputes = await t.disputes.execute(t.admin([VIEW]), { accountId: BUYER });
    const exported = await t.disputesExport.execute(t.admin([VIEW, EXPORT]), { accountId: BUYER });
    expect([payments, disputes, exported].map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'access.denied',
      'access.denied',
      'access.denied',
    ]);
    expect(t.asked).toHaveLength(0);
  });

  it('pages the payments with their total and what the customer paid', async () => {
    const t = setup();
    const read = await t.payments.execute(t.admin(READ), {
      accountId: BUYER,
      filters: { paymentState: ['captured'] },
    });
    if (!read.ok) throw new Error(read.error.code);
    expect(read.value.total).toBe(1);
    expect(read.value.items).toEqual([
      {
        orderId: ORDER_A,
        status: 'confirmed',
        paymentState: 'captured',
        amount: { amount: 4500n, currency },
        providerPaymentId: 'pi_a',
        createdAt: NOW.subtract({ hours: 48 }).toString(),
        confirmedAt: NOW.subtract({ hours: 47 }).toString(),
      },
    ]);
    expect(read.value.paid).toEqual([{ amount: 4500n, currency }]);
    const prevNext = await t.payments.execute(t.admin(READ), {
      accountId: BUYER,
      paging: 'prev-next',
      pageSize: 1,
    });
    expect(prevNext.ok && [prevNext.value.total, prevNext.value.hasNext]).toEqual([null, true]);
    expect(t.asked[1]).toMatchObject({ window: { offset: 0, limit: 2 }, withTotal: false });
  });

  it('filters the payments by order status and by created between two instants', async () => {
    const t = setup();
    const statusOf = async (filters: object) => {
      const read = await t.payments.execute(t.admin(READ), { accountId: BUYER, filters });
      if (!read.ok) throw new Error(read.error.code);
      return read.value.items.map((item) => item.orderId);
    };
    expect(await statusOf({ status: ['cancelled'] })).toEqual([ORDER_B]);
    expect(t.asked[0]).toMatchObject({ query: { statuses: ['cancelled'], from: null, to: null } });
    const from = NOW.subtract({ hours: 50 }).toString();
    const to = NOW.subtract({ hours: 24 }).toString();
    expect(await statusOf({ from, to })).toEqual([ORDER_A]);
    expect(t.asked[1]).toMatchObject({
      query: { statuses: null, from: Temporal.Instant.from(from), to: Temporal.Instant.from(to) },
    });
  });

  it('refuses bad filters and callers without the key, and passes ordering’s denial on', async () => {
    const t = setup();
    const codeOf = async (input: object, keys = READ) => {
      const read = await t.payments.execute(t.admin(keys), input);
      return read.ok ? 'ok' : read.error.code;
    };
    expect(await codeOf({ accountId: BUYER, filters: { paymentState: ['paid'] } })).toBe(
      'validation.failed',
    );
    expect(await codeOf({ accountId: BUYER, filters: { from: 'yesterday' } })).toBe(
      'validation.failed',
    );
    expect(await codeOf({ accountId: BUYER, sort: 'provider' })).toBe('validation.failed');
    expect(await codeOf({ accountId: 'x' })).toBe('validation.failed');
    expect(await codeOf({ accountId: BUYER }, [])).toBe('access.denied');
    const denied = setup(true);
    const read = await denied.payments.execute(denied.admin(READ), { accountId: BUYER });
    expect(read.ok ? 'ok' : read.error.code).toBe('access.denied');
  });

  it('lists the disputes of this customer’s orders in this Market only, without provider ids', async () => {
    const t = setup();
    const read = await t.disputes.execute(t.admin(READ), { accountId: BUYER });
    if (!read.ok) throw new Error(read.error.code);
    expect(read.value.total).toBe(2);
    expect(read.value.items.map((d) => d.status)).toEqual(['needs_response', 'won']);
    expect(
      JSON.stringify(read.value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
    ).not.toMatch(/secret/);
    const open = await t.disputes.execute(t.admin(READ), {
      accountId: BUYER,
      filters: { status: ['won'] },
      sort: 'amount',
    });
    expect(open.ok && open.value.items.map((d) => d.amount)).toEqual([{ amount: 2000n, currency }]);
    const none = await t.disputes.execute(t.admin(READ), { accountId: id<'Account'>(0xb9) });
    expect(none.ok && none.value.total).toBe(0);
  });

  it('answers batch.too-large on disputes for a customer with more than 10,000 orders', async () => {
    const t = setup();
    const bulk = await t.disputes.execute(t.admin(READ), { accountId: BULK_BUYER });
    expect(bulk.ok ? 'ok' : bulk.error).toEqual({ code: 'batch.too-large', max: 10_000 });
    const bulkExport = await t.disputesExport.execute(t.admin([...READ, EXPORT]), {
      accountId: BULK_BUYER,
    });
    expect(bulkExport.ok ? 'ok' : bulkExport.error.code).toBe('batch.too-large');
    expect(t.audits).toHaveLength(0);
    const full = await t.disputes.execute(t.admin(READ), { accountId: FULL_BUYER });
    expect(full.ok && full.value.total).toBe(0);
  });

  it('exports both lists behind the export key and a fresh proof, audited by count only', async () => {
    const t = setup();
    const noKey = await t.paymentsExport.execute(t.admin(READ), { accountId: BUYER });
    expect(noKey.ok ? 'ok' : noKey.error.code).toBe('access.denied');
    const exporter = t.admin([...READ, EXPORT]);
    t.stepUp.refuse = true;
    const stale = await t.disputesExport.execute(exporter, { accountId: BUYER });
    expect(stale.ok ? 'ok' : stale.error.code).toBe('second-factor.required');
    expect(t.audits).toHaveLength(0);
    t.stepUp.refuse = false;
    const payments = await t.paymentsExport.execute(exporter, { accountId: BUYER });
    if (!payments.ok) throw new Error(payments.error.code);
    expect(payments.value.filename).toBe('customer-payments-2026-11-16.csv');
    expect((await text(payments.value.chunks)).trim().split('\n')).toHaveLength(3);
    const disputes = await t.disputesExport.execute(exporter, { accountId: BUYER, format: 'xlsx' });
    if (!disputes.ok) throw new Error(disputes.error.code);
    const sheet = await text(disputes.value.chunks);
    expect(sheet).not.toMatch(/secret/);
    expect(
      t.audits.map((a) => [a.action, a.targetId, (a.after as { rowCount: number }).rowCount]),
    ).toEqual([
      ['payments.customer-payments.exported', BUYER, 2],
      ['payments.customer-disputes.exported', BUYER, 2],
    ]);
  });
});
