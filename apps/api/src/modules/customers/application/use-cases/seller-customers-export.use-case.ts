import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CUSTOMERS_SELLER_CUSTOMERS_EXPORT,
  CUSTOMERS_SELLER_CUSTOMERS_VIEW,
} from '../../contracts/permissions';
import { SellerCustomersExported } from '../../domain/audit';
import { SELLER_CUSTOMER_MAX_SELECTED } from '../../domain/seller-customers';
import { XLSX_CONTENT_TYPE } from '../ports/sheet-writer';
import {
  customerCodeOf,
  invalid,
  isRecord,
  selectorOf,
  sellerOfCall,
  sellerRowOfRecord,
  type SellerCustomerDependencies,
  type SellerCustomerRowView,
} from '../seller-customers-flow';
import type { SellerCustomersCodesFailure } from './seller-customers-codes.use-case';

/** Rows read per chunk while the file streams. */
const CHUNK = 500;
/** Codes one request may name (the page's selection); "select all" goes by the filter. */
const MAX_CODES = 1000;

const HEADERS = [
  'Customer code',
  'First name',
  'Orders',
  'Spent (minor units)',
  'Currency',
  'First order',
  'Last order',
  'Follower',
  'Followed since',
] as const;

const cells = (row: SellerCustomerRowView): string[] => [
  row.code,
  row.firstName ?? '',
  String(row.orderCount),
  row.spentMinor ?? '',
  row.currency ?? '',
  row.firstOrderAt ?? '',
  row.lastOrderAt ?? '',
  row.follower ? 'yes' : 'no',
  row.followedAt ?? '',
];

export interface SellerCustomersExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

const OWN_KEYS = new Set(['format', 'codes', 'view', 'q', 'filters']);

/**
 * `customers.seller-customers-export`: the shop's customers as a CSV or XLSX file: code, first
 * name and the numbers with this shop. The rows are the named `codes` (at most 1000; a code the
 * shop never gave is dropped) or what `view`, `q` and `filters` match (at most 10,000; more is
 * refused whole). Rule: the seller keys `customers.seller-customers.view` and `.export`, denied
 * while the shop is not approved; the shop is the session's; a Login as Seller session is
 * refused. CSV cells pass the shared formula guard; XLSX cells are string values. The audit row holds the format, the count and how the rows were picked.
 */
export class SellerCustomersExport extends UseCase<
  unknown,
  SellerCustomersExportOutput,
  SellerCustomersCodesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-customers-export',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_SELLER_CUSTOMERS_VIEW.key, CUSTOMERS_SELLER_CUSTOMERS_EXPORT.key],
    },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SellerCustomersExportOutput, SellerCustomersCodesFailure>> {
    const sellerId = sellerOfCall(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    for (const key of Object.keys(input)) if (!OWN_KEYS.has(key)) return invalid(key, 'unknown');
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');

    let named: readonly string[] | null = null;
    if (input['codes'] !== undefined) {
      const raw = input['codes'];
      if (!Array.isArray(raw)) return invalid('codes', 'type');
      if (raw.length === 0) return invalid('codes', 'required');
      if (raw.length > MAX_CODES)
        return err({ code: 'batch.too-large', max: MAX_CODES, total: raw.length });
      const codes = new Set<string>();
      for (const part of raw as unknown[]) {
        const code = customerCodeOf(part);
        if (code === null) return invalid('codes', 'format');
        codes.add(code);
      }
      named = [...codes];
    }
    const selector = selectorOf(input);
    if (!selector.ok) return selector;
    const { deps } = this;
    const { market } = context;
    const query = { sellerId, selector: selector.value };

    const picked = await deps.unitOfWork.run<readonly string[], SellerCustomersCodesFailure>(
      market,
      async () => {
        let codes: readonly string[];
        if (named !== null) {
          codes = (await deps.sellerCustomers.findByCodes(market, sellerId, named)).map(
            (row) => row.code,
          );
        } else {
          const rows = await deps.sellerCustomers.page(
            market,
            query,
            { sort: 'code', direction: 'asc' },
            { offset: 0, limit: SELLER_CUSTOMER_MAX_SELECTED + 1 },
          );
          if (rows.length > SELLER_CUSTOMER_MAX_SELECTED) {
            const total = await deps.sellerCustomers.count(market, query);
            return err({ code: 'batch.too-large', max: SELLER_CUSTOMER_MAX_SELECTED, total });
          }
          codes = rows.map((row) => row.code);
        }
        await deps.audit.record(
          context,
          SellerCustomersExported.entry(sellerId, {
            after: {
              format,
              rowCount: codes.length,
              selection: named !== null ? 'codes' : 'filter',
            },
          }),
        );
        return ok(codes);
      },
    );
    if (!picked.ok) return picked;

    const day = deps.clock.now().toString().slice(0, 10);
    const rows = this.#rows(context, sellerId, picked.value);
    if (format === 'xlsx') {
      return ok({
        filename: `customers-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Customers', flat(rows)),
      });
    }
    return ok({
      filename: `customers-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  async *#rows(
    context: CallContext,
    sellerId: Id<'Seller'>,
    codes: readonly string[],
  ): AsyncGenerator<readonly (readonly string[])[]> {
    const { deps } = this;
    yield [[...HEADERS]];
    for (let start = 0; start < codes.length; start += CHUNK) {
      const chunk = codes.slice(start, start + CHUNK);
      const read = await deps.unitOfWork.run(
        context.market,
        async () => ok(await deps.sellerCustomers.findByCodes(context.market, sellerId, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('customers.seller-customers-export: the read failed');
      yield read.value.map((record) => cells(sellerRowOfRecord(record)));
    }
  }
}

async function* flat(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) for (const row of group) yield row;
}

async function* csvChunks(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}
