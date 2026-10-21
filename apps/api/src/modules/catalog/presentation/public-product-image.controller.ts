import { Controller, Get, Logger, Param, Res, StreamableFile } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { PublishedImageRead } from '../application/use-cases/published-image-read.use-case';
import { fail } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * How long a shared cache or a browser may keep a served photo. Short and not `immutable`: the
 * URL carries the image id, not a content hash, and a takedown must reach buyers within minutes.
 */
export const PUBLIC_IMAGE_MAX_AGE_SECONDS = 300;

/**
 * The buyer-facing photo route (catalog design 10, simplified path; storefront images package).
 * No session is read and none is ever written: the actor is the Market's anonymous actor and the
 * Market is the request's (`x-market-id`). In the default per-origin rate-limit class. Serves a
 * rendition only for a product that is published in the Market, for a photo that is in its
 * current published revision and is not taken down; every other case, whatever the reason, is the
 * same `404 image.not-found`. The bytes are JPEG written by the server; the type is set by the
 * server and the answer is sandboxed, never sniffed, and never carries a cookie.
 */
@ApiTags('catalog')
@RoutePopulation('customer')
@Controller('catalog/products/:productId/images')
export class PublicProductImageController {
  readonly #logger = new Logger('PublicProductImageController');

  constructor(private readonly readImage: PublishedImageRead) {}

  @Get(':imageId/:size')
  @ApiOperation({
    summary: 'A product photo (public)',
    description:
      'No session needed. `size` is thumb, medium or large. Served only for a published ' +
      "product's current photo that is not taken down; any other case is 404 image.not-found. " +
      'The answer is an image/jpeg written by the server, with `nosniff`, a sandboxing CSP, ' +
      '`Cross-Origin-Resource-Policy: cross-origin` and `Cache-Control: public, max-age=300` ' +
      '(no `immutable`: a takedown must take effect quickly). No cookie is ever set. The ' +
      'query string is ignored.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiParam({ name: 'size', enum: ['thumb', 'medium', 'large'] })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'image.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    // Set on every answer, an error too: these only restrict what the browser may do with it.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    const result = await this.readImage.execute(context, { productId, imageId, size });
    if (result.ok) {
      // Only a served photo is cacheable; the global `no-store` stays on every refusal.
      response.setHeader('Cache-Control', `public, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}`);
      // The storefront loads the photo from another origin (a cookieless image domain).
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return new StreamableFile(result.value.bytes, { type: result.value.contentType });
    }
    const { error } = result;
    if (error.code === 'image.not-found') throw fail(404, error.code);
    const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, error.code);
    this.#logger.warn({
      msg: 'catalog.public-image-refused',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'image.unavailable');
  }
}
