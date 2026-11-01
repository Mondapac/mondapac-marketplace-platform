import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { RequiresStepUp } from '../../../platform/authz';
import { ListModerationQueue } from '../application/use-cases/list-moderation-queue.use-case';
import { ModerateReview } from '../application/use-cases/moderate-review.use-case';
import { RemoveReview } from '../application/use-cases/remove-review.use-case';
import { ViewModerationReview } from '../application/use-cases/view-moderation-review.use-case';
import { DeleteProductReview } from '../application/use-cases/delete-product-review.use-case';
import { EditProductReview } from '../application/use-cases/edit-product-review.use-case';
import { ListMyReviews } from '../application/use-cases/list-my-reviews.use-case';
import { ListProductReviews } from '../application/use-cases/list-product-reviews.use-case';
import { ListToReview } from '../application/use-cases/list-to-review.use-case';
import { RateSellerOrder } from '../application/use-cases/rate-seller-order.use-case';
import { SetReviewsStatus } from '../application/use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from '../application/use-cases/submit-product-review.use-case';
import { ViewProductSummary } from '../application/use-cases/view-product-summary.use-case';
import { ViewReviewsSettings } from '../application/use-cases/view-reviews-settings.use-case';
import { ViewSellerSummary } from '../application/use-cases/view-seller-summary.use-case';
import { closedBody, closedQuery, refusal } from './http-answers';
import {
  DeletedReviewBody,
  ModerateRequest,
  ModerationDetailBody,
  moderationDetailBody,
  ModerationQueueBody,
  moderationQueueBody,
  EditReviewRequest,
  MyReviewsBody,
  myReviewsBody,
  OwnReviewBody,
  OwnSellerRatingBody,
  ownReviewBody,
  ownSellerRatingBody,
  ProductReviewsBody,
  productReviewsBody,
  ProductSummaryBody,
  productSummaryBody,
  RateSellerOrderRequest,
  SellerSummaryBody,
  sellerSummaryBody,
  SetSettingsRequest,
  SettingsBody,
  settingsBody,
  SubmitReviewRequest,
  SubmittedReviewBody,
  submittedReviewBody,
  ToReviewBody,
  toReviewBody,
} from './reviews.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  // Ids and codes only: a review's text is never logged.
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The signed-in buyer's own reviews and ratings. Thin adapters: the buyer comes from the session,
 * never from the request; refused in an acting-as session. Every answer is `Cache-Control:
 * no-store`.
 */
@ApiTags('reviews')
@RoutePopulation('customer')
@ReadsSession()
@Controller('reviews')
export class BuyerReviewsController {
  readonly #logger = new Logger('BuyerReviewsController');

  constructor(
    private readonly toReview: ListToReview,
    private readonly mine: ListMyReviews,
    private readonly submit: SubmitProductReview,
    private readonly edit: EditProductReview,
    private readonly remove: DeleteProductReview,
    private readonly rate: RateSellerOrder,
  ) {}

  @Get('me/to-review')
  @ApiOperation({
    summary: 'What the buyer can still review or rate',
    description:
      'Delivered products and seller orders inside the Market review window that have no review ' +
      'or rating yet. Answers reviews.disabled (404) while reviews are off.',
  })
  @ApiOkResponse({ type: ToReviewBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async toReviewList(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.toReview.execute(context, {});
    logRoute(
      this.#logger,
      'reviews.list-to-review-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return toReviewBody(result.value);
  }

  @Get('me')
  @ApiOperation({ summary: "The buyer's own reviews and seller ratings, newest first" })
  @ApiOkResponse({ type: MyReviewsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async myReviews(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.mine.execute(context, {});
    logRoute(
      this.#logger,
      'reviews.list-my-reviews-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return myReviewsBody(result.value);
  }

  @Post('products')
  @ApiOperation({
    summary: 'Review a product the buyer received',
    description:
      'Verified buyers only: the account has a delivered seller order with the product, inside ' +
      'the Market review window. A clean text publishes at once; a flagged one is held for a ' +
      'human. One review per product: a second call records a later purchase (200, ' +
      '`purchase-recorded`) or answers reviews.already-reviewed (409). Rating 1 to 5; title and ' +
      'body optional.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SubmitReviewRequest })
  @ApiCreatedResponse({ type: SubmittedReviewBody })
  @ApiOkResponse({ type: SubmittedReviewBody, description: 'outcome purchase-recorded' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, reviews.not-eligible or reviews.own-store',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'reviews.window-closed or reviews.already-reviewed',
  })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'reviews.rate-limited' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async submitReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'productId',
      'rating',
      'title',
      'body',
      'anonymous',
      'locale',
    ]);
    if (invalid !== null) throw invalid;
    const result = await this.submit.execute(context, requestBody as Record<string, unknown>);
    logRoute(
      this.#logger,
      'reviews.submit-product-review-route',
      context,
      result.ok ? result.value.outcome : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    response.status(result.value.outcome === 'purchase-recorded' ? 200 : 201);
    return submittedReviewBody(result.value);
  }

  @Patch('products/:id')
  @ApiOperation({
    summary: "Edit the buyer's own review",
    description:
      'Up to the Market edit window after the first submit. Only the fields sent ' +
      'change; null clears the title or the body. A flagged text puts the review on hold.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: EditReviewRequest })
  @ApiOkResponse({ type: OwnReviewBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'reviews.not-editable or reviews.edit-window-closed',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async editReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['rating', 'title', 'body', 'anonymous']);
    if (invalid !== null) throw invalid;
    const result = await this.edit.execute(context, {
      ...(requestBody as Record<string, unknown>),
      reviewId: id,
    });
    logRoute(
      this.#logger,
      'reviews.edit-product-review-route',
      context,
      result.ok ? 'edited' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownReviewBody(result.value);
  }

  @Delete('products/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: "Delete the buyer's own review",
    description:
      'At any time. The review leaves the public page and its text is cleared; the row stays ' +
      'so the rating history is honest. Deleting twice answers the same. A review a moderator ' +
      'hid or removed can be deleted too (the text goes), but cannot then be written again.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: DeletedReviewBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled or reviews.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async deleteReview(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, { reviewId: id });
    logRoute(
      this.#logger,
      'reviews.delete-product-review-route',
      context,
      result.ok ? 'deleted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { id: result.value.id, status: result.value.status };
  }

  @Post('seller-orders/:sellerOrderId/rating')
  @ApiOperation({
    summary: 'Rate a delivered seller order',
    description:
      'Once per seller order, inside the Market review window after delivery. Satisfaction 1 to ' +
      '5, as described yes or no, arrived ok yes or no, and (only when it did not arrive ok) a ' +
      'reason code. There is no question about timeliness and the courier is never rated.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiBody({ type: RateSellerOrderRequest })
  @ApiCreatedResponse({ type: OwnSellerRatingBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, reviews.not-eligible or reviews.own-store',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'reviews.window-closed or reviews.already-rated',
  })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'reviews.rate-limited' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async rateOrder(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerOrderId') sellerOrderId: string,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'satisfaction',
      'asDescribed',
      'arrivedOk',
      'reasonCode',
    ]);
    if (invalid !== null) throw invalid;
    const result = await this.rate.execute(context, {
      ...(requestBody as Record<string, unknown>),
      sellerOrderId,
    });
    logRoute(
      this.#logger,
      'reviews.rate-seller-order-route',
      context,
      result.ok ? 'rated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownSellerRatingBody(result.value);
  }
}

/**
 * The public reads: published reviews of a product and the two summaries. No session is read; the
 * Market is the request's. In the default per-origin rate-limit class.
 */
@ApiTags('reviews')
@RoutePopulation('customer')
@Controller('reviews')
export class PublicReviewsController {
  readonly #logger = new Logger('PublicReviewsController');

  constructor(
    private readonly list: ListProductReviews,
    private readonly productSummary: ViewProductSummary,
    private readonly sellerSummary: ViewSellerSummary,
  ) {}

  @Get('products/:productId')
  @ApiOperation({
    summary: 'The published reviews of a product (public)',
    description:
      'No session needed. Published reviews only, newest first, one page at a time (the Market page size). ' +
      'Authors show their short name read now, "Verified buyer" when they chose to be anonymous, ' +
      'or "Former customer" once their account was deleted. Answers reviews.disabled (404) while ' +
      'reviews are off.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiQuery({ name: 'stars', required: false, description: '1 to 5: only reviews of that rating.' })
  @ApiQuery({ name: 'sort', required: false, description: '`recent` (default; the only one now).' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiOkResponse({ type: ProductReviewsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async productReviews(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = closedQuery(query, ['stars', 'sort', 'cursor']);
    if (unknown !== null) throw unknown;
    const result = await this.list.execute(context, {
      productId,
      stars: query.stars,
      sort: query.sort,
      cursor: query.cursor,
    });
    logRoute(
      this.#logger,
      'reviews.list-product-reviews-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return productReviewsBody(result.value);
  }

  @Get('products/:productId/summary')
  @ApiOperation({
    summary: 'The star summary of a product (public)',
    description: 'Across sellers, from the first review. Hundredths of a star and a 1-5 histogram.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: ProductSummaryBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async productSummaryRoute(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = closedQuery(query, []);
    if (unknown !== null) throw unknown;
    const result = await this.productSummary.execute(context, { productId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return productSummaryBody(result.value);
  }

  @Get('sellers/:sellerId/summary')
  @ApiOperation({
    summary: 'The rated-order summary of a seller (public)',
    description:
      'Carries the count of rated seller orders and the Market minimum; the web decides whether ' +
      'to show it.',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: SellerSummaryBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'reviews.unavailable' })
  async sellerSummaryRoute(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
    @Query() query: Record<string, unknown>,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = closedQuery(query, []);
    if (unknown !== null) throw unknown;
    const result = await this.sellerSummary.execute(context, { sellerId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerSummaryBody(result.value);
  }
}

/** The reviews switch of the Market, for admins. */
@ApiTags('reviews')
@RoutePopulation('admin')
@ReadsSession()
@Controller('reviews/admin/settings')
export class AdminReviewsController {
  readonly #logger = new Logger('AdminReviewsController');

  constructor(
    private readonly view: ViewReviewsSettings,
    private readonly set: SetReviewsStatus,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The reviews state of the Market (admin)',
    description: 'Needs reviews.settings.view. No row means off.',
  })
  @ApiOkResponse({ type: SettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async get(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    logRoute(
      this.#logger,
      'reviews.view-reviews-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @RequiresStepUp('reviews.settings.change')
  @ApiOperation({
    summary: 'Move the reviews of the Market to off or active (admin)',
    description:
      'Needs reviews.settings.manage (protected) and a fresh two-step proof of this admin ' +
      '(`POST identity/admin/step-up/verify` for reviews.settings.change; without it 403 ' +
      'second-factor.required with details.actionKey). Refused in an acting-as session. Audited with ' +
      'before and after. Asking for the state the Market is in changes nothing. Turning off ' +
      'deletes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSettingsRequest })
  @ApiOkResponse({ type: SettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required (details.actionKey) or second-factor.enrolment-required',
  })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['status']);
    if (invalid !== null) throw invalid;
    const { status } = requestBody as { status?: unknown };
    const result = await this.set.execute(context, { status });
    logRoute(
      this.#logger,
      'reviews.set-reviews-status-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }
}

const MODERATE_STEP_UP_NOTE =
  'Needs a fresh two-step proof of this admin for reviews.review.moderate (`POST ' +
  'identity/admin/step-up/verify`); without it 403 second-factor.required with details.actionKey. ' +
  'The proof is spent by the change. Refused in an acting-as session. Audited with codes only.';

const MODERATE_FORBIDDEN =
  'access.denied, request.csrf, second-factor.required (details.actionKey) or second-factor.enrolment-required';

const MODERATE_CONFLICT =
  'reviews.not-moderatable: the review is not in a status the action applies to, or another ' +
  'moderator moved it first';

/**
 * The moderator queue (package 2): held, reported and actioned reviews, and the actions on them.
 * Works whether the Market switch is on or off. A review's text appears here for the moderator
 * only, never in a log, audit row or event. The author is never named. Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('reviews')
@RoutePopulation('admin')
@ReadsSession()
@Controller('reviews/admin/moderation')
export class AdminModerationController {
  readonly #logger = new Logger('AdminModerationController');

  constructor(
    private readonly list: ListModerationQueue,
    private readonly view: ViewModerationReview,
    private readonly moderate: ModerateReview,
    private readonly remove: RemoveReview,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The moderator queue (admin)',
    description:
      'Needs reviews.moderation.queue. Tabs: held, reported, actioned. Newest submitted first, ' +
      '25 per page (limit up to 50), with counts per tab.',
  })
  @ApiQuery({ name: 'tab', required: false, enum: ['held', 'reported', 'actioned'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: ModerationQueueBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async queue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = closedQuery(query, ['tab', 'cursor', 'limit']);
    if (unknown !== null) throw unknown;
    const limit = query.limit;
    const result = await this.list.execute(context, {
      ...(query.tab === undefined ? {} : { tab: query.tab }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(limit === undefined
        ? {}
        : { limit: typeof limit === 'string' && /^\d{1,3}$/.test(limit) ? Number(limit) : NaN }),
    });
    logRoute(
      this.#logger,
      'reviews.list-moderation-queue-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return moderationQueueBody(result.value);
  }

  @Get(':reviewId')
  @ApiOperation({
    summary: 'One review for a moderator (admin)',
    description:
      'Needs reviews.moderation.queue. The review with its open report reasons, signal codes, ' +
      'its history and the actions that apply now.',
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  async detail(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Query() query: Record<string, unknown>,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const unknown = closedQuery(query, []);
    if (unknown !== null) throw unknown;
    const result = await this.view.execute(context, { reviewId });
    logRoute(
      this.#logger,
      'reviews.view-moderation-review-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return moderationDetailBody(result.value);
  }

  private async act(
    action: 'publish' | 'hide' | 'restore' | 'dismiss-reports' | 'remove',
    context: CallContext,
    request: Request,
    response: Response,
    reviewId: string,
    requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['reasonCode']);
    if (invalid !== null) throw invalid;
    const { reasonCode } = requestBody as { reasonCode?: unknown };
    const useCase = action === 'remove' ? this.remove : this.moderate;
    const result = await useCase.execute(context, { reviewId, action, reasonCode });
    logRoute(
      this.#logger,
      `reviews.${action}-review-route`,
      context,
      result.ok ? 'done' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return moderationDetailBody(result.value);
  }

  @Post(':reviewId/publish')
  @HttpCode(200)
  @RequiresStepUp('reviews.review.moderate')
  @ApiOperation({
    summary: 'Publish a held review (admin)',
    description: `Needs reviews.moderation.moderate. Reason: checked-ok. ${MODERATE_STEP_UP_NOTE}`,
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ModerateRequest })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: MODERATE_FORBIDDEN })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: MODERATE_CONFLICT })
  publish(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    return this.act('publish', context, request, response, reviewId, requestBody);
  }

  @Post(':reviewId/hide')
  @HttpCode(200)
  @RequiresStepUp('reviews.review.moderate')
  @ApiOperation({
    summary: 'Hide a review, reversibly (admin)',
    description:
      'Needs reviews.moderation.moderate. A closed reason: personal-information, abusive, ' +
      'irrelevant, not-a-purchase, incentivised, spam or other. There is no reason for a negative ' +
      `review or a seller request: a true negative review is never hidden. ${MODERATE_STEP_UP_NOTE}`,
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ModerateRequest })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: MODERATE_FORBIDDEN })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: MODERATE_CONFLICT })
  hide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    return this.act('hide', context, request, response, reviewId, requestBody);
  }

  @Post(':reviewId/restore')
  @HttpCode(200)
  @RequiresStepUp('reviews.review.moderate')
  @ApiOperation({
    summary: 'Restore a hidden review (admin)',
    description: `Needs reviews.moderation.moderate. Reason: reinstated or hidden-in-error. A removed review stays removed. ${MODERATE_STEP_UP_NOTE}`,
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ModerateRequest })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: MODERATE_FORBIDDEN })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: MODERATE_CONFLICT })
  restore(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    return this.act('restore', context, request, response, reviewId, requestBody);
  }

  @Post(':reviewId/remove')
  @HttpCode(200)
  @RequiresStepUp('reviews.review.moderate')
  @ApiOperation({
    summary: 'Remove a review for illegal, defamatory or private content (admin)',
    description:
      'Needs reviews.moderation.remove (protected). Reason: illegal, defamatory, ' +
      `personal-information or abusive. Not reversible. ${MODERATE_STEP_UP_NOTE}`,
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ModerateRequest })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: MODERATE_FORBIDDEN })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: MODERATE_CONFLICT })
  removeReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    return this.act('remove', context, request, response, reviewId, requestBody);
  }

  @Post(':reviewId/dismiss-reports')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dismiss the open reports of a review (admin)',
    description:
      'Needs reviews.moderation.moderate. Reason: not-against-policy or duplicate. Changes no ' +
      'status and needs no two-step proof. Audited with codes only.',
  })
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiBody({ type: ModerateRequest })
  @ApiOkResponse({ type: ModerationDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'reviews.not-found' })
  @ApiConflictResponse({ ...ERROR, description: MODERATE_CONFLICT })
  dismissReports(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('reviewId') reviewId: string,
    @Body() requestBody: unknown,
  ) {
    return this.act('dismiss-reports', context, request, response, reviewId, requestBody);
  }
}
