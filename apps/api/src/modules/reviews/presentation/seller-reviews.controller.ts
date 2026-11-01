import { Body, Controller, Get, Logger, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
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
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { EditReviewReply } from '../application/use-cases/edit-review-reply.use-case';
import { ListSellerReviews } from '../application/use-cases/list-seller-reviews.use-case';
import { ReplyToReview } from '../application/use-cases/reply-to-review.use-case';
import { ReportReview } from '../application/use-cases/report-review.use-case';
import { closedBody, closedQuery, refusal } from './http-answers';
import {
  ReplyRequest,
  ReportedBody,
  ReportRequest,
  SellerReviewBody,
  sellerReviewBody,
  SellerReviewsBody,
  sellerReviewsBody,
} from './seller-reviews.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The shop's reviews (package 4). Thin adapters: the seller comes from the session, never from the
 * request; writes are refused in an acting-as session. A seller never sees the buyer, only the
 * order reference. Every answer is `Cache-Control: no-store`; no review or reply text is logged.
 */
@ApiTags('reviews')
@RoutePopulation('seller')
@ReadsSession()
@Controller('reviews/seller')
export class SellerReviewsController {
  readonly #logger = new Logger('SellerReviewsController');

  constructor(
    private readonly list: ListSellerReviews,
    private readonly replyTo: ReplyToReview,
    private readonly editReply: EditReviewReply,
    private readonly reportReview: ReportReview,
  ) {}

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  @Get()
  @ApiOperation({
    summary: "The shop's published reviews, newest first",
    description:
      'Needs reviews.seller.view. Each item carries the order reference, never the buyer. ' +
      'Answers reviews.disabled (404) while reviews are off.',
  })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: SellerReviewsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async listReviews(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedQuery(query, ['cursor']);
    if (invalid !== null) throw invalid;
    const result = await this.list.execute(context, { cursor: query.cursor });
    this.log('reviews.list-seller-reviews-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerReviewsBody(result.value);
  }

  @Post(':reviewId/reply')
  @ApiOperation({
    summary: "Write the shop's one public reply to a review",
    description:
      'Needs reviews.seller.reply. Only a published review of the shop takes a reply; contact ' +
      'details, links and blocked words are refused. A second reply is reviews.already-replied.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiBody({ type: ReplyRequest })
  @ApiCreatedResponse({ type: SellerReviewBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'reviews.already-replied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async reply(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['body']);
    if (invalid !== null) throw invalid;
    const result = await this.replyTo.execute(context, {
      ...(requestBody as Record<string, unknown>),
      reviewId,
    });
    this.log('reviews.reply-to-review-route', context, result.ok ? 'created' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerReviewBody(result.value);
  }

  @Patch(':reviewId/reply')
  @ApiOperation({
    summary: "Change the shop's reply",
    description:
      'Needs reviews.seller.reply. Allowed for the Market edit window after the reply was written ' +
      '(reviews.edit-window-closed afterwards).',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiBody({ type: ReplyRequest })
  @ApiOkResponse({ type: SellerReviewBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'reviews.edit-window-closed' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['body']);
    if (invalid !== null) throw invalid;
    const result = await this.editReply.execute(context, {
      ...(requestBody as Record<string, unknown>),
      reviewId,
    });
    this.log('reviews.edit-reply-route', context, result.ok ? 'edited' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerReviewBody(result.value);
  }

  @Post(':reviewId/report')
  @ApiOperation({
    summary: 'Report a review of the shop to the moderators',
    description:
      'Needs reviews.seller.report. A reason code from a closed list; the review stays as it is ' +
      'until a moderator decides. Repeating the report answers the same.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiBody({ type: ReportRequest })
  @ApiCreatedResponse({ type: ReportedBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async report(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['reasonCode']);
    if (invalid !== null) throw invalid;
    const result = await this.reportReview.execute(context, {
      ...(requestBody as Record<string, unknown>),
      reviewId,
    });
    this.log('reviews.report-review-route', context, result.ok ? 'reported' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
