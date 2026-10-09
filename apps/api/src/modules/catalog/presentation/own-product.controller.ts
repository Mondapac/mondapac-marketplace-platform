import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
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
import { OwnProductCreate } from '../application/use-cases/own-product-create.use-case';
import { OwnProductSaveDraft } from '../application/use-cases/own-product-save-draft.use-case';
import { OwnProductSubmit } from '../application/use-cases/own-product-submit.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import {
  ApiErrorBody,
  PlatformProductCreated,
  PlatformProductCreateRequest,
  PlatformProductDraftSaved,
  PlatformProductSaveDraftRequest,
  PlatformProductSubmitRequest,
  PlatformProductSubmitted,
} from './platform-product.dto';
import { PLATFORM_PRODUCT_STATUS } from './platform-product.controller';

/**
 * The HTTP status of each refusal of the seller product routes (catalog design 4.2, 8.2): the
 * platform table plus the seller guards. A seller who may not sell is 403; a Market setting that
 * is off, or a type the seller may not sell, is 422. A product of another seller, a PLATFORM
 * product and an unknown id are one byte-identical 404.
 */
export const OWN_PRODUCT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...PLATFORM_PRODUCT_STATUS,
  'seller.not-eligible': 403,
  'setting.product-creation-off': 422,
  'type.not-allowed': 422,
});

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    OWN_PRODUCT_STATUS,
    error,
    response,
    context,
    'catalog.own-product-unmapped-refusal',
  );
}

function productIdOf(raw: string, response: Response): string | HttpException {
  const parsed = parseId<'Product'>(raw);
  return parsed.ok ? parsed.value : refusal({ code: 'product.not-found' }, response);
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const PRODUCT_PARAM = { name: 'productId', description: 'The product. A UUID v7.' };

/**
 * Seller product authoring over HTTP (catalog design 4.2, 8.2; OFR-01): a seller creates a draft
 * product of their own, saves its working copy and submits it (a revision publishes at once or
 * waits for review, 4.3). Every route reads the seller session of the request's Market
 * (`@ReadsSession`), so it needs the CSRF token and the seller panel's origin; JSON only, with a
 * closed body. Thin adapters over one use case each (key `catalog.own-product.edit`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/products')
export class OwnProductController {
  readonly #logger = new Logger('OwnProductController');

  constructor(
    private readonly createProduct: OwnProductCreate,
    private readonly saveDraft: OwnProductSaveDraft,
    private readonly submitProduct: OwnProductSubmit,
  ) {}

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a draft product of the seller',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The request names the type ' +
      'only; the product is SELLER, owned by the session seller, in the Market default family, ' +
      'with a fresh product code. The type must be one the seller may sell.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformProductCreateRequest })
  @ApiCreatedResponse({ type: PlatformProductCreated })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'product.type-not-offered, type.not-allowed or setting.product-creation-off',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable, product.type-unknown or product.family-unavailable',
  })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PlatformProductCreated> {
    const input = closedBody(request, body, ['typeCode']);
    let outcome: PlatformProductCreated | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createProduct.execute(context, {
        typeCode: input.typeCode as string,
      });
      outcome = result.ok
        ? {
            productId: result.value.productId,
            productCode: result.value.productCode,
            variantIds: [...result.value.variantIds],
          }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-create', context, outcome);
  }

  @Put(':productId/draft')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the working copy of an own product (autosave included)',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Replaces the draft. A text ' +
      'that holds a certification-like claim or a hidden character, or that cannot be ' +
      'checked, is not written: it keeps its last saved value and is listed in refusedFields. ' +
      'A product of another seller, a PLATFORM product and an unknown id are product.not-found. ' +
      'At most 60 saves a minute per account.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformProductSaveDraftRequest })
  @ApiOkResponse({ type: PlatformProductDraftSaved })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or working-copy.invalid-content',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, product.not-editable, product.not-a-draft or variant.id-taken',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'variant.* refusals (variant.limit-reached has details.max)',
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async saveWorkingCopy(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<PlatformProductDraftSaved> {
    const productId = productIdOf(rawProductId, response);
    const input = closedBody(request, body, ['content', 'variantIds']);
    let outcome: PlatformProductDraftSaved | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.saveDraft.execute(context, {
        productId,
        content: input.content,
        variantIds: input.variantIds as readonly (string | null)[],
      });
      outcome = result.ok
        ? {
            variantIds: [...result.value.variantIds],
            refusedFields: result.value.refusedFields.map((field) => ({ ...field })),
          }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-save-draft', context, outcome);
  }

  @Post(':productId/submit')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Submit the working copy of an own product',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Checks every text of the ' +
      'frozen content, freezes the revision and stores it. The revision publishes at once or ' +
      'waits for review (published in the answer). A claim in a text refuses the submit ' +
      '(claim-text.refused, details.fields); a draft that is not ready lists its issues ' +
      '(revision.not-ready, details.issues).',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformProductSubmitRequest })
  @ApiOkResponse({ type: PlatformProductSubmitted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'product.not-found or working-copy.not-found',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, revision.pending-exists, revision.base-changed, product.not-a-draft or another state refusal',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'claim-text.refused, revision.not-ready or type.not-allowed',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable, revision.schema-unavailable or revision.type-unknown',
  })
  async submit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<PlatformProductSubmitted> {
    const productId = productIdOf(rawProductId, response);
    const input = closedBody(request, body, ['replacePending']);
    let outcome: PlatformProductSubmitted | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.submitProduct.execute(context, {
        productId,
        replacePending: input.replacePending as boolean,
      });
      outcome = result.ok
        ? {
            revisionId: result.value.revisionId,
            revisionNo: result.value.revisionNo,
            published: result.value.published,
          }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-submit', context, outcome);
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
