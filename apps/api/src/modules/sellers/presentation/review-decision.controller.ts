import { Body, Controller, HttpCode, Logger, Param, Post, Put, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
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
import { ReviewRecordManualCheck } from '../application/use-cases/review-record-manual-check.use-case';
import { ReviewApprove } from '../application/use-cases/review-approve.use-case';
import { ReviewReject } from '../application/use-cases/review-reject.use-case';
import { errorOf, fail } from './my-file.answer';
import type { FieldProblem } from './my-file.body';
import { SellersErrorBody } from './my-file.dto';
import { parseApproveBody, parseManualCheckBody, parseRejectBody } from './review-decision.body';
import {
  ApproveRequest,
  ManualCheckRecordedBody,
  ManualCheckRequest,
  RejectRequest,
  ReviewDecidedBody,
} from './review-decision.dto';

const CONFLICTS =
  'file.decision-in-progress (another decision is in flight), review.not-current-revision ' +
  '(revisionId is not the pending onboarding revision: read the review again), ' +
  'seller-access.wrong-state, conflict.stale';

/**
 * The reviewer's decision on a seller application (sellers design 3.1, 6.2, 7.3; slice
 * 7a-decide). Thin adapters: the `CallContext` comes from `@Call()` and the admin session cookie
 * of the request's Market (`@RoutePopulation('admin')` with `@ReadsSession()`); an unsafe request
 * also needs `Origin` on the Market's admin list, `Sec-Fetch-Site: same-origin` and the CSRF
 * header. Who may decide is the use case's gate (`identity.seller-access.approve`, checked again
 * by `identity`). The seller id of the path is read with the request's Market, so a seller of
 * another Market is `file.not-found`. Bodies are JSON only and closed. The reason of a rejection
 * is never logged; a log line holds the outcome code, the seller and revision ids, the Market and
 * the correlation id only.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class ReviewDecisionController {
  readonly #logger = new Logger('ReviewDecisionController');

  constructor(
    private readonly approve: ReviewApprove,
    private readonly reject: ReviewReject,
    private readonly manualCheck: ReviewRecordManualCheck,
  ) {}

  @Post(':sellerId/review/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a seller application (reviewer)',
    description:
      'Approves pending revision N. Refused while the register blocks it (a definite negative, ' +
      'or no current active result and no manual check recorded) and when another seller of the ' +
      'Market holds the business number. Needs identity.seller-access.approve.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ApproveRequest })
  @ApiOkResponse({ type: ReviewDecidedBody, description: 'decision: approved' })
  @ApiAcceptedResponse({ type: ReviewDecidedBody, description: 'decision: in-progress' })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description:
      `${CONFLICTS}, review.register-negative, review.manual-register-check-required, ` +
      'review.identifier-claimed, seller-access.owner-unverified',
  })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async postApprove(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ReviewDecidedBody> {
    response.setHeader('Cache-Control', 'no-store');
    const input = this.shapeOf('sellers.review-approve', context, request, body, parseApproveBody);
    const result = await this.approve.execute(context, { sellerId, ...input });
    this.log(
      'sellers.review-approve',
      context,
      result.ok ? result.value.decision : result.error.code,
    );
    if (!result.ok) throw errorOf(result.error, response);
    if (result.value.decision === 'in-progress') response.status(202);
    return result.value;
  }

  @Post(':sellerId/review/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject a seller application (reviewer)',
    description:
      'Rejects pending revision N with a reason the Seller Owner receives by mail. Needs ' +
      'identity.seller-access.approve.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: RejectRequest })
  @ApiOkResponse({ type: ReviewDecidedBody, description: 'decision: rejected' })
  @ApiAcceptedResponse({ type: ReviewDecidedBody, description: 'decision: in-progress' })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed or seller-access.reason-required',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: CONFLICTS })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async postReject(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ReviewDecidedBody> {
    response.setHeader('Cache-Control', 'no-store');
    const input = this.shapeOf('sellers.review-reject', context, request, body, parseRejectBody);
    const result = await this.reject.execute(context, { sellerId, ...input });
    this.log(
      'sellers.review-reject',
      context,
      result.ok ? result.value.decision : result.error.code,
    );
    if (!result.ok) throw errorOf(result.error, response);
    if (result.value.decision === 'in-progress') response.status(202);
    return result.value;
  }

  @Put(':sellerId/review/manual-register-check')
  @ApiOperation({
    summary: 'Record a manual register check (reviewer)',
    description:
      'Records what the reviewer read in the official register by hand for pending revision N ' +
      '(active, not-found or cancelled); recording again replaces it. Needs ' +
      'sellers.seller-file.review.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ManualCheckRequest })
  @ApiOkResponse({ type: ManualCheckRecordedBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description: 'file.decision-in-progress, review.not-current-revision, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async putManualCheck(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ManualCheckRecordedBody> {
    response.setHeader('Cache-Control', 'no-store');
    const msg = 'sellers.review-record-manual-check';
    const input = this.shapeOf(msg, context, request, body, parseManualCheckBody);
    const result = await this.manualCheck.execute(context, { sellerId, ...input });
    this.log(msg, context, result.ok ? 'recorded' : result.error.code);
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }

  /** JSON only, closed shape; a refusal is logged by code and answered before the gate. */
  private shapeOf<T>(
    msg: string,
    context: CallContext,
    request: Request,
    body: unknown,
    parse: (body: unknown) => T | readonly FieldProblem[],
  ): T {
    if (request.is('application/json') !== 'application/json') {
      this.log(msg, context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const parsed = parse(body);
    if (Array.isArray(parsed)) {
      this.log(msg, context, 'validation.failed');
      throw fail(400, 'validation.failed', { fields: parsed });
    }
    return parsed as T;
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
