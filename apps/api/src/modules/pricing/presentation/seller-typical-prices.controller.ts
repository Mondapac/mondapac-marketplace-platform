import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { ViewTypicalPrices } from '../application/use-cases/view-typical-prices.use-case';
import { fail } from './http-answers';
import { setRetryAfter } from './retry-after';
import { TypicalPricesBody } from './typical-prices.dto';

const ERROR = { type: Object };

/**
 * `GET /pricing/seller/offers/:offerId/typical-prices`: the range other businesses sell each
 * Variant of one own Offer in. A thin adapter: the seller comes from the session, one use case
 * does the work through its gate (`pricing.price.view`). An Offer that is absent, deleted or not
 * the seller's is one 404. Every answer is `Cache-Control: no-store`; reads are capped per account.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId/typical-prices')
export class SellerTypicalPricesController {
  readonly #logger = new Logger('SellerTypicalPricesController');

  constructor(private readonly viewTypical: ViewTypicalPrices) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'Read the typical price range of each Variant of one own Offer',
    description:
      'Needs pricing.price.view and a seller who may sell. A range only, and only when enough independent businesses sell the Variant.',
  })
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiOkResponse({ type: TypicalPricesBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'request.throttled (Retry-After)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
  ): Promise<TypicalPricesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewTypical.execute(context, { offerId });
    this.#logger.log({
      msg: 'pricing.view-typical-prices-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error = result.error;
      if (error.code === 'validation.failed') {
        throw fail(400, error.code, { fields: error.fields });
      }
      if (error.code === 'pricing.offer-not-found') throw fail(404, error.code);
      if (error.code === 'request.throttled') {
        const outcome = fail(429, error.code, { retryAfterSeconds: error.retryAfterSeconds });
        setRetryAfter(response, outcome);
        throw outcome;
      }
      const status = ACCESS_DENIED_STATUS[error.code];
      throw fail(status ?? 500, status === undefined ? 'internal' : error.code);
    }
    return {
      offerId: result.value.offerId,
      variants: result.value.variants.map((variant) => ({
        variantId: variant.variantId,
        range: variant.range,
      })),
    };
  }
}
