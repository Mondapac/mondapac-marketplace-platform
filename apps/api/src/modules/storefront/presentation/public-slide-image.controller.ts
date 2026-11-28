import { Controller, Get, Logger, Param, Res, StreamableFile } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ViewStorefrontSlideImage } from '../application/use-cases/view-slide-image.use-case';
import { refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * The buyer-facing slide picture route. No session is read: the actor is the Market's anonymous
 * actor and the Market is in the path (`:market`, checked like `x-market-id`; an `<img>` cannot
 * send a header). The slider read names these paths in `desktopUrl` and the other size fields.
 */
@ApiTags('storefront')
@RoutePopulation('customer')
@MarketFromPath()
@RateLimit('public-media')
@Controller('storefront/slide-images')
export class PublicSlideImageController {
  readonly #logger = new Logger('PublicSlideImageController');

  constructor(private readonly slideImage: ViewStorefrontSlideImage) {}

  @Get(':market/:imageId/:size')
  @ApiOperation({
    summary: 'One rendition of a slide image (public)',
    description:
      'No session needed; the Market is in the path because a browser image request cannot send ' +
      '`x-market-id`. `size` is desktop, desktop-small, mobile or mobile-small; always a ' +
      'metadata-free JPEG. The image id is unguessable and the file is read from the stored ' +
      'rendition row of that Market. `Cache-Control: public, max-age=300` and ' +
      '`Cross-Origin-Resource-Policy: cross-origin` (the buyer site loads it from another origin).',
  })
  @ApiParam({ name: 'market', description: 'The Market id: two capital letters' })
  @ApiParam({ name: 'imageId', description: 'A slide image id. A UUID v7.' })
  @ApiParam({ name: 'size', enum: ['desktop', 'desktop-small', 'mobile', 'mobile-small'] })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.slide-image-not-found' })
  async slideImageFile(
    @Call() context: CallContext,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const result = await this.slideImage.execute(context, { imageId, size });
    this.#logger.log({
      msg: 'storefront.view-slide-image-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      response.setHeader('Cache-Control', 'no-store');
      throw refusal(result.error, context, this.#logger);
    }
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return new StreamableFile(result.value.bytes, { type: result.value.contentType });
  }
}
