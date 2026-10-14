import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiBadRequestResponse,
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
import { ViewOfferPrices } from '../application/use-cases/view-offer-prices.use-case';
import { fail } from './http-answers';
import { OfferPricesBody } from './offer-prices.dto';

const ERROR = { type: Object };

/**
 * `GET /pricing/seller/offers/:offerId/prices`: the prices of the Variants of one own Offer, with
 * the series version the regular-price write needs. A thin adapter: the seller comes from the
 * session, one use case does the work through its gate (`pricing.price.view`). An Offer that is
 * absent, deleted or not the seller's is one 404. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId/prices')
export class SellerOfferPricesController {
  readonly #logger = new Logger('SellerOfferPricesController');

  constructor(private readonly viewPrices: ViewOfferPrices) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'Read the prices of one own Offer, per Variant',
    description: 'Needs pricing.price.view and a seller who may sell.',
  })
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiOkResponse({ type: OfferPricesBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
  ): Promise<OfferPricesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewPrices.execute(context, { offerId });
    this.#logger.log({
      msg: 'pricing.view-offer-prices-route',
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
      const status = ACCESS_DENIED_STATUS[error.code];
      throw fail(status ?? 500, status === undefined ? 'internal' : error.code);
    }
    return {
      offerId: result.value.offerId,
      currency: result.value.currency,
      variants: result.value.variants.map((variant) => ({
        variantId: variant.variantId,
        seriesVersion: variant.seriesVersion,
        currency: variant.currency,
        inForce:
          variant.inForce === null
            ? null
            : {
                amount: variant.inForce.amount,
                effectiveFrom: variant.inForce.effectiveFrom.toString(),
              },
        held:
          variant.held === null
            ? null
            : {
                amount: variant.held.amount,
                submittedAt: variant.held.submittedAt.toString(),
                direction: variant.held.direction,
              },
        special:
          variant.special === null
            ? null
            : {
                amount: variant.special.amount,
                startsAt: variant.special.startsAt.toString(),
                endsAt: variant.special.endsAt.toString(),
                state: variant.special.state,
              },
        heldSpecial:
          variant.heldSpecial === null
            ? null
            : {
                amount: variant.heldSpecial.amount,
                startsAt: variant.heldSpecial.startsAt.toString(),
                endsAt: variant.heldSpecial.endsAt.toString(),
                submittedAt: variant.heldSpecial.submittedAt.toString(),
              },
        retired: variant.retired,
      })),
    };
  }
}
