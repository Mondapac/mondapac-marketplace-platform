import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { ORDERING_SELLER_ORDER_VIEW } from '../../../ordering';
import { REPORTING_SELLER_REPORT_EXPORT } from '../../contracts/permissions';
import { SellerDailyExported } from '../../domain/audit';
import { SELLER_DAILY_HEADER, sellerDailyRows } from '../../domain/daily-export';
import {
  dailyExport,
  type DailyExportDependencies,
  type DailyExportFailure,
} from '../daily-export-flow';
import type { SellerKpiReader } from '../ports/seller-kpi-reader';

export type { DailyExportFailure };

export interface ExportSellerDailyDependencies extends DailyExportDependencies {
  readonly reader: SellerKpiReader;
  readonly audit: AuditWriter;
}

/**
 * `reporting.export-seller-daily` (dashboards v2, PR 5): the seller's own figures per Market day
 * of a preset or a custom range (at most 13 months, ending by the Market's today) as a CSV or XLSX
 * file, the figures of its KPI cards. Always the session's own seller (`sessionSellerOf`), never
 * an id from input: a `sellerId` in the query is refused as an unknown field. Rule: the seller
 * orders key and the seller export key, denied while the seller is not approved. Every export
 * writes an audit row on the seller (range, format, row count) in the unit that reads the rows.
 */
export class ExportSellerDaily extends UseCase<unknown, ExportFile, DailyExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.export-seller-daily',
    rule: {
      kind: 'permissions',
      allOf: [ORDERING_SELLER_ORDER_VIEW.key, REPORTING_SELLER_REPORT_EXPORT.key],
    },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ExportSellerDailyDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, DailyExportFailure>> {
    const sellerId = sessionSellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { reader, audit } = this.deps;
    return dailyExport(this.deps, context, input, {
      fallback: '30d',
      baseName: 'sales-daily',
      sheetName: 'Sales daily',
      header: SELLER_DAILY_HEADER,
      rows: async (range, currency) =>
        sellerDailyRows(
          range,
          currency,
          await reader.daily(context.market, sellerId, currency, range),
        ),
      audit: (after) => audit.record(context, SellerDailyExported.entry(sellerId, { after })),
    });
  }
}
