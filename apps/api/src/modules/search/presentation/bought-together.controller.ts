import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ListBoughtTogether } from '../application/use-cases/list-bought-together.use-case';
import { ShelfPageBody } from './search.dto';
import { boughtTogetherRequestOf, fail } from './shelf-request';

/**
 * The product page's "bought together" shelf (personalization 1d-2). No session is read: the actor
 * is the Market's anonymous actor and the Market is the request's; nothing about the shopper is
 * used. `no-store`, like the other shelves: every answer is re-checked against catalog and sellers.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('search')
export class BoughtTogetherController {
  readonly #logger = new Logger('BoughtTogetherController');

  constructor(private readonly boughtTogether: ListBoughtTogether) {}

  @Get('bought-together')
  @ApiOperation({
    summary: 'Bought together shelf (public)',
    description:
      'No session needed. The Offers that appeared with `offer` on at least 3 distinct paid ' +
      'orders over the last 90 days (rebuilt nightly), most orders first, the asked Offer ' +
      'itself never included. `limit` is 1 to 24 (default 12). Only Offers that are sellable ' +
      'now and whose seller may sell are returned; the list may be short or empty. No other ' +
      'query field is allowed.',
  })
  @ApiQuery({ name: 'offer', required: true, description: 'An Offer id (uuid).' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 24, default 12.' })
  @ApiOkResponse({ type: ShelfPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async listBoughtTogether(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ShelfPageBody> {
    // Set first, so an error answer is `no-store` too.
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.boughtTogether.execute(context, boughtTogetherRequestOf(query));
    if (result.ok) return JSON.parse(JSON.stringify(result.value)) as ShelfPageBody;
    const { error } = result;
    if (error.code === 'validation.failed') throw fail(400, error.code, { fields: error.fields });
    const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, error.code);
    this.#logger.warn({
      msg: 'search.bought-together-refused',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'search.unavailable');
  }
}
