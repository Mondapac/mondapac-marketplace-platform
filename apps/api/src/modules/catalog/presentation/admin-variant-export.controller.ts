import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  AdminVariantsExport,
  EXPORT_FORMATS,
  EXPORT_MAX_ROWS,
} from '../application/use-cases/admin-variants-export.use-case';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import { writeChunks } from './write-chunks';

/**
 * The HTTP status of each refusal of the variant export (catalog design 14b). A malformed request
 * is 400; a file over the row cap is 413 (`details.max`, `details.total`, `details.unit`: `products` or `rows`, what total counts); a missing dependency
 * is 503.
 */
export const ADMIN_VARIANT_EXPORT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'export.too-large': 413,
  'access.unavailable': 503,
});

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The variant file of the admin Catalogue over HTTP (catalog design 14b): one row per variant of
 * the products the list filters match, as CSV or XLSX. A read, so it needs the admin session but no
 * CSRF token. A thin adapter: the use case does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/variants')
export class AdminVariantExportController {
  readonly #logger = new Logger('AdminVariantExportController');

  constructor(private readonly exportVariants: AdminVariantsExport) {}

  @Get('export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the variants of the listed products as a file',
    description:
      'Needs catalog.product.view. `format` is csv (the default) or xlsx, with the same columns ' +
      'and header row: product_code, variant_code, product_type, one option[<attribute code>] ' +
      'per axis of the exported products, gtin, offer_count. One row per variant of the ' +
      "product's published revision; a product never published has none, and no price, stock or " +
      'seller is written. The products are what the selector keys of the list ' +
      `(view, q, scope, status, categoryId, typeCode, sellerId) match; at most ${EXPORT_MAX_ROWS} ` +
      'rows, else export.too-large. The file streams as an attachment. CSV: a text cell that ' +
      'starts with = + - @ is written with a leading quote. XLSX: every cell is a string value.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'view', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'scope', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'typeCode', required: false })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiOkResponse({
    description:
      'text/csv; charset=utf-8 (variants-<date>.csv) or ' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (variants-<date>.xlsx), as an attachment',
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'export.too-large (details.max, details.total, details.unit: products or rows)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportVariants.execute(context, { ...query });
    if (!result.ok) {
      const error = refusalWith(ADMIN_VARIANT_EXPORT_STATUS, result.error, response, context);
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
        msg: 'catalog.admin-variants-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
