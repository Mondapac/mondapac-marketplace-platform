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
import { OfferApprove } from '../application/use-cases/offer-approve.use-case';
import { OfferRequestChanges } from '../application/use-cases/offer-request-changes.use-case';
import { ReviewQueueList } from '../application/use-cases/review-queue-list.use-case';
import { closedBody, pageQuery, refusalWith } from './http-answers';
import {
  OfferApproveRequest,
  OfferDecided,
  OfferRequestChangesRequest,
  ReviewQueueList as ReviewQueueListDto,
} from './offer-review.dto';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin Offer review routes (catalog design 4.4, 8.2). A
 * malformed request is 400; an unknown Offer is 404; a decision on a state that has moved on (not
 * waiting any more, a stale version, an unpublished product, a seller who may not sell) is 409; a
 * claim in the description is 422; a missing dependency is 503.
 */
export const OFFER_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'offer.not-found': 404,
  'offer.not-pending-review': 409,
  'offer.product-not-published': 409,
  'seller.not-eligible': 409,
  'type.not-allowed': 409,
  'conflict.stale': 409,
  'claim-text.refused': 422,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The review queue of Offers over HTTP (catalog design 4.4, 8.2, 9.2): list the Offers waiting for
 * their first publication, approve one, or send it back with a reason code. Admin routes read the
 * admin session (`@ReadsSession`), so decisions need the CSRF token and the admin panel's origin;
 * JSON only, closed bodies. A thin adapter: one use case does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class OfferReviewController {
  readonly #logger = new Logger('OfferReviewController');

  constructor(
    private readonly queue: ReviewQueueList,
    private readonly approveOffer: OfferApprove,
    private readonly requestChanges: OfferRequestChanges,
  ) {}

  @Get('review-queue')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the Offers waiting for their first publication',
    description:
      'Needs catalog.product.view. Oldest submit first, keyset-paged: send `nextAfterId` of ' +
      'the previous page as `afterId`. `limit` is 1 to 50 (default 25).',
  })
  @ApiQuery({
    name: 'afterId',
    required: false,
    description: 'The last Offer id of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiOkResponse({ type: ReviewQueueListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ReviewQueueListDto> {
    const result = await this.queue.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as ReviewQueueListDto)
      : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.review-queue-list', context, outcome);
  }

  @Post('offers/:offerId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Publish an Offer that waits for its first publication',
    description:
      'Needs catalog.product.approve. Names the Offer version the reviewer saw. The description ' +
      'is claim-checked again; the seller must still be allowed to sell and the product must be ' +
      'published.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OfferApproveRequest })
  @ApiOkResponse({ type: OfferDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'offer.not-pending-review, offer.product-not-published, seller.not-eligible or conflict.stale',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'claim-text.refused' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OfferDecided> {
    const input = closedBody(request, body, ['version']);
    let outcome: OfferDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveOffer.execute(context, {
        offerId,
        version: input.version as number,
      });
      outcome = result.ok ? {} : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-approve', context, outcome);
  }

  @Post('offers/:offerId/request-changes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send an Offer back to the seller with a reason code',
    description:
      'Needs catalog.product.approve. Names the Offer version the reviewer saw and one reason ' +
      'code; the Offer becomes changes-needed and the seller is told by mail.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OfferRequestChangesRequest })
  @ApiOkResponse({ type: OfferDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer.not-pending-review or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async requestOfferChanges(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OfferDecided> {
    const input = closedBody(request, body, ['version', 'reasonCode']);
    let outcome: OfferDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestChanges.execute(context, {
        offerId,
        version: input.version as number,
        reasonCode: input.reasonCode as string,
      });
      outcome = result.ok ? {} : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-request-changes', context, outcome);
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
