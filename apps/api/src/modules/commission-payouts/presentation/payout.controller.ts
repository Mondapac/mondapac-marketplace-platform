import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ApprovePayout } from '../application/use-cases/approve-payout.use-case';
import { ListOwnPayoutHolds } from '../application/use-cases/list-own-payout-holds.use-case';
import { ListOwnPayouts } from '../application/use-cases/list-own-payouts.use-case';
import { ListPayouts } from '../application/use-cases/list-payouts.use-case';
import { ViewNextPayout } from '../application/use-cases/view-next-payout.use-case';
import { ViewPayout } from '../application/use-cases/view-payout.use-case';
import { PAYOUT_STATES } from '../domain/payout';
import { closedBody, parseLimit, refusal } from './http-answers';
import {
  approvedPayoutBody,
  ApprovedPayoutBody,
  ApprovePayoutRequest,
  nextPayoutBody,
  NextPayoutBody,
  ownPayoutHoldsBody,
  OwnPayoutHoldsBody,
  ownPayoutsBody,
  OwnPayoutsBody,
  payoutDetailBody,
  PayoutDetailBody,
  payoutListBody,
  PayoutListBody,
} from './payout.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const CURSOR = {
  name: 'cursor',
  required: false,
  description: 'The `nextCursor` of the last page.',
};
const LIMIT = { name: 'limit', required: false, description: '1 to 100; default 50.' };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The seller payouts (package 6d; G2 4.7), for admins: the list, one payout with what an approver
 * needs, and the approval of a payout that waits. Approving marks the payout and binds the amount;
 * no route moves money, the worker does. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('admin')
@ReadsSession()
@Controller('commission-payouts/admin/payouts')
export class AdminPayoutsController {
  readonly #logger = new Logger('AdminPayoutsController');

  constructor(
    private readonly list: ListPayouts,
    private readonly view: ViewPayout,
    private readonly approve: ApprovePayout,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The seller payouts (admin)',
    description:
      'Needs commission-payouts.payout.view. Newest first; `status` limits the list to one state.',
  })
  @ApiQuery({ name: 'status', required: false, enum: PAYOUT_STATES })
  @ApiQuery(CURSOR)
  @ApiQuery(LIMIT)
  @ApiOkResponse({ type: PayoutListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async payouts(
    @Call() context: CallContext,
    @Query('status') status: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      status,
      cursor,
      limit: parseLimit(limit),
    });
    logRoute(
      this.#logger,
      'commission-payouts.list-payouts-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutListBody(result.value);
  }

  @Get(':payoutId')
  @ApiOperation({
    summary: 'One seller payout (admin)',
    description:
      'Needs commission-payouts.payout.view. The seller orders taken, the seller account readiness ' +
      "from the seller's last payout evaluation, the instant of the last bank change (null until " +
      "payments provides it), the per-transfer limit and today's total against the daily alert level.",
  })
  @ApiParam({ name: 'payoutId', format: 'uuid' })
  @ApiOkResponse({ type: PayoutDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.payout-not-found' })
  async payout(
    @Call() context: CallContext,
    @Param('payoutId') payoutId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { payoutId });
    logRoute(
      this.#logger,
      'commission-payouts.view-payout-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutDetailBody(result.value);
  }

  @Post(':payoutId/approve')
  @HttpCode(200)
  @RequiresStepUp('commission-payouts.payout.approve')
  @ApiOperation({
    summary: 'Approve a payout (admin)',
    description:
      'Needs commission-payouts.payout.approve (protected) and a fresh two-step proof for ' +
      'commission-payouts.payout.approve (403 second-factor.required without one; refused in a ' +
      'Login-as-Seller session; the proof is spent by the approval). The body echoes the transfer ' +
      'amount the admin saw: a different amount is 409 commission-payouts.payout.amount-changed ' +
      'and nothing changes. Only a payout that waits for approval can be approved. The transfer ' +
      'is sent by the worker, not by this request. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'payoutId', format: 'uuid' })
  @ApiBody({ type: ApprovePayoutRequest })
  @ApiOkResponse({ type: ApprovedPayoutBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required or second-factor.enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.payout-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'commission-payouts.payout.amount-changed or commission-payouts.payout.not-awaiting-approval',
  })
  async approval(
    @Call() context: CallContext,
    @Param('payoutId') payoutId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['amountMinor']);
    if (invalid !== null) throw invalid;
    const { amountMinor } = requestBody as Record<string, unknown>;
    const result = await this.approve.execute(context, { payoutId, amountMinor });
    logRoute(
      this.#logger,
      'commission-payouts.approve-payout-route',
      context,
      result.ok ? 'approved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return approvedPayoutBody(result.value);
  }
}

/**
 * The signed-in seller's payouts (package 6d; design 5.4): the estimated next payout with the
 * reason when it is not on its way, the history, and the money on hold. Own resources only; no
 * admin note, hold id, transfer id or internal code. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('seller')
@ReadsSession()
@Controller('commission-payouts/seller')
export class SellerPayoutsController {
  readonly #logger = new Logger('SellerPayoutsController');

  constructor(
    private readonly next: ViewNextPayout,
    private readonly history: ListOwnPayouts,
    private readonly holds: ListOwnPayoutHolds,
  ) {}

  @Get('payouts/next')
  @ApiOperation({
    summary: "The seller's estimated next payout",
    description:
      'When the next payout is looked at (in the seller zone), an estimate of the amount, and the ' +
      'reason when it is not on its way: below-minimum, awaiting-approval, account-not-ready, ' +
      'cooling-off, payouts-paused, zone-missing or second-factor-required.',
  })
  @ApiOkResponse({ type: NextPayoutBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.unavailable or commission-payouts.terms-unavailable',
  })
  async nextPayout(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.next.execute(context, undefined);
    logRoute(
      this.#logger,
      'commission-payouts.view-next-payout-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return nextPayoutBody(result.value);
  }

  @Get('payouts')
  @ApiOperation({
    summary: "The seller's payouts",
    description: 'Newest first. A payout that was voided never happened and is not listed.',
  })
  @ApiQuery(CURSOR)
  @ApiQuery(LIMIT)
  @ApiOkResponse({ type: OwnPayoutsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async payouts(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.history.execute(context, { cursor, limit: parseLimit(limit) });
    logRoute(
      this.#logger,
      'commission-payouts.list-own-payouts-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownPayoutsBody(result.value);
  }

  @Get('payout-holds')
  @ApiOperation({
    summary: "The seller's money on hold",
    description:
      'Per seller order: the reason (on-hold, refund-pending, holding-period or awaiting-delivery) ' +
      'and the date it is available from when known. A hold is never described further.',
  })
  @ApiOkResponse({ type: OwnPayoutHoldsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async payoutHolds(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.holds.execute(context, undefined);
    logRoute(
      this.#logger,
      'commission-payouts.list-own-payout-holds-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownPayoutHoldsBody(result.value);
  }
}
