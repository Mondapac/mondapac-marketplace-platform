import { Body, Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import { UploadStorefrontSlideImage } from '../application/use-cases/upload-slide-image.use-case';
import { fail, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

export class SlideImageRequest {
  @ApiProperty({
    description: 'The wide desktop picture, base64 (JPEG, PNG or WebP, at most 4 MiB).',
  })
  desktop!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'An optional separate tall picture for phones, base64 (same limits).',
  })
  mobile?: string | null;
}

export class SlideImageBody {
  @ApiProperty({ format: 'uuid', description: 'Use it as `image.ref` of a slide.' })
  imageId!: string;
  @ApiProperty() hasMobile!: boolean;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

/** The body of a large JSON route comes as bytes; anything else is passed on to be refused. */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The slide image library, for admins (file storage pilot F9): one upload route. Thin adapter: the
 * use case does its work behind its gate. Unsafe requests carry a session cookie, so the Origin
 * and Sec-Fetch-Site checks and the CSRF token apply as on every admin route.
 */
@ApiTags('storefront')
@RoutePopulation('admin')
@ReadsSession()
@Controller('storefront/admin/slide-images')
export class AdminSlideImageController {
  readonly #logger = new Logger('AdminSlideImageController');

  constructor(private readonly upload: UploadStorefrontSlideImage) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Upload a slide image (admin)',
    description:
      'Needs storefront.slide.edit. A wide desktop picture and, if wanted, a separate tall mobile ' +
      'one. Each is decoded and written again as metadata-free JPEG renditions; the uploads are ' +
      'not kept. The answer names the image; a slide draft then uses it as `image.ref`. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SlideImageRequest })
  @ApiCreatedResponse({ type: SlideImageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'file.too-large' })
  @ApiUnsupportedMediaTypeResponse({
    ...ERROR,
    description: 'Not application/json, or file.unsupported-type',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'file.too-small, file.too-many-pixels or file.unreadable',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SlideImageBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.upload.execute(context, jsonOf(body));
    this.#logger.log({
      msg: 'storefront.upload-slide-image-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const retry = (result.error as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retry !== undefined) response.setHeader('Retry-After', String(retry));
      throw refusal(result.error, context, this.#logger);
    }
    return { ...result.value };
  }
}
