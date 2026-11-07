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
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { parseId } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { PlatformProductImageDelete } from '../application/use-cases/platform-product-image-delete.use-case';
import { PlatformProductImageList } from '../application/use-cases/platform-product-image-list.use-case';
import { PlatformProductImageUpload } from '../application/use-cases/platform-product-image-upload.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  PRODUCT_IMAGE_STATUS,
  ProductImageList,
  ProductImageUploadRequest,
  ProductImageView,
} from './product-image.controller';

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    PRODUCT_IMAGE_STATUS,
    error,
    response,
    context,
    'catalog.platform-product-image-unmapped-refusal',
  );
}

/** The upload arrives as bytes (the larger body parser); see the seller photo controller. */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const PRODUCT_PARAM = { name: 'productId', description: 'The PLATFORM product. A UUID v7.' };

/**
 * Photos of PLATFORM products for the admin form (P1 admin product images). The same pipeline as
 * the seller photo routes: JSON in with a base64 photo, the server decodes it and keeps only three
 * JPEG renditions it wrote. The bytes are read through the admin rendition route
 * `GET catalog/admin/products/:productId/images/:imageId/:size`. Order and the main photo are the
 * draft's `imageIds`, saved by the platform product draft route. Every route needs
 * `catalog.platform-product.edit` (checked by each use case's gate) and reads the admin session,
 * so the unsafe methods need the CSRF token. Thin adapters over one use case each.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/platform-products/:productId/images')
export class PlatformProductImageController {
  readonly #logger = new Logger('PlatformProductImageController');

  constructor(
    private readonly uploadImage: PlatformProductImageUpload,
    private readonly listImages: PlatformProductImageList,
    private readonly deleteImage: PlatformProductImageDelete,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the photos of a platform product',
    description:
      'Needs catalog.platform-product.edit. Clean photos of the library, oldest first; at most 8.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiOkResponse({ type: ProductImageList })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
  ): Promise<ProductImageList> {
    const productId = productIdOf(rawProductId);
    let outcome: ProductImageList | HttpException;
    if (productId === null) outcome = refusal({ code: 'product.not-found' }, response, context);
    else {
      const result = await this.listImages.execute(context, { productId });
      outcome = result.ok
        ? ({ images: result.value } as ProductImageList)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-images-list', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a photo to a platform product',
    description:
      'Needs catalog.platform-product.edit. Decodes the photo and stores three metadata-free ' +
      'JPEG renditions; the upload itself is not kept. The photo joins a revision only when its ' +
      'id is in the draft (imageIds) and the draft is submitted.',
  })
  @ApiParam(PRODUCT_PARAM)
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
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<ProductImageView> {
    const productId = productIdOf(rawProductId);
    let outcome: ProductImageView | HttpException;
    if (productId === null) outcome = refusal({ code: 'product.not-found' }, response, context);
    else {
      const input = closedBody(request, jsonOf(body), ['data']);
      if (input instanceof HttpException) outcome = input;
      else {
        const result = await this.uploadImage.execute(context, { productId, data: input.data });
        outcome = result.ok ? result.value : refusal(result.error, response, context);
      }
    }
    return this.settle('catalog.platform-product-image-upload', context, outcome);
  }

  @Delete(':imageId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete a photo of a platform product',
    description:
      'Needs catalog.platform-product.edit. A photo that a revision holds stays (image.in-use); ' +
      'a taken-down photo cannot be deleted.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ description: '{ deleted: true }' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied, request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'image.in-use' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async remove(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Param('imageId') imageId: string,
  ): Promise<{ deleted: true }> {
    const productId = productIdOf(rawProductId);
    let outcome: { deleted: true } | HttpException;
    if (productId === null) outcome = refusal({ code: 'image.not-found' }, response, context);
    else {
      const result = await this.deleteImage.execute(context, { productId, imageId });
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-image-delete', context, outcome);
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

/** A path id: malformed answers as an unknown product, byte-identical to a missing one. */
function productIdOf(raw: string): string | null {
  const parsed = parseId<'Product'>(raw);
  return parsed.ok ? parsed.value : null;
}
