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
  ApiOperation,
  ApiParam,
  ApiQuery,
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
import { OwnOfferEdit } from '../application/use-cases/own-offer-edit.use-case';
import { OwnOfferCreateOnPlatformProduct } from '../application/use-cases/own-offer-create-on-platform-product.use-case';
import { OwnOfferRead } from '../application/use-cases/own-offer-read.use-case';
import { OwnOffersList } from '../application/use-cases/own-offers-list.use-case';
import { closedBody, pageQuery, refusalWith } from './http-answers';
import { OwnOfferList, OwnOfferViewDto } from './own-reads.dto';
import {
  OwnOfferCreated,
  OwnOfferCreateRequest,
  OwnOfferEdited,
  OwnOfferEditRequest,
} from './own-offer.dto';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the seller Offer routes (catalog design 4.4, 8.2; slice
 * 7a-3). A malformed request is 400; a product that is missing, not published, of another Market
 * or not PLATFORM is a byte-identical 404; a seller who may not sell is 403; a request the rules
 * refuse (a claim in a text, a type the seller may not sell, the Market's setting off) is 422; a
 * taken product or SKU is 409 (the answer never says which of the two held first when both do);
 * a spent budget is 429; a missing dependency is 503.
 */
export const OWN_OFFER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'product.not-found': 404,
  'offer.not-found': 404,
  'offer.not-editable': 409,
  'conflict.stale': 409,
  'seller.not-eligible': 403,
  'offer.exists-for-product': 409,
  'offer.sku-taken': 409,
  'type.not-allowed': 422,
  'setting.sell-from-catalogue-off': 422,
  'claim-text.refused': 422,
  'request.throttled': 429,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

/**
 * Seller Offers over HTTP (catalog design 4.4, 8.2; OFR-02, OFR-03; slice 7a-3): a seller creates
 * a draft Offer on a published PLATFORM product. The route reads the seller session of the
 * request's Market (`@ReadsSession`), so it needs the CSRF token and the seller panel's origin;
 * JSON only, with a closed body. A thin adapter: the `CallContext` comes from `@Call()`, one use
 * case does the work through its gate (key `catalog.own-product.edit`), and the answer is mapped
 * to `{ statusCode, code, details? }`. The outcome code is logged with the correlation id; never
 * a body or a text.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/offers')
export class OwnOfferController {
  readonly #logger = new Logger('OwnOfferController');

  constructor(
    private readonly createOffer: OwnOfferCreateOnPlatformProduct,
    private readonly editOffer: OwnOfferEdit,
    private readonly listOffers: OwnOffersList,
    private readonly readOffer: OwnOfferRead,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the Offers of the seller',
    description:
      'Needs catalog.own-product.view. Offers that are not deleted, newest first, keyset-paged: ' +
      'send `nextAfterId` of the previous page as `afterId`. `limit` is 1 to 50 (default 25). ' +
      'Each row carries the code, type and published name of its product.',
  })
  @ApiQuery({
    name: 'afterId',
    required: false,
    description: 'The last Offer id of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiOkResponse({ type: OwnOfferList })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OwnOfferList> {
    const result = await this.listOffers.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnOfferList)
      : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    return this.settleRead('catalog.own-offers-list', context, outcome);
  }

  @Get(':offerId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read one Offer of the seller',
    description:
      'Needs catalog.own-product.view. An Offer of another seller, a deleted one and an unknown ' +
      'id are one byte-identical offer.not-found.',
  })
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiOkResponse({ type: OwnOfferViewDto })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
  ): Promise<OwnOfferViewDto> {
    const parsed = parseId<'Offer'>(offerId);
    // A malformed id answers as an unknown Offer, byte-identical to a missing one.
    const result = parsed.ok
      ? await this.readOffer.execute(context, { offerId: parsed.value })
      : null;
    const outcome =
      result === null
        ? refusalWith(OWN_OFFER_STATUS, { code: 'offer.not-found' }, response, context)
        : result.ok
          ? (JSON.parse(JSON.stringify(result.value)) as OwnOfferViewDto)
          : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    return this.settleRead('catalog.own-offer-read', context, outcome);
  }

  private settleRead<T extends object>(
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

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a draft Offer on a PLATFORM product',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The seller comes from the ' +
      'session. A text that holds a certification-like claim or a hidden character, or that ' +
      'cannot be checked, refuses the whole create (claim-text.refused, details.fields). Shares ' +
      'the save budget of draft saves: 60 a minute and 1,000 a day per account.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: OwnOfferCreateRequest })
  @ApiCreatedResponse({ type: OwnOfferCreated })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer.exists-for-product or offer.sku-taken',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'claim-text.refused, type.not-allowed or setting.sell-from-catalogue-off',
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OwnOfferCreated> {
    const input = closedBody(request, body, [
      'productId',
      'sellerSku',
      'conditionCode',
      'description',
    ]);
    let outcome: OwnOfferCreated | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createOffer.execute(context, {
        productId: input.productId as string,
        sellerSku: input.sellerSku as string,
        conditionCode: input.conditionCode as string,
        description: input.description,
      });
      outcome = result.ok
        ? { offerId: result.value.offerId }
        : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-offer-create',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Put(':offerId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Edit the content of an own Offer that is not yet published',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The whole content form: SKU, ' +
      'condition and description. An Offer of another seller, a deleted one or an unknown id is ' +
      'a byte-identical offer.not-found. A changed text that holds a certification-like claim or ' +
      'a hidden character, or that cannot be checked, refuses the whole edit ' +
      '(claim-text.refused, details.fields). An Offer waiting for review or needing changes ' +
      'returns to draft. A published Offer is offer.not-editable. Shares the save budget of ' +
      'draft saves: 60 a minute and 1,000 a day per account.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OwnOfferEditRequest })
  @ApiOkResponse({ type: OwnOfferEdited })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer.sku-taken, offer.not-editable or conflict.stale',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'claim-text.refused' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OwnOfferEdited> {
    const input = closedBody(request, body, ['sellerSku', 'conditionCode', 'description']);
    let outcome: OwnOfferEdited | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editOffer.execute(context, {
        offerId,
        sellerSku: input.sellerSku as string,
        conditionCode: input.conditionCode as string,
        description: input.description,
      });
      outcome = result.ok
        ? { changedFields: [...result.value.changedFields] }
        : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-offer-edit',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
