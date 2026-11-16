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
import type { Result } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../platform/list-export';
import { AdminExportConnectedAccounts } from '../application/use-cases/admin-export-connected-accounts.use-case';
import { AdminListConnectedAccounts } from '../application/use-cases/admin-list-connected-accounts.use-case';
import { AdminViewConnectedAccount } from '../application/use-cases/admin-view-connected-account.use-case';
import { ACCOUNT_STATUSES } from '../domain/connected-account';
import {
  ACCOUNT_EXPORT_COLUMNS,
  ACCOUNT_REQUIREMENT_FILTERS,
  ACCOUNT_SORT_KEYS,
  ACCOUNT_WAITING_FILTERS,
} from '../domain/connected-account-list';
import { writeChunks } from './write-chunks';
import {
  ConnectedAccountDetailBody,
  ConnectedAccountPageBody,
  connectedAccountDetailBody,
  connectedAccountPageBody,
} from './payout-account.dto';

const ERROR = { type: Object };

/** The paging numbers of a list query as numbers (the query string carries text). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (typeof value === 'string' && /^[0-9]{1,6}$/.test(value)) out[key] = Number(value);
  }
  return out;
}

/** The HTTP status of each refusal of the admin connected-account routes. */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'payments.connected-account.not-found': 404,
  'batch.too-large': 413,
  'payments.search-unavailable': 503,
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
    private readonly exporter: AdminExportConnectedAccounts,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The Market's seller connected accounts (admin Seller accounts list)",
    description:
      'Needs payments.connected-account.view. Page numbers with a total and the status counts ' +
      '(`paging=pages`, default) or Previous/Next (`paging=prev-next`); `cursor` answers the ' +
      'older card ("Show more", newest created first, 25 rows). No Stripe id, bank detail or ' +
      'requirement content.',
  })
  @ApiQuery({ name: 'status', required: false, enum: [...ACCOUNT_STATUSES] })
  @ApiQuery({ name: 'ready', required: false, enum: ['yes', 'no'] })
  @ApiQuery({ name: 'requirements', required: false, enum: [...ACCOUNT_REQUIREMENT_FILTERS] })
  @ApiQuery({ name: 'waiting', required: false, enum: [...ACCOUNT_WAITING_FILTERS] })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A seller id (exact) or part of a store name (2 to 80 characters).',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Created at or after (ISO instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Created before (ISO instant).' })
  @ApiQuery({ name: 'sort', required: false, enum: [...ACCOUNT_SORT_KEYS] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: '1 to 100, default 25.',
  })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page (the older card).',
  })
  @ApiOkResponse({ type: ConnectedAccountPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'access.unavailable, or payments.search-unavailable (the store search failed)',
  })
  async accounts(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectedAccountPageBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, numbersOf(query));
    this.log('payments.admin-list-connected-accounts-route', context, result);
    if (!result.ok) throw this.refusal(result.error, context);
    return connectedAccountPageBody(result.value);
  }

  @Get('export')
  @ApiOperation({
    summary: 'The Seller accounts list as a CSV or XLSX file (admin)',
    description:
      'Needs payments.connected-account.view. `ids` (seller ids, at most 200) writes those rows ' +
      "in that order; without it, the list's selector and sort, at most 10,000 rows (413 " +
      'batch.too-large with the total above that).',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({
    name: 'columns',
    required: false,
    description: `Extra columns, comma-separated: ${ACCOUNT_EXPORT_COLUMNS.join(', ')}.`,
  })
  @ApiQuery({ name: 'ids', required: false, description: 'Comma-separated seller ids.' })
  @ApiOkResponse({ description: 'The file, as an attachment.' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'payments.connected-account.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async export(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exporter.execute(context, query);
    await this.send(response, result, context);
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

  /**
   * The refusal as JSON, or the file as an attachment streamed in chunks (no-store, nosniff). A
   * stream that fails after the status line ends the connection.
   */
  private async send(
    response: Response,
    result: Result<
      ExportFile,
      { code: string; fields?: readonly unknown[]; max?: number; total?: number }
    >,
    context: CallContext,
  ): Promise<void> {
    const msg = 'payments.admin-export-connected-accounts-route';
    this.log(msg, context, result);
    if (!result.ok) {
      const error = this.refusal(result.error, context);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      this.#logger.warn({
        msg,
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
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
    error: { code: string; fields?: readonly unknown[]; max?: number; total?: number },
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
        ...(error.code === 'batch.too-large'
          ? {
              details: {
                max: error.max,
                ...(error.total === undefined ? {} : { total: error.total }),
              },
            }
          : {}),
      },
      status,
    );
  }
}
