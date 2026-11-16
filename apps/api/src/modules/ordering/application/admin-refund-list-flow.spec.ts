import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeLabels } from '../../../../test/support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  refundRowActions,
  type RefundCursor,
  type RefundListFilter,
  type RefundListRecord,
  type RefundSort,
} from '../domain/admin-refund-list';
import type { AdminRefundListReader } from './ports/admin-refund-list.reader';
import { AdminListRefunds } from './use-cases/admin-list-refunds.use-case';

// The admin Refunds list in memory, on both Market fixtures: the view key, every query check, the
// search resolved by the owning modules (and failing closed), the names that never fail the read,
// and the row actions. The SQL is in test/db/ordering-refund-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const VIEW = 'ordering.order.view';

/** Answers what it was given and remembers what it was asked. */
class RecordingReader implements AdminRefundListReader {
  records: RefundListRecord[] = [];
  asked: {
    filter: RefundListFilter;
    sort: RefundSort;
    offset: number;
    limit: number;
    after?: RefundCursor;
  }[] = [];
  counted = 0;
  page(
    _m: MarketContext,
    filter: RefundListFilter,
    sort: RefundSort,
    offset: number,
    limit: number,
    after: RefundCursor | null = null,
  ) {
    this.asked.push({ filter, sort, offset, limit, ...(after === null ? {} : { after }) });
    return Promise.resolve(this.records.slice(offset, offset + limit));
  }
  count() {
    this.counted += 1;
    return Promise.resolve(this.records.length);
  }
  countByState() {
    return Promise.resolve({ pending: 1, succeeded: 2, failed: 3 });
  }
}

describe.each(['AU', 'ZZ'] as const)('admin refund list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new SequenceIdGenerator(new FixedClock(T0));

  function setup(keys: readonly string[] = [VIEW]) {
    const check: AuthorisationCheck = {
      check: (_context, declaration) => {
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const reader = new RecordingReader();
    const labels = new FakeLabels();
    const list = new AdminListRefunds(createUseCaseGate(markets, check), {
      unitOfWork,
      refunds: reader,
      labels,
    });
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return { list, reader, labels, context };
  }

  const record = (overrides: Partial<RefundListRecord> = {}): RefundListRecord => ({
    refundId: ids.next<'Refund'>(),
    orderId: ids.next<'Order'>(),
    sellerOrderId: ids.next<'SellerOrder'>(),
    sellerId: ids.next<'Seller'>(),
    accountId: ids.next<'Account'>(),
    gross: { amount: 1100n, currency },
    tax: { amount: 100n, currency },
    shippingGross: { amount: 0n, currency },
    reason: 'damaged',
    actor: 'admin',
    state: 'succeeded',
    lossBearer: 'seller',
    lossReasonCode: null,
    stripeRefundId: 're_test_1',
    requestedAt: T0,
    settledAt: T0,
    ledgerRecordedAt: null,
    creditNoteId: ids.next<'CreditNote'>(),
    ...overrides,
  });

  const fieldsOf = (result: Result<unknown, { code: string }>) =>
    !result.ok && 'fields' in result.error
      ? (result.error as { fields: { path: string; code: string }[] }).fields
      : [];

  it('needs ordering.order.view', async () => {
    expect(AdminListRefunds.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    const { list, reader, context } = setup([]);
    const result = await list.execute(context, {});
    expect(!result.ok && result.error.code).toBe('access.denied');
    expect(reader.asked).toEqual([]);
  });

  it('answers the first page, newest first, with the state counts as the total', async () => {
    const { list, reader, context } = setup();
    reader.records = [record(), record()];
    const result = await list.execute(context, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(reader.counted).toBe(0);
    expect(result.value).toMatchObject({
      total: 6,
      nextCursor: null,
      page: 1,
      pageSize: 25,
      counts: { pending: 1, succeeded: 2, failed: 3 },
      searchCapped: false,
      searchScope: null,
    });
    expect(reader.asked[0]).toMatchObject({
      sort: { key: 'requested', direction: 'desc' },
      offset: 0,
      limit: 25,
    });
  });

  it('passes every filter to the reader, parsed', async () => {
    const { list, reader, context } = setup();
    const sellerId = ids.next<'Seller'>();
    const reference = ids.next<'Order'>();
    const result = await list.execute(context, {
      page: 3,
      pageSize: 10,
      sort: 'amount',
      direction: 'asc',
      state: 'pending',
      q: ` ${reference.toUpperCase()} `,
      reason: 'item-unavailable',
      actor: 'seller',
      lossBearer: 'platform',
      ledger: 'waiting',
      sellerId,
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
      minAmount: '100',
      maxAmount: '5000',
    });
    expect(result.ok).toBe(true);
    expect(reader.asked[0]).toEqual({
      filter: {
        state: 'pending',
        reference,
        stripeRefundId: null,
        reason: 'item-unavailable',
        actor: 'seller',
        lossBearer: 'platform',
        ledger: 'waiting',
        sellerId,
        from: Temporal.Instant.from('2026-11-01T00:00:00Z'),
        to: Temporal.Instant.from('2026-11-02T00:00:00Z'),
        minAmount: 100n,
        maxAmount: 5000n,
        parties: null,
      },
      sort: { key: 'amount', direction: 'asc' },
      offset: 20,
      limit: 10,
    });
  });

  it('takes a state tab total from the counts and counts only a narrower filter', async () => {
    const { list, reader, context } = setup();
    const total = async (input: Record<string, unknown>) => {
      const result = await list.execute(context, input);
      return result.ok ? result.value.total : null;
    };
    expect(await total({ state: 'pending' })).toBe(1);
    expect(await total({ state: 'failed' })).toBe(3);
    expect(reader.counted).toBe(0);
    reader.records = [record()];
    expect(await total({ state: 'succeeded', ledger: 'recorded' })).toBe(1);
    expect(reader.counted).toBe(1);
  });

  it('walks Previous/Next pages newest request first, past row 10,000, with no total', async () => {
    const { list, reader, context } = setup();
    const rows = [record(), record(), record()];
    reader.records = rows;
    const first = await list.execute(context, { limit: 2 });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value).toMatchObject({ total: null, page: null, pageSize: 2 });
    expect(first.value.nextCursor).toBe(
      `${rows[1]!.requestedAt.epochMilliseconds}.${rows[1]!.refundId}`,
    );
    expect(reader.asked[0]).toMatchObject({
      sort: { key: 'requested', direction: 'desc' },
      offset: 0,
      limit: 3,
    });
    reader.records = [rows[2]!];
    const last = await list.execute(context, { cursor: first.value.nextCursor, limit: 2 });
    expect(reader.asked[1]!.after).toEqual({
      requestedAt: rows[1]!.requestedAt,
      refundId: rows[1]!.refundId,
    });
    expect(last.ok && last.value.nextCursor).toBeNull();
    expect(reader.counted).toBe(0);

    const refused = await list.execute(context, { cursor: 'x', limit: 101, sort: 'amount' });
    expect(fieldsOf(refused).map((f) => `${f.path}:${f.code}`)).toEqual([
      'sort:with-cursor',
      'cursor:format',
      'limit:range',
    ]);
  });

  it('reads a Stripe refund id as an exact Stripe reference', async () => {
    const { list, reader, context } = setup();
    await list.execute(context, { q: 're_3PqAbC12' });
    expect(reader.asked[0]!.filter).toMatchObject({
      stripeRefundId: 're_3PqAbC12',
      reference: null,
    });
  });

  it('refuses every malformed field at once, before reading', async () => {
    const { list, reader, context } = setup();
    const result = await list.execute(context, {
      page: 0,
      pageSize: 101,
      sort: 'customer',
      direction: 'up',
      state: 'refunded',
      q: 'not an id',
      search: 'x',
      reason: 'changed-mind',
      actor: 'system',
      lossBearer: 'nobody',
      ledger: 'maybe',
      sellerId: 'abc',
      from: 'yesterday',
      to: '2026-11-02',
      minAmount: '-1',
      maxAmount: '1.5',
    });
    expect(!result.ok && result.error.code).toBe('validation.failed');
    expect(fieldsOf(result).map((f) => `${f.path}:${f.code}`)).toEqual([
      'page:range',
      'pageSize:range',
      'sort:value',
      'direction:value',
      'state:value',
      'reason:value',
      'actor:value',
      'lossBearer:value',
      'ledger:value',
      'q:format',
      'search:length',
      'sellerId:format',
      'from:format',
      'to:format',
      'minAmount:format',
      'maxAmount:format',
    ]);
    expect(reader.asked).toEqual([]);
  });

  it('refuses reversed ranges and pages past 10,000 rows', async () => {
    const { list, context } = setup();
    const reversed = await list.execute(context, {
      from: '2026-11-02T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      minAmount: '500',
      maxAmount: '100',
    });
    expect(fieldsOf(reversed)).toEqual([
      { path: 'to', code: 'range' },
      { path: 'maxAmount', code: 'range' },
    ]);
    const deep = await list.execute(context, { page: 101, pageSize: 100 });
    expect(fieldsOf(deep)).toEqual([{ path: 'page', code: 'too-deep' }]);
  });

  it('resolves the search through the owning modules and reports its scope', async () => {
    const { list, reader, labels, context } = setup();
    const accountId = ids.next<'Account'>();
    const sellerId = ids.next<'Seller'>();
    labels.customers.set(accountId, { displayName: 'Amina K', email: 'a@example.test' });
    labels.stores.set(sellerId, 'Amin Grocers');
    labels.searchCapped = true;
    const result = await list.execute(context, { search: 'amin' });
    if (!result.ok) throw new Error(result.error.code);
    expect(reader.asked[0]!.filter.parties).toEqual({
      accountIds: [accountId],
      sellerIds: [sellerId],
    });
    expect(result.value).toMatchObject({ searchCapped: true, searchScope: 'customers-and-stores' });

    labels.customerSearchDenied = true;
    const storesOnly = await list.execute(context, { search: 'amin' });
    expect(storesOnly.ok && storesOnly.value.searchScope).toBe('stores');
  });

  it('fails closed when the search cannot run: no unfiltered rows', async () => {
    const { list, reader, labels, context } = setup();
    labels.fail.add('stores');
    const result = await list.execute(context, { search: 'amin' });
    expect(!result.ok && result.error.code).toBe('ordering.search-unavailable');
    expect(reader.asked).toEqual([]);
  });

  it('adds store and customer names, and leaves them null when a lookup fails', async () => {
    const { list, reader, labels, context } = setup();
    const row = record();
    reader.records = [row];
    labels.stores.set(row.sellerId, 'Halal Corner');
    labels.customers.set(row.accountId, { displayName: 'Omar', email: 'o@example.test' });
    const named = await list.execute(context, {});
    expect(named.ok && named.value.rows[0]).toMatchObject({
      storeName: 'Halal Corner',
      customer: { displayName: 'Omar', email: 'o@example.test' },
    });
    labels.fail.add('stores');
    labels.fail.add('customers');
    const unnamed = await list.execute(context, {});
    expect(unnamed.ok && unnamed.value.rows[0]).toMatchObject({ storeName: null, customer: null });
  });

  it('allows the Stripe reference action only once Stripe made the refund', () => {
    expect(refundRowActions(record())).toEqual(['view-order', 'copy-stripe-reference']);
    expect(refundRowActions(record({ state: 'pending', stripeRefundId: null }))).toEqual([
      'view-order',
    ]);
  });
});
