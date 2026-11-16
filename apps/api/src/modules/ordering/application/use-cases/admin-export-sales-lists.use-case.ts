import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import { listDocuments, type AdminDocumentListDependencies } from '../admin-document-list-flow';
import { listRefunds, type AdminRefundListDependencies } from '../admin-refund-list-flow';
import { listShipments, type AdminShipmentListDependencies } from '../admin-shipment-list-flow';
import {
  CONFIRMATION_EXPORT_COLUMNS,
  CREDIT_NOTE_EXPORT_COLUMNS,
  CREDIT_NOTE_ONLY_COLUMNS,
  REFUND_EXPORT_COLUMNS,
  SHIPMENT_EXPORT_COLUMNS,
} from '../sales-list-export-columns';
import {
  salesListExport,
  type SalesExportDependencies,
  type SalesExportFailure,
} from '../sales-list-export';

// The CSV/XLSX exports of the admin Sales lists (Shipments, Refunds, Invoices). Each has the rule
// of the list it reads through, `permissions [ordering.order.view]`; customer names and emails are
// filled only when the list fills them (the admin holds identity.customer-account.view).

const VIEW_RULE = { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] } as const;

const SHIPMENT_FILTER_KEYS = new Set([
  'stage',
  'q',
  'search',
  'deliveryMethod',
  'attention',
  'fleet',
  'sellerId',
  'paidFrom',
  'paidTo',
  'shippedFrom',
  'shippedTo',
]);

const REFUND_FILTER_KEYS = new Set([
  'state',
  'q',
  'search',
  'reason',
  'actor',
  'lossBearer',
  'ledger',
  'sellerId',
  'from',
  'to',
  'minAmount',
  'maxAmount',
]);

const DOCUMENT_FILTER_KEYS = new Set([
  'kind',
  'q',
  'search',
  'sellerId',
  'from',
  'to',
  'minAmount',
  'maxAmount',
]);

/** The page of a list as the export reads it. */
const pageOf = <Row>(page: {
  readonly rows: readonly Row[];
  readonly total: number | null;
  readonly nextCursor: string | null;
}) => ({ rows: page.rows, total: page.total, nextCursor: page.nextCursor });

/**
 * `ordering.admin-export-shipments`: the Shipments list as a file (`shipments-<day>.csv|xlsx`), the
 * selected seller orders (`ids`) or every row of the filter, at most 10,000, newest payment first.
 */
export class AdminExportShipments extends UseCase<unknown, ExportFile, SalesExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-shipments',
    rule: VIEW_RULE,
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminShipmentListDependencies & SalesExportDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, SalesExportFailure>> {
    return salesListExport(this.deps, context, input, {
      name: 'shipments',
      sheetName: 'Shipments',
      filterKeys: SHIPMENT_FILTER_KEYS,
      columns: SHIPMENT_EXPORT_COLUMNS,
      read: async (query, ids) => {
        const page = await listShipments(this.deps, context, query, ids);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}

/**
 * `ordering.admin-export-refunds`: the Refunds list as a file (`refunds-<day>.csv|xlsx`), the
 * selected refunds (`ids`) or every row of the filter, at most 10,000, newest request first.
 */
export class AdminExportRefunds extends UseCase<unknown, ExportFile, SalesExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-refunds',
    rule: VIEW_RULE,
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminRefundListDependencies & SalesExportDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, SalesExportFailure>> {
    return salesListExport(this.deps, context, input, {
      name: 'refunds',
      sheetName: 'Refunds',
      filterKeys: REFUND_FILTER_KEYS,
      columns: REFUND_EXPORT_COLUMNS,
      read: async (query, ids) => {
        const page = await listRefunds(this.deps, context, query, ids);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}

/**
 * `ordering.admin-export-documents`: one tab of the Invoices list as a file, the order
 * confirmations (`order-confirmations-<day>`) or the credit notes (`credit-notes-<day>`) by
 * `kind`; never named "invoices" and with no number column, because these are not tax invoices.
 * The selected documents (`ids`: seller order ids or credit note ids) or every row of the filter,
 * at most 10,000, newest first.
 */
export class AdminExportDocuments extends UseCase<unknown, ExportFile, SalesExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-documents',
    rule: VIEW_RULE,
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDocumentListDependencies & SalesExportDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, SalesExportFailure>> {
    const kind =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['kind']
        : undefined;
    const credit = kind === 'credit-note';
    return salesListExport(this.deps, context, input, {
      name: credit ? 'credit-notes' : 'order-confirmations',
      sheetName: credit ? 'Credit notes' : 'Order confirmations',
      filterKeys: DOCUMENT_FILTER_KEYS,
      columns: credit ? CREDIT_NOTE_EXPORT_COLUMNS : CONFIRMATION_EXPORT_COLUMNS,
      ...(credit ? {} : { skipped: CREDIT_NOTE_ONLY_COLUMNS }),
      read: async (query, ids) => {
        const page = await listDocuments(this.deps, context, query, ids);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}
