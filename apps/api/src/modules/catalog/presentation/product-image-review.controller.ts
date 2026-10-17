import {
  Body,
  Controller,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
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
import { ProductImageAdminRead } from '../application/use-cases/product-image-admin-read.use-case';
import { ProductImageTakeDown } from '../application/use-cases/product-image-take-down.use-case';
import { ProductRevisionImageList } from '../application/use-cases/product-revision-image-list.use-case';
import { IMAGE_TAKEDOWN_REASONS } from '../domain/events';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The status of each refusal of the admin photo routes (catalog design 10.4, 10.5). */
export const PRODUCT_IMAGE_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'image.not-found': 404,
  'revision.not-found': 404,
  'access.unavailable': 503,
});

export class RevisionImageDto {
  @ApiProperty() imageId!: string;
  @ApiProperty({ minimum: 1, description: '1 is the primary photo.' }) position!: number;
  @ApiProperty({ enum: ['clean', 'taken-down'], description: 'A taken-down photo is not served.' })
  state!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

export class RevisionImageListDto {
  @ApiProperty({ type: [RevisionImageDto] }) images!: RevisionImageDto[];
}

export class ProductImageTakeDownRequest {
  @ApiProperty({ enum: IMAGE_TAKEDOWN_REASONS, description: 'Why the photo is taken down.' })
  reasonCode!: string;
}

export class ProductImageTakenDownDto {
  @ApiProperty({ example: true }) takenDown!: true;
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The reviewer's side of product photos (catalog design 10.4, 10.5; slice 13): the photos of a
 * revision, a rendition of one photo, and the takedown. Renditions are served as the seller
 * route serves them: `image/jpeg` written by the server, `nosniff`, `no-store`, a sandboxing CSP.
 * Admin routes read the admin session; the takedown also needs the CSRF token and the panel's
 * origin. Thin adapters over one use case each.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/products/:productId')
export class ProductImageReviewController {
  readonly #logger = new Logger('ProductImageReviewController');

  constructor(
    private readonly listImages: ProductRevisionImageList,
    private readonly readImage: ProductImageAdminRead,
    private readonly takeDown: ProductImageTakeDown,
  ) {}

  @Get('revisions/:revisionId/images')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the photos of a product revision',
    description:
      'Needs catalog.product.view. In order, position 1 first. A taken-down photo is listed with ' +
      'its state but not served.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'revisionId', format: 'uuid' })
  @ApiOkResponse({ type: RevisionImageListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'revision.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('revisionId') revisionId: string,
  ): Promise<RevisionImageListDto> {
    const result = await this.listImages.execute(context, { productId, revisionId });
    const outcome = result.ok
      ? ({ images: result.value } as RevisionImageListDto)
      : refusalWith(PRODUCT_IMAGE_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.product-revision-image-list', context, outcome);
  }

  @Get('images/:imageId/:size')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @ApiOperation({
    summary: 'Read one rendition of a product photo',
    description:
      'Needs catalog.product.view. `size` is thumb, medium or large. The answer is an ' +
      'image/jpeg written by the server. A taken-down photo answers image.not-found.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
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
      : refusalWith(PRODUCT_IMAGE_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.product-image-admin-read', context, outcome);
  }

  @Post('images/:imageId/take-down')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Take a product photo down',
    description:
      'Needs catalog.product.approve. The photo is never served again, its files are removed ' +
      'and it cannot join a new revision; revisions that hold it keep their row. Repeating the ' +
      'call succeeds.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiBody({ type: ProductImageTakeDownRequest })
  @ApiOkResponse({ type: ProductImageTakenDownDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async takeDownImage(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
    @Body() body: unknown,
  ): Promise<ProductImageTakenDownDto> {
    const input = closedBody(request, body, ['reasonCode']);
    let outcome: ProductImageTakenDownDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.takeDown.execute(context, {
        productId,
        imageId,
        reasonCode: input.reasonCode as string,
      });
      outcome = result.ok
        ? result.value
        : refusalWith(PRODUCT_IMAGE_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.product-image-take-down', context, outcome);
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
