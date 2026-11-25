import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
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
import {
  MAX_LIST_OFFERS,
  ViewOffersPrices,
} from '../application/use-cases/view-offers-prices.use-case';
import { fail } from './http-answers';
import { OffersPricesBody } from './offer-prices.dto';
import { variantPriceBody } from './seller-offer-prices.controller';

const ERROR = { type: Object };

/**
 * `GET /pricing/seller/offer-prices?offerIds=a,b`: the prices of a page of the seller's own Offers
 * in one read (the Offer list's price and stock cells, Offer page PR 8). Each Offer is answered as
 * `GET /pricing/seller/offers/:offerId/prices` answers it; an Offer that is not the seller's, is
 * deleted or is unknown is left out. A thin adapter over one use case (`pricing.price.view`).
 * Every answer is `Cache-Control: no-store`.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offer-prices')
export class SellerOffersPricesController {
  readonly #logger = new Logger('SellerOffersPricesController');

  constructor(private readonly viewPrices: ViewOffersPrices) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'Read the prices of several own Offers, per Variant',
    description: 'Needs pricing.price.view and a seller who may sell.',
  })
  @ApiQuery({
    name: 'offerIds',
    description: `Offer ids, comma separated: 1 to ${MAX_LIST_OFFERS}, each once.`,
  })
  @ApiOkResponse({ type: OffersPricesBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('offerIds') offerIds: unknown,
  ): Promise<OffersPricesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewPrices.execute(context, { offerIds });
    this.#logger.log({
      msg: 'pricing.view-offers-prices-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error = result.error;
      if (error.code === 'validation.failed') {
        throw fail(400, error.code, { fields: error.fields });
      }
      const status = ACCESS_DENIED_STATUS[error.code];
      throw fail(status ?? 500, status === undefined ? 'internal' : error.code);
    }
    return {
      currency: result.value.currency,
      offers: result.value.offers.map((offer) => ({
        offerId: offer.offerId,
        variants: offer.variants.map(variantPriceBody),
      })),
    };
  }
}
