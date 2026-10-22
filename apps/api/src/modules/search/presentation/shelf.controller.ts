import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import type { ShelfRequest } from '../domain/shelf-query';
import {
  ListBestsellers,
  type ShelfFailure,
} from '../application/use-cases/list-bestsellers.use-case';
import { ListSpecials } from '../application/use-cases/list-specials.use-case';
import { ShelfPageBody, SpecialsPageBody } from './search.dto';
import { fail, shelfRequestOf } from './shelf-request';

const money = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

const requestOf = (query: Record<string, unknown>): ShelfRequest =>
  shelfRequestOf(query, ['category', 'limit']);

/**
 * The storefront's product shelves (storefront reads package): best sellers and specials. No
 * session is read: the actor is the Market's anonymous actor and the Market is the request's. In
 * the default rate-limit class (per origin). `no-store`, like search: every answer is re-checked
 * against catalog and sellers.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('search')
export class ShelfController {
  readonly #logger = new Logger('ShelfController');

  constructor(
    private readonly bestsellers: ListBestsellers,
    private readonly specials: ListSpecials,
  ) {}

  @Get('bestsellers')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Best sellers shelf (public)',
    description:
      'No session needed. Offers with the most paid order lines over the last 30 days, most ' +
      'first; a short shelf is filled in browse order (by name). `category` limits it to one ' +
      'platform category; `limit` is 1 to 24 (default 12). Only Offers that are sellable now ' +
      'and whose seller may sell are returned.',
  })
  @ApiQuery({ name: 'category', required: false, description: 'A platform category id.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 24, default 12.' })
  @ApiOkResponse({ type: ShelfPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async listBestsellers(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<ShelfPageBody> {
    const result = await this.bestsellers.execute(context, requestOf(query));
    return JSON.parse(JSON.stringify(this.answer(context, result))) as ShelfPageBody;
  }

  @Get('specials')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Specials shelf (public)',
    description:
      'No session needed. Offers whose price is a special right now, newest special first, ' +
      'each with the special and the regular price (Money: minor units as a string and the ' +
      'currency). `category` and `limit` as for best sellers.',
  })
  @ApiQuery({ name: 'category', required: false, description: 'A platform category id.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 24, default 12.' })
  @ApiOkResponse({ type: SpecialsPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async listSpecials(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<SpecialsPageBody> {
    const page = this.answer(context, await this.specials.execute(context, requestOf(query)));
    return {
      items: page.items.map((item) => ({
        offerId: item.offerId,
        productId: item.productId,
        sellerId: item.sellerId,
        name: item.name,
        shortText: item.shortText,
        categoryIds: [...item.categoryIds],
        variantId: item.variantId,
        price: money(item.price),
        regularPrice: money(item.regularPrice),
        taxInclusive: item.taxInclusive,
        specialEndsAt: item.specialEndsAt.toString(),
      })),
    };
  }

  private answer<T>(context: CallContext, result: Result<T, ShelfFailure | AccessDenied>): T {
    if (result.ok) return result.value;
    const { error } = result;
    if (error.code === 'validation.failed') throw fail(400, error.code, { fields: error.fields });
    const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, error.code);
    this.#logger.warn({
      msg: 'search.shelf-refused',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'search.unavailable');
  }
}
