import { Body, Controller, Get, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
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
import { RequiresStepUp } from '../../../platform/authz';
import { DecideDispute } from '../application/use-cases/decide-dispute.use-case';
import { ListDisputes } from '../application/use-cases/list-disputes.use-case';
import { ListOwnDisputes } from '../application/use-cases/list-own-disputes.use-case';
import { ViewDispute } from '../application/use-cases/view-dispute.use-case';
import { DISPUTE_BUCKETS } from '../domain/dispute';
import {
  disputeDecisionBody,
  DisputeDecisionBody,
  DisputeDecisionRequest,
  disputeDetailBody,
  DisputeDetailBody,
  disputeListBody,
  DisputeListBody,
  ownDisputesBody,
  OwnDisputesBody,
} from './dispute.dto';
import { closedBody, parseLimit, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The dispute cases (package 8b; G2 4.10), for admins: the list with its bucket counts, one case,
 * and the decision on who bears a lost chargeback. Evidence is sent in the Stripe Dashboard (D6):
 * the case carries the provider dispute id and the deadline. Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('admin')
@ReadsSession()
@Controller('commission-payouts/admin/disputes')
export class AdminDisputesController {
  readonly #logger = new Logger('AdminDisputesController');

  constructor(
    private readonly list: ListDisputes,
    private readonly view: ViewDispute,
    private readonly decide: DecideDispute,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The dispute cases (admin)',
    description:
      'Needs commission-payouts.dispute.view. Newest opened first, with the count of every bucket. ' +
      'Buckets: needs-response (open, Stripe wants evidence), under-review (open, with the bank), ' +
      'decision-needed (lost with a seller order undecided, or lost and reinstated while a seller still repays), ' +
      'won, closed (everything else closed). Without a filter every case is listed.',
  })
  @ApiQuery({ name: 'filter', required: false, enum: DISPUTE_BUCKETS })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 50.' })
  @ApiOkResponse({ type: DisputeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async cases(
    @Call() context: CallContext,
    @Query('filter') filter: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      filter,
      cursor,
      limit: parseLimit(limit),
    });
    logRoute(
      this.#logger,
      'commission-payouts.list-disputes-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return disputeListBody(result.value);
  }

  @Get(':disputeId')
  @ApiOperation({
    summary: 'One dispute case (admin)',
    description:
      'Needs commission-payouts.dispute.view. The case, the provider dispute id (for the Stripe Dashboard link), ' +
      'and per seller order: the seller share, the recoverable cap, whether the hold is active, the decision and ' +
      'whether a decision may be recorded now; then the timeline.',
  })
  @ApiParam({ name: 'disputeId', format: 'uuid' })
  @ApiOkResponse({ type: DisputeDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.dispute-not-found' })
  async one(
    @Call() context: CallContext,
    @Param('disputeId') disputeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { disputeId });
    logRoute(
      this.#logger,
      'commission-payouts.view-dispute-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return disputeDetailBody(result.value);
  }

  @Post(':disputeId/seller-orders/:sellerOrderId/decision')
  @RequiresStepUp('commission-payouts.dispute.attribute')
  @ApiOperation({
    summary: 'Decide who bears a lost chargeback (admin)',
    description:
      'Needs commission-payouts.dispute.attribute (protected) and a fresh two-step proof for ' +
      'commission-payouts.dispute.attribute (403 second-factor.required without one; refused in a ' +
      'Login-as-Seller session). Only for a lost chargeback. bearer platform: no money moves. ' +
      'bearer seller: amountMinor more than 0 and at most the seller order recoverableCap, in the ' +
      "case's currency (else commission-payouts.dispute.amount-out-of-range); one dispute-debit " +
      'ledger row. A second decision on a decided seller order is refused ' +
      'commission-payouts.dispute.already-decided, except platform after seller when the bank ' +
      'later returned the money (needsReview), which reverses the recovery. Audited with the reason code.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'disputeId', format: 'uuid' })
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiBody({ type: DisputeDecisionRequest })
  @ApiCreatedResponse({ type: DisputeDecisionBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed (details.fields) or commission-payouts.dispute.amount-out-of-range',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description:
      'commission-payouts.dispute-not-found or commission-payouts.seller-order-not-found',
  })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'commission-payouts.dispute.not-decidable or commission-payouts.dispute.already-decided',
  })
  async decision(
    @Call() context: CallContext,
    @Param('disputeId') disputeId: string,
    @Param('sellerOrderId') sellerOrderId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['bearer', 'amountMinor', 'reasonCode']);
    if (invalid !== null) throw invalid;
    const { bearer, amountMinor, reasonCode } = requestBody as Record<string, unknown>;
    const result = await this.decide.execute(context, {
      disputeId,
      sellerOrderId,
      bearer,
      amountMinor,
      reasonCode,
    });
    logRoute(
      this.#logger,
      'commission-payouts.decide-dispute-route',
      context,
      result.ok ? 'decided' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return disputeDecisionBody(result.value);
  }
}

/** The signed-in seller's own disputed seller orders (D8): no reason, no evidence, no provider id. */
@ApiTags('commission-payouts')
@RoutePopulation('seller')
@ReadsSession()
@Controller('commission-payouts/seller/disputes')
export class SellerDisputesController {
  readonly #logger = new Logger('SellerDisputesController');

  constructor(private readonly own: ListOwnDisputes) {}

  @Get()
  @ApiOperation({
    summary: "The seller's disputed seller orders",
    description:
      'The seller orders a payment dispute holds or held: since when, whether the hold is open, and ' +
      'what was recovered from the seller once decided. No reason, evidence date, provider id or buyer data.',
  })
  @ApiOkResponse({ type: OwnDisputesBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async mine(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.own.execute(context, undefined);
    logRoute(
      this.#logger,
      'commission-payouts.list-own-disputes-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownDisputesBody(result.value);
  }
}
