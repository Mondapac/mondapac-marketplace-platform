import { Controller, Get, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { ReadOwnSellerHealth } from '../application/use-cases/read-own-seller-health.use-case';
import { RefreshOwnSellerHealth } from '../application/use-cases/refresh-own-seller-health.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { OwnSellerHealthBody, SellerHealthRecalculationBody } from './seller-health.dto';

/**
 * The seller's own "Refresh now" for their health over HTTP (seller health, HLT-03). A thin
 * adapter: the `CallContext` comes from `@Call()` and the seller session cookie; who may refresh is
 * the gate's rule (`own-resources`, approved sellers only) and the seller is the actor's, so no
 * route takes a seller id. The cooldown is the use case's: a second click too soon answers 429 with
 * `Retry-After`. The response is `Cache-Control: no-store`, errors included.
 */
@ApiTags('sellers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('sellers/own-health')
export class OwnSellerHealthController {
  readonly #logger = new Logger('OwnSellerHealthController');

  constructor(
    private readonly refresh: RefreshOwnSellerHealth,
    private readonly read: ReadOwnSellerHealth,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My health (seller)',
    description:
      "The acting seller's latest stored score with its five metrics, the 90-day trend and the " +
      'state of "Refresh now" (a recount waiting, seconds left of the cooldown). Read from what ' +
      'the nightly run stored; nothing is computed here. Approved sellers only.',
  })
  @ApiOkResponse({ type: OwnSellerHealthBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: 'session.invalid' })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnSellerHealthBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.read.execute(context, {});
    this.#logger.log({
      msg: 'sellers.read-own-seller-health-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      current:
        result.value.current === null
          ? null
          : {
              ...result.value.current,
              metrics: result.value.current.metrics.map((m) => ({ ...m })),
            },
      trend: result.value.trend.map((point) => ({ ...point })),
      refresh: { ...result.value.refresh },
    };
  }

  @Post('refresh')
  @HttpCode(202)
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session.' })
  @ApiOperation({
    summary: 'Refresh my health now (seller)',
    description:
      'Queues a recount of the acting seller. The job measures it within about two minutes. ' +
      'After a click the seller waits 15 minutes before the next one (429 with Retry-After). ' +
      'Approved sellers only. Health only informs: nothing happens to the seller.',
  })
  @ApiAcceptedResponse({ type: SellerHealthRecalculationBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: 'session.invalid' })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiTooManyRequestsResponse({ type: SellersErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async post(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthRecalculationBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.refresh.execute(context, {});
    this.#logger.log({
      msg: 'sellers.refresh-own-seller-health-route',
      outcome: result.ok ? result.value.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return { status: result.value.status };
  }
}
