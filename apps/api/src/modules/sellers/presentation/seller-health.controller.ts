import { Controller, Get, HttpCode, Logger, Param, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RequestSellerHealthRecalculation } from '../application/use-cases/request-seller-health-recalculation.use-case';
import { SellerHealthQueueRead } from '../application/use-cases/seller-health-queue.use-case';
import { SellerHealthRead } from '../application/use-cases/seller-health-read.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import {
  SellerHealthBody,
  SellerHealthQueueBody,
  SellerHealthRecalculationBody,
} from './seller-health.dto';

/**
 * The admin's seller health card over HTTP (seller health package 5). A thin adapter: the
 * `CallContext` comes from `@Call()` and the admin session cookie (`@RoutePopulation('admin')`
 * with `@ReadsSession()`); the controller authenticates only. Who may read is the gate of the use
 * case (`sellers.seller.view`) and the Market is the request's. The response is
 * `Cache-Control: no-store`, errors included. Health only informs; nothing here acts on a seller.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@Controller('sellers/admin')
export class SellerHealthController {
  readonly #logger = new Logger('SellerHealthController');

  constructor(
    private readonly read: SellerHealthRead,
    private readonly queue: SellerHealthQueueRead,
    private readonly recalculate: RequestSellerHealthRecalculation,
  ) {}

  @Get('health-queue')
  @ReadsSession()
  @ApiOperation({
    summary: 'Sellers that need a look (admin)',
    description:
      'The sellers whose latest stored health is unhealthy, worst score first, with the metric ' +
      'that set it. Health only informs: nothing happens to the seller. Needs sellers.seller.view.',
  })
  @ApiOkResponse({ type: SellerHealthQueueBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async healthQueue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthQueueBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.queue.execute(context, {});
    this.#logger.log({
      msg: 'sellers.seller-health-queue-route',
      outcome: result.ok ? 'read' : result.error.code,
      ...(result.ok ? { rows: result.value.items.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      items: result.value.items.map((item) => ({ ...item })),
      truncated: result.value.truncated,
    };
  }

  @Get(':sellerId/health')
  @ReadsSession()
  @ApiOperation({
    summary: "A seller's health card (admin)",
    description:
      'The latest stored score of the seller with its five metrics, and the 90-day trend. ' +
      'Read from what the nightly run stored; nothing is computed here. Needs sellers.seller.view.',
  })
  @ApiOkResponse({ type: SellerHealthBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (no such seller in this Market)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async sellerHealth(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.read.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-health-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      sellerId: result.value.sellerId,
      current:
        result.value.current === null
          ? null
          : {
              ...result.value.current,
              metrics: result.value.current.metrics.map((m) => ({ ...m })),
            },
      trend: result.value.trend.map((point) => ({ ...point })),
    };
  }

  @Post(':sellerId/health/recalculate')
  @HttpCode(202)
  @ReadsSession()
  @ApiOperation({
    summary: "Recalculate a seller's health now (admin)",
    description:
      'Queues a recount of one seller. The job measures it within about two minutes and the ' +
      'card then shows the new score; nothing is computed in this request. A second request ' +
      'while one waits adds nothing. Health only informs: nothing happens to the seller. ' +
      'Needs sellers.seller-health.recalculate.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiAcceptedResponse({ type: SellerHealthRecalculationBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (no such seller, or not approved yet, in this Market)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async recalculateHealth(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthRecalculationBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.recalculate.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-health-recalculate-route',
      outcome: result.ok ? result.value.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return { status: result.value.status };
  }
}
