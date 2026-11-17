import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { listDocuments, type AdminDocumentListDependencies } from '../admin-document-list-flow';
import {
  CONFIRMATION_EXPORT_COLUMNS,
  CREDIT_NOTE_EXPORT_COLUMNS,
  CREDIT_NOTE_ONLY_COLUMNS,
} from '../sales-list-export-columns';
import {
  exportLabels,
  pageOf,
  SALES_EXPORT_RULE,
  salesListExport,
  type SalesExportDependencies,
  type SalesExportFailure,
} from '../sales-list-export';

/** The list's own filter keys (no paging or sort keys). */
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
    rule: SALES_EXPORT_RULE,
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
    const names = exportLabels(this.deps.labels);
    const deps = { ...this.deps, labels: names.labels };
    return salesListExport(deps, context, input, {
      name: credit ? 'credit-notes' : 'order-confirmations',
      sheetName: credit ? 'Credit notes' : 'Order confirmations',
      filterKeys: DOCUMENT_FILTER_KEYS,
      columns: credit ? CREDIT_NOTE_EXPORT_COLUMNS : CONFIRMATION_EXPORT_COLUMNS,
      ...(credit ? {} : { skipped: CREDIT_NOTE_ONLY_COLUMNS }),
      lookupFailed: names.failed,
      read: async (query, scope) => {
        const page = await listDocuments(deps, context, query, scope);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}
