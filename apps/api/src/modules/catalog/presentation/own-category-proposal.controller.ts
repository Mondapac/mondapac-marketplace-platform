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
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { OwnCategoryPropose } from '../application/use-cases/own-category-propose.use-case';
import { OwnCategoryProposalCancel } from '../application/use-cases/own-category-proposal-cancel.use-case';
import { OwnCategoryProposalsList } from '../application/use-cases/own-category-proposals-list.use-case';
import { OwnOfferSetShelf } from '../application/use-cases/own-offer-set-shelf.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  CategoryProposedBody,
  CategoryProposeRequest,
  OfferShelfBody,
  OfferShelfRequest,
  OwnCategoryProposalsBody,
  ProposalDecidedBody,
  ProposalVersionRequest,
} from './seller-category.dto';

/**
 * The HTTP status of each refusal of the seller category proposal routes (categories C9a). A
 * malformed request is 400; a seller who may not propose (SEL-26 off) or may not sell is 403; an
 * unknown parent, proposal, Offer or shelf is 404; a duplicate, a decided proposal or a stale
 * version is 409; a claim word, an uncheckable locale, a missing required name or the pending cap
 * is 422; the daily limit is 429; a missing dependency is 503.
 */
export const OWN_CATEGORY_PROPOSAL_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'category-proposal.not-allowed': 403,
  'seller.not-eligible': 403,
  'category.parent-not-found': 404,
  'category-proposal.not-found': 404,
  'offer.not-found': 404,
  'seller-category.not-found': 404,
  'category-proposal.duplicate': 409,
  'category-proposal.not-pending': 409,
  'conflict.stale': 409,
  'category.required-locale-missing': 422,
  'category.claim-word': 422,
  'category.locale-uncheckable': 422,
  'category-proposal.limit': 422,
  'request.throttled': 429,
  'claim-text.check-unavailable': 503,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    OWN_CATEGORY_PROPOSAL_STATUS,
    error,
    response,
    context,
    'catalog.own-category-proposal-unmapped-refusal',
  );

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * Seller category proposals and shelves over HTTP (categories C9a; CAT-51 to CAT-54). The seller
 * session of the request's Market is read (`@ReadsSession`), so a write needs the CSRF token and
 * the seller panel's origin; JSON only, closed bodies. The seller is always the session's, never a
 * body field. Thin adapters over one use case each; every route logs its outcome code with the
 * correlation id, never a name.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller')
export class OwnCategoryProposalController {
  readonly #logger = new Logger('OwnCategoryProposalController');

  constructor(
    private readonly listOwn: OwnCategoryProposalsList,
    private readonly propose: OwnCategoryPropose,
    private readonly cancel: OwnCategoryProposalCancel,
    private readonly setShelf: OwnOfferSetShelf,
  ) {}

  @Get('category-proposals')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List my category proposals and shelves',
    description:
      'Needs catalog.own-category.propose. The newest 50 proposals, every shelf (active first), ' +
      'whether the seller may propose now and the pending cap.',
  })
  @ApiOkResponse({ type: OwnCategoryProposalsBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnCategoryProposalsBody> {
    const result = await this.listOwn.execute(context, {});
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnCategoryProposalsBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.own-category-proposals-list', context, outcome);
  }

  @Post('category-proposals')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Propose a category (a shelf of my shop)',
    description:
      'Needs catalog.own-category.propose, an approved seller who may sell, and the category ' +
      'proposal permission an admin turned on for the seller (SEL-26). An approved proposal ' +
      'becomes a shelf of the seller’s shop, never a platform category. Every name and ' +
      'description passes the claim-text check in its own locale. At most the Market’s pending ' +
      'cap may wait (details.max) and 20 a day; a name already waiting or already a shelf under ' +
      'the same parent is category-proposal.duplicate.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryProposeRequest })
  @ApiCreatedResponse({ type: CategoryProposedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf, access.seller-not-approved, category-proposal.not-allowed or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.parent-not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'category-proposal.duplicate' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'category.claim-word, category.locale-uncheckable, category.required-locale-missing ' +
      '(details.fields) or category-proposal.limit (details.max)',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CategoryProposedBody> {
    const input = closedBody(request, body, ['platformParentId', 'texts']);
    let outcome: CategoryProposedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.propose.execute(context, input);
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-category-propose', context, outcome);
  }

  @Post('category-proposals/:proposalId/cancel')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Withdraw a waiting category proposal',
    description: 'Needs catalog.own-category.propose. Only a pending proposal of the seller.',
  })
  @ApiParam({ name: 'proposalId', description: 'The proposal. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProposalVersionRequest })
  @ApiOkResponse({ type: ProposalDecidedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category-proposal.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'category-proposal.not-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async withdraw(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalDecidedBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: ProposalDecidedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.cancel.execute(context, { proposalId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-category-proposal-cancel', context, outcome);
  }

  @Put('offers/:offerId/shelf')
  @ReadsSession()
  @ApiOperation({
    summary: 'Put an Offer on one of my shelves, or take it off',
    description:
      'Needs catalog.own-product.edit and an approved seller. The shelf must be an active shelf ' +
      'of the seller; `shelfId: null` clears it. A shelf groups Offers on the shop page only: ' +
      'it is never a platform category and changes no badge, filter or revision.',
  })
  @ApiParam({ name: 'offerId', description: 'The Offer. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: OfferShelfRequest })
  @ApiOkResponse({ type: OfferShelfBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or access.seller-not-approved',
  })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'offer.not-found or seller-category.not-found',
  })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async shelf(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OfferShelfBody> {
    const input = closedBody(request, body, ['shelfId', 'version']);
    let outcome: OfferShelfBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setShelf.execute(context, { offerId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.own-offer-set-shelf', context, outcome);
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
