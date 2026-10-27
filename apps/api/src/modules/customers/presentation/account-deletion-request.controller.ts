import { Body, Controller, Delete, Get, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
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
import { CancelAccountDeletion } from '../application/use-cases/cancel-account-deletion.use-case';
import {
  RequestAccountDeletion,
  type AccountDeletionRequestView,
} from '../application/use-cases/request-account-deletion.use-case';
import { ViewAccountDeletionRequest } from '../application/use-cases/view-account-deletion-request.use-case';
import { AccountDeletionRequestBody, RequestAccountDeletionRequest } from './account-deletion.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

const body = (view: AccountDeletionRequestView) => ({
  status: view.status,
  requestedAt: view.requestedAt.toString(),
  scheduledFor: view.scheduledFor.toString(),
  waitingPeriodDays: view.waitingPeriodDays,
});

/**
 * The signed-in buyer's own account deletion request (customers package 5b). Thin adapters: the
 * buyer comes from the session, never from the request, and each use case does its work behind its
 * gate. Every answer is `Cache-Control: no-store`. There is no customer OTP in the platform, so no
 * step-up is asked (notes.md).
 */
@ApiTags('customers')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/deletion-requests')
export class AccountDeletionRequestController {
  readonly #logger = new Logger('AccountDeletionRequestController');

  constructor(
    private readonly request: RequestAccountDeletion,
    private readonly view: ViewAccountDeletionRequest,
    private readonly cancel: CancelAccountDeletion,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Ask to delete the account',
    description:
      'Customer sessions only. Answers 403 customers.account-deletion-disabled while the Market ' +
      'has deletion off, and 409 customers.account-deletion-blocked with details.blockers ' +
      '(open-orders and pending-refunds with a count, wallet-balance) until each is settled. ' +
      'The request is carried out waitingPeriodDays later; every other session of the account ' +
      'ends now. One pending request per account (409 ' +
      'customers.account-deletion-already-requested).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RequestAccountDeletionRequest })
  @ApiCreatedResponse({ type: AccountDeletionRequestBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf or customers.account-deletion-disabled',
  })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'customers.account-deletion-blocked (details.blockers), ' +
      'customers.account-deletion-already-requested or customers.conflict',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(httpRequest, requestBody, ['confirm']);
    if (invalid !== null) throw invalid;
    const result = await this.request.execute(context, {
      confirm: (requestBody as { confirm?: unknown }).confirm,
    });
    this.log('customers.request-account-deletion-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
  }

  @Get('current')
  @ApiOperation({
    summary: 'The open deletion request',
    description:
      'Customer sessions only. status is pending (can be cancelled) or executing (the job has ' +
      'taken it). 404 when the account has no open request.',
  })
  @ApiOkResponse({ type: AccountDeletionRequestBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.account-deletion-request-not-found' })
  async current(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log('customers.view-account-deletion-request-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
  }

  @Delete('current')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cancel the pending deletion request',
    description:
      'Customer sessions only, during the wait. 404 when there is no pending request (also ' +
      'when it was just carried out or cancelled). 409 customers.account-deletion-in-progress ' +
      'once the job has claimed the request: it can no longer be cancelled. 204 always means ' +
      'the account will not be erased.',
  })
  @ApiHeader(CSRF)
  @ApiNoContentResponse({ description: 'The request is cancelled.' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.account-deletion-request-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'customers.account-deletion-in-progress or customers.conflict (ask again)',
  })
  async cancelCurrent(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.cancel.execute(context, { reason: 'customer' });
    this.log('customers.cancel-account-deletion-route', context, result);
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
