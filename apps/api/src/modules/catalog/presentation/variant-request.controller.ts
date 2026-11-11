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
  ApiOperation,
  ApiParam,
  ApiQuery,
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
import { OwnVariantRequestCreate } from '../application/use-cases/own-variant-request-create.use-case';
import { OwnVariantRequestsList } from '../application/use-cases/own-variant-requests-list.use-case';
import { VariantRequestApprove } from '../application/use-cases/variant-request-approve.use-case';
import { VariantRequestDecline } from '../application/use-cases/variant-request-decline.use-case';
import { VariantRequestList } from '../application/use-cases/variant-request-list.use-case';
import { VariantRequestMap } from '../application/use-cases/variant-request-map.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  OwnVariantRequestListBody,
  RequestVariantRequest,
  VariantRequestApproveRequest,
  VariantRequestDeclineRequest,
  VariantRequestDecisionWrapBody,
  VariantRequestListBody,
  VariantRequestMapRequest,
  VariantRequestOpenedBody,
} from './variant-request.dto';

/** The HTTP status of each refusal of the seller variant-request routes (variants V7). */
export const OWN_VARIANT_REQUEST_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'seller.not-eligible': 403,
  'offer.not-found': 404,
  'variant-request.already-open': 409,
  'variant-request.variant-exists': 409,
  'variant-request.product-unavailable': 422,
  'variant-request.not-configurable': 422,
  'variant-request.option-unknown': 422,
  'variant-request.options-invalid': 422,
  'variant-request.limit-reached': 422,
  'variant-request.daily-limit': 422,
  'access.unavailable': 503,
});

/** The HTTP status of each refusal of the admin variant-request routes. */
export const VARIANT_REQUEST_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'variant-request.not-found': 404,
  'variant-request.stale': 409,
  'variant-request.not-open': 409,
  'variant-request.variant-exists': 409,
  'variant-request.product-unavailable': 409,
  'variant-request.not-configurable': 409,
  'variant-request.draft-unavailable': 409,
  'variant-request.variant-unknown': 422,
  'variant-request.reason-invalid': 422,
  'variant-request.variant-invalid': 422,
  'working-copy.invalid-content': 422,
  'product.not-found': 404,
  'conflict.stale': 409,
  'request.throttled': 429,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NEEDS = 'Needs catalog.variant-request.review; refused in an acting-as session.';

function settle<T extends object>(
  logger: Logger,
  msg: string,
  context: CallContext,
  outcome: T | HttpException,
): T {
  const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
  logger[failed ? 'warn' : 'log']({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/**
 * A seller's request for a variant (a size) a PLATFORM product they sell does not have (variants
 * plan, package V7). The seller session of the request's Market is read, so the route needs the
 * CSRF token and the seller panel's origin; JSON only, a closed body. A thin adapter over one use
 * case (key `catalog.own-product.edit`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/offers')
export class OwnVariantRequestController {
  readonly #logger = new Logger('OwnVariantRequestController');

  constructor(private readonly create: OwnVariantRequestCreate) {}

  @Post(':offerId/variant-requests')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Request a new size for a platform product',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The Offer must be the seller’s ' +
      'own on a published PLATFORM product with variants. The option values name one active ' +
      'option on each axis of the product; a combination the product already has is refused. ' +
      'One open request per Offer and combination, at most 10 open per seller and 20 in 24 ' +
      'hours. The seller is told the outcome by mail.',
  })
  @ApiParam({ name: 'offerId', description: 'The seller’s own Offer. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: RequestVariantRequest })
  @ApiCreatedResponse({ type: VariantRequestOpenedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf, access.seller-not-approved or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'variant-request.already-open or variant-request.variant-exists',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'variant-request.option-unknown, .product-unavailable, .not-configurable, ' +
      '.options-invalid or .limit-reached (details.max)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async request(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<VariantRequestOpenedBody> {
    const input = closedBody(request, body, ['optionValues']);
    let outcome: VariantRequestOpenedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.create.execute(context, {
        offerId,
        optionValues: input['optionValues'],
      });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(
            OWN_VARIANT_REQUEST_STATUS,
            result.error,
            response,
            context,
            'catalog.own-variant-request-unmapped-refusal',
          );
    }
    return settle(this.#logger, 'catalog.own-variant-request-create', context, outcome);
  }
}

/**
 * The seller's own variant requests over HTTP (the "Sizes you asked for" part of the seller
 * panel): one read of every request the seller made, with its outcome. A thin adapter over one use
 * case (key `catalog.own-product.view`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/variant-requests')
export class OwnVariantRequestsController {
  readonly #logger = new Logger('OwnVariantRequestsController');

  constructor(private readonly list: OwnVariantRequestsList) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: "List the seller's variant requests",
    description:
      'Needs catalog.own-product.view. Newest first, keyset-paged: send `nextAfterId` of the ' +
      'previous page as `afterId`. `limit` is 1 to 50 (default 25); `status` narrows to open, ' +
      'approved, mapped or declined. `openCount` and `maxOpen` count the waiting ones whatever ' +
      'the filter. Only the seller’s own requests are read.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'approved', 'mapped', 'declined'] })
  @ApiQuery({ name: 'afterId', required: false, description: 'The last id of the previous page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiOkResponse({ type: OwnVariantRequestListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async index(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OwnVariantRequestListBody> {
    const result = await this.list.execute(context, pageQuery(query));
    const outcome: OwnVariantRequestListBody | HttpException = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnVariantRequestListBody)
      : refusalWith(
          OWN_VARIANT_REQUEST_STATUS,
          result.error,
          response,
          context,
          'catalog.own-variant-requests-unmapped-refusal',
        );
    return settle(this.#logger, 'catalog.own-variant-requests-list', context, outcome);
  }
}

/**
 * The queue of sellers' variant requests and the three decisions on one (variants plan, package
 * V7): the admin "Variants > Waiting for you" tab. Every route reads the admin session of the
 * request's Market; the list answers `no-store`; writes need the CSRF token, JSON and closed
 * bodies. Thin adapters: each route calls one use case through its gate and maps the answer to
 * `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/variant-requests')
export class VariantRequestController {
  readonly #logger = new Logger('VariantRequestController');

  constructor(
    private readonly listOpen: VariantRequestList,
    private readonly approveOne: VariantRequestApprove,
    private readonly mapOne: VariantRequestMap,
    private readonly declineOne: VariantRequestDecline,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Variant requests waiting for a decision',
    description: `${NEEDS} Open requests, oldest first, each with the variants the product has.`,
  })
  @ApiOkResponse({ type: VariantRequestListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async index(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<VariantRequestListBody> {
    const result = await this.listOpen.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as VariantRequestListBody)
      : this.#refusal(result.error, response, context);
    return settle(this.#logger, 'catalog.variant-request-list', context, outcome);
  }

  @Post(':requestId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add the requested variant to the product’s draft',
    description:
      `${NEEDS} Also needs catalog.platform-product.edit. The variant is added to the ` +
      'product’s draft as a proposed variant through the same save as the product form; the ' +
      'draft then goes through the normal submit and review. The seller is told by mail.',
  })
  @ApiParam({ name: 'requestId', description: 'The request. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: VariantRequestApproveRequest })
  @ApiOkResponse({ type: VariantRequestDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'variant-request.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'variant-request.stale, .not-open, .variant-exists, .draft-unavailable, ' +
      '.product-unavailable or .not-configurable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<VariantRequestDecisionWrapBody> {
    return this.#decide(
      'catalog.variant-request-approve',
      context,
      response,
      closedBody(request, body, ['version']),
      (input) => this.approveOne.execute(context, { ...input, requestId }),
    );
  }

  @Post(':requestId/map')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Point the request at a variant the product already has',
    description: `${NEEDS} The variant must be one of the product that is not retired. The seller is told by mail.`,
  })
  @ApiParam({ name: 'requestId', description: 'The request. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: VariantRequestMapRequest })
  @ApiOkResponse({ type: VariantRequestDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'variant-request.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'variant-request.stale or variant-request.not-open',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'variant-request.variant-unknown',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async map(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<VariantRequestDecisionWrapBody> {
    return this.#decide(
      'catalog.variant-request-map',
      context,
      response,
      closedBody(request, body, ['version', 'variantId']),
      (input) => this.mapOne.execute(context, { ...input, requestId }),
    );
  }

  @Post(':requestId/decline')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Decline the request with a reason',
    description: `${NEEDS} The reason (1 to 300 characters) is sent to the seller by mail.`,
  })
  @ApiParam({ name: 'requestId', description: 'The request. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: VariantRequestDeclineRequest })
  @ApiOkResponse({ type: VariantRequestDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'variant-request.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'variant-request.stale or variant-request.not-open',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'variant-request.reason-invalid',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async decline(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<VariantRequestDecisionWrapBody> {
    return this.#decide(
      'catalog.variant-request-decline',
      context,
      response,
      closedBody(request, body, ['version', 'reason']),
      (input) => this.declineOne.execute(context, { ...input, requestId }),
    );
  }

  #refusal(error: Refusal, response: Response, context: CallContext): HttpException {
    return refusalWith(
      VARIANT_REQUEST_ADMIN_STATUS,
      error,
      response,
      context,
      'catalog.variant-request-unmapped-refusal',
    );
  }

  async #decide(
    msg: string,
    context: CallContext,
    response: Response,
    input: Record<string, unknown> | HttpException,
    run: (
      input: Record<string, unknown>,
    ) => Promise<{ ok: true; value: object } | { ok: false; error: Refusal }>,
  ): Promise<VariantRequestDecisionWrapBody> {
    let outcome: VariantRequestDecisionWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await run(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as VariantRequestDecisionWrapBody)
        : this.#refusal(result.error, response, context);
    }
    return settle(this.#logger, msg, context, outcome);
  }
}
