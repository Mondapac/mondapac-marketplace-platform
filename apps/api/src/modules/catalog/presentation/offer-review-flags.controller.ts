import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Put,
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
  ApiProperty,
  ApiPropertyOptional,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Temporal } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ChangeCategoryAlwaysReview } from '../application/use-cases/change-category-always-review.use-case';
import { ChangeCategoryReviewStop } from '../application/use-cases/change-category-review-stop.use-case';
import { ViewCategoryOfferReviewFlags } from '../application/use-cases/view-category-offer-review-flags.use-case';
import { ViewSellerReviewStanding } from '../application/use-cases/view-seller-review-standing.use-case';
import { closedBody, fail, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of these routes. */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'category.not-found': 404,
  'seller.not-found': 404,
  'conflict.stale': 409,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const STEP_UP_FORBIDDEN =
  'request.csrf, access.denied (also an acting-as session), second-factor.required or ' +
  'second-factor.enrolment-required (details.actionKey)';

const iso = (instant: Temporal.Instant | null): string | null =>
  instant === null ? null : instant.toString();

export class CategoryOfferReviewFlagRequest {
  @ApiProperty({ description: 'The new value of the flag.' })
  on!: boolean;

  @ApiProperty({
    description:
      'Why (1 to 500 characters after trimming), always required. Kept in the change log for ' +
      'admins; never logged.',
    minLength: 1,
    maxLength: 500,
  })
  reason!: string;

  @ApiProperty({
    description:
      "The flags' version the admin saw (GET catalog/admin/offer-review/category-flags; 0 for a " +
      'category not listed). Another one is 409 conflict.stale.',
    minimum: 0,
  })
  expectedVersion!: number;
}

export class CategoryOfferReviewFlagChangedDto {
  @ApiProperty()
  on!: boolean;

  @ApiProperty({ description: 'False when the flag already held the value (nothing written).' })
  changed!: boolean;

  @ApiProperty({ description: 'The expectedVersion of the next change.' })
  version!: number;
}

export class FlaggedCategoryDto {
  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty({ description: 'Always review (R7), also for its sub-categories.' })
  alwaysReview!: boolean;

  @ApiProperty({ description: 'Offer review stop (R0), also for its sub-categories.' })
  reviewStop!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  alwaysReviewChangedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewStopChangedAt!: string | null;

  @ApiProperty({ description: 'The expectedVersion of the next change of this category.' })
  version!: number;
}

export class FlaggedCategoriesDto {
  @ApiProperty({ type: [FlaggedCategoryDto] })
  items!: FlaggedCategoryDto[];
}

export class SellerFlagDto {
  @ApiProperty()
  on!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  at!: string | null;
}

export class SellerFlagsDto {
  @ApiProperty({ type: SellerFlagDto })
  trustedFromStart!: SellerFlagDto;

  @ApiProperty({ type: SellerFlagDto })
  fullReview!: SellerFlagDto;

  @ApiProperty({ type: SellerFlagDto })
  reviewStop!: SellerFlagDto;
}

export class SellerReviewStandingDto {
  @ApiProperty({ enum: ['trusted', 'probation'] })
  status!: 'trusted' | 'probation';

  @ApiProperty({
    enum: ['count', 'admin'],
    nullable: true,
    description: 'count: earned in probation; admin: Trusted from start. Null in probation.',
  })
  source!: 'count' | 'admin' | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When Trusted began (null in probation or when not stamped yet).',
  })
  trustedSince!: string | null;

  @ApiProperty({
    description: 'Approved first publications in the current epoch (one per product).',
  })
  count!: number;

  @ApiProperty({ description: 'N, or ceil(N/2) after a misconduct revocation.' })
  target!: number;

  @ApiProperty({ description: 'N as read now.' })
  probationOffers!: number;

  @ApiProperty({ description: '0 while the seller has no standing yet.' })
  epoch!: number;

  @ApiProperty({ enum: ['initial', 'after-misconduct'] })
  targetKind!: 'initial' | 'after-misconduct';

  @ApiProperty({ description: 'Changes needed in a row (0 or 1).' })
  consecutiveChangesNeeded!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  trustLostAt!: string | null;

  @ApiPropertyOptional({
    type: SellerFlagsDto,
    nullable: true,
    description: "The seller's Offer review flags; null when sellers could not answer.",
  })
  flags!: SellerFlagsDto | null;
}

/**
 * The Offer review standing of a seller and the Offer review flags of platform categories, for an
 * admin (risk-based Offer approval slice 4; ADR-0051 decision 4). The category switches are
 * protected and need a fresh two-step code of the admin (checked here, spent in the change's
 * unit). A thin adapter: one use case per route through its gate. JSON only, closed bodies,
 * `Cache-Control: no-store`. The reason is never logged.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@ReadsSession()
@Controller('catalog/admin')
export class CatalogOfferReviewController {
  readonly #logger = new Logger('CatalogOfferReviewController');

  constructor(
    private readonly standing: ViewSellerReviewStanding,
    private readonly flagged: ViewCategoryOfferReviewFlags,
    private readonly alwaysReview: ChangeCategoryAlwaysReview,
    private readonly reviewStop: ChangeCategoryReviewStop,
  ) {}

  @Get('sellers/:sellerId/review-standing')
  @ApiOperation({
    summary: "A seller's probation and Trusted (admin)",
    description:
      'Needs catalog.product.approve. The status as the review policy sees it now (N read now), ' +
      "the count of the current epoch and the seller's Offer review flags.",
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: SellerReviewStandingDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.not-found (a malformed id)' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async sellerStanding(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ): Promise<SellerReviewStandingDto> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.standing.execute(context, { sellerId });
    const outcome: SellerReviewStandingDto | HttpException = result.ok
      ? {
          status: result.value.status,
          source: result.value.source,
          trustedSince: iso(result.value.trustedSince),
          count: result.value.count,
          target: result.value.target,
          probationOffers: result.value.probationOffers,
          epoch: result.value.epoch,
          targetKind: result.value.targetKind,
          consecutiveChangesNeeded: result.value.consecutiveChangesNeeded,
          trustLostAt: iso(result.value.trustLostAt),
          flags:
            result.value.flags === null
              ? null
              : {
                  trustedFromStart: {
                    on: result.value.flags.trustedFromStart.on,
                    at: iso(result.value.flags.trustedFromStart.at),
                  },
                  fullReview: {
                    on: result.value.flags.fullReview.on,
                    at: iso(result.value.flags.fullReview.at),
                  },
                  reviewStop: {
                    on: result.value.flags.reviewStop.on,
                    at: iso(result.value.flags.reviewStop.at),
                  },
                },
        }
      : refusalWith(STATUS, result.error, response, context);
    return this.#settle('catalog.view-seller-review-standing', context, outcome);
  }

  @Get('offer-review/category-flags')
  @ApiOperation({
    summary: 'The platform categories with an Offer review flag on (admin)',
    description:
      'Needs catalog.category-tree.view. Each category with "always review" or the Offer review ' +
      'stop on (both apply to its sub-categories too), with the version of its flags. A category ' +
      'not listed has both off and version 0.',
  })
  @ApiOkResponse({ type: FlaggedCategoriesDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async categoryFlags(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FlaggedCategoriesDto> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.flagged.execute(context, {});
    const outcome: FlaggedCategoriesDto | HttpException = result.ok
      ? {
          items: result.value.map((row) => ({
            categoryId: row.categoryId,
            alwaysReview: row.alwaysReview,
            reviewStop: row.reviewStop,
            alwaysReviewChangedAt: iso(row.alwaysReviewChangedAt),
            reviewStopChangedAt: iso(row.reviewStopChangedAt),
            version: row.version,
          })),
        }
      : refusalWith(STATUS, result.error, response, context);
    return this.#settle('catalog.view-category-offer-review-flags', context, outcome);
  }

  @Put('categories/:categoryId/offer-review')
  @HttpCode(200)
  @RequiresStepUp('catalog.category-review.change')
  @ApiOperation({
    summary: 'Mark a platform category "always review", or clear it (admin)',
    description:
      'Needs the protected catalog.category-review.manage and a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for catalog.category-review.change; without ' +
      'it 403 second-factor.required with details.actionKey); refused in an acting-as session. ' +
      'On: first publications and watched edits of Offers of products in it or a sub-category ' +
      'wait for an admin (sensitive-category). A stale expectedVersion is 409 conflict.stale.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiBody({ type: CategoryOfferReviewFlagRequest })
  @ApiOkResponse({ type: CategoryOfferReviewFlagChangedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: STEP_UP_FORBIDDEN })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  putAlwaysReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryOfferReviewFlagChangedDto> {
    return this.#change(
      this.alwaysReview,
      'catalog.change-category-always-review',
      context,
      request,
      response,
      categoryId,
      body,
    );
  }

  @Put('categories/:categoryId/offer-review-stop')
  @HttpCode(200)
  @RequiresStepUp('catalog.offer-review-stop.change')
  @ApiOperation({
    summary: "Switch a platform category's Offer review stop (admin)",
    description:
      'Needs the protected catalog.offer-review-stop.manage and a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for catalog.offer-review-stop.change; without ' +
      'it 403 second-factor.required with details.actionKey); refused in an acting-as session. ' +
      'On: first publications and watched edits of Offers of products in it or a sub-category ' +
      'wait for an admin in every mode; live Offers stay live. A stale expectedVersion is 409 ' +
      'conflict.stale.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiBody({ type: CategoryOfferReviewFlagRequest })
  @ApiOkResponse({ type: CategoryOfferReviewFlagChangedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: STEP_UP_FORBIDDEN })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  putReviewStop(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryOfferReviewFlagChangedDto> {
    return this.#change(
      this.reviewStop,
      'catalog.change-category-review-stop',
      context,
      request,
      response,
      categoryId,
      body,
    );
  }

  async #change(
    useCase: ChangeCategoryAlwaysReview | ChangeCategoryReviewStop,
    msg: string,
    context: CallContext,
    request: Request,
    response: Response,
    categoryId: string,
    body: unknown,
  ): Promise<CategoryOfferReviewFlagChangedDto> {
    response.setHeader('Cache-Control', 'no-store');
    const input = closedBody(request, body, ['on', 'reason', 'expectedVersion']);
    let outcome: CategoryOfferReviewFlagChangedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await useCase.execute(context, { categoryId, body: input });
      if (result.ok) outcome = { ...result.value };
      else if (
        result.error.code === 'second-factor.required' ||
        result.error.code === 'second-factor.enrolment-required'
      ) {
        outcome = fail(403, result.error.code, { actionKey: result.error.actionKey });
      } else outcome = refusalWith(STATUS, result.error, response, context);
    }
    return this.#settle(`${msg}-route`, context, outcome);
  }

  #settle<T extends object>(msg: string, context: CallContext, outcome: T | HttpException): T {
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
