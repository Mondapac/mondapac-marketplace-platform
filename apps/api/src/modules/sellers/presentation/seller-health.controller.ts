import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SellerHealthRead } from '../application/use-cases/seller-health-read.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { SellerHealthBody } from './seller-health.dto';

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

  constructor(private readonly read: SellerHealthRead) {}

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
}
