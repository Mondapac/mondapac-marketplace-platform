import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { listShipments, type AdminShipmentListDependencies } from '../admin-shipment-list-flow';
import { SHIPMENT_EXPORT_COLUMNS } from '../sales-list-export-columns';
import {
  exportLabels,
  pageOf,
  SALES_EXPORT_RULE,
  salesListExport,
  type SalesExportDependencies,
  type SalesExportFailure,
} from '../sales-list-export';

/** The list's own filter keys (no paging or sort keys). */
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

/**
 * `ordering.admin-export-shipments`: the Shipments list as a file (`shipments-<day>.csv|xlsx`), the
 * selected seller orders (`ids`) or every row of the filter, at most 10,000, newest payment first.
 */
export class AdminExportShipments extends UseCase<unknown, ExportFile, SalesExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-shipments',
    rule: SALES_EXPORT_RULE,
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
    const names = exportLabels(this.deps.labels);
    const deps = { ...this.deps, labels: names.labels };
    return salesListExport(deps, context, input, {
      name: 'shipments',
      sheetName: 'Shipments',
      filterKeys: SHIPMENT_FILTER_KEYS,
      columns: SHIPMENT_EXPORT_COLUMNS,
      lookupFailed: names.failed,
      read: async (query, scope) => {
        const page = await listShipments(deps, context, query, scope);
        return page.ok ? { ok: true, value: pageOf(page.value) } : page;
      },
    });
  }
}
