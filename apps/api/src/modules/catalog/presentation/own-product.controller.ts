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
  Put,
  Query,
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
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  getSchemaPath,
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
import { OwnProductOptions as OwnProductOptionsUseCase } from '../application/use-cases/own-product-options.use-case';
import { OwnProductSaveDraft } from '../application/use-cases/own-product-save-draft.use-case';
import { OwnProductSetOwnBrand } from '../application/use-cases/own-product-set-own-brand.use-case';
import { OwnProductSubmit } from '../application/use-cases/own-product-submit.use-case';
import { OwnProductRead } from '../application/use-cases/own-product-read.use-case';
import {
  OWN_LISTED_STATUSES,
  OWN_PAGE_SIZES,
  OWN_PRODUCT_SORTS,
  OWN_PRODUCT_VIEWS,
  OwnProductsList,
} from '../application/use-cases/own-products-list.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import {
  OwnProductList,
  OwnProductOptions,
  OwnProductPageList,
  OwnProductView,
} from './own-reads.dto';
import {
  ApiErrorBody,
  PlatformProductDraftSaved,
  PlatformProductSaveDraftRequest,
  PlatformProductSubmitRequest,
  PlatformProductSubmitted,
} from './platform-product.dto';
import {
  OwnProductCreated,
  OwnProductCreateRequest,
  OwnProductOwnBrandRequest,
  OwnProductOwnBrandSet,
} from './own-offer.dto';
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
  'offer.sku-taken': 409,
  'claim-text.refused': 422,
  // The claim steps of a submit (design 4.2 row 1, 5.1a): T4, the requested set, the publish
  // re-ask of a revision that publishes at once (slice 11).
  'claim.tags-would-be-lost': 422,
  'claim.requested-tag-not-allowed': 422,
  'offer.handling-missing': 422,
  'tag.type-unknown': 422,
  'conflict.retry': 409,
  'claim.check-unavailable': 503,
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

const WHOLE_NUMBER = /^\d{1,6}$/;

/**
 * The query of the product list as the use case reads it: `limit` (keyset mode), `page` and
 * `pageSize` become numbers and `paused` a boolean; a value that is not of that shape becomes
 * one the use case refuses (-1 or the text itself), so the answer is a `validation.failed`.
 */
function productListQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = pageQuery(query);
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined) {
      out[key] = typeof value === 'string' && WHOLE_NUMBER.test(value) ? Number(value) : -1;
    }
  }
  const paused = out['paused'];
  if (paused === 'true') out['paused'] = true;
  else if (paused === 'false') out['paused'] = false;
  return out;
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
    private readonly listProducts: OwnProductsList,
    private readonly readProduct: OwnProductRead,
    private readonly productOptions: OwnProductOptionsUseCase,
    private readonly setOwnBrand: OwnProductSetOwnBrand,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiExtraModels(OwnProductList, OwnProductPageList)
  @ApiOperation({
    summary: 'List the products of the seller',
    description:
      'Needs catalog.own-product.view. Only the seller’s own products of the Market are listed; ' +
      'discarded and withdrawn products are not. Two modes. Keyset mode (no list parameter): ' +
      'newest first, send `nextAfterId` of the previous page as `afterId`; `limit` is 1 to 50 ' +
      '(default 25); the answer is { items, nextAfterId }. List mode (any of view, q, status, ' +
      'categoryId, paused, typeCode, sort, direction, page, pageSize; send `page=1` for the first ' +
      'page): `view` is a tab, all (default), drafts (draft), live (published or matched, a ' +
      'paused product stays live), inactive (unpublished or retired) or in-review (has a pending ' +
      'revision; overlaps the others). `q` matches a part of the name (Market default locale) or ' +
      'of the product code. Filters: status, categoryId, paused (true or false), typeCode. ' +
      '`sort` is name, updated or created (default updated), `direction` asc or desc (default ' +
      'asc for name, desc otherwise). `pageSize` is 25, 50 or 100 (default 25); page numbers stop ' +
      'at row 10,000 (a later page is validation.failed on page). `counts` holds the five tab ' +
      'counts for the same search and filters. Sorting by name over more than 2000 matches is ' +
      'refused with validation.failed (sort, too-broad). Do not mix afterId or limit with the ' +
      'list parameters. No price and no stock.',
  })
  @ApiQuery({
    name: 'afterId',
    required: false,
    description: 'Keyset mode: the last product id of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Keyset mode: 1 to 50, default 25.' })
  @ApiQuery({ name: 'view', required: false, enum: OWN_PRODUCT_VIEWS })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Up to 100 characters, no control characters.',
  })
  @ApiQuery({ name: 'status', required: false, enum: OWN_LISTED_STATUSES })
  @ApiQuery({ name: 'categoryId', required: false, description: 'A platform category id.' })
  @ApiQuery({ name: 'paused', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'typeCode', required: false, description: 'A product type code.' })
  @ApiQuery({ name: 'sort', required: false, enum: OWN_PRODUCT_SORTS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: '1 or more, default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, enum: OWN_PAGE_SIZES.map(String) })
  @ApiOkResponse({
    description: 'OwnProductList in keyset mode, OwnProductPageList in list mode.',
    schema: {
      oneOf: [{ $ref: getSchemaPath(OwnProductList) }, { $ref: getSchemaPath(OwnProductPageList) }],
    },
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OwnProductList | OwnProductPageList> {
    const result = await this.listProducts.execute(context, productListQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnProductList | OwnProductPageList)
      : refusal(result.error, response, context);
    return this.settle('catalog.own-products-list', context, outcome);
  }

  // Declared before `:productId`, so "options" is not read as a product id.
  @Get('options')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Options for the product form and list filters',
    description:
      "Needs catalog.own-product.edit. The Market's product types, Offer conditions and locales, " +
      'whether sellers may create products here, and the statuses shown on products and Offers. ' +
      "The type list is the Market's and is not yet narrowed by what the seller may sell.",
  })
  @ApiOkResponse({ type: OwnProductOptions })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async options(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnProductOptions> {
    const result = await this.productOptions.execute(context, {});
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnProductOptions)
      : refusal(result.error, response, context);
    return this.settle('catalog.own-product-options', context, outcome);
  }

  @Get(':productId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read one product of the seller',
    description:
      'Needs catalog.own-product.view. The product with its variants, working copy, published ' +
      'revision and pending revision. Another seller’s product, a PLATFORM product and an ' +
      'unknown id are one byte-identical product.not-found.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiOkResponse({ type: OwnProductView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
  ): Promise<OwnProductView> {
    const productId = productIdOf(rawProductId, response);
    let outcome: OwnProductView | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else {
      const result = await this.readProduct.execute(context, { productId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as OwnProductView)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-read', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a draft product of the seller',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The request names the type and ' +
      'the Offer form (sellerSku, conditionCode, description); the product is SELLER, owned by ' +
      'the session seller, in the Market default family, with a fresh product code, and the ' +
      "seller's draft Offer is made with it. The type must be one the seller may sell.",
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: OwnProductCreateRequest })
  @ApiCreatedResponse({ type: OwnProductCreated })
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
  ): Promise<OwnProductCreated> {
    const input = closedBody(request, body, [
      'typeCode',
      'sellerSku',
      'conditionCode',
      'description',
    ]);
    let outcome: OwnProductCreated | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createProduct.execute(context, {
        typeCode: input.typeCode as string,
        sellerSku: input.sellerSku as string,
        conditionCode: input.conditionCode as string,
        description: input.description,
      });
      outcome = result.ok
        ? {
            productId: result.value.productId,
            productCode: result.value.productCode,
            variantIds: [...result.value.variantIds],
            offerId: result.value.offerId,
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
            variantNotices: result.value.variantNotices.map((notice) => ({ ...notice })),
          }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-save-draft', context, outcome);
  }

  @Put(':productId/own-brand')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Mark an own product as carrying the seller's own brand",
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The mark lets the seller ' +
      'propose a brand (POST catalog/seller/brands). It is a flag of the product, not part of ' +
      'a revision: it needs no review and changes nothing buyers see. Setting the value it ' +
      'already has changes nothing. A product of another seller, a PLATFORM product and an ' +
      'unknown id are product.not-found.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: OwnProductOwnBrandRequest })
  @ApiOkResponse({ type: OwnProductOwnBrandSet })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or product.not-editable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async setProductOwnBrand(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<OwnProductOwnBrandSet> {
    const productId = productIdOf(rawProductId, response);
    const input = closedBody(request, body, ['ownBrand']);
    let outcome: OwnProductOwnBrandSet | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setOwnBrand.execute(context, {
        productId,
        ownBrand: input['ownBrand'],
      });
      outcome = result.ok
        ? { productId: result.value.productId, ownBrand: result.value.ownBrand }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-product-set-own-brand', context, outcome);
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
      "(revision.not-ready, details.issues). Certification tags of the seller's Offer are asked " +
      'against the submitted revision: one that would be lost refuses (claim.tags-would-be-lost, ' +
      'details.tags); when the revision publishes at once, that ask settles the tags against it. ' +
      'An unanswered check refuses (claim.check-unavailable); a lost race is retried, then ' +
      'conflict.retry.',
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
      'conflict.stale, conflict.retry, revision.pending-exists, revision.base-changed, product.not-a-draft or another state refusal',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'claim-text.refused, revision.not-ready, type.not-allowed, claim.tags-would-be-lost or ' +
      'offer.handling-missing',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description:
      'access.unavailable, claim.check-unavailable, revision.schema-unavailable or ' +
      'revision.type-unknown',
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
