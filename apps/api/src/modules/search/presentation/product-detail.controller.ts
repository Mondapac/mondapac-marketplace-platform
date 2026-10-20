import { Controller, Get, Header, HttpException, Logger, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import {
  ViewProductDetail,
  type ProductDetail,
  type ProductDetailFailure,
} from '../application/use-cases/view-product-detail.use-case';
import { ProductDetailBody } from './search.dto';

const fail = (status: number, code: string, details?: object): HttpException =>
  new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);

const money = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

/** The route takes no query string: any key is `validation.failed` (400). */
function checkQuery(query: Record<string, unknown>): void {
  const fields = Object.keys(query)
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
}

/**
 * The storefront's product page data (storefront reads package). No session is read: the actor is
 * the Market's anonymous actor and the Market is the request's. In the default rate-limit class
 * (per origin). `no-store`, like search: every answer is re-checked against catalog and sellers.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('search')
export class ProductDetailController {
  readonly #logger = new Logger('ProductDetailController');

  constructor(private readonly detail: ViewProductDetail) {}

  @Get('product-detail/:productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Product page (public)',
    description:
      'No session needed. The published product text and categories and its sellable Offers, ' +
      'lowest unit price first. Each Offer lists its priced Variants with the buyer price (Money: ' +
      'minor units as a string and the currency), the public stock state (never the exact count) ' +
      'and the seller public store name and minimum order. Only Offers that are sellable now and ' +
      'whose seller may sell are returned. Takes no query string.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ description: 'search.product-not-found' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async viewProductDetail(
    @Call() context: CallContext,
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductDetailBody> {
    checkQuery(query);
    const detail = this.answer(context, await this.detail.execute(context, { productId }));
    return {
      productId: detail.productId,
      name: detail.name,
      shortDescription: detail.shortDescription,
      description: detail.description,
      categoryIds: [...detail.categoryIds],
      offers: detail.offers.map((offer) => ({
        offerId: offer.offerId,
        sellerId: offer.sellerId,
        seller: {
          storeName: offer.seller.storeName,
          ...(offer.seller.minimumOrder === undefined
            ? {}
            : {
                minimumOrder:
                  offer.seller.minimumOrder === null ? null : money(offer.seller.minimumOrder),
              }),
        },
        units: offer.units.map((unit) => ({
          variantId: unit.variantId,
          label: unit.label,
          price: money(unit.price),
          taxInclusive: unit.taxInclusive,
          special: unit.special === null ? null : { endsAt: unit.special.endsAt.toString() },
          stock: { status: unit.stock.status, onlyLeft: unit.stock.onlyLeft },
        })),
      })),
    };
  }

  private answer(
    context: CallContext,
    result: Result<ProductDetail, ProductDetailFailure | AccessDenied>,
  ): ProductDetail {
    if (result.ok) return result.value;
    const { error } = result;
    if (error.code === 'validation.failed') throw fail(400, error.code, { fields: error.fields });
    if (error.code === 'search.product-not-found') throw fail(404, error.code);
    const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, error.code);
    this.#logger.warn({
      msg: 'search.product-detail-refused',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'search.unavailable');
  }
}
