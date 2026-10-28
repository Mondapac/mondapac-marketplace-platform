import {
  Body,
  Controller,
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
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CreateOwnPromotion } from '../application/use-cases/create-own-promotion.use-case';
import { CreatePromotion } from '../application/use-cases/create-promotion.use-case';
import { DecidePromotionReview } from '../application/use-cases/decide-promotion-review.use-case';
import { EditOwnPromotion } from '../application/use-cases/edit-own-promotion.use-case';
import { EditPromotion } from '../application/use-cases/edit-promotion.use-case';
import { ListFreeShippingThresholds } from '../application/use-cases/list-free-shipping-thresholds.use-case';
import { ListOwnPromotions } from '../application/use-cases/list-own-promotions.use-case';
import { ListPromotionReviews } from '../application/use-cases/list-promotion-reviews.use-case';
import { ListPromotionsFull } from '../application/use-cases/list-promotions-full.use-case';
import { ListPromotions } from '../application/use-cases/list-promotions.use-case';
import { PauseOwnPromotion } from '../application/use-cases/pause-own-promotion.use-case';
import { PausePromotion } from '../application/use-cases/pause-promotion.use-case';
import { PreviewQuote } from '../application/use-cases/preview-quote.use-case';
import { ResumeOwnPromotion } from '../application/use-cases/resume-own-promotion.use-case';
import { ResumePromotion } from '../application/use-cases/resume-promotion.use-case';
import { SetCoFundingOptIn } from '../application/use-cases/set-co-funding-opt-in.use-case';
import { SetFirstOrderSettings } from '../application/use-cases/set-first-order-settings.use-case';
import { SetFreeShippingThreshold } from '../application/use-cases/set-free-shipping-threshold.use-case';
import { SetPromotionBudget } from '../application/use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from '../application/use-cases/set-promotions-status.use-case';
import { ViewFirstOrderSettings } from '../application/use-cases/view-first-order-settings.use-case';
import { ViewPromotion } from '../application/use-cases/view-promotion.use-case';
import { ViewPromotionsSettings } from '../application/use-cases/view-promotions-settings.use-case';
import { closedBody, closedQuery, limitOf, refusal } from './http-answers';
import {
  BudgetRequest,
  FirstOrderBody,
  firstOrderBody,
  FirstOrderRequest,
  OptInBody,
  OptInRequest,
  OwnPromotionBody,
  OwnPromotionsBody,
  ownBody,
  PromotionBody,
  promotionBody,
  PromotionRequest,
  PromotionsBody,
  PromotionUsageListBody,
  QuoteBody,
  quoteBody,
  QuoteRequestBody,
  ReviewDecisionRequest,
  ReviewItemBody,
  reviewItemBody,
  ReviewQueueBody,
  SetSettingsRequest,
  SettingsBody,
  settingsBody,
  ThresholdRequest,
  ThresholdResultBody,
  ThresholdsBody,
  thresholdsBody,
  usageBody,
} from './promotions.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const UNAUTHENTICATED = 'access.unauthenticated or session.invalid';
const PROMOTION_FIELDS = [
  'type',
  'name',
  'funding',
  'platformSplitBps',
  'combinable',
  'code',
  'startsAt',
  'endsAt',
  'testMode',
  'specialCampaign',
  'reward',
  'capMinor',
  'maxPerOrderMinor',
  'maxTotalUses',
  'maxUsesPerCustomer',
  'budgetMinor',
  'minSpendMinor',
  'productIds',
  'sellerIds',
  'zones',
] as const;
const LIST_QUERY = ['status', 'limit'] as const;

/**
 * Logs ids and codes only (a promotion's name and code are never logged), then returns the value
 * of a success or throws the HTTP form of the refusal.
 */
function settle<T>(
  logger: Logger,
  msg: string,
  context: CallContext,
  result: Result<T, { readonly code: string } & Record<string, unknown>>,
  outcome: string,
): T {
  logger.log({
    msg,
    outcome: result.ok ? outcome : result.error.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (!result.ok) throw refusal(result.error, context, logger);
  return result.value;
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

/** The body of an unsafe route: JSON only, no key outside `allowed`. */
function bodyOf(
  request: Request,
  requestBody: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const invalid = closedBody(request, requestBody, allowed);
  if (invalid !== null) throw invalid;
  return requestBody as Record<string, unknown>;
}

function listQueryOf(query: Record<string, unknown>) {
  const unknown = closedQuery(query, LIST_QUERY);
  if (unknown !== null) throw unknown;
  return { status: query.status, limit: limitOf(query.limit) };
}

const LIST_QUERY_DOCS = [
  { name: 'status', required: false, description: 'Only promotions in this status.' },
  { name: 'limit', required: false, description: '1 to 100; default 50.' },
] as const;

/**
 * Promotions for admins: the Market switch, the catalogue (full for a manager, usage counts for a
 * Viewer), the review queue, first-order and free-shipping settings and a quote preview. Thin
 * adapters over the use cases; every answer is `Cache-Control: no-store`. Whether a change needs
 * a fresh two-step code depends on the data, so it is asked of the use case, not the route.
 */
@ApiTags('promotions')
@RoutePopulation('admin')
@ReadsSession()
@Controller('promotions/admin')
export class AdminPromotionsController {
  readonly #logger = new Logger('AdminPromotionsController');

  constructor(
    private readonly viewSettings: ViewPromotionsSettings,
    private readonly setStatus: SetPromotionsStatus,
    private readonly listUsage: ListPromotions,
    private readonly listFull: ListPromotionsFull,
    private readonly viewOne: ViewPromotion,
    private readonly create: CreatePromotion,
    private readonly edit: EditPromotion,
    private readonly pause: PausePromotion,
    private readonly resume: ResumePromotion,
    private readonly setBudget: SetPromotionBudget,
    private readonly listReviews: ListPromotionReviews,
    private readonly decideReview: DecidePromotionReview,
    private readonly viewFirstOrder: ViewFirstOrderSettings,
    private readonly setFirstOrder: SetFirstOrderSettings,
    private readonly listThresholds: ListFreeShippingThresholds,
    private readonly setThreshold: SetFreeShippingThreshold,
    private readonly preview: PreviewQuote,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary: 'The promotions state of the Market (admin)',
    description: 'Needs promotions.settings.view. No row means off.',
  })
  @ApiOkResponse({ type: SettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async getSettings(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    const result = await this.viewSettings.execute(context, {});
    return settingsBody(
      settle(this.#logger, 'promotions.view-settings-route', context, result, 'read'),
    );
  }

  @Put('settings')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Move the promotions of the Market to off or active (admin)',
    description:
      'Needs promotions.settings.manage (protected); refused in an acting-as session. Audited ' +
      'with before and after. Asking for the state the Market is in changes nothing. Turning off ' +
      'deletes nothing and a quote then carries no discount.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSettingsRequest })
  @ApiOkResponse({ type: SettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  async putSettings(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const { status } = bodyOf(request, requestBody, ['status']);
    const result = await this.setStatus.execute(context, { status });
    return settingsBody(
      settle(this.#logger, 'promotions.set-status-route', context, result, 'set'),
    );
  }

  @Get('promotions')
  @ApiOperation({
    summary: 'Promotions with their usage (admin Viewer)',
    description:
      'Needs promotions.promotion.view. Names, status and usage counts; no budget, no cap and ' +
      'no cost. Answers promotions.disabled (404) while the Market switch is off.',
  })
  @ApiQuery(LIST_QUERY_DOCS[0])
  @ApiQuery(LIST_QUERY_DOCS[1])
  @ApiOkResponse({ type: PromotionUsageListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ) {
    noStore(response);
    const result = await this.listUsage.execute(context, listQueryOf(query));
    const items = settle(this.#logger, 'promotions.list-route', context, result, 'read');
    return { items: items.map(usageBody) };
  }

  @Get('promotions/costs')
  @ApiOperation({
    summary: 'Promotions with budget, caps and spend (admin manager)',
    description: 'Needs promotions.promotion.manage. The Viewer cannot read this list.',
  })
  @ApiQuery(LIST_QUERY_DOCS[0])
  @ApiQuery(LIST_QUERY_DOCS[1])
  @ApiOkResponse({ type: PromotionsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async listCosts(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ) {
    noStore(response);
    const result = await this.listFull.execute(context, listQueryOf(query));
    const items = settle(this.#logger, 'promotions.list-full-route', context, result, 'read');
    return { items: items.map(promotionBody) };
  }

  @Get('promotions/:id')
  @ApiOperation({ summary: 'One promotion in full (admin manager)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PromotionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    noStore(response);
    const result = await this.viewOne.execute(context, { promotionId: id });
    return promotionBody(settle(this.#logger, 'promotions.view-route', context, result, 'read'));
  }

  @Post('promotions')
  @ApiOperation({
    summary: 'Create a promotion (admin manager)',
    description:
      'Needs promotions.promotion.manage; refused in an acting-as session. A promotion that ' +
      'platform funds above the Market step-up amount, and a special campaign, need a fresh ' +
      'two-step code: second-factor.required (403, details.actionKey) otherwise. A platform ' +
      'promotion needs a budget. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PromotionRequest })
  @ApiCreatedResponse({ type: PromotionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, second-factor.required or enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.code-taken' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async createPromotion(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, PROMOTION_FIELDS);
    const result = await this.create.execute(context, body);
    const view = settle(this.#logger, 'promotions.create-route', context, result, 'created');
    response.status(201);
    return promotionBody(view);
  }

  @Patch('promotions/:id')
  @ApiOperation({
    summary: 'Edit a promotion (admin manager)',
    description:
      'The whole definition is sent again. Only the fields the promotion type allows to change ' +
      'after it started are accepted; promotions.not-editable (409) otherwise. The same step-up ' +
      'rule as create applies to the new terms.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: PromotionRequest })
  @ApiOkResponse({ type: PromotionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, second-factor.required or enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'promotions.not-editable, promotions.invalid-state, promotions.code-taken or promotions.too-many-active',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async editPromotion(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, PROMOTION_FIELDS);
    const result = await this.edit.execute(context, { ...body, promotionId: id });
    return promotionBody(settle(this.#logger, 'promotions.edit-route', context, result, 'edited'));
  }

  @Post('promotions/:id/pause')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause a promotion (admin manager)',
    description: 'Its discounts stop at once. Pausing a paused promotion changes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PromotionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async pausePromotion(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    noStore(response);
    const result = await this.pause.execute(context, { promotionId: id });
    return promotionBody(settle(this.#logger, 'promotions.pause-route', context, result, 'paused'));
  }

  @Post('promotions/:id/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resume a paused promotion (admin manager)',
    description:
      'A promotion an admin paused can be resumed by an admin; a seller cannot resume one an ' +
      'admin paused.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PromotionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async resumePromotion(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    noStore(response);
    const result = await this.resume.execute(context, { promotionId: id });
    return promotionBody(
      settle(this.#logger, 'promotions.resume-route', context, result, 'resumed'),
    );
  }

  @Put('promotions/:id/budget')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the budget of a platform promotion (admin manager)',
    description:
      'Minor units as digits. The budget never goes below what the promotion has already spent. ' +
      'A budget above the Market step-up amount needs a fresh two-step code.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: BudgetRequest })
  @ApiOkResponse({ type: PromotionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, second-factor.required or enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async putBudget(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const { budgetMinor } = bodyOf(request, requestBody, ['budgetMinor']);
    const result = await this.setBudget.execute(context, { promotionId: id, budgetMinor });
    return promotionBody(settle(this.#logger, 'promotions.budget-route', context, result, 'set'));
  }

  @Get('reviews')
  @ApiOperation({
    summary: 'Seller promotions waiting for an admin (admin manager)',
    description:
      'Open reviews first: a new seller (inside the Market new-seller days), a discount above ' +
      'the Market threshold, or a post-publication check.',
  })
  @ApiOkResponse({ type: ReviewQueueBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async getReviews(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    const result = await this.listReviews.execute(context, {});
    const items = settle(this.#logger, 'promotions.list-reviews-route', context, result, 'read');
    return { items: items.map(reviewItemBody) };
  }

  @Put('reviews/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve or reject a queued seller promotion (admin manager)',
    description:
      'Approval activates the promotion; rejection ends it. The body carries the `updatedAt` of ' +
      'the promotion as `promotionVersion`: a promotion changed since, or a second decision on the ' +
      'same review, answers promotions.invalid-state (409). Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: ReviewDecisionRequest })
  @ApiOkResponse({ type: ReviewItemBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async putReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const { decision, promotionVersion } = bodyOf(request, requestBody, [
      'decision',
      'promotionVersion',
    ]);
    const result = await this.decideReview.execute(context, {
      reviewId: id,
      decision,
      promotionVersion,
    });
    return reviewItemBody(
      settle(this.#logger, 'promotions.decide-review-route', context, result, 'decided'),
    );
  }

  @Get('first-order')
  @ApiOperation({
    summary: 'The first-order discount of the Market (admin manager)',
    description:
      '`source` says where the answer comes from: the stored setting, the Market file, or none.',
  })
  @ApiOkResponse({ type: FirstOrderBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async getFirstOrder(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    noStore(response);
    const result = await this.viewFirstOrder.execute(context, {});
    return firstOrderBody(
      settle(this.#logger, 'promotions.view-first-order-route', context, result, 'read'),
    );
  }

  @Put('first-order')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the first-order discount of the Market (admin manager)',
    description:
      'Platform-funded. A percentage needs `percentBps`, a fixed amount needs `amountMinor`. ' +
      'Audited with before and after.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: FirstOrderRequest })
  @ApiOkResponse({ type: FirstOrderBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async putFirstOrder(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, [
      'enabled',
      'kind',
      'percentBps',
      'amountMinor',
      'capMinor',
      'minSpendMinor',
      'monthlyBudgetMinor',
    ]);
    const result = await this.setFirstOrder.execute(context, body);
    return firstOrderBody(
      settle(this.#logger, 'promotions.set-first-order-route', context, result, 'set'),
    );
  }

  @Get('free-shipping')
  @ApiOperation({
    summary: 'Free-shipping thresholds of the Market (admin manager)',
    description: 'The Market default and the zones with a threshold of their own.',
  })
  @ApiOkResponse({ type: ThresholdsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async getThresholds(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    noStore(response);
    const result = await this.listThresholds.execute(context, {});
    return thresholdsBody(
      settle(this.#logger, 'promotions.list-thresholds-route', context, result, 'read'),
    );
  }

  @Put('free-shipping/:zoneCode')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the free-shipping threshold of one zone (admin manager)',
    description: 'Null returns the zone to the Market default. Audited with before and after.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'zoneCode' })
  @ApiBody({ type: ThresholdRequest })
  @ApiOkResponse({ type: ThresholdResultBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async putThreshold(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('zoneCode') zoneCode: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const { thresholdMinor } = bodyOf(request, requestBody, ['thresholdMinor']);
    const result = await this.setThreshold.execute(context, { zoneCode, thresholdMinor });
    const value = settle(this.#logger, 'promotions.set-threshold-route', context, result, 'set');
    return {
      zoneCode: value.zoneCode,
      thresholdMinor: value.thresholdMinor === null ? null : value.thresholdMinor.toString(),
    };
  }

  @Post('preview-quote')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Preview the discounts of a cart (admin manager)',
    description:
      'Runs the same calculation checkout will, on a cart the admin types in. The default is ' +
      'test mode, so test-mode promotions are included. Nothing is stored. With the switch off ' +
      'the answer carries `enabled: false` and no discount.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: QuoteRequestBody })
  @ApiOkResponse({ type: QuoteBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async previewQuote(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, [
      'lines',
      'shipping',
      'code',
      'isFirstOrder',
      'testMode',
      'orderCommissionMinor',
    ]);
    const result = await this.preview.execute(context, body);
    return quoteBody(settle(this.#logger, 'promotions.preview-route', context, result, 'read'));
  }
}

/**
 * A seller's own promotions. The seller comes from the session, never from the request; a seller
 * who is not approved is refused by the use case's access declaration; an acting-as session is
 * refused. A seller sees and changes only its own.
 */
@ApiTags('promotions')
@RoutePopulation('seller')
@ReadsSession()
@Controller('promotions/seller')
export class SellerPromotionsController {
  readonly #logger = new Logger('SellerPromotionsController');

  constructor(
    private readonly list: ListOwnPromotions,
    private readonly create: CreateOwnPromotion,
    private readonly edit: EditOwnPromotion,
    private readonly pause: PauseOwnPromotion,
    private readonly resume: ResumeOwnPromotion,
    private readonly optIn: SetCoFundingOptIn,
  ) {}

  @Get('promotions')
  @ApiOperation({ summary: "The seller's own promotions" })
  @ApiQuery(LIST_QUERY_DOCS[0])
  @ApiQuery(LIST_QUERY_DOCS[1])
  @ApiOkResponse({ type: OwnPromotionsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  async listOwn(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ) {
    noStore(response);
    const result = await this.list.execute(context, listQueryOf(query));
    const items = settle(this.#logger, 'promotions.list-own-route', context, result, 'read');
    return { items: items.map(ownBody) };
  }

  @Post('promotions')
  @ApiOperation({
    summary: 'Create a promotion on the seller own products',
    description:
      'Seller-funded. A new seller (inside the Market new-seller days) and a discount above the ' +
      'Market threshold go to an admin before they apply: the answer is status ' +
      '`PENDING_REVIEW`. Test mode, a special campaign and platform funding are not available ' +
      'to a seller.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PromotionRequest })
  @ApiCreatedResponse({ type: OwnPromotionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'promotions.code-taken or promotions.too-many-active',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'promotions.unavailable' })
  async createOwn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, PROMOTION_FIELDS);
    const result = await this.create.execute(context, body);
    const view = settle(this.#logger, 'promotions.create-own-route', context, result, 'created');
    response.status(201);
    return ownBody(view);
  }

  @Patch('promotions/:id')
  @ApiOperation({ summary: 'Edit one of the seller own promotions' })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: PromotionRequest })
  @ApiOkResponse({ type: OwnPromotionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'promotions.not-editable, promotions.invalid-state, promotions.code-taken or promotions.too-many-active',
  })
  async editOwn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const body = bodyOf(request, requestBody, PROMOTION_FIELDS);
    const result = await this.edit.execute(context, { ...body, promotionId: id });
    return ownBody(settle(this.#logger, 'promotions.edit-own-route', context, result, 'edited'));
  }

  @Post('promotions/:id/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pause one of the seller own promotions' })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OwnPromotionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async pauseOwn(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    noStore(response);
    const result = await this.pause.execute(context, { promotionId: id });
    return ownBody(settle(this.#logger, 'promotions.pause-own-route', context, result, 'paused'));
  }

  @Post('promotions/:id/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resume one of the seller own promotions',
    description: 'Not available when an admin paused the promotion: access is then refused.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OwnPromotionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'promotions.invalid-state or promotions.too-many-active',
  })
  async resumeOwn(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    noStore(response);
    const result = await this.resume.execute(context, { promotionId: id });
    return ownBody(settle(this.#logger, 'promotions.resume-own-route', context, result, 'resumed'));
  }

  @Put('campaigns/:id/opt-in')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Opt in to, or out of, a co-funded campaign',
    description:
      'For the seller own products only. Withdrawing stops the campaign for this seller; ' +
      'it never changes what was already ordered.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: OptInRequest })
  @ApiOkResponse({ type: OptInBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHENTICATED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'promotions.disabled or promotions.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'promotions.invalid-state' })
  async putOptIn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() requestBody: unknown,
  ) {
    noStore(response);
    const { optIn } = bodyOf(request, requestBody, ['optIn']);
    const result = await this.optIn.execute(context, { promotionId: id, optIn });
    const value = settle(this.#logger, 'promotions.opt-in-route', context, result, 'set');
    return { promotionId: value.promotionId, optedIn: value.optedIn };
  }
}
