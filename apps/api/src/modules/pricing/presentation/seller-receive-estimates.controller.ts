import { Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import { ViewReceiveEstimates } from '../application/use-cases/view-receive-estimates.use-case';
import { fail } from './http-answers';
import { ReceiveEstimatesBody } from './receive-estimates.dto';

const ERROR = { type: Object };

/**
 * `GET /pricing/seller/offers/:offerId/receive-estimates?lines=variantId:priceMinor,...`: what the
 * seller receives for one unit of each named Variant of one own Offer at the given price (Offer
 * page PR 4, "You receive (est.)"). A thin adapter: the seller comes from the session, one use
 * case does the work through its gate (`pricing.price.view` and `commission-payouts.earnings.view`).
 * Only `lines` is accepted. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId/receive-estimates')
export class SellerReceiveEstimatesController {
  readonly #logger = new Logger('SellerReceiveEstimatesController');

  constructor(private readonly viewEstimates: ViewReceiveEstimates) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'Estimate what the seller receives for one unit at given prices of one own Offer',
    description:
      'Needs pricing.price.view, commission-payouts.earnings.view and a seller who may sell. Uses the seller own commission rate and the line tax rate of the Offer; promotions are not counted. Writes nothing.',
  })
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiQuery({
    name: 'lines',
    required: true,
    description: 'Up to 20 `variantId:priceMinor` pairs, comma separated, each Variant once.',
  })
  @ApiOkResponse({ type: ReceiveEstimatesBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'pricing.estimate-unavailable or access.unavailable',
  })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ReceiveEstimatesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = Object.keys(query).filter((key) => key !== 'lines');
    if (unknown.length > 0) {
      throw fail(400, 'validation.failed', {
        fields: unknown.map((path) => ({ path, code: 'unknown' })),
      });
    }
    const result = await this.viewEstimates.execute(context, { offerId, lines: query.lines });
    this.#logger.log({
      msg: 'pricing.view-receive-estimates-route',
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
      if (error.code === 'pricing.estimate-unavailable') throw fail(503, error.code);
      const status = ACCESS_DENIED_STATUS[error.code];
      throw fail(status ?? 500, status === undefined ? 'internal' : error.code);
    }
    return {
      offerId: result.value.offerId,
      currency: result.value.currency,
      taxInclusive: result.value.taxInclusive,
      lines: result.value.lines.map((line) => ({ ...line })),
    };
  }
}
