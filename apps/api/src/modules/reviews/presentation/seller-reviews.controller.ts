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
  ApiPayloadTooLargeResponse,
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
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { ExportSellerReviews } from '../application/use-cases/export-seller-reviews.use-case';
import { QuerySellerReviews } from '../application/use-cases/query-seller-reviews.use-case';
import {
  SELLER_REVIEW_EXPORT_COLUMNS,
  SELLER_REVIEW_SORT_KEYS,
  SELLER_REVIEW_VIEWS,
} from '../domain/seller-review-list';
import { EditReviewReply } from '../application/use-cases/edit-review-reply.use-case';
import { ListSellerReviews } from '../application/use-cases/list-seller-reviews.use-case';
import { ReplyToReview } from '../application/use-cases/reply-to-review.use-case';
import { ReportReview } from '../application/use-cases/report-review.use-case';
import { closedBody, closedQuery, fail, refusal } from './http-answers';
import {
  ReplyRequest,
  ReportedBody,
  ReportRequest,
  SellerReviewBody,
  sellerReviewBody,
  SellerReviewListBody,
  sellerReviewListBody,
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
    private readonly query: QuerySellerReviews,
    private readonly exportReviews: ExportSellerReviews,
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

  // Before `:reviewId/...`, so `list` and `export` are never read as a review id.
  @Get('list')
  @ApiOperation({
    summary: "The shop's reviews as a super list",
    description:
      'Needs reviews.seller.view. Views (all, unanswered, answered, low) with counts, filters ' +
      '(reply, minRating/maxRating 1 to 5, q = a review, order, Offer or product id or text in ' +
      'the title or review, from/to published), sort (published or rating, with direction; ' +
      'newest first by default), page numbers with a total (`paging=pages`, default) or ' +
      'Previous/Next without one (`paging=prev-next`), and each row’s actions (open, reply, ' +
      'edit-reply, report; none that write in an acting-as session). Never the buyer. The older ' +
      'cursor route keeps its answer.',
  })
  @ApiQuery({ name: 'view', required: false, enum: SELLER_REVIEW_VIEWS })
  @ApiQuery({ name: 'reply', required: false, enum: ['none', 'published'] })
  @ApiQuery({ name: 'minRating', required: false })
  @ApiQuery({ name: 'maxRating', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Published at or after (ISO instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Published before (ISO instant).' })
  @ApiQuery({ name: 'sort', required: false, enum: SELLER_REVIEW_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: SellerReviewListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async listRows(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.query.execute(context, numbersOf(query));
    this.log(
      'reviews.query-seller-reviews-route',
      context,
      result.ok ? 'listed' : result.error.code,
    );
    if (!result.ok) throw this.refuse(result.error, context);
    return sellerReviewListBody(result.value);
  }

  @Get('export')
  @ApiOperation({
    summary: "Export the shop's reviews of the list as a file",
    description:
      'Needs reviews.seller.view. `format` is csv (default) or xlsx. `columns` is the ' +
      `comma-separated optional columns in the order shown (${SELLER_REVIEW_EXPORT_COLUMNS.join(', ')}); ` +
      'rating, title, review and published are always there. The reviews are `ids` ' +
      '(comma-separated, at most 200; an id that is not a published review of the shop refuses ' +
      'the whole file as not found) or the selector keys of the list, at most 10,000 (more: ' +
      'batch.too-large with the total). Never the buyer. CSV: a text cell that starts with = + - @ ' +
      'gets a leading quote. XLSX: every cell is a string value.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiOkResponse({ description: 'reviews-<date>.csv or reviews-<date>.xlsx, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportReviews.execute(context, { ...query });
    this.log(
      'reviews.export-seller-reviews-route',
      context,
      result.ok ? 'export' : result.error.code,
    );
    if (!result.ok) {
      const error =
        result.error.code === 'batch.too-large'
          ? fail(413, 'batch.too-large', {
              max: result.error.max,
              ...(result.error.total === undefined ? {} : { total: result.error.total }),
            })
          : this.refuse(result.error, context);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'reviews.export-seller-reviews',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  private refuse(error: { readonly code: string }, context: CallContext) {
    return refusal({ ...error }, context, this.#logger);
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

/** `page` and `pageSize` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined) {
      out[key] = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : -1;
    }
  }
  return out;
}
