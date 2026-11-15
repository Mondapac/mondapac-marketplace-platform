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
  documentRowActions,
  type DocumentListFilter,
  type DocumentListRecord,
  type DocumentSort,
} from '../domain/admin-document-list';
import type { AdminDocumentListReader } from './ports/admin-document-list.reader';
import { AdminListDocuments } from './use-cases/admin-list-documents.use-case';

// The admin Invoices list in memory, on both Market fixtures: the view key, the kind (one tab at a
// time, order confirmations by default), every query check, the search failing closed, the rows
// that never carry a document number yet, and the row actions. The SQL is in
// test/db/ordering-document-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const VIEW = 'ordering.order.view';

class RecordingReader implements AdminDocumentListReader {
  records: DocumentListRecord[] = [];
  asked: { filter: DocumentListFilter; sort: DocumentSort; offset: number; limit: number }[] = [];
  page(
    _m: MarketContext,
    filter: DocumentListFilter,
    sort: DocumentSort,
    offset: number,
    limit: number,
  ) {
    this.asked.push({ filter, sort, offset, limit });
    return Promise.resolve(this.records.slice(offset, offset + limit));
  }
  count() {
    return Promise.resolve(this.records.length);
  }
  countByKind() {
    return Promise.resolve({ orderConfirmations: 7, creditNotes: 2 });
  }
}

describe.each(['AU', 'ZZ'] as const)('admin document list in market %s', (code) => {
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
    const list = new AdminListDocuments(createUseCaseGate(markets, check), {
      unitOfWork,
      documents: reader,
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

  const record = (overrides: Partial<DocumentListRecord> = {}): DocumentListRecord => {
    const sellerOrderId = ids.next<'SellerOrder'>();
    return {
      kind: 'order-confirmation',
      documentId: sellerOrderId,
      orderId: ids.next<'Order'>(),
      sellerOrderId,
      sellerId: ids.next<'Seller'>(),
      accountId: ids.next<'Account'>(),
      issuedAt: T0,
      total: { amount: 3850n, currency },
      tax: { amount: 350n, currency },
      shipping: { amount: 550n, currency },
      refundId: null,
      refundReason: null,
      ...overrides,
    };
  };

  const fieldsOf = (result: Result<unknown, { code: string }>) =>
    !result.ok && 'fields' in result.error
      ? (result.error as { fields: { path: string; code: string }[] }).fields
      : [];

  it('needs ordering.order.view', async () => {
    expect(AdminListDocuments.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    const { list, reader, context } = setup([]);
    const result = await list.execute(context, {});
    expect(!result.ok && result.error.code).toBe('access.denied');
    expect(reader.asked).toEqual([]);
  });

  it('reads order confirmations by default, newest first, with the kind counts', async () => {
    const { list, reader, context } = setup();
    reader.records = [record()];
    const result = await list.execute(context, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(reader.asked[0]).toMatchObject({
      filter: { kind: 'order-confirmation' },
      sort: { key: 'issued', direction: 'desc' },
      offset: 0,
      limit: 25,
    });
    expect(result.value).toMatchObject({
      total: 1,
      counts: { orderConfirmations: 7, creditNotes: 2 },
    });
    expect(result.value.rows[0]).toMatchObject({
      documentNumber: null,
      actions: ['view-order', 'download-order-document'],
    });
  });

  it('passes every filter to the reader, parsed', async () => {
    const { list, reader, context } = setup();
    const sellerId = ids.next<'Seller'>();
    const reference = ids.next<'Refund'>();
    await list.execute(context, {
      kind: 'credit-note',
      page: 2,
      pageSize: 50,
      sort: 'amount',
      direction: 'asc',
      q: reference.toUpperCase(),
      sellerId,
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
      minAmount: '1',
      maxAmount: '99',
    });
    expect(reader.asked[0]).toEqual({
      filter: {
        kind: 'credit-note',
        reference,
        sellerId,
        from: Temporal.Instant.from('2026-11-01T00:00:00Z'),
        to: Temporal.Instant.from('2026-11-02T00:00:00Z'),
        minAmount: 1n,
        maxAmount: 99n,
        parties: null,
      },
      sort: { key: 'amount', direction: 'asc' },
      offset: 50,
      limit: 50,
    });
  });

  it('refuses every malformed field at once, before reading', async () => {
    const { list, reader, context } = setup();
    const result = await list.execute(context, {
      kind: 'tax-invoice',
      page: -1,
      sort: 'number',
      q: 'INV-1',
      search: ' ',
      sellerId: 1,
      from: '2026-11-02T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      minAmount: '9',
      maxAmount: '1',
    });
    expect(fieldsOf(result).map((f) => `${f.path}:${f.code}`)).toEqual([
      'kind:value',
      'page:range',
      'sort:value',
      'q:format',
      'search:length',
      'sellerId:format',
      'to:range',
      'maxAmount:range',
    ]);
    expect(reader.asked).toEqual([]);
  });

  it('fails closed when the search cannot run', async () => {
    const { list, reader, labels, context } = setup();
    labels.fail.add('stores');
    const result = await list.execute(context, { search: 'amin' });
    expect(!result.ok && result.error.code).toBe('ordering.search-unavailable');
    expect(reader.asked).toEqual([]);
  });

  it('lets a credit note open its order only', () => {
    expect(
      documentRowActions(
        record({ kind: 'credit-note', refundId: ids.next<'Refund'>(), refundReason: 'damaged' }),
      ),
    ).toEqual(['view-order']);
  });
});
