import { Controller, Get, HttpException, Logger, Query, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { MAX_RANGE_MONTHS, parsePeriodQuery } from '../../reporting';
import { ViewAdminKpis } from '../application/use-cases/view-admin-kpis.use-case';
import { ViewAdminWorkQueue } from '../application/use-cases/view-admin-work-queue.use-case';
import { AdminKpisBody, adminKpisBody, WorkQueueBody, workQueueBody } from './dashboard.dto';

const ERROR = { type: Object };

/** The HTTP error of a refusal: `{ statusCode, code }`. */
export function dashboardRefusal(error: AccessDenied): HttpException {
  const status = ACCESS_DENIED_STATUS[error.code];
  return new HttpException({ statusCode: status, code: error.code }, status);
}

/**
 * The admin dashboard's composed reads (dashboards upgrade, option B). `Cache-Control: no-store`:
 * the counts are kept only in the API process, under the viewer's permission set. Logs ids and
 * codes only.
 */
@ApiTags('dashboard')
@RoutePopulation('admin')
@ReadsSession()
@Controller('dashboard/admin')
export class AdminDashboardController {
  readonly #logger = new Logger('AdminDashboardController');

  constructor(
    private readonly workQueue: ViewAdminWorkQueue,
    private readonly kpis: ViewAdminKpis,
  ) {}

  @Get('work-queue')
  @ApiOperation({
    summary: "The admin's work queue (counts of every queue the admin may see)",
    description:
      'No key of its own: each queue is asked only when the admin holds its keys, and its owner ' +
      'checks them again. Every queue is asked at once with a 1.5 s limit; one that fails or is ' +
      'late answers status error and the rest still answer. Counts are kept for 60 s per Market, ' +
      'tenant, panel and permission set, except the live queues (security alerts, disputes, ' +
      'uncertified listings). Only a platform admin acting as themselves; an acting-as session is ' +
      'access.denied.',
  })
  @ApiOkResponse({ type: WorkQueueBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async getWorkQueue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkQueueBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.workQueue.execute(context, {});
    this.#logger.log({
      msg: 'dashboard.admin-work-queue',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw dashboardRefusal(result.error);
    return workQueueBody(result.value);
  }

  @Get('kpis')
  @ApiOperation({
    summary: "The admin's marketplace KPIs for a period, against the period before it",
    description:
      'Two sections, each asked only when the admin holds its key: `operations` (orders, cancel ' +
      'rate, on-time shipping, refund count; key `ordering.order.view`) and `finance` (GMV with ' +
      'and without GST, refunded goods, net sales, average order; key ' +
      '`commission-payouts.settlement.view`). A section the admin holds no key for is null. One ' +
      'that fails or takes over 1.5 s is `status: error` and the other still answers. Days are ' +
      "the Market's days, never UTC. Only a platform admin acting as themselves. A custom range " +
      '(`from` and `to`, Market days, both included) is at most 13 calendar months and ends by ' +
      "the Market's today; it is compared with as many days just before it.",
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month', 'custom'] })
  @ApiQuery({
    name: 'from',
    required: false,
    description: `First Market day (YYYY-MM-DD) of a custom range; with \`to\`, at most ${MAX_RANGE_MONTHS} months.`,
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: "Last Market day (YYYY-MM-DD) of a custom range, not after the Market's today.",
  })
  @ApiOkResponse({ type: AdminKpisBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async getKpis(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminKpisBody> {
    response.setHeader('Cache-Control', 'no-store');
    const { period, from, to, ...rest } = query;
    const parsed = parsePeriodQuery({ period, from, to }, '7d');
    if (!parsed.ok || Object.keys(rest).length > 0) {
      const fields = [
        ...(parsed.ok ? [] : parsed.error),
        ...Object.keys(rest)
          .sort()
          .slice(0, 10)
          .map((key) => ({ path: key.slice(0, 64), code: 'unknown-field' })),
      ];
      throw new HttpException(
        { statusCode: 400, code: 'validation.failed', details: { fields } },
        400,
      );
    }
    const result = await this.kpis.execute(context, { period: parsed.value });
    this.#logger.log({
      msg: 'dashboard.admin-kpis',
      outcome: result.ok ? 'ok' : result.error.code,
      period: typeof parsed.value === 'string' ? parsed.value : 'custom',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException(
          { statusCode: 400, code: 'validation.failed', details: { fields: result.error.fields } },
          400,
        );
      }
      throw dashboardRefusal(result.error);
    }
    return adminKpisBody(result.value);
  }
}
