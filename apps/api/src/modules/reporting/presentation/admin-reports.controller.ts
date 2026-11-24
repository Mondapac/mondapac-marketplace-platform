import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ExportMarketplaceDaily } from '../application/use-cases/export-marketplace-daily.use-case';
import { DAILY_EXPORT_QUERY, sendDailyExport } from './daily-export-response';

const ERROR = { type: Object };

/** The admin panel's report downloads (dashboards v2, PR 5). `Cache-Control: no-store`. */
@ApiTags('reporting')
@RoutePopulation('admin')
@ReadsSession()
@Controller('reporting/admin')
export class AdminReportsController {
  readonly #logger = new Logger('AdminReportsController');

  constructor(private readonly exportDaily: ExportMarketplaceDaily) {}

  @Get('daily/export')
  @ApiOperation({
    summary: "The marketplace's figures per Market day of a period, as a CSV or XLSX file",
    description:
      'Needs commission-payouts.settlement.view, ordering.order.view and ' +
      'reporting.marketplace-report.export; only a platform admin acting as themselves. One row ' +
      "per Market day (never UTC) of the period: a preset (default 7d) or a custom range of at most 13 calendar months that ends by the Market's today. Money is minor units with the " +
      'currency in its own column; GMV is goods of paid orders on their paid day, refunds count on ' +
      'their own day. Every download is audited (range, format, row count). The file streams as ' +
      'an attachment (marketplace-daily-<from>-<to>.csv).',
  })
  @ApiQuery(DAILY_EXPORT_QUERY.period)
  @ApiQuery(DAILY_EXPORT_QUERY.from)
  @ApiQuery(DAILY_EXPORT_QUERY.to)
  @ApiQuery(DAILY_EXPORT_QUERY.format)
  @ApiOkResponse({ description: 'text/csv; charset=utf-8, or an XLSX file, as an attachment' })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed (details.fields: period, from, to with format, after-to, too-long, future; format; unknown-field)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportDaily.execute(context, { ...query });
    await sendDailyExport(
      result,
      context,
      response,
      this.#logger,
      'reporting.marketplace-daily-export',
    );
  }
}
