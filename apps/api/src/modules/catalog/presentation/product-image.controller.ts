import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { OwnProductImageDelete } from '../application/use-cases/own-product-image-delete.use-case';
import { OwnProductImageList } from '../application/use-cases/own-product-image-list.use-case';
import { OwnProductImageRead } from '../application/use-cases/own-product-image-read.use-case';
import { OwnProductImageUpload } from '../application/use-cases/own-product-image-upload.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { OWN_PRODUCT_STATUS } from './own-product.controller';
import { ApiErrorBody } from './platform-product.dto';

/** The status of each refusal of the photo routes, on top of the seller product table. */
export const PRODUCT_IMAGE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...OWN_PRODUCT_STATUS,
  'image.not-found': 404,
  'image.in-use': 409,
  'image.limit-reached': 409,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.too-many-pixels': 422,
  'file.too-small': 422,
  'file.unreadable': 422,
});

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    PRODUCT_IMAGE_STATUS,
    error,
    response,
    context,
    'catalog.product-image-unmapped-refusal',
  );
}

/**
 * The upload arrives as bytes (its body parser takes a larger limit than the JSON one); anything
 * that is not a JSON object stays as it is and `closedBody` refuses it.
 */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export class ProductImageUploadRequest {
  @ApiProperty({
    description:
      'The photo as standard base64 text: JPEG, PNG or WebP, at most 4 MiB of bytes. The panel ' +
      'shrinks it before sending. The type is read from the content.',
  })
  data!: string;
}

export class ProductImageView {
  @ApiProperty() imageId!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty() createdAt!: string;
}

export class ProductImageList {
  @ApiProperty({ type: [ProductImageView] }) images!: ProductImageView[];
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * Photos of a seller's own products (catalog design 10, simplified path). JSON in, JPEG out: the
 * panel sends a base64 photo, the server decodes and rewrites it, and serves only the files it
 * wrote (`image/jpeg`, `nosniff`, `no-store`, a sandboxing CSP). Thin adapters over one use case
 * each.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/products/:productId/images')
export class ProductImageController {
  readonly #logger = new Logger('ProductImageController');

  constructor(
    private readonly uploadImage: OwnProductImageUpload,
    private readonly listImages: OwnProductImageList,
    private readonly readImage: OwnProductImageRead,
    private readonly deleteImage: OwnProductImageDelete,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the photos of an own product',
    description: 'Needs catalog.own-product.view. Oldest first; at most 8.',
  })
  @ApiOkResponse({ type: ProductImageList })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
  ): Promise<ProductImageList> {
    const result = await this.listImages.execute(context, { productId });
    const outcome = result.ok
      ? ({ images: result.value } as ProductImageList)
      : refusal(result.error, response, context);
    return this.settle('catalog.own-product-images-list', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a photo to an own product',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Decodes the photo and stores ' +
      'three metadata-free JPEG renditions; the upload itself is not kept. The photo joins a ' +
      'revision only when its id is in the draft (imageIds) and the draft is submitted; every ' +
      'revision that adds a photo goes to review.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductImageUploadRequest })
  @ApiCreatedResponse({ type: ProductImageView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied, request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'image.limit-reached' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'file.too-many-pixels, file.too-small or file.unreadable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'file.unsupported-type' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async upload(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<ProductImageView> {
    const input = closedBody(request, jsonOf(body), ['data']);
    let outcome: ProductImageView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.uploadImage.execute(context, { productId, data: input.data });
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-image-upload', context, outcome);
  }

  @Get(':imageId/:size')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @ApiOperation({
    summary: 'Read one rendition of a photo',
    description:
      'Needs catalog.own-product.view. `size` is thumb, medium or large. The answer is an ' +
      'image/jpeg written by the server.',
  })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    const result = await this.readImage.execute(context, { productId, imageId, size });
    const outcome = result.ok
      ? new StreamableFile(result.value.bytes, { type: result.value.contentType })
      : refusal(result.error, response, context);
    return this.settle('catalog.own-product-image-read', context, outcome);
  }

  @Delete(':imageId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete a photo of an own product',
    description:
      'Needs catalog.own-product.edit. A photo that a revision holds stays (image.in-use).',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ description: '{ deleted: true }' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied, request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'image.in-use' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async remove(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
  ): Promise<{ deleted: true }> {
    const result = await this.deleteImage.execute(context, { productId, imageId });
    const outcome = result.ok ? result.value : refusal(result.error, response, context);
    return this.settle('catalog.own-product-image-delete', context, outcome);
  }

  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
