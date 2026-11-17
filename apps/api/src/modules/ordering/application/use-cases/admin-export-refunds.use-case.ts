import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { listRefunds, type AdminRefundListDependencies } from '../admin-refund-list-flow';
import { REFUND_EXPORT_COLUMNS } from '../sales-list-export-columns';
import {
  exportLabels,
  pageOf,
  SALES_EXPORT_RULE,
  salesListExport,
  type SalesExportDependencies,
  type SalesExportFailure,
} from '../sales-list-export';

/** The list's own filter keys (no paging or sort keys). */
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

/**
 * `ordering.admin-export-refunds`: the Refunds list as a file (`refunds-<day>.csv|xlsx`), the
 * selected refunds (`ids`) or every row of the filter, at most 10,000, newest request first.
 */
export class AdminExportRefunds extends UseCase<unknown, ExportFile, SalesExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-refunds',
    rule: SALES_EXPORT_RULE,
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
    const names = exportLabels(this.deps.labels);
    const deps = { ...this.deps, labels: names.labels };
    return salesListExport(deps, context, input, {
      name: 'refunds',
      sheetName: 'Refunds',
      filterKeys: REFUND_FILTER_KEYS,
      columns: REFUND_EXPORT_COLUMNS,
      lookupFailed: names.failed,
      read: async (query, scope) => {
        const page = await listRefunds(deps, context, query, scope);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}
