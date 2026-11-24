import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import { REPORTING_MARKETPLACE_REPORT_EXPORT } from '../../contracts/permissions';
import { MarketplaceDailyExported } from '../../domain/audit';
import { MARKETPLACE_DAILY_HEADER, marketplaceDailyRows } from '../../domain/daily-export';
import {
  dailyExport,
  type DailyExportDependencies,
  type DailyExportFailure,
} from '../daily-export-flow';
import type { AdminKpiReader } from '../ports/admin-kpi-reader';

export interface ExportMarketplaceDailyDependencies extends DailyExportDependencies {
  readonly reader: AdminKpiReader;
  readonly audit: AuditWriter;
}

/**
 * `reporting.export-marketplace-daily` (dashboards v2, PR 5): the marketplace's figures per Market
 * day of a preset or a custom range (at most 13 months, ending by the Market's today) as a CSV or
 * XLSX file: GMV with and without tax, refunded goods, net sales and the order counts, every seller
 * summed. Money and orders, so the rule is the finance key, the orders key and the export key; only
 * a platform admin acting as themselves. Every export writes an audit row (range, format, row
 * count) in the unit that reads the rows.
 */
export class ExportMarketplaceDaily extends UseCase<unknown, ExportFile, DailyExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.export-marketplace-daily',
    rule: {
      kind: 'permissions',
      allOf: [
        COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key,
        ORDERING_ORDER_VIEW.key,
        REPORTING_MARKETPLACE_REPORT_EXPORT.key,
      ],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ExportMarketplaceDailyDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, DailyExportFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { reader, audit } = this.deps;
    return dailyExport(this.deps, context, input, {
      fallback: '7d',
      baseName: 'marketplace-daily',
      sheetName: 'Marketplace daily',
      header: MARKETPLACE_DAILY_HEADER,
      rows: async (range, currency) =>
        marketplaceDailyRows(
          range,
          currency,
          (await reader.dailyTotals(context.market, currency, range)).days,
        ),
      audit: (after) =>
        audit.record(context, MarketplaceDailyExported.entry('marketplace-daily', { after })),
    });
  }
}
