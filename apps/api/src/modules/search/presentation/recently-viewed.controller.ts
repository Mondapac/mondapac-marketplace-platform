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
import { ListRecentlyViewedGuest } from '../application/use-cases/list-recently-viewed-guest.use-case';
import { ListRecentlyViewed } from '../application/use-cases/list-recently-viewed.use-case';
import { personalShelf } from './personal-shelf';
import { ShelfPageBody } from './search.dto';

/**
 * The storefront's "recently viewed" shelf (personalization package 1d-1): the products the
 * shopper viewed that are sellable now, newest view first. Served from the `search` module
 * because the summaries come from its read model (`engagement` cannot depend on `search`); the
 * path is the engagement recommendations'. The shopper is the signed-in customer of the session
 * or, without one, the engagement guest cookie; never a query or body field. Under Global Privacy
 * Control, with the customer's switch off, or for a guest without `Engagement-Consent: granted`
 * the list is empty. `no-store`; no cookie is ever set or extended; the cookie is never logged.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('engagement/recommendations')
export class RecentlyViewedController {
  readonly #logger = new Logger('RecentlyViewedController');

  constructor(
    private readonly forCustomer: ListRecentlyViewed,
    private readonly forGuest: ListRecentlyViewedGuest,
  ) {}

  @Get('recently-viewed')
  @ReadsSession()
  @ApiOperation({
    summary: 'Recently viewed shelf (customer or guest)',
    description:
      'The products the shopper viewed that are sellable now, newest view first, each once ' +
      '(at most 50 are looked at), re-checked against catalog and sellers. Empty with ' +
      'Sec-GPC: 1, the customer’s personalization switch off, or a guest without ' +
      'Engagement-Consent: granted. `limit` is 1 to 24 (default 12). No other query field is allowed.',
  })
  @ApiHeader({ name: 'Sec-GPC', required: false, description: '1: an empty list' })
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
  recentlyViewed(
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
      'search.recently-viewed-refused',
    );
  }
}
