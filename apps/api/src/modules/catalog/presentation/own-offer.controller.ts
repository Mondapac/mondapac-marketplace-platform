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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RequiresStepUp } from '../../../platform/authz';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
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
import { OwnOfferDelete } from '../application/use-cases/own-offer-delete.use-case';
import { OwnOfferSubmit } from '../application/use-cases/own-offer-submit.use-case';
import { OwnOfferSetHandling } from '../application/use-cases/own-offer-set-handling.use-case';
import { OwnOfferEdit } from '../application/use-cases/own-offer-edit.use-case';
import { OwnOfferCreateOnPlatformProduct } from '../application/use-cases/own-offer-create-on-platform-product.use-case';
import { OwnOfferRead } from '../application/use-cases/own-offer-read.use-case';
import { OwnOffersList } from '../application/use-cases/own-offers-list.use-case';
import { closedBody, optionalClosedBody, pageQuery, refusalWith } from './http-answers';
import { OwnOfferAddTag } from '../application/use-cases/own-offer-add-tag.use-case';
import { OwnOfferRemoveTag } from '../application/use-cases/own-offer-remove-tag.use-case';
import { OwnOfferList, OwnOfferViewDto } from './own-reads.dto';
import {
  OwnOfferCreated,
  OwnOfferCreateRequest,
  OwnOfferEdited,
  OwnOfferEditRequest,
  OwnOfferHandlingSet,
  OwnOfferSetHandlingRequest,
  OwnOfferSubmitRequest,
  OwnOfferSubmitted,
  OwnOfferAddTagRequest,
  OwnOfferTagAdded,
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
  'offer.not-submittable': 409,
  'offer.product-not-published': 409,
  'offer.handling-missing': 422,
  'offer.delete-via-product': 422,
  'conflict.stale': 409,
  'seller.not-eligible': 403,
  'offer.exists-for-product': 409,
  'offer.sku-taken': 409,
  'type.not-allowed': 422,
  'setting.sell-from-catalogue-off': 422,
  'claim-text.refused': 422,
  'request.throttled': 429,
  'access.unavailable': 503,
  // Tags (catalog design 5.2, 5.3).
  'tag.exists': 409,
  'tag.not-found': 404,
  'tag.suspended': 409,
  'tag.not-removable': 409,
  'tag.product-not-published': 409,
  'tag.type-unknown': 422,
  'claim.tag-not-allowed': 422,
  'claim.requested-tag-not-allowed': 422,
  'claim.check-unavailable': 503,
  'conflict.retry': 409,
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
    private readonly setOfferHandling: OwnOfferSetHandling,
    private readonly submitOffer: OwnOfferSubmit,
    private readonly deleteOffer: OwnOfferDelete,
    private readonly listOffers: OwnOffersList,
    private readonly readOffer: OwnOfferRead,
    private readonly addOfferTag: OwnOfferAddTag,
    private readonly removeOfferTag: OwnOfferRemoveTag,
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
    summary: 'Edit the content of an own Offer',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The whole content form: SKU, ' +
      'condition and description. An Offer of another seller, a deleted one or an unknown id is ' +
      'a byte-identical offer.not-found. A changed text that holds a certification-like claim or ' +
      'a hidden character, or that cannot be checked, refuses the whole edit ' +
      '(claim-text.refused, details.fields). An Offer waiting for review or needing changes ' +
      'returns to draft; a published Offer stays published with no queue. Every tag of the ' +
      'Offer is asked of certification again: one no longer allowed is suspended and the Offer ' +
      'goes off sale; an unanswered check refuses the edit (claim.check-unavailable). A lost ' +
      'race is retried, then conflict.retry. Shares the save budget of draft saves: 60 a minute ' +
      'and 1,000 a day per account.',
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
    description: 'offer.sku-taken, offer.not-editable or conflict.retry',
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
  @Put(':offerId/handling')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record how the goods of an own Offer are handled',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Body: handling, one of ' +
      'SEALED_ORIGINAL, REPACKED, PREPARED, FRESH. An Offer of another seller, a deleted one or ' +
      'an unknown id is a byte-identical offer.not-found. An Offer waiting for review or ' +
      'needing changes returns to draft; a published Offer stays published. Every tag is asked ' +
      'again against the new handling: one no longer allowed is suspended and the Offer goes ' +
      'off sale; an unanswered check refuses (claim.check-unavailable). Shares the save budget ' +
      'of draft saves: 60 a minute and 1,000 a day per account.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OwnOfferSetHandlingRequest })
  @ApiOkResponse({ type: OwnOfferHandlingSet })
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
    description: 'offer.not-editable, conflict.stale or conflict.retry',
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async setHandling(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OwnOfferHandlingSet> {
    const input = closedBody(request, body, ['handling']);
    let outcome: OwnOfferHandlingSet | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setOfferHandling.execute(context, {
        offerId,
        handling: input.handling,
      });
      outcome = result.ok
        ? { changedFields: [...result.value.changedFields] }
        : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-offer-set-handling',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post(':offerId/submit')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Submit a draft Offer for publication',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. The body is optional: ' +
      '`requestedTags` names certification types to tag at the submit. The Offer must be ' +
      "the seller's own draft with its handling recorded, on a published product of a type the " +
      'seller may sell; every description text is claim-checked again and every tag is asked ' +
      'of certification again (a kept tag no longer allowed is suspended; a requested type not ' +
      'allowed refuses the whole submit). Where the Market asks for approval the Offer waits for ' +
      'review (published: false); otherwise it is published at once.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OwnOfferSubmitRequest, required: false })
  @ApiOkResponse({ type: OwnOfferSubmitted })
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
    description:
      'offer.not-submittable, offer.product-not-published, conflict.stale or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'offer.handling-missing, type.not-allowed, claim-text.refused, tag.type-unknown or ' +
      'claim.requested-tag-not-allowed (details.tags: typeCode and reason per type)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'A body that is not JSON' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim.check-unavailable',
  })
  async submit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OwnOfferSubmitted> {
    const input = optionalClosedBody(request, body, ['requestedTags']);
    let outcome: OwnOfferSubmitted | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.submitOffer.execute(context, {
        offerId,
        ...(Object.hasOwn(input, 'requestedTags') ? { requestedTags: input.requestedTags } : {}),
      });
      outcome = result.ok
        ? { published: result.value.published }
        : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    }
    return this.settleRead('catalog.own-offer-submit', context, outcome);
  }

  @Post(':offerId/tags')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a certification tag to an own Offer',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Body: typeCode only. ' +
      'Certification decides (evaluateClaims) for every variant of the published product; the ' +
      'tag is written active only when every variant is allowed on one certificate. A refusal ' +
      'names the type and the reason code (claim.tag-not-allowed, details.tags); an unanswered ' +
      'check refuses (claim.check-unavailable). A product never published takes its tags as ' +
      'requestedTags at its first submit (tag.product-not-published). Shares the save budget.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OwnOfferAddTagRequest })
  @ApiCreatedResponse({ type: OwnOfferTagAdded })
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
    description: 'tag.exists, tag.product-not-published or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'offer.handling-missing, tag.type-unknown or claim.tag-not-allowed (details.tags: ' +
      'typeCode and reason)',
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim.check-unavailable',
  })
  async addTag(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OwnOfferTagAdded> {
    const input = closedBody(request, body, ['typeCode']);
    let outcome: OwnOfferTagAdded | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.addOfferTag.execute(context, { offerId, typeCode: input.typeCode });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    }
    return this.settleRead('catalog.own-offer-add-tag', context, outcome);
  }

  @Delete(':offerId/tags/:typeCode')
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({
    summary: 'Remove an active certification tag from an own Offer',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Removing asks nothing. A ' +
      'suspended tag is tag.suspended: it is removed only with the "sell without this badge" ' +
      'confirmation. A pending-publish tag is left out at the next submit instead.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiParam({ name: 'typeCode' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found or tag.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'tag.suspended, tag.not-removable or conflict.stale',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async removeTag(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Param('typeCode') typeCode: string,
  ): Promise<void> {
    const result = await this.removeOfferTag.execute(context, { offerId, typeCode });
    const outcome = result.ok ? {} : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    this.settleRead('catalog.own-offer-remove-tag', context, outcome);
  }

  @Delete(':offerId')
  @RequiresStepUp('catalog.offer.delete')
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete an own Offer on a PLATFORM product',
    description:
      'Needs catalog.own-product.edit. The Offer becomes deleted and stops being listed; the ' +
      'row stays. An Offer of another seller, a deleted one or an unknown id is a ' +
      "byte-identical offer.not-found. An Offer on the seller's own product is refused " +
      '(offer.delete-via-product): there the product is withdrawn.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'conflict.stale' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'offer.delete-via-product' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async remove(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
  ): Promise<void> {
    const result = await this.deleteOffer.execute(context, { offerId });
    const outcome = result.ok ? {} : refusalWith(OWN_OFFER_STATUS, result.error, response, context);
    this.settleRead('catalog.own-offer-delete', context, outcome);
  }
}
