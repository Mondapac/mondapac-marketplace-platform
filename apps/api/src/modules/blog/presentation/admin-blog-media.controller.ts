import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ListBlogMedia } from '../application/use-cases/list-media.use-case';
import { UploadBlogMedia } from '../application/use-cases/upload-media.use-case';
import { ViewBlogMediaFile } from '../application/use-cases/view-media-file.use-case';
import { MEDIA_SIZES } from '../domain/media';
import { closedBody, plain, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const UNAVAILABLE = {
  ...ERROR,
  description: 'blog.unavailable (with Retry-After when too many pictures are being processed)',
};

export class BlogMediaUploadRequest {
  @ApiProperty({
    description:
      'The picture as standard base64 (JPEG, PNG or WebP by content, at most 4 MiB decoded, the ' +
      'longest side at least 400 pixels).',
  })
  data!: string;
}

export class BlogMediaBody {
  @ApiProperty({
    format: 'uuid',
    description: 'Use it as `coverImageId` of a post or `imageId` of an image block.',
  })
  id!: string;
  @ApiProperty({ description: 'Width of the large rendition, in pixels.' }) width!: number;
  @ApiProperty({ description: 'Height of the large rendition, in pixels.' }) height!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'uuid', description: 'The account that uploaded the picture.' })
  uploadedBy!: string;
}

export class BlogMediaPage {
  @ApiProperty({ type: [BlogMediaBody], description: 'Newest first.' }) items!: BlogMediaBody[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() hasMore!: boolean;
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
 * The blog media library, for admins (blog media upload): upload a picture, list the library and
 * read one rendition. Thin adapters: each use case does its work behind its gate (upload:
 * `blog.media.edit`; list and read: `blog.post.read`). Unsafe requests carry a session cookie, so
 * the Origin and Sec-Fetch-Site checks and the CSRF token apply as on every admin route. Every
 * answer is `no-store`; a rendition is served as the JPEG the server wrote, with `nosniff` and a
 * sandboxing CSP, like catalog's admin photo route.
 */
@ApiTags('blog')
@RoutePopulation('admin')
@ReadsSession()
@Controller('blog/admin/media')
export class AdminBlogMediaController {
  readonly #logger = new Logger('AdminBlogMediaController');

  constructor(
    private readonly upload: UploadBlogMedia,
    private readonly list: ListBlogMedia,
    private readonly file: ViewBlogMediaFile,
  ) {}

  private settle<T>(
    msg: string,
    context: CallContext,
    response: Response,
    result: Result<T, { readonly code: string } & Record<string, unknown>>,
  ): T {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const retry = result.error.retryAfterSeconds;
      if (typeof retry === 'number') response.setHeader('Retry-After', String(retry));
      throw refusal(result.error, context, this.#logger);
    }
    return result.value;
  }

  @Get()
  @ApiOperation({
    summary: 'The pictures of the blog media library (admin)',
    description: 'Needs blog.post.read. Newest first, 40 a page.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'From 1.' })
  @ApiOkResponse({ type: BlogMediaPage })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async index(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { query: request.query });
    return plain(this.settle('blog.list-media-route', context, response, result));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Upload a picture to the blog media library (admin)',
    description:
      'Needs blog.media.edit. The picture is decoded and written again as metadata-free JPEG ' +
      'renditions (large, thumb); the upload is not kept. The answer names the picture; a post ' +
      'then uses it as coverImageId or as the imageId of an image block. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BlogMediaUploadRequest })
  @ApiCreatedResponse({ type: BlogMediaBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'file.too-large' })
  @ApiUnsupportedMediaTypeResponse({
    ...ERROR,
    description: 'Not application/json (request.body-unsupported), or file.unsupported-type',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'file.too-small, file.too-many-pixels or file.unreadable',
  })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const json = jsonOf(body);
    const invalid = closedBody(request, json, ['data']);
    if (invalid !== null) throw invalid;
    const result = await this.upload.execute(context, { body: json });
    return plain(this.settle('blog.upload-media-route', context, response, result));
  }

  @Get(':media/:size')
  @ApiOperation({
    summary: 'One rendition of a picture of the blog media library (admin)',
    description:
      `Needs blog.post.read. size is ${MEDIA_SIZES.join(' or ')}. The answer is an image/jpeg ` +
      'written by the server.',
  })
  @ApiParam({ name: 'media', format: 'uuid', description: 'The picture.' })
  @ApiParam({ name: 'size', enum: MEDIA_SIZES })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'blog.media-not-found' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('media') media: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', 'sandbox');
    const result = await this.file.execute(context, { media, size });
    const value = this.settle('blog.view-media-file-route', context, response, result);
    return new StreamableFile(value.bytes, { type: value.contentType });
  }
}
