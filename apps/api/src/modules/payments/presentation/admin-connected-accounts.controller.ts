import { Controller, Get, HttpException, Logger, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
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
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminListConnectedAccounts } from '../application/use-cases/admin-list-connected-accounts.use-case';
import { AdminViewConnectedAccount } from '../application/use-cases/admin-view-connected-account.use-case';
import { ACCOUNT_STATUSES } from '../domain/connected-account';
import {
  ConnectedAccountDetailBody,
  ConnectedAccountPageBody,
  connectedAccountDetailBody,
  connectedAccountPageBody,
} from './payout-account.dto';

const ERROR = { type: Object };

/** The HTTP status of each refusal of the admin connected-account routes. */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'payments.connected-account.not-found': 404,
  ...ACCESS_DENIED_STATUS,
});

/**
 * The admin's read-only view of the Market's seller connected accounts: state, the bank-change
 * waiting period and the kind and time of each change. The controller authenticates only; each
 * use case's gate needs `payments.connected-account.view`. No Stripe id, bank detail or
 * requirement content is ever answered. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('payments')
@RoutePopulation('admin')
@ReadsSession()
@Controller('payments/admin/connected-accounts')
export class AdminConnectedAccountsController {
  readonly #logger = new Logger('AdminConnectedAccountsController');

  constructor(
    private readonly list: AdminListConnectedAccounts,
    private readonly view: AdminViewConnectedAccount,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The Market's seller connected accounts, newest first (admin)",
    description: 'Needs payments.connected-account.view. 25 per page.',
  })
  @ApiQuery({ name: 'status', required: false, enum: [...ACCOUNT_STATUSES] })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page.',
  })
  @ApiOkResponse({ type: ConnectedAccountPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async accounts(
    @Call() context: CallContext,
    @Query('status') status: unknown,
    @Query('cursor') cursor: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectedAccountPageBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { status, cursor });
    this.log('payments.admin-list-connected-accounts-route', context, result);
    if (!result.ok) throw this.refusal(result.error, context);
    return connectedAccountPageBody(result.value);
  }

  @Get(':sellerId')
  @ApiOperation({
    summary: "One seller's connected account (admin)",
    description: 'Needs payments.connected-account.view.',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: ConnectedAccountDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'payments.connected-account.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async account(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectedAccountDetailBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.log('payments.admin-view-connected-account-route', context, result);
    if (!result.ok) throw this.refusal(result.error, context);
    return connectedAccountDetailBody(result.value);
  }

  private log(
    msg: string,
    context: CallContext,
    result: { ok: true } | { ok: false; error: { code: string } },
  ): void {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  private refusal(
    error: { code: string; fields?: readonly unknown[] },
    context: CallContext,
  ): HttpException {
    const status = STATUS[error.code];
    if (status === undefined) {
      this.#logger.error({
        msg: 'payments.unmapped-refusal',
        code: error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return new HttpException({ statusCode: 500, code: 'internal' }, 500);
    }
    return new HttpException(
      {
        statusCode: status,
        code: error.code,
        ...(error.fields === undefined ? {} : { details: { fields: error.fields } }),
      },
      status,
    );
  }
}
