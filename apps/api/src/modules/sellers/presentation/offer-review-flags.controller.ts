import { Body, Controller, Get, HttpCode, Logger, Param, Put, Req, Res } from '@nestjs/common';
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
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import type { AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import type {
  ChangeOfferReviewFlagFailure,
  ChangeOfferReviewFlagInput,
  ChangeOfferReviewFlagResult,
} from '../application/use-cases/change-offer-review-trust.use-case';
import { ChangeOfferReviewFullReviewUseCase } from '../application/use-cases/change-offer-review-full-review.use-case';
import { ChangeOfferReviewStopUseCase } from '../application/use-cases/change-offer-review-stop.use-case';
import { ChangeOfferReviewTrustUseCase } from '../application/use-cases/change-offer-review-trust.use-case';
import { ViewOfferReviewFlagsUseCase } from '../application/use-cases/view-offer-review-flags.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class OfferReviewFlagRequest {
  @ApiProperty({ description: 'The new value of the flag.' })
  on!: boolean;

  @ApiProperty({
    description:
      'Why (1 to 500 characters after trimming), always required. Kept in the change log for ' +
      'admins; never sent to the seller, never logged.',
    minLength: 1,
    maxLength: 500,
  })
  reason!: string;

  @ApiProperty({
    description: 'The version the admin saw (GET .../offer-review); another one is 409.',
    minimum: 1,
  })
  expectedVersion!: number;
}

export class OfferReviewFlagChangedBody {
  @ApiProperty()
  on!: boolean;

  @ApiProperty({ description: 'False when the flag already held the value (nothing written).' })
  changed!: boolean;

  @ApiProperty({ description: 'The version to send with the next change.' })
  version!: number;
}

export class OfferReviewFlagViewBody {
  @ApiProperty()
  on!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When an admin last changed the flag (UTC); null when it never changed.',
  })
  changedAt!: string | null;
}

export class OfferReviewFlagsViewBody {
  @ApiProperty({
    type: OfferReviewFlagViewBody,
    description: 'Trusted from start: the seller skips probation.',
  })
  trustedFromStart!: OfferReviewFlagViewBody;

  @ApiProperty({
    type: OfferReviewFlagViewBody,
    description: 'Full review (R6): every first publication of the seller waits for an admin.',
  })
  fullReview!: OfferReviewFlagViewBody;

  @ApiProperty({
    type: OfferReviewFlagViewBody,
    description:
      'Offer review stop (R0 for the seller): first publications and watched edits wait for an ' +
      'admin in every mode.',
  })
  reviewStop!: OfferReviewFlagViewBody;

  @ApiProperty({ description: 'The expectedVersion of the next change.' })
  version!: number;
}

const STEP_UP_FORBIDDEN =
  'request.csrf, access.denied (also an acting-as session), second-factor.required or ' +
  'second-factor.enrolment-required (details.actionKey)';

/**
 * A seller's Offer review flags (SEL-25; risk-based Offer approval slice 4, ADR-0051 decision 4),
 * for an admin: the read needs `sellers.seller.view`; each switch its own key. Trusted from start
 * and the stop are protected and need a fresh two-step code of the admin (checked here, spent in
 * the change's unit). A thin adapter: the `CallContext` comes from `@Call()` and the admin session
 * cookie; an unsafe request also needs the CSRF header. Who may do it is the use case's gate. The
 * body is JSON only and closed; the answers are `Cache-Control: no-store`. The reason is never
 * logged.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class SellerOfferReviewFlagsController {
  readonly #logger = new Logger('SellerOfferReviewFlagsController');

  constructor(
    private readonly view: ViewOfferReviewFlagsUseCase,
    private readonly trust: ChangeOfferReviewTrustUseCase,
    private readonly fullReview: ChangeOfferReviewFullReviewUseCase,
    private readonly stop: ChangeOfferReviewStopUseCase,
  ) {}

  @Get(':sellerId/offer-review')
  @ApiOperation({
    summary: "Read a seller's Offer review flags (admin)",
    description: 'All off by default. Needs sellers.seller.view.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: OfferReviewFlagsViewBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  async getFlags(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OfferReviewFlagsViewBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.#log('sellers.offer-review-flags-read', context, result.ok ? 'ok' : result.error.code);
    if (!result.ok) throw errorOf(result.error, response);
    const flag = (value: { on: boolean; changedAt: { toString(): string } | null }) => ({
      on: value.on,
      changedAt: value.changedAt === null ? null : value.changedAt.toString(),
    });
    return {
      trustedFromStart: flag(result.value.trustedFromStart),
      fullReview: flag(result.value.fullReview),
      reviewStop: flag(result.value.reviewStop),
      version: result.value.version,
    };
  }

  @Put(':sellerId/offer-review/trusted')
  @HttpCode(200)
  @RequiresStepUp('sellers.offer-review-trust.change')
  @ApiOperation({
    summary: "Switch a seller's Trusted-from-start flag (admin)",
    description:
      'Needs the protected sellers.offer-review-trust.manage and a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for sellers.offer-review-trust.change; ' +
      'without it 403 second-factor.required with details.actionKey); refused in an acting-as ' +
      'session. On: the seller skips probation. Off: back to probation with its current count. ' +
      'A stale expectedVersion is 409 conflict.stale.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: OfferReviewFlagRequest })
  @ApiOkResponse({ type: OfferReviewFlagChangedBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: STEP_UP_FORBIDDEN })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  putTrusted(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OfferReviewFlagChangedBody> {
    return this.#change(this.trust, 'sellers.offer-review-trust-set', context, request, response, {
      sellerId,
      body,
    });
  }

  @Put(':sellerId/offer-review/full-review')
  @HttpCode(200)
  @ApiOperation({
    summary: "Switch a seller's full-review flag (admin)",
    description:
      'Needs sellers.offer-review-full.manage; refused in an acting-as session. On: every first ' +
      'publication of the seller waits for an admin (watched edits are not held by it). A ' +
      'stale expectedVersion is 409 conflict.stale.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: OfferReviewFlagRequest })
  @ApiOkResponse({ type: OfferReviewFlagChangedBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  putFullReview(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OfferReviewFlagChangedBody> {
    return this.#change(
      this.fullReview,
      'sellers.offer-review-full-review-set',
      context,
      request,
      response,
      { sellerId, body },
    );
  }

  @Put(':sellerId/offer-review/stop')
  @HttpCode(200)
  @RequiresStepUp('sellers.offer-review-stop.change')
  @ApiOperation({
    summary: "Switch a seller's Offer review stop (admin)",
    description:
      'Needs the protected sellers.offer-review-stop.manage and a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for sellers.offer-review-stop.change; ' +
      'without it 403 second-factor.required with details.actionKey); refused in an acting-as ' +
      "session. On: the seller's first publications and watched edits wait for an admin in " +
      'every mode; live Offers stay live. A stale expectedVersion is 409 conflict.stale.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: OfferReviewFlagRequest })
  @ApiOkResponse({ type: OfferReviewFlagChangedBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: STEP_UP_FORBIDDEN })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  putStop(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OfferReviewFlagChangedBody> {
    return this.#change(this.stop, 'sellers.offer-review-stop-set', context, request, response, {
      sellerId,
      body,
    });
  }

  async #change(
    useCase: {
      execute(
        context: CallContext,
        input: ChangeOfferReviewFlagInput,
      ): Promise<Result<ChangeOfferReviewFlagResult, ChangeOfferReviewFlagFailure | AccessDenied>>;
    },
    msg: string,
    context: CallContext,
    request: Request,
    response: Response,
    input: ChangeOfferReviewFlagInput,
  ): Promise<OfferReviewFlagChangedBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await useCase.execute(context, input);
    this.#log(msg, context, result.ok ? 'ok' : result.error.code);
    if (!result.ok) {
      const error = result.error;
      if (
        error.code === 'second-factor.required' ||
        error.code === 'second-factor.enrolment-required'
      ) {
        throw fail(403, error.code, { actionKey: error.actionKey });
      }
      throw errorOf(error as Exclude<typeof error, { readonly actionKey: string }>, response);
    }
    return { ...result.value };
  }

  #log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
