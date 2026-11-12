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
import { PlatformProductOptions } from '../application/use-cases/platform-product-options.use-case';
import { PlatformProductDiscard } from '../application/use-cases/platform-product-discard.use-case';
import { PlatformProductRead } from '../application/use-cases/platform-product-read.use-case';
import { PlatformProductAddSizes } from '../application/use-cases/platform-product-add-sizes.use-case';
import { PlatformProductAddSizesImpact } from '../application/use-cases/platform-product-add-sizes-impact.use-case';
import { PlatformProductCreate } from '../application/use-cases/platform-product-create.use-case';
import { PlatformProductSaveDraft } from '../application/use-cases/platform-product-save-draft.use-case';
import { PlatformProductSubmit } from '../application/use-cases/platform-product-submit.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import {
  AddSizesDone,
  AddSizesImpactView,
  ApiErrorBody,
  PlatformAddSizesRequest,
  PlatformProductCreated,
  PlatformProductCreateRequest,
  PlatformProductDiscarded,
  PlatformProductDraftSaved,
  PlatformProductOptionsView,
  PlatformProductView,
  PlatformProductSaveDraftRequest,
  PlatformProductSubmitRequest,
  PlatformProductSubmitted,
} from './platform-product.dto';

/**
 * The HTTP status of each refusal of the platform product routes (catalog design 4.2, 8.2; slice
 * 6). The design names codes, not statuses. Chosen: a malformed request is 400; a product that is
 * missing, of another Market or malformed in the path is 404; a SELLER product (or an owner
 * mismatch) is 403 to an admin, who may know it exists; a state that refuses the change is 409; a request the rules refuse (a claim in a text, a draft that is not ready, a
 * type the Market does not offer) is 422; a missing Market setup is 503.
 */
export const PLATFORM_PRODUCT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'working-copy.invalid-content': 400,
  'product.not-found': 404,
  'working-copy.not-found': 404,
  'product.platform-admin-only': 403,
  'product.seller-only': 403,
  'product.scope-owner-mismatch': 403,
  'conflict.stale': 409,
  'product.not-a-draft': 409,
  'product.not-editable': 409,
  'revision.pending-exists': 409,
  'revision.base-changed': 409,
  'revision.id-taken': 409,
  'revision.outcome-not-allowed': 409,
  'review.not-current-revision': 409,
  'product.no-published-revision': 409,
  // Add sizes (design 4.2a): a type that is not Simple, a count that moved, a type the Market or
  // the seller's allowed types do not list.
  'product.not-simple': 409,
  'confirm.count-changed': 409,
  'product-type.not-allowed': 403,
  'product.family-invalid': 503,
  'variant.id-taken': 409,
  'variant.unknown': 422,
  'variant.fixed': 422,
  'variant.limit-reached': 422,
  'variant.not-found': 422,
  'variant.not-proposed': 422,
  'variant.none': 422,
  'product.type-not-offered': 422,
  'claim-text.refused': 422,
  'revision.not-ready': 422,
  'request.throttled': 429,
  'product.type-unknown': 503,
  'product.family-unavailable': 503,
  'revision.schema-unavailable': 503,
  'revision.type-unknown': 503,
  'access.unavailable': 503,
});

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    PLATFORM_PRODUCT_STATUS,
    error,
    response,
    context,
    'catalog.platform-product-unmapped-refusal',
  );
}

/** A path id: malformed answers as an unknown product, byte-identical to a missing one. */
function productIdOf(raw: string, response: Response): string | HttpException {
  const parsed = parseId<'Product'>(raw);
  return parsed.ok ? parsed.value : refusal({ code: 'product.not-found' }, response);
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const PRODUCT_PARAM = { name: 'productId', description: `The product. A UUID v7.` };

/**
 * PLATFORM product authoring over HTTP (catalog design 4.2, 8.2; CAT-10, CAT-41; slice 6): an
 * admin creates a draft product, saves its working copy and submits it (an admin's revision
 * publishes at once). Every route reads the admin session of the request's Market
 * (`@ReadsSession`), so its unsafe method needs the CSRF token and the admin panel's origin; JSON
 * only, with a closed body. Thin adapters: the `CallContext` comes from `@Call()`, each route
 * calls one use case through its gate, which checks `catalog.platform-product.edit`, and maps the
 * answer to the error format `{ statusCode, code, details? }`. Every route logs its outcome code
 * with the correlation id; never a body or a text.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/platform-products')
export class PlatformProductController {
  readonly #logger = new Logger('PlatformProductController');

  constructor(
    private readonly createProduct: PlatformProductCreate,
    private readonly saveDraft: PlatformProductSaveDraft,
    private readonly submitProduct: PlatformProductSubmit,
    private readonly productOptions: PlatformProductOptions,
    private readonly readProduct: PlatformProductRead,
    private readonly addSizes: PlatformProductAddSizes,
    private readonly addSizesImpact: PlatformProductAddSizesImpact,
    private readonly discardProduct: PlatformProductDiscard,
  ) {}

  // Declared before `:productId`, so "options" is not read as a product id.
  @Get('options')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Options for the platform product create form',
    description: "Needs catalog.platform-product.edit. The Market's product types and locales.",
  })
  @ApiOkResponse({ type: PlatformProductOptionsView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async options(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformProductOptionsView> {
    const result = await this.productOptions.execute(context, {});
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as PlatformProductOptionsView)
      : refusal(result.error, response, context);
    return this.settle('catalog.platform-product-options', context, outcome);
  }

  @Get(':productId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read one PLATFORM product',
    description:
      'Needs catalog.platform-product.edit. The product with its variants, working copy and ' +
      'published revision, and what the form is drawn from. A SELLER product and an unknown id ' +
      'are one byte-identical product.not-found.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiOkResponse({ type: PlatformProductView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
  ): Promise<PlatformProductView> {
    const productId = productIdOf(rawProductId, response);
    let outcome: PlatformProductView | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else {
      const result = await this.readProduct.execute(context, { productId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as PlatformProductView)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-read', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a PLATFORM draft product',
    description:
      'Needs catalog.platform-product.edit. The request names the type only; the product is ' +
      "PLATFORM, in the Market's default family, with a fresh product code. A Simple product " +
      'gets its one variant at once.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformProductCreateRequest })
  @ApiCreatedResponse({ type: PlatformProductCreated })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'product.type-not-offered' })
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
    return this.settle('catalog.platform-product-create', context, outcome);
  }

  @Put(':productId/draft')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the working copy of a PLATFORM product (autosave included)',
    description:
      'Needs catalog.platform-product.edit. Replaces the draft. A text that holds a ' +
      'certification-like claim or a hidden character, or that cannot be checked, is not ' +
      'written: it keeps its last saved value and is listed in refusedFields; everything else ' +
      'is saved. At most 60 saves a minute per account.',
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
    description: 'access.denied, request.csrf, product.seller-only or product.scope-owner-mismatch',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, product.not-editable, product.not-a-draft or variant.id-taken',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'variant.unknown, variant.fixed, variant.limit-reached (details.max), variant.not-found, variant.not-proposed or variant.none',
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
    return this.settle('catalog.platform-product-save-draft', context, outcome);
  }

  @Post(':productId/submit')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Submit the working copy of a PLATFORM product',
    description:
      'Needs catalog.platform-product.edit. Checks every text of the frozen content, freezes ' +
      "the revision and stores it; an admin's revision publishes at once. A claim in a text " +
      'refuses the submit (claim-text.refused, details.fields); a draft that is not ready ' +
      'lists its issues (revision.not-ready, details.issues).',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformProductSubmitRequest })
  @ApiOkResponse({ type: PlatformProductSubmitted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or product.platform-admin-only',
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
    description: 'claim-text.refused or revision.not-ready',
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
    return this.settle('catalog.platform-product-submit', context, outcome);
  }

  @Post(':productId/add-sizes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add sizes: turn a PLATFORM Simple product into a Configurable one',
    description:
      'Needs catalog.platform-product.edit. Once and never back. Sets the axes and the option ' +
      "values of the product's one variant, which keeps its id, prices and stock, and changes " +
      'the type; nothing is published, the next submit freezes a Configurable revision. ' +
      'Offers of other sellers who may not sell configurable go off sale (cause type-not-allowed): ' +
      'read how many from GET :productId/add-sizes-impact and send it as offOfferCount; a ' +
      'different count answers confirm.count-changed (details.currentCount). 20 an hour per ' +
      'account (request.throttled).',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformAddSizesRequest })
  @ApiOkResponse({ type: AddSizesDone })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'validation.failed (details.fields). Body: path version, axes, optionValues, replacePending ' +
      'or offOfferCount with code range, type, format, too-many or unknown-field; the axes ' +
      '(path axes) and the option values (path optionValues) with the variants.axes-*, ' +
      'variants.option-* or variants.option-not-in-family issue codes',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or product-type.not-allowed',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'product.not-simple, revision.pending-exists, product.not-editable, confirm.count-changed ' +
      '(details.currentCount) or conflict.stale',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable, revision.schema-unavailable or product.family-invalid',
  })
  async addProductSizes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<AddSizesDone> {
    const productId = productIdOf(rawProductId, response);
    const input = closedBody(request, body, [
      'version',
      'axes',
      'optionValues',
      'replacePending',
      'offOfferCount',
    ]);
    let outcome: AddSizesDone | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.addSizes.execute(context, { productId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-add-sizes', context, outcome);
  }

  @Get(':productId/add-sizes-impact')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'How many Offers would go off sale if sizes were added',
    description:
      'Needs catalog.platform-product.edit. The confirm of Add sizes: the number of other ' +
      "sellers' Offers on the product whose sellers may not sell configurable, and the product " +
      'version to send with the command. Writes nothing and spends no limit.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiOkResponse({ type: AddSizesImpactView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied or product-type.not-allowed',
  })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'product.not-found (also a SELLER product, as for the command)',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'product.not-simple or product.not-editable, as for the command',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async addSizesImpactOf(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
  ): Promise<AddSizesImpactView> {
    const productId = productIdOf(rawProductId, response);
    let outcome: AddSizesImpactView | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else {
      const result = await this.addSizesImpact.execute(context, { productId });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-add-sizes-impact', context, outcome);
  }

  @Post(':productId/discard')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Discard a PLATFORM product that was never submitted',
    description:
      'Needs catalog.platform-product.edit. Only a draft can be discarded (product.not-a-draft ' +
      'otherwise). A missing product, a SELLER product and one already discarded all answer ' +
      'product.not-found. Every live variant is retired.',
  })
  @ApiParam(PRODUCT_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: PlatformProductDiscarded })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'product.not-a-draft or conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async discard(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') rawProductId: string,
    @Body() body: unknown,
  ): Promise<PlatformProductDiscarded> {
    const productId = productIdOf(rawProductId, response);
    const input = closedBody(request, body, []);
    let outcome: PlatformProductDiscarded | HttpException;
    if (productId instanceof HttpException) outcome = productId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.discardProduct.execute(context, { productId });
      outcome = result.ok
        ? { productId: result.value.productId }
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.platform-product-discard', context, outcome);
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
