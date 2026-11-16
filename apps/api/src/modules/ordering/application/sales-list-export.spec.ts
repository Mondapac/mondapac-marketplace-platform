import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import ExcelJS from 'exceljs';
import { FakeLabels } from '../../../../test/support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, XLSX_CONTENT_TYPE } from '../../../platform/list-export';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  DocumentCursor,
  DocumentListFilter,
  DocumentListRecord,
} from '../domain/admin-document-list';
import type { RefundCursor, RefundListFilter, RefundListRecord } from '../domain/admin-refund-list';
import type {
  ShipmentCursor,
  ShipmentListFilter,
  ShipmentListRecord,
} from '../domain/admin-shipment-list';
import type { AdminDocumentListReader } from './ports/admin-document-list.reader';
import type { AdminRefundListReader } from './ports/admin-refund-list.reader';
import type { AdminShipmentListReader } from './ports/admin-shipment-list.reader';
import { SALES_EXPORT_MAX_IDS, SALES_EXPORT_PAGE, zonedText } from './sales-list-export';
import { AdminExportDocuments } from './use-cases/admin-export-documents.use-case';
import { AdminExportRefunds } from './use-cases/admin-export-refunds.use-case';
import { AdminExportShipments } from './use-cases/admin-export-shipments.use-case';

// The Sales list exports (Shipments, Refunds, Invoices) in memory, on both Market fixtures: the
// view key, the query checks, the columns and their order, the selected rows, the cap, the zone of
// the times, the customer cells and the two formats. The readers' `ids` SQL is in the db specs.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T23:30:00Z');
const VIEW = 'ordering.order.view';
const ZONES: Readonly<Record<string, string>> = { AU: 'Australia/Brisbane', ZZ: 'Asia/Tokyo' };

/** A reader that pages its records by offset or by a cursor (an index into the records). */
class Pager<R, F extends { ids: readonly string[] | null }> {
  records: R[] = [];
  filters: F[] = [];
  total: number | null = null;
  constructor(private readonly idOf: (record: R) => string) {}
  pageOf(filter: F, offset: number, limit: number, after: unknown) {
    this.filters.push(filter);
    const chosen =
      filter.ids === null
        ? this.records
        : this.records.filter((record) => filter.ids!.includes(this.idOf(record)));
    const start =
      after === null || after === undefined
        ? offset
        : chosen.findIndex((record) => this.matches(record, after)) + 1;
    return Promise.resolve(chosen.slice(start, start + limit));
  }
  matches(record: R, after: unknown): boolean {
    return Object.values(after as object).includes(this.idOf(record));
  }
  countOf(filter: F) {
    if (this.total !== null) return Promise.resolve(this.total);
    return Promise.resolve(
      filter.ids === null
        ? this.records.length
        : this.records.filter((record) => filter.ids!.includes(this.idOf(record))).length,
    );
  }
}

class ShipmentReader
  extends Pager<ShipmentListRecord, ShipmentListFilter>
  implements AdminShipmentListReader
{
  constructor() {
    super((record) => record.sellerOrderId);
  }
  page(
    _m: MarketContext,
    filter: ShipmentListFilter,
    _s: unknown,
    offset: number,
    limit: number,
    after: ShipmentCursor | null = null,
  ) {
    return this.pageOf(filter, offset, limit, after);
  }
  count(_m: MarketContext, filter: ShipmentListFilter) {
    return this.countOf(filter);
  }
  countByStage() {
    // A narrower filter is counted; this answers the tab totals only.
    const n = this.total ?? this.records.length;
    return Promise.resolve({
      toPrepare: n,
      ready: 0,
      shipped: 0,
      delivered: 0,
      refunded: 0,
      attention: 0,
    });
  }
}

class RefundReader
  extends Pager<RefundListRecord, RefundListFilter>
  implements AdminRefundListReader
{
  constructor() {
    super((record) => record.refundId);
  }
  page(
    _m: MarketContext,
    filter: RefundListFilter,
    _s: unknown,
    offset: number,
    limit: number,
    after: RefundCursor | null = null,
  ) {
    return this.pageOf(filter, offset, limit, after);
  }
  count(_m: MarketContext, filter: RefundListFilter) {
    return this.countOf(filter);
  }
  countByState() {
    return Promise.resolve({ pending: this.records.length, succeeded: 0, failed: 0 });
  }
}

class DocumentReader
  extends Pager<DocumentListRecord, DocumentListFilter>
  implements AdminDocumentListReader
{
  constructor() {
    super((record) => record.documentId);
  }
  page(
    _m: MarketContext,
    filter: DocumentListFilter,
    _s: unknown,
    offset: number,
    limit: number,
    after: DocumentCursor | null = null,
  ) {
    return this.pageOf(filter, offset, limit, after).then((rows) =>
      rows.filter((row) => row.kind === filter.kind),
    );
  }
  count(_m: MarketContext, filter: DocumentListFilter) {
    return Promise.resolve(this.records.filter((row) => row.kind === filter.kind).length);
  }
  countByKind() {
    const of = (kind: string) => this.records.filter((row) => row.kind === kind).length;
    return Promise.resolve({
      orderConfirmations: of('order-confirmation'),
      creditNotes: of('credit-note'),
    });
  }
}

async function textOf(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += typeof chunk === 'string' ? chunk : '';
  return out.replace(/^\uFEFF/, '');
}

const linesOf = async (chunks: AsyncIterable<string | Uint8Array>) =>
  (await textOf(chunks)).split('\r\n').filter((line) => line !== '');

describe.each(['AU', 'ZZ'] as const)('admin Sales list exports in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const zone = ZONES[code]!;
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
    const gate = createUseCaseGate(markets, check);
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const labels = new FakeLabels();
    const shared = {
      unitOfWork,
      labels,
      clock: new FixedClock(T0),
      sheetWriter: new ExceljsSheetWriter(),
      zones: { zoneOf: (m: MarketContext) => ZONES[m.marketId]! },
    };
    const shipments = new ShipmentReader();
    const refunds = new RefundReader();
    const documents = new DocumentReader();
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return {
      context,
      labels,
      shipments,
      refunds,
      documents,
      exportShipments: new AdminExportShipments(gate, { ...shared, shipments }),
      exportRefunds: new AdminExportRefunds(gate, { ...shared, refunds }),
      exportDocuments: new AdminExportDocuments(gate, { ...shared, documents }),
    };
  }

  const money = (amount: bigint) => ({ amount, currency });

  const shipment = (overrides: Partial<ShipmentListRecord> = {}): ShipmentListRecord => ({
    sellerOrderId: ids.next<'SellerOrder'>(),
    orderId: ids.next<'Order'>(),
    sellerId: ids.next<'Seller'>(),
    accountId: ids.next<'Account'>(),
    paidAt: T0,
    deliveryMethod: 'instant',
    deliveryWindow: null,
    fulfilment: 'to-ship',
    readyAt: null,
    shippedAt: null,
    deliveredAt: null,
    carrier: null,
    trackingRef: null,
    fleet: null,
    deliveryAttention: null,
    shipping: money(500n),
    total: money(1500n),
    refunded: money(0n),
    ...overrides,
  });

  const fieldsOf = (result: Result<unknown, { code: string }>) =>
    !result.ok && 'fields' in result.error
      ? (result.error as { fields: { path: string; code: string }[] }).fields
      : [];

  const amount = (minor: bigint) =>
    currency === 'JPY' ? `${minor}` : (Number(minor) / 100).toFixed(2);

  it('needs ordering.order.view on each list, and reads nothing without it', async () => {
    for (const type of [AdminExportShipments, AdminExportRefunds, AdminExportDocuments]) {
      expect(type.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    }
    const { exportShipments, exportRefunds, exportDocuments, shipments, context } = setup([]);
    for (const use of [exportShipments, exportRefunds, exportDocuments]) {
      const result = await use.execute(context, {});
      expect(!result.ok && result.error.code).toBe('access.denied');
    }
    expect(shipments.filters).toEqual([]);
  });

  it('writes every shipment column with money split, times in the zone and the customer', async () => {
    const { exportShipments, shipments, labels, context } = setup();
    const row = shipment({
      deliveryMethod: 'scheduled',
      deliveryWindow: { start: T0, end: T0.add({ hours: 2 }) },
      fulfilment: 'shipped',
      readyAt: T0,
      shippedAt: T0,
      carrier: 'Acme, Couriers',
      trackingRef: 'TR 1',
      fleet: 'acme',
      deliveryAttention: 'carrier-unknown',
    });
    shipments.records = [row];
    labels.stores.set(row.sellerId, '=Store');
    labels.customers.set(row.accountId, { displayName: 'Sara', email: 'sara@example.test' });

    const result = await exportShipments.execute(context, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.filename).toBe(
      `shipments-${T0.toZonedDateTimeISO(zone).toPlainDate().toString()}.csv`,
    );
    expect(result.value.contentType).toBe('text/csv; charset=utf-8');
    const [header, line] = await linesOf(result.value.chunks);
    expect(header).toBe(
      'Order ID,Seller order ID,Stage,Delivery problem,Store,Seller ID,Customer,Customer email,' +
        'Paid,Delivery method,Window start,Window end,Carrier,Tracking reference,Fleet,Ready,' +
        'Shipped,Delivered,Delivery fee (incl. tax),Delivery fee (incl. tax) currency,' +
        'Total (incl. tax),Total (incl. tax) currency,Refunded (incl. tax),' +
        'Refunded (incl. tax) currency',
    );
    const at = zonedText(T0, zone);
    expect(at).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(line).toBe(
      [
        row.orderId,
        row.sellerOrderId,
        'shipped',
        'carrier-unknown',
        "'=Store",
        row.sellerId,
        'Sara',
        'sara@example.test',
        at,
        'scheduled',
        at,
        zonedText(T0.add({ hours: 2 }), zone),
        '"Acme, Couriers"',
        'TR 1',
        'acme',
        at,
        at,
        '',
        amount(500n),
        currency,
        amount(1500n),
        currency,
        amount(0n),
        currency,
      ].join(','),
    );
  });

  it('leaves the customer cells empty when the list has no customer (no customer key)', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const result = await exportShipments.execute(context, { columns: 'customer' });
    if (!result.ok) throw new Error(result.error.code);
    const [header, line] = await linesOf(result.value.chunks);
    expect(header).toBe('Order ID,Stage,Delivery problem,Customer,Customer email');
    expect(line!.endsWith(',to-prepare,,,')).toBe(true);
  });

  it('writes the fixed columns first, then the chosen ones in the order given', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const result = await exportShipments.execute(context, { columns: 'total,paid,total' });
    if (!result.ok) throw new Error(result.error.code);
    const [header] = await linesOf(result.value.chunks);
    expect(header).toBe(
      'Order ID,Stage,Delivery problem,Total (incl. tax),Total (incl. tax) currency,Paid',
    );
    const fixedOnly = await exportShipments.execute(context, { columns: '' });
    if (!fixedOnly.ok) throw new Error(fixedOnly.error.code);
    expect((await linesOf(fixedOnly.value.chunks))[0]).toBe('Order ID,Stage,Delivery problem');
  });

  it('refuses an unknown column, key, paging or sort key, format and zone, reading nothing', async () => {
    const { exportShipments, shipments, context } = setup();
    for (const [input, path] of [
      [{ columns: 'secret' }, 'columns'],
      [{ page: '2' }, 'page'],
      [{ sort: 'total' }, 'sort'],
      [{ cursor: 'x' }, 'cursor'],
      [{ other: '1' }, 'other'],
      [{ format: 'pdf' }, 'format'],
      [{ zone: 'Mars/Base' }, 'zone'],
      [{ ids: '' }, 'ids'],
      [{ ids: 'not-an-id' }, 'ids'],
    ] as const) {
      const result = await exportShipments.execute(context, input);
      expect(fieldsOf(result)).toEqual([expect.objectContaining({ path })]);
    }
    expect(shipments.filters).toEqual([]);
  });

  it('passes the list filter on and refuses what the list refuses', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const ok = await exportShipments.execute(context, { stage: 'ready', fleet: 'acme' });
    if (!ok.ok) throw new Error(ok.error.code);
    await textOf(ok.value.chunks);
    expect(shipments.filters[0]).toMatchObject({ stage: 'ready', fleet: 'acme', ids: null });
    const refused = await exportShipments.execute(context, { stage: 'lost' });
    expect(fieldsOf(refused)).toEqual([{ path: 'stage', code: 'value' }]);
  });

  it('exports only the selected rows, and refuses more than the selection limit or a repeat', async () => {
    const { exportShipments, shipments, context } = setup();
    const [a, b, c] = [shipment(), shipment(), shipment()];
    shipments.records = [a, b, c];
    const result = await exportShipments.execute(context, {
      ids: `${c.sellerOrderId},${a.sellerOrderId.toUpperCase()}`,
      columns: '',
    });
    if (!result.ok) throw new Error(result.error.code);
    const lines = await linesOf(result.value.chunks);
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([a.orderId, c.orderId]);
    expect(shipments.filters.every((f) => f.ids?.length === 2)).toBe(true);

    const many = Array.from({ length: SALES_EXPORT_MAX_IDS + 1 }, () => ids.next<'SellerOrder'>());
    const tooMany = await exportShipments.execute(context, { ids: many.join(',') });
    expect(!tooMany.ok && tooMany.error).toEqual({
      code: 'batch.too-large',
      max: SALES_EXPORT_MAX_IDS,
    });
    const repeat = await exportShipments.execute(context, {
      ids: `${a.sellerOrderId},${a.sellerOrderId}`,
    });
    expect(fieldsOf(repeat)).toEqual([{ path: 'ids', code: 'duplicate' }]);
  });

  it('refuses more than 10,000 matching rows whole, with the total, before any row', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    shipments.total = 10_001;
    const result = await exportShipments.execute(context, { fleet: 'acme' });
    expect(!result.ok && result.error).toEqual({
      code: 'batch.too-large',
      max: 10_000,
      total: 10_001,
    });
    expect(shipments.filters).toHaveLength(1);
  });

  it('streams every page through the cursor, newest payment first', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = Array.from({ length: SALES_EXPORT_PAGE + 3 }, (_, n) =>
      shipment({ paidAt: T0.subtract({ minutes: n }) }),
    );
    const result = await exportShipments.execute(context, { columns: '' });
    if (!result.ok) throw new Error(result.error.code);
    const lines = await linesOf(result.value.chunks);
    expect(lines).toHaveLength(SALES_EXPORT_PAGE + 4);
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(
      shipments.records.map((record) => record.orderId),
    );
  });

  it('writes the times in the zone asked for', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const result = await exportShipments.execute(context, { columns: 'paid', zone: 'UTC' });
    if (!result.ok) throw new Error(result.error.code);
    const [, line] = await linesOf(result.value.chunks);
    expect(line!.endsWith(',2026-11-15T23:30:00+00:00')).toBe(true);
    expect(result.value.filename).toBe('shipments-2026-11-15.csv');
  });

  it('writes an XLSX file whose cells are all text', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const result = await exportShipments.execute(context, { format: 'xlsx', columns: 'total' });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.contentType).toBe(XLSX_CONTENT_TYPE);
    expect(result.value.filename).toMatch(/^shipments-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const parts: Uint8Array[] = [];
    for await (const chunk of result.value.chunks) {
      parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Shipments')!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'Order ID',
      'Stage',
      'Delivery problem',
      'Total (incl. tax)',
      'Total (incl. tax) currency',
    ]);
    expect(sheet.getRow(2).getCell(4).value).toBe(amount(1500n));
  });

  it('exports refunds with their columns and selected refunds', async () => {
    const { exportRefunds, refunds, context } = setup();
    const refund: RefundListRecord = {
      refundId: ids.next<'Refund'>(),
      orderId: ids.next<'Order'>(),
      sellerOrderId: ids.next<'SellerOrder'>(),
      sellerId: ids.next<'Seller'>(),
      accountId: ids.next<'Account'>(),
      gross: money(1100n),
      tax: money(100n),
      shippingGross: money(0n),
      reason: 'item-unavailable',
      actor: 'admin',
      state: 'succeeded',
      lossBearer: 'platform',
      lossReasonCode: null,
      stripeRefundId: 're_123',
      requestedAt: T0,
      settledAt: null,
      ledgerRecordedAt: null,
      creditNoteId: null,
    };
    refunds.records = [refund];
    const result = await exportRefunds.execute(context, {
      ids: refund.refundId,
      columns: 'refundId,amount,stripeRefundId,settled',
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.filename).toMatch(/^refunds-/);
    expect(await linesOf(result.value.chunks)).toEqual([
      'Order ID,State,Refund ID,Amount (incl. tax),Amount (incl. tax) currency,' +
        'Stripe refund ID,Settled',
      `${refund.orderId},succeeded,${refund.refundId},${amount(1100n)},${currency},re_123,`,
    ]);
    expect(refunds.filters[0]!.ids).toEqual([refund.refundId]);
  });

  it('names the Invoices files by tab, never "invoices", and skips the credit note columns on confirmations', async () => {
    const { exportDocuments, documents, context } = setup();
    const base = {
      orderId: ids.next<'Order'>(),
      sellerOrderId: ids.next<'SellerOrder'>(),
      sellerId: ids.next<'Seller'>(),
      accountId: ids.next<'Account'>(),
      issuedAt: T0,
      total: money(2000n),
      tax: null,
      shipping: money(0n),
    };
    const confirmation: DocumentListRecord = {
      ...base,
      kind: 'order-confirmation',
      documentId: base.sellerOrderId,
      refundId: null,
      refundReason: null,
    };
    const credit: DocumentListRecord = {
      ...base,
      kind: 'credit-note',
      documentId: ids.next<'CreditNote'>(),
      refundId: ids.next<'Refund'>(),
      refundReason: 'damaged',
    };
    documents.records = [confirmation, credit];

    const confirmations = await exportDocuments.execute(context, {
      columns: 'documentId,refundId,reason,tax',
    });
    if (!confirmations.ok) throw new Error(confirmations.error.code);
    expect(confirmations.value.filename).toMatch(/^order-confirmations-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(await linesOf(confirmations.value.chunks)).toEqual([
      'Order ID,Tax,Tax currency',
      `${base.orderId},,`,
    ]);

    const notes = await exportDocuments.execute(context, {
      kind: 'credit-note',
      columns: 'documentId,refundId,reason',
    });
    if (!notes.ok) throw new Error(notes.error.code);
    expect(notes.value.filename).toMatch(/^credit-notes-/);
    expect(await linesOf(notes.value.chunks)).toEqual([
      'Order ID,Credit note ID,Refund ID,Reason',
      `${base.orderId},${credit.documentId},${credit.refundId},damaged`,
    ]);
  });

  it('reads the tab counts once, for the size, and never on the streamed pages', async () => {
    const { exportShipments, shipments, context } = setup();
    let counted = 0;
    const countByStage = shipments.countByStage.bind(shipments);
    shipments.countByStage = () => {
      counted += 1;
      return countByStage();
    };
    shipments.records = Array.from({ length: SALES_EXPORT_PAGE * 2 + 1 }, () => shipment());
    const result = await exportShipments.execute(context, { columns: '' });
    if (!result.ok) throw new Error(result.error.code);
    expect(await linesOf(result.value.chunks)).toHaveLength(SALES_EXPORT_PAGE * 2 + 2);
    expect(counted).toBe(1);
  });

  it('resolves a name search once for the whole file', async () => {
    const { exportShipments, shipments, labels, context } = setup();
    shipments.records = Array.from({ length: SALES_EXPORT_PAGE + 1 }, () => shipment());
    const result = await exportShipments.execute(context, { search: 'Sara', columns: '' });
    if (!result.ok) throw new Error(result.error.code);
    await textOf(result.value.chunks);
    expect(labels.calls.filter((call) => call.lookup === 'search-customers')).toHaveLength(1);
    expect(labels.calls.filter((call) => call.lookup === 'search-stores')).toHaveLength(1);
  });

  it('refuses a name search that matched too many parties, as the file would miss rows', async () => {
    const { exportShipments, shipments, labels, context } = setup();
    shipments.records = [shipment()];
    labels.searchCapped = true;
    const result = await exportShipments.execute(context, { search: 'Sara' });
    expect(fieldsOf(result)).toEqual([{ path: 'search', code: 'too-broad' }]);
  });

  it('refuses before the file, or fails the file, when the customer lookup fails', async () => {
    const { exportShipments, shipments, labels, context } = setup();
    shipments.records = Array.from({ length: SALES_EXPORT_PAGE + 1 }, () => shipment());
    labels.fail.add('customers');
    const before = await exportShipments.execute(context, {});
    expect(!before.ok && before.error.code).toBe('access.unavailable');

    labels.fail.clear();
    const started = await exportShipments.execute(context, {});
    if (!started.ok) throw new Error(started.error.code);
    labels.fail.add('customers');
    await expect(textOf(started.value.chunks)).rejects.toThrow(/lookup failed/);

    // A store name is advisory: the Seller ID cell stays, so the file goes on.
    labels.fail.clear();
    labels.fail.add('stores');
    const stores = await exportShipments.execute(context, { columns: 'store' });
    if (!stores.ok) throw new Error(stores.error.code);
    expect(await linesOf(stores.value.chunks)).toHaveLength(SALES_EXPORT_PAGE + 2);
  });

  it('fails the file when a page read fails while it streams', async () => {
    const { exportShipments, shipments, context } = setup();
    shipments.records = [shipment()];
    const page = shipments.page.bind(shipments);
    let reads = 0;
    shipments.page = (...args: Parameters<ShipmentReader['page']>) => {
      reads += 1;
      return reads === 1 ? page(...args) : Promise.reject(new Error('database gone'));
    };
    const result = await exportShipments.execute(context, {});
    if (!result.ok) throw new Error(result.error.code);
    await expect(textOf(result.value.chunks)).rejects.toThrow();
  });
});
