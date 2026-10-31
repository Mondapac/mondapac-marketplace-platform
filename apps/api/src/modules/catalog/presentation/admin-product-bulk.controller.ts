import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminProductsBulk } from '../application/use-cases/admin-products-bulk.use-case';
import {
  AdminProductsExport,
  EXPORT_COLUMNS,
  EXPORT_FORMATS,
  EXPORT_MAX_ROWS,
} from '../application/use-cases/admin-products-export.use-case';
import { AdminProductBulkDto, AdminProductBulkRequest } from './admin-product-bulk.dto';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the bulk action and the export (catalog design 9.2c). A
 * malformed request is 400; an id that is no product of the Market is 404 (the same answer for
 * every unknown id); a request over the cap is 413; a Delete confirmed with another Offer count
 * than the current one is 409 (confirm again with `details.currentCount`); a missing dependency
 * is 503.
 */
export const ADMIN_PRODUCT_BULK_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'product.not-found': 404,
  'batch.too-large': 413,
  'retire.count-changed': 409,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The Bulk action menu of the admin Products page over HTTP (catalog design 9.2c): Deactivate,
 * Activate and Delete over many products, and the export of the list as a file. Admin routes read
 * the admin session, so the bulk action needs the CSRF token and the panel's origin. A thin
 * adapter: one use case each does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/products')
export class AdminProductBulkController {
  readonly #logger = new Logger('AdminProductBulkController');

  constructor(
    private readonly bulk: AdminProductsBulk,
    private readonly exportProducts: AdminProductsExport,
  ) {}

  @Post('bulk')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Deactivate, activate or delete many products',
    description:
      'Needs catalog.product.view; each product then needs the key of its action: ' +
      'catalog.product.pause (pause, resume), catalog.product.delete (delete of a SELLER ' +
      'product: withdraw) or catalog.platform-product.retire (delete of a PLATFORM product: ' +
      'retire). Names the products by `productIds` (1 to 200) or by a `selector` (the tab, ' +
      'search and filters of the list, resolved here, at most 2000 products). Each product is ' +
      'its own unit: the answer lists every product as done, skipped (already in that state, ' +
      'or the admin may not act on it) or failed, and the counts. Delete of PLATFORM products ' +
      'needs `confirmOfferCount`, the number a dry run answered; another number is refused ' +
      'with retire.count-changed and the current count. `dryRun: true` changes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminProductBulkRequest })
  @ApiOkResponse({ type: AdminProductBulkDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'retire.count-changed (details.currentCount)',
  })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'batch.too-large (details.max, details.total)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async run(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminProductBulkDto> {
    const input = closedBody(
      request,
      body,
      ['action'],
      ['productIds', 'selector', 'confirmOfferCount', 'dryRun'],
    );
    if (input instanceof HttpException) throw input;
    const result = await this.bulk.execute(context, input);
    if (!result.ok) throw refusalWith(ADMIN_PRODUCT_BULK_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as AdminProductBulkDto;
  }

  @Get('export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the products of the list as a file',
    description:
      'Needs catalog.product.view. `format` is csv (xlsx is not supported yet). `columns` is the ' +
      'comma-separated optional columns in the order shown (code, offers, updated, type, scope, ' +
      'seller, created); product, product code, category and status are always there. The ' +
      `products are \`ids\` (comma-separated, at most 200) or the selector keys of the list ` +
      `(view, q, scope, status, categoryId, typeCode, sellerId), at most ${EXPORT_MAX_ROWS}. ` +
      'The file streams as an attachment. A text cell that starts with = + - @ is written with a ' +
      'leading quote, so a spreadsheet never runs it as a formula.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({
    name: 'columns',
    required: false,
    description: `Any of: ${EXPORT_COLUMNS.join(', ')}.`,
  })
  @ApiQuery({ name: 'ids', required: false, description: 'Comma-separated product ids.' })
  @ApiQuery({ name: 'view', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'scope', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'typeCode', required: false })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiOkResponse({ description: 'text/csv; charset=utf-8, as an attachment' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportProducts.execute(context, { ...query });
    if (!result.ok) {
      const error = refusalWith(ADMIN_PRODUCT_BULK_STATUS, result.error, response, context);
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
      for await (const chunk of chunks) {
        // Backpressure: wait for the socket when its buffer is full.
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => response.once('drain', resolve));
        }
      }
      response.end();
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'catalog.admin-products-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
