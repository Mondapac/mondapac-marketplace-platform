import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ListForYouGuest } from '../application/use-cases/list-for-you-guest.use-case';
import { ListForYou } from '../application/use-cases/list-for-you.use-case';
import { personalShelf } from './personal-shelf';
import { ShelfPageBody } from './search.dto';

/**
 * The storefront's "for you" shelf (personalization package 1d-1). The shopper is the signed-in
 * customer of the session or, without one, the engagement guest cookie; never a query or body
 * field. Under Global Privacy Control, with the customer's switch off, or for a guest without
 * `Engagement-Consent: granted` nothing personal is used and the shelf is the Market's best
 * sellers. `no-store`; no cookie is ever set or extended; the cookie is never logged.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('search')
export class ForYouController {
  readonly #logger = new Logger('ForYouController');

  constructor(
    private readonly forCustomer: ListForYou,
    private readonly forGuest: ListForYouGuest,
  ) {}

  @Get('for-you')
  @ReadsSession()
  @ApiOperation({
    summary: 'For-you shelf (customer or guest)',
    description:
      "Best sellers in the categories the shopper viewed, then the Market's best sellers, " +
      'each Offer once and re-checked against catalog and sellers. A certification (a ' +
      'certified category or tag) is never a signal. With Sec-GPC: 1, the customer’s ' +
      'personalization switch off, or a guest without Engagement-Consent: granted, it is the ' +
      "Market's best sellers. `limit` is 1 to 24 (default 12). No other query field is allowed.",
  })
  @ApiHeader({ name: 'Sec-GPC', required: false, description: '1: nothing personal is used' })
  @ApiHeader({
    name: 'Engagement-Consent',
    required: false,
    description: 'granted: the guest accepted the behaviour cookie. Ignored for a customer.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 24, default 12.' })
  @ApiOkResponse({ type: ShelfPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  forYou(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ShelfPageBody> {
    return personalShelf(
      context,
      request,
      response,
      query,
      (ctx, input) => this.forCustomer.execute(ctx, input),
      (ctx, input) => this.forGuest.execute(ctx, input),
      this.#logger,
      'search.for-you-refused',
    );
  }
}
