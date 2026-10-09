import { Body, Controller, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SellerList } from '../application/use-cases/list.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { SellerListBody, SellerListRequest } from './seller-list.dto';

/**
 * The admin seller list over HTTP (sellers design 6.2, 7.8; SEL-14; slice 6). A thin adapter:
 * the `CallContext` comes from `@Call()` and the admin session cookie of the request's Market
 * (`@RoutePopulation('admin')` with `@ReadsSession()`); the controller authenticates only. Who
 * may list is the gate of the use case (`sellers.seller.view`), and the Market is the request's,
 * so a seller of another Market is never listed (AC 1).
 *
 * A POST, because the search term is a body field and never sits in a URL; it changes nothing,
 * so it is a read (`HttpCode(200)`) that still needs the CSRF token of an unsafe method. The
 * body is JSON, closed and shape-checked by the domain's `parseListRequest`; it is never logged,
 * and a log line holds the outcome, the tab, the Market and the correlation id only. Every
 * response is `Cache-Control: no-store`, errors included.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@Controller('sellers/admin')
export class SellerListController {
  readonly #logger = new Logger('SellerListController');

  constructor(private readonly list: SellerList) {}

  @Post('list')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'List sellers (admin)',
    description:
      'Three tabs read from the seller files: awaiting review (oldest first, with the kind of ' +
      'the submission), incomplete (most recently changed first) and all (newest first), with ' +
      'a store-name or slug prefix search, a kind filter, an outside-service-area filter and the ' +
      'counts the tabs show. Clear fields only: no business name, phone, address or number, and ' +
      "none of the owner's personal data. Needs sellers.seller.view.",
  })
  @ApiHeader({
    name: CSRF_HEADER,
    required: true,
    description: 'The CSRF token of the session (an unsafe method, although this is a read)',
  })
  @ApiBody({ type: SellerListRequest })
  @ApiOkResponse({ type: SellerListBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields) or search.too-broad',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied or request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable (the read, or identity, could not answer)',
  })
  async listSellers(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerListBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, body);
    this.#logger.log({
      msg: 'sellers.list-route',
      outcome: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      ...result.value,
      items: [...result.value.items],
    };
  }
}
