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
import { parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ApproveAdminCredit } from '../application/use-cases/approve-admin-credit.use-case';
import { IssueAdminCredit } from '../application/use-cases/issue-admin-credit.use-case';
import { ListAdminCreditRequests } from '../application/use-cases/list-admin-credit-requests.use-case';
import { RejectAdminCredit } from '../application/use-cases/reject-admin-credit.use-case';
import { ViewCustomerWallet } from '../application/use-cases/view-customer-wallet.use-case';
import {
  AdminCreditBody,
  adminCreditBody,
  CreditListBody,
  creditListBody,
  CustomerWalletBody,
  customerWalletBody,
  IssueCreditRequest,
  RejectCreditRequest,
} from './admin-credit.dto';
import { closedBody, parseLimit, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const REQUEST_PARAM = { name: 'requestId', format: 'uuid', description: 'The credit request.' };
const STEP_UP_REFUSALS = (action: string) =>
  `access.denied, request.csrf, second-factor.required (details.actionKey: ${action}) or ` +
  'second-factor.enrolment-required';

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * Admin credit issuance with maker-checker (customer wallet package 2a). Thin adapters: the
 * acting admin comes from the session; amounts are minor-unit strings in the Market currency.
 * Every answer is `Cache-Control: no-store`. The note an admin writes is returned only here.
 */
@ApiTags('wallet')
@RoutePopulation('admin')
@ReadsSession()
@Controller('wallet/admin')
export class AdminWalletCreditController {
  readonly #logger = new Logger('AdminWalletCreditController');

  constructor(
    private readonly issue: IssueAdminCredit,
    private readonly approve: ApproveAdminCredit,
    private readonly reject: RejectAdminCredit,
    private readonly list: ListAdminCreditRequests,
    private readonly customer: ViewCustomerWallet,
  ) {}

  @Post('credits')
  @HttpCode(201)
  @RequiresStepUp('wallet.credit.issue')
  @ApiOperation({
    summary: 'Issue promo store credit to a customer (admin)',
    description:
      "Needs wallet.credit.issue (protected) and a fresh two-step proof for `wallet.credit.issue`. Within the Market's " +
      'per-issue and per-admin daily caps the credit is granted at once (status granted); above ' +
      'either one it becomes a pending request (status pending) that a second, different admin ' +
      'approves or rejects, and that expires if nobody does. The wallet must be active. The same ' +
      'idempotencyKey with the same request answers the first result again; with another request ' +
      'idempotency.key-reused. Refused in an acting-as session. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssueCreditRequest })
  @ApiCreatedResponse({ type: AdminCreditBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_REFUSALS('wallet.credit.issue') })
  @ApiNotFoundResponse({ ...ERROR, description: 'wallet.disabled' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'wallet.paused, wallet.frozen, wallet.cap-exceeded, wallet.account-not-active or ' +
      'idempotency.key-reused',
  })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'wallet.unavailable or access.unavailable',
  })
  async issueCredit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'customerAccountId',
      'amount',
      'currency',
      'reasonCode',
      'note',
      'idempotencyKey',
    ]);
    if (invalid !== null) throw invalid;
    const body = requestBody as Record<string, unknown>;
    const minor = parseMinorUnits(body.amount);
    const result = await this.issue.execute(context, {
      customerAccountId: body.customerAccountId,
      amount:
        minor.ok && typeof body.currency === 'string'
          ? { amount: minor.value, currency: body.currency }
          : undefined,
      reasonCode: body.reasonCode,
      note: body.note,
      idempotencyKey: body.idempotencyKey,
    });
    logRoute(
      this.#logger,
      'wallet.issue-admin-credit-route',
      context,
      result.ok ? result.value.status : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return adminCreditBody(result.value);
  }

  @Get('credit-requests')
  @ApiOperation({
    summary: 'Admin credit requests of the Market, newest first (admin)',
    description: 'Needs wallet.credit.view. status: pending (default), decided or granted.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'decided', 'granted'] })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 20.' })
  @ApiOkResponse({ type: CreditListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async requests(
    @Call() context: CallContext,
    @Query('status') status: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { status, cursor, limit: parseLimit(limit) });
    logRoute(
      this.#logger,
      'wallet.list-admin-credit-requests-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return creditListBody(result.value);
  }

  @Post('credit-requests/:requestId/approve')
  @HttpCode(200)
  @RequiresStepUp('wallet.credit.approve')
  @ApiOperation({
    summary: "Approve another admin's pending credit request (admin, maker-checker)",
    description:
      'Needs wallet.credit.approve (protected) and a fresh two-step proof for ' +
      '`wallet.credit.approve`. The admin who asked cannot approve. The credit is granted now: ' +
      'the wallet must be active, the customer wallet active and the balance cap not passed. ' +
      'No body is read. Refused in an acting-as session. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiOkResponse({ type: AdminCreditBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: `${STEP_UP_REFUSALS('wallet.credit.approve')} or wallet.approver-is-requester`,
  })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'wallet.credit-request-not-found or wallet.disabled',
  })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'wallet.credit-request-decided, wallet.credit-request-expired, wallet.paused, ' +
      'wallet.frozen, wallet.cap-exceeded or wallet.account-not-active',
  })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'wallet.unavailable or access.unavailable',
  })
  async approveRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.approve.execute(context, { requestId });
    logRoute(
      this.#logger,
      'wallet.approve-admin-credit-route',
      context,
      result.ok ? 'approved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return adminCreditBody(result.value);
  }

  @Post('credit-requests/:requestId/reject')
  @HttpCode(200)
  @RequiresStepUp('wallet.credit.approve')
  @ApiOperation({
    summary: "Reject another admin's pending credit request (admin, maker-checker)",
    description:
      'Needs wallet.credit.approve (protected) and a fresh two-step proof for ' +
      '`wallet.credit.approve`. The admin who asked cannot reject. No money moves. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiBody({ type: RejectCreditRequest })
  @ApiOkResponse({ type: AdminCreditBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: `${STEP_UP_REFUSALS('wallet.credit.approve')} or wallet.approver-is-requester`,
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'wallet.credit-request-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'wallet.credit-request-decided or wallet.credit-request-expired',
  })
  async rejectRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['reasonCode']);
    if (invalid !== null) throw invalid;
    const { reasonCode } = requestBody as { reasonCode?: unknown };
    const result = await this.reject.execute(context, { requestId, reasonCode });
    logRoute(
      this.#logger,
      'wallet.reject-admin-credit-route',
      context,
      result.ok ? 'rejected' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return adminCreditBody(result.value);
  }

  @Get('customers/:customerAccountId')
  @ApiOperation({
    summary: "A customer's wallet and the caller's caps, for the issuing screen (admin)",
    description:
      'Needs wallet.credit.view. A customer never granted credit has a zero balance and ' +
      'accountStatus none. usedToday is what the calling admin counted today toward the daily cap.',
  })
  @ApiParam({ name: 'customerAccountId', format: 'uuid' })
  @ApiOkResponse({ type: CustomerWalletBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'wallet.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'wallet.unavailable' })
  async customerWallet(
    @Call() context: CallContext,
    @Param('customerAccountId') customerAccountId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.customer.execute(context, { customerAccountId });
    logRoute(
      this.#logger,
      'wallet.view-customer-wallet-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return customerWalletBody(result.value);
  }
}
