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
import { DEFAULT_PERIOD, ViewSellerKpis } from '../application/use-cases/view-seller-kpis.use-case';
import { ViewSellerNetEarnings } from '../application/use-cases/view-seller-net-earnings.use-case';
import {
  SellerKpisBody,
  SellerNetEarningsBody,
  sellerKpisBody,
  sellerNetEarningsBody,
} from './seller-kpis.dto';

const ERROR = { type: Object };

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
    private readonly netEarnings: ViewSellerNetEarnings,
  ) {}

  @Get('kpis')
  @ApiOperation({
    summary: "The seller's own KPIs and trend for a period, against the period before",
    description:
      "Always the session's own seller (never an id from input); needs `ordering.seller-order.view`. " +
      'Days are the Market\'s days, not UTC. Figures come from the daily rollups, so "today" is as ' +
      'fresh as the last event (see `refreshedAt`). Money is a decimal string of minor units. ' +
      'Shipped on time counts shipped orders only (an unshipped overdue order is a task, not yet ' +
      'a KPI; FE-127).',
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month'] })
  @ApiOkResponse({ type: SellerKpisBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (unknown period)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Query('period') period: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerKpisBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.kpis.execute(context, { period });
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
        throw new HttpException({ statusCode: 400, code: 'validation.failed' }, 400);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerKpisBody(result.value);
  }

  @Get('net-earnings')
  @ApiOperation({
    summary: "The seller's own net earnings for a dashboard period",
    description:
      "Always the session's own seller (never an id from input); needs " +
      '`commission-payouts.earnings.view` (the key of the seller ledger). The period is the same ' +
      "as the KPI strip's, counted in the Market's days. Without GST. `ready` is false, and " +
      '`netEarnings` null, until a week of matching ledger exists (FE-066): a partial figure is ' +
      'never sent. Money is a decimal string of minor units.',
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month'] })
  @ApiOkResponse({ type: SellerNetEarningsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (unknown period)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async getNetEarnings(
    @Call() context: CallContext,
    @Query('period') period: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerNetEarningsBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.netEarnings.execute(context, { period: period ?? DEFAULT_PERIOD });
    const actor = context.actor;
    this.#logger.log({
      msg: 'reporting.seller-net-earnings',
      outcome: result.ok ? 'ok' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException({ statusCode: 400, code: 'validation.failed' }, 400);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerNetEarningsBody(result.value);
  }
}
