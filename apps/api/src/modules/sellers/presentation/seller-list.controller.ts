import { Body, Controller, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
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
import type { AccessDenied } from '../../../platform/authz';
import { writeChunks } from '../../../platform/list-export';
import { SellerList } from '../application/use-cases/list.use-case';
import { SellerListExport } from '../application/use-cases/seller-list-export.use-case';
import {
  SellerListQuery,
  type SellerSuperListFailure,
} from '../application/use-cases/seller-list-query.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import {
  SellerListBody,
  SellerListRequest,
  SellerSuperListBody,
  SellerSuperListExportRequest,
  SellerSuperListRequest,
} from './seller-list.dto';

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

  constructor(
    private readonly list: SellerList,
    private readonly superList: SellerListQuery,
    private readonly superExport: SellerListExport,
  ) {}

  @Post('list')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'List sellers (admin)',
    description:
      'Three tabs read from the seller files: awaiting review (oldest first, with the kind of ' +
      'the submission), incomplete (most recently changed first) and all (newest first), with ' +
      'a store-name or slug prefix search, a kind filter, an outside-service-area filter and the ' +
      'counts the tabs show; and three tabs paged through the access state of identity ' +
      '(changes needed, approved, suspended; newest first, no search). No business name, ' +
      'phone, address or number. Needs sellers.seller.view; the status, the owner name and ' +
      'email, the state tabs and their counts also need identity.seller-access.view.',
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
  @ApiForbiddenResponse({
    type: SellersErrorBody,
    description:
      'access.denied (also a state tab without identity.seller-access.view) or request.csrf',
  })
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
      areas: [...result.value.areas],
    };
  }

  @Post('sellers/list')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'List sellers as a super list (admin)',
    description:
      'Super list 15. Needs sellers.seller.view. The seven tabs of the seller list (`view`), ' +
      'with its filters (`kind`, `outsideArea`, `areaCode`, `q`), a sort (`queue`, the tab\u2019s ' +
      'own order, or `name`, with `direction`), page numbers with a total (`paging=pages`, ' +
      'default) or Previous/Next without one (`paging=prev-next`), the tab counts and each ' +
      'row\u2019s actions. The status, the owner name and email, the identity state tabs and ' +
      'their counts also need identity.seller-access.view. A POST so the search term never sits ' +
      'in a URL; a read, so 200. No business name, phone, address or number.',
  })
  @ApiHeader({
    name: CSRF_HEADER,
    required: true,
    description: 'The CSRF token of the session (an unsafe method, although this is a read)',
  })
  @ApiBody({ type: SellerSuperListRequest })
  @ApiOkResponse({ type: SellerSuperListBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields) or search.too-broad',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({
    type: SellersErrorBody,
    description:
      'access.denied (also a state tab without identity.seller-access.view) or request.csrf',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable (the read, or identity, could not answer)',
  })
  async listSellersPage(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerSuperListBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.superList.execute(context, body);
    this.#logger.log({
      msg: 'sellers.seller-list-query-route',
      outcome: result.ok ? 'listed' : result.error.code,
      ...(result.ok ? { tab: result.value.tab, rows: result.value.items.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw this.refusal(result.error, response);
    return {
      ...result.value,
      items: result.value.items.map((row) => ({ ...row, actions: [...row.actions] })),
      areas: [...result.value.areas],
    };
  }

  @Post('sellers/export')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the sellers list as a file (admin)',
    description:
      'Super list 15. Needs sellers.seller.view. `format` is csv (default) or xlsx; `columns` the ' +
      'optional columns (seller-id). The rows are `ids` (comma-separated seller ids, at most ' +
      '200; an id with no seller file in the Market refuses the whole file as file.not-found; no ' +
      'selector or sort beside them) or the selector and sort of the list, at most 10,000 ' +
      '(batch.too-large with the total). Columns: store, slug, status, ' +
      'kind, submitted, service area, timezone, created, last changed, health band and score; ' +
      'the status is blank without identity.seller-access.view. The owner\u2019s name and email are never in a file. CSV: a text cell ' +
      'that starts with = + - @ gets a leading quote. XLSX: every cell is a string.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SellerSuperListExportRequest })
  @ApiOkResponse({ description: 'sellers-<date>.csv or sellers-<date>.xlsx, as an attachment' })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields) or search.too-broad',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiPayloadTooLargeResponse({
    type: SellersErrorBody,
    description: 'batch.too-large (details.max, details.total)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async exportSellers(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.superExport.execute(context, body);
    this.#logger.log({
      msg: 'sellers.seller-list-export-route',
      outcome: result.ok ? 'export' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error = this.refusal(result.error, response);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'sellers.seller-list-export-route',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  private refusal(error: SellerSuperListFailure | AccessDenied, response: Response) {
    return error.code === 'batch.too-large'
      ? fail(413, 'batch.too-large', {
          max: error.max,
          ...(error.total === undefined ? {} : { total: error.total }),
        })
      : errorOf(error, response);
  }
}
