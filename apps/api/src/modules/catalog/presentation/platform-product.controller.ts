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
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { PlatformProductCreate } from '../application/use-cases/platform-product-create.use-case';
import { PlatformProductSaveDraft } from '../application/use-cases/platform-product-save-draft.use-case';
import { PlatformProductSubmit } from '../application/use-cases/platform-product-submit.use-case';
import {
  ApiErrorBody,
  PlatformProductCreated,
  PlatformProductCreateRequest,
  PlatformProductDraftSaved,
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

type Refusal = { readonly code: string; readonly retryAfterSeconds?: number };

function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The refusal fields that reach the client as `details`; any other field stays on the server. */
const DETAIL_KEYS = ['fields', 'issues', 'retryAfterSeconds', 'max'] as const;
const logger = new Logger('PlatformProductController');

/**
 * A refusal as an error answer: its status, the allow-listed detail fields, and `Retry-After`
 * with a wait. A code with no status is a defect: it answers a bare `internal` and the code is
 * logged, never sent.
 */
function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  const status =
    PLATFORM_PRODUCT_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'catalog.platform-product-unmapped-refusal',
      code: error.code,
      marketId: context?.market.marketId,
      correlationId: context?.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  const details = Object.fromEntries(
    DETAIL_KEYS.filter((key) => key in error).map((key) => [
      key,
      (error as Record<string, unknown>)[key],
    ]),
  );
  return Object.keys(details).length === 0
    ? fail(status, error.code)
    : fail(status, error.code, details);
}

/** The JSON-only check and the closed object of a body: no unknown key, no array, no scalar. */
function closedBody(
  request: Request,
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  const record = body as Record<string, unknown>;
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(record).sort().slice(0, 10)) {
    if (!keys.includes(key)) {
      fields.push({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
        code: 'unknown-field',
      });
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fields.push({ path: key, code: 'required' });
  }
  return fields.length > 0 ? fail(400, 'validation.failed', { fields }) : record;
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
  ) {}

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
