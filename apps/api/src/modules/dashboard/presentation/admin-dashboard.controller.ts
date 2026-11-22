import { Controller, Get, HttpException, Logger, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
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
import { ViewAdminWorkQueue } from '../application/use-cases/view-admin-work-queue.use-case';
import { WorkQueueBody, workQueueBody } from './dashboard.dto';

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

  constructor(private readonly workQueue: ViewAdminWorkQueue) {}

  @Get('work-queue')
  @ApiOperation({
    summary: "The admin's work queue (counts of every queue the admin may see)",
    description:
      'No key of its own: each queue is asked only when the admin holds its keys, and its owner ' +
      'checks them again. Every queue is asked at once with a 1.5 s limit; one that fails or is ' +
      'late answers status error and the rest still answer. Counts are kept for 60 s per Market ' +
      'and permission set, except the live (critical) queues.',
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
}
