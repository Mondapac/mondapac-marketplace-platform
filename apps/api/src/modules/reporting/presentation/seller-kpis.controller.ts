import { Controller, Get, HttpException, Logger, Query, Res } from '@nestjs/common';
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
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ExportSellerDaily } from '../application/use-cases/export-seller-daily.use-case';
import { ViewSellerKpis } from '../application/use-cases/view-seller-kpis.use-case';
import { DAILY_EXPORT_QUERY, sendDailyExport } from './daily-export-response';
import { SellerKpisBody, sellerKpisBody } from './seller-kpis.dto';

const ERROR = { type: Object };

/** The 400 body: `details.fields` when the refusal names them. */
export function validationBody(error: {
  readonly fields?: readonly { readonly path: string; readonly code: string }[];
}): Record<string, unknown> {
  return error.fields === undefined || error.fields.length === 0
    ? { statusCode: 400, code: 'validation.failed' }
    : { statusCode: 400, code: 'validation.failed', details: { fields: error.fields } };
}

/**
 * The seller's KPI read (dashboards upgrade, option B, phase 6). `Cache-Control: no-store`. Logs
 * ids and codes only, never an amount.
 */
@ApiTags('reporting')
@RoutePopulation('seller')
@ReadsSession()
@Controller('reporting/seller')
export class SellerKpisController {
  readonly #logger = new Logger('SellerKpisController');

  constructor(
    private readonly kpis: ViewSellerKpis,
    private readonly exportDaily: ExportSellerDaily,
  ) {}

  @Get('kpis')
  @ApiOperation({
    summary: "The seller's own KPIs and trend for a period, against the period before",
    description:
      "Always the session's own seller (never an id from input); needs `ordering.seller-order.view`. " +
      'Days are the Market\'s days, not UTC. Figures come from the daily rollups, so "today" is as ' +
      'fresh as the last event (see `refreshedAt`). Money is a decimal string of minor units. ' +
      'Shipped on time counts shipped orders only (an unshipped overdue order is a task, not yet ' +
      'a KPI; FE-127). A custom range (`from` and `to`, Market days, both included) is at most 13 ' +
      "calendar months and ends by the Market's today; it is compared with as many days before it.",
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month', 'custom'] })
  @ApiQuery({ name: 'from', required: false, description: 'First Market day (YYYY-MM-DD).' })
  @ApiQuery({ name: 'to', required: false, description: 'Last Market day (YYYY-MM-DD).' })
  @ApiOkResponse({ type: SellerKpisBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: period, from, to)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Query('period') period: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerKpisBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.kpis.execute(context, { period, from, to });
    const actor = context.actor;
    this.#logger.log({
      msg: 'reporting.seller-kpis',
      outcome: result.ok ? 'ok' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException(validationBody(result.error), 400);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerKpisBody(result.value);
  }

  @Get('daily/export')
  @ApiOperation({
    summary: "The seller's own figures per Market day of a period, as a CSV or XLSX file",
    description:
      "Always the session's own seller (a sellerId in the query is validation.failed); needs " +
      'ordering.seller-order.view and reporting.seller-report.export, denied while the seller is ' +
      "not approved. One row per Market day (never UTC): a preset (default 30d) or a custom range of at most 13 calendar months that ends by the Market's today. Money is minor units with " +
      'the currency in its own column. Every download is audited on the seller (range, format, ' +
      'row count). The file streams as an attachment (sales-daily-<from>-<to>.csv).',
  })
  @ApiQuery(DAILY_EXPORT_QUERY.period)
  @ApiQuery(DAILY_EXPORT_QUERY.from)
  @ApiQuery(DAILY_EXPORT_QUERY.to)
  @ApiQuery(DAILY_EXPORT_QUERY.format)
  @ApiOkResponse({ description: 'text/csv; charset=utf-8, or an XLSX file, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportDaily.execute(context, { ...query });
    await sendDailyExport(result, context, response, this.#logger, 'reporting.seller-daily-export');
  }
}
