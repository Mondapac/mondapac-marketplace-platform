import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
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
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminCancelAccountDeletion } from '../application/use-cases/admin-cancel-account-deletion.use-case';
import {
  AdminListAccountDeletions,
  type PendingDeletionRequestPage,
} from '../application/use-cases/admin-list-account-deletions.use-case';
import {
  AdminRequestAccountDeletion,
  type AdminDeletionRequestMade,
} from '../application/use-cases/admin-request-account-deletion.use-case';
import { BUYER_ACCOUNT_DELETE_STEP_UP } from '../contracts/step-up';
import {
  AdminAccountDeletionRequestMadeBody,
  AdminCancelAccountDeletionRequest,
  AdminRequestAccountDeletionRequest,
  PendingAccountDeletionRequestPageBody,
} from './account-deletion.dto';
import { closedBody, parseLimit, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const STEP_UP_REFUSALS =
  `second-factor.required (details.actionKey: ${BUYER_ACCOUNT_DELETE_STEP_UP}) or ` +
  'second-factor.enrolment-required';

const madeBody = (made: AdminDeletionRequestMade) => ({
  requestId: made.requestId,
  status: made.status,
  requestedAt: made.requestedAt.toString(),
  scheduledFor: made.scheduledFor.toString(),
  waitingPeriodDays: made.waitingPeriodDays,
});

const pageBody = (page: PendingDeletionRequestPage) => ({
  entries: page.entries.map((entry) => ({
    requestId: entry.requestId,
    accountId: entry.accountId,
    requestedAt: entry.requestedAt.toString(),
    scheduledFor: entry.scheduledFor.toString(),
    status: entry.status,
    requestedBy: entry.requestedBy,
  })),
  nextCursor: page.nextCursor,
});

/**
 * An admin deletes a buyer's account for them and sees the pending requests (customers package
 * 5c). Thin adapters: the admin comes from the session, the buyer from the path; each use case
 * checks its permission, the admin step-up proof and the buyer's Market. Every answer is
 * `Cache-Control: no-store`; the bodies (ticket reference, reason) are never logged.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin')
export class AdminAccountDeletionRequestsController {
  readonly #logger = new Logger('AdminAccountDeletionRequestsController');

  constructor(
    private readonly request: AdminRequestAccountDeletion,
    private readonly cancel: AdminCancelAccountDeletion,
    private readonly list: AdminListAccountDeletions,
  ) {}

  @Post('buyers/:accountId/deletion-requests')
  @RequiresStepUp('customers.buyer-account.delete')
  @ApiOperation({
    summary: "Delete a buyer's account for them (admin)",
    description:
      'Needs customers.buyer-account.delete (protected) and a fresh two-step proof of this admin ' +
      `session for \`${BUYER_ACCOUNT_DELETE_STEP_UP}\` (POST /identity/admin/step-up/verify, valid ` +
      '5 minutes, spent by the request). Works whether or not the Market lets buyers delete ' +
      'themselves. Same blockers as the buyer (409 customers.account-deletion-blocked with ' +
      "details.blockers) and the setting's waiting period; the buyer's sessions end now. The " +
      "account must be an active customer account of the admin's Market (404 " +
      'customers.buyer-account-not-found). One open request per account (409). Refused in an ' +
      'acting-as session.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'accountId', description: "The buyer's account id." })
  @ApiBody({ type: AdminRequestAccountDeletionRequest })
  @ApiCreatedResponse({ type: AdminAccountDeletionRequestMadeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: `access.denied, request.csrf, ${STEP_UP_REFUSALS}`,
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.buyer-account-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'customers.account-deletion-blocked (details.blockers), ' +
      'customers.account-deletion-already-requested or customers.conflict',
  })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'customers.unavailable or access.unavailable',
  })
  async create(
    @Call() context: CallContext,
    @Param('accountId') accountId: string,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(httpRequest, requestBody, ['ticketRef', 'reason', 'confirm']);
    if (invalid !== null) throw invalid;
    const { ticketRef, reason, confirm } = requestBody as {
      ticketRef?: unknown;
      reason?: unknown;
      confirm?: unknown;
    };
    const result = await this.request.execute(context, { accountId, ticketRef, reason, confirm });
    this.log('customers.admin-request-account-deletion-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    response.status(201);
    return madeBody(result.value);
  }

  @Get('deletion-requests')
  @ApiOperation({
    summary: 'Pending buyer deletion requests of the Market (admin)',
    description:
      'Needs customers.account-deletion-requests.view. Earliest scheduled date first. Ids, dates ' +
      'and who asked (customer or admin): no name, email or ticket text. status: pending (the ' +
      'default and the only value).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending'] })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 20.' })
  @ApiOkResponse({ type: PendingAccountDeletionRequestPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async pending(
    @Call() context: CallContext,
    @Query('status') status: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { status, cursor, limit: parseLimit(limit) });
    this.log('customers.admin-list-account-deletions-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return pageBody(result.value);
  }

  @Delete('deletion-requests/:requestId')
  @HttpCode(204)
  @RequiresStepUp('customers.buyer-account.delete')
  @ApiOperation({
    summary: 'Cancel a pending deletion request (admin)',
    description:
      'Needs customers.buyer-account.delete (protected), a reason (1 to 500 characters) and a ' +
      `fresh two-step proof for \`${BUYER_ACCOUNT_DELETE_STEP_UP}\`. Cancels a request during ` +
      'the wait, whoever made it. 404 when there is no pending request (also one already ' +
      'closed). 409 customers.account-deletion-in-progress once the job has claimed it; 204 ' +
      'always means the account will not be erased. Refused in an acting-as session.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'requestId', description: 'The deletion request id.' })
  @ApiBody({ type: AdminCancelAccountDeletionRequest })
  @ApiNoContentResponse({ description: 'The request is cancelled.' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: `access.denied, request.csrf, ${STEP_UP_REFUSALS}`,
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.account-deletion-request-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'customers.account-deletion-in-progress or customers.conflict (ask again)',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async cancelRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(httpRequest, requestBody, ['reason']);
    if (invalid !== null) throw invalid;
    const result = await this.cancel.execute(context, {
      requestId,
      reason: (requestBody as { reason?: unknown }).reason,
    });
    this.log('customers.admin-cancel-account-deletion-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
  }

  private log(
    msg: string,
    context: CallContext,
    result:
      { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } },
  ): void {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
