import {
  Controller,
  Get,
  Header,
  HttpException,
  Logger,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { PublishedStoreImageRead } from '../application/use-cases/published-store-image-read.use-case';
import { SellersErrorBody } from './my-file.dto';

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

/**
 * The public logo and banner of a store that may sell now (slice 12 part 2). No session is read.
 * Only the store's CURRENT image of a store that passes the same eligibility as the store page is
 * served; an unknown or malformed slug, an unknown, replaced or removed image, another store's
 * image, a size that does not exist and a store that may not sell now all answer one identical
 * 404. The bytes are the JPEG the server wrote (no metadata), `nosniff`, with a CSP that allows
 * nothing, cached for five minutes by browsers and shared caches (the image id is unique, so a
 * new picture is a new URL; a removed picture is gone from the origin at once and from caches
 * within the five minutes).
 */
@ApiTags('sellers')
@RoutePopulation('customer')
@Controller('sellers/stores/:slug/images')
export class PublicStoreImageController {
  readonly #logger = new Logger('PublicStoreImageController');

  constructor(private readonly read: PublishedStoreImageRead) {}

  @Get(':imageId/:size')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiOperation({
    summary: 'The logo or banner of a store that sells now (public)',
    description:
      'No session needed. `size` is small or large. Any other case is 404 image.not-found, alike.',
  })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'image.not-found' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async image(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('slug') slug: string,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    const result = await this.read.execute(context, { slug, imageId, size });
    if (result.ok) {
      response.setHeader('Cache-Control', 'public, max-age=300');
      return new StreamableFile(result.value.bytes, { type: result.value.contentType });
    }
    response.setHeader('Cache-Control', 'no-store');
    const { code } = result.error;
    if (code === 'image.not-found') throw fail(404, code);
    const denied = ACCESS_DENIED_STATUS[code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, code);
    this.#logger.warn({
      msg: 'sellers.public-store-image-refused',
      code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'sellers.unavailable');
  }
}
