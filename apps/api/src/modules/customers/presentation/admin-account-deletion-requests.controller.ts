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
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminCancelAccountDeletion } from '../application/use-cases/admin-cancel-account-deletion.use-case';
import { AdminExportAccountDeletions } from '../application/use-cases/admin-export-account-deletions.use-case';
import {
  AdminListAccountDeletions,
  type AdminDeletionListPage,
} from '../application/use-cases/admin-list-account-deletions.use-case';
import {
  DELETION_CANCEL_REASONS,
  DELETION_EXPORT_COLUMNS,
  DELETION_LIST_VIEWS,
  DELETION_REQUESTERS,
  DELETION_SORT_KEYS,
} from '../domain/admin-deletion-list';
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

const instant = (value: { toString(): string } | null) =>
  value === null ? null : value.toString();

const pageBody = (page: AdminDeletionListPage) => ({
  entries: page.entries.map((entry) => ({
    requestId: entry.id,
    accountId: entry.accountId,
    requestedAt: entry.requestedAt.toString(),
    scheduledFor: entry.scheduledFor.toString(),
    status: entry.status,
    requestedBy: entry.requestedBy,
    cancelledAt: instant(entry.cancelledAt),
    cancelReason: entry.cancelReason,
    completedAt: instant(entry.completedAt),
    actions: [...entry.actions],
  })),
  counts: { ...page.counts },
  total: page.total,
  page: page.page,
  pageSize: page.pageSize,
  nextCursor: page.nextCursor,
});

const ISO = 'An ISO instant (UTC or with an offset).';

/** `page`, `pageSize` and `limit` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize', 'limit']) {
    if (out[key] !== undefined) out[key] = parseLimit(out[key]);
  }
  return out;
}

/** The selector keys of the list, shared by the list and the export (OpenAPI only). */
const SELECTOR_QUERIES = [
  {
    name: 'view',
    required: false,
    enum: DELETION_LIST_VIEWS,
    description: 'pending (default), executing, cancelled, completed or all.',
  },
  {
    name: 'status',
    required: false,
    enum: ['pending'],
    description: "The older list's name of the pending view; never with `view`.",
  },
  { name: 'requestedBy', required: false, enum: DELETION_REQUESTERS },
  { name: 'cancelReason', required: false, enum: DELETION_CANCEL_REASONS },
  { name: 'q', required: false, description: 'A request id or a buyer account id, exact.' },
  { name: 'from', required: false, description: `Requested at or after. ${ISO}` },
  { name: 'to', required: false, description: `Requested before. ${ISO}` },
  { name: 'scheduledBefore', required: false, description: `Deletes before. ${ISO}` },
  { name: 'sort', required: false, enum: DELETION_SORT_KEYS },
  { name: 'direction', required: false, enum: ['asc', 'desc'] },
] as const;

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
    private readonly exportRequests: AdminExportAccountDeletions,
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
    summary: 'Buyer deletion requests of the Market (admin)',
    description:
      'Needs customers.account-deletion-requests.view. The Account deletion requests super ' +
      'list: a view (pending by default, executing, cancelled, completed or all), filters and ' +
      'sort, with the count of every view for the Market whatever the filter. Ids, dates and who ' +
      'asked (customer or admin): no name, email, ticket or reason. Page numbers (`page`, ' +
      '`pageSize`, 25 by default) answer the total; `cursor` or `limit` asks for Previous/Next, ' +
      'earliest scheduled first only (the older list: 20 rows by default). Each row carries its ' +
      '`actions`. Refused in an acting-as session.',
  })
  @ApiQuery(SELECTOR_QUERIES[0])
  @ApiQuery(SELECTOR_QUERIES[1])
  @ApiQuery(SELECTOR_QUERIES[2])
  @ApiQuery(SELECTOR_QUERIES[3])
  @ApiQuery(SELECTOR_QUERIES[4])
  @ApiQuery(SELECTOR_QUERIES[5])
  @ApiQuery(SELECTOR_QUERIES[6])
  @ApiQuery(SELECTOR_QUERIES[7])
  @ApiQuery(SELECTOR_QUERIES[8])
  @ApiQuery(SELECTOR_QUERIES[9])
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'From 1; page x pageSize at most 10,000.',
  })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 20.' })
  @ApiOkResponse({ type: PendingAccountDeletionRequestPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async pending(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, numbersOf(query));
    this.log('customers.admin-list-account-deletions-route', context, result);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return pageBody(result.value);
  }

  // Before `deletion-requests/:requestId`, so `export` is never read as a request id.
  @Get('deletion-requests/export')
  @ApiOperation({
    summary: 'Export the buyer deletion requests of the list as a file (admin)',
    description:
      'Needs customers.account-deletion-requests.view. `format` is csv (default) or xlsx. ' +
      `\`columns\` is the comma-separated optional columns in the order shown (${DELETION_EXPORT_COLUMNS.join(', ')}); ` +
      'request id, account id, status, requested by, requested and deletes on are always there. ' +
      'No name, email, ticket or reason is written. The requests are `ids` (comma-separated, at ' +
      'most 200; an id that is not a request of the Market refuses the whole file as not found) ' +
      'or the selector keys of the list, at most 10,000 (more: batch.too-large with the total). ' +
      'Refused in an acting-as session.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiQuery(SELECTOR_QUERIES[0])
  @ApiQuery(SELECTOR_QUERIES[1])
  @ApiQuery(SELECTOR_QUERIES[2])
  @ApiQuery(SELECTOR_QUERIES[3])
  @ApiQuery(SELECTOR_QUERIES[4])
  @ApiQuery(SELECTOR_QUERIES[5])
  @ApiQuery(SELECTOR_QUERIES[6])
  @ApiQuery(SELECTOR_QUERIES[7])
  @ApiQuery(SELECTOR_QUERIES[8])
  @ApiQuery(SELECTOR_QUERIES[9])
  @ApiOkResponse({
    description: 'deletion-requests-<date>.csv or deletion-requests-<date>.xlsx, as an attachment',
  })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.account-deletion-request-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportRequests.execute(context, { ...query });
    this.log('customers.admin-export-account-deletions-route', context, result);
    if (!result.ok) {
      const error = refusal(result.error, context, this.#logger);
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
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'customers.admin-export-account-deletions',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Delete('deletion-requests/:requestId')
  @HttpCode(204)
  @RequiresStepUp('customers.buyer-account.delete')
  @ApiOperation({
    summary: 'Cancel a pending deletion request (admin)',
    description:
      'Needs customers.buyer-account.delete (protected), a reason (1 to 500 characters, no personal data: it is checked, not stored) and a ' +
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
