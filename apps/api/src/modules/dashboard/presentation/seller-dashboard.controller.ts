import { Controller, Get, Logger, Res } from '@nestjs/common';
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
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ViewSellerTasks } from '../application/use-cases/view-seller-tasks.use-case';
import { dashboardRefusal } from './admin-dashboard.controller';
import { WorkQueueBody, workQueueBody } from './dashboard.dto';

const ERROR = { type: Object };

/**
 * The seller dashboard's composed reads (dashboards upgrade, option B). `Cache-Control: no-store`:
 * the counts are kept only in the API process, under the member's permission set and seller. Logs
 * ids and codes only.
 */
@ApiTags('dashboard')
@RoutePopulation('seller')
@ReadsSession()
@Controller('dashboard/seller')
export class SellerDashboardController {
  readonly #logger = new Logger('SellerDashboardController');

  constructor(private readonly tasks: ViewSellerTasks) {}

  @Get('tasks')
  @ApiOperation({
    summary: "The seller's tasks (counts of every seller queue the member may see)",
    description:
      "Always the session's own seller. No key of its own: each queue is asked only when the " +
      'member holds its keys, and its owner checks them again (a queue its owner refuses while ' +
      'the seller is not approved is absent). Every queue is asked at once with a 1.5 s limit; ' +
      'one that fails or is late answers status error and the rest still answer. Counts are kept ' +
      'for 60 s per Market, tenant, seller, access state and permission set, except the live ' +
      'queues (late orders, disputes). Only a seller-panel session; anyone else is access.denied.',
  })
  @ApiOkResponse({ type: WorkQueueBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async getTasks(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkQueueBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.tasks.execute(context, {});
    const actor = context.actor;
    this.#logger.log({
      msg: 'dashboard.seller-tasks',
      outcome: result.ok ? 'ok' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      queues: result.ok ? result.value.queues.length : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw dashboardRefusal(result.error);
    return workQueueBody(result.value);
  }
}
