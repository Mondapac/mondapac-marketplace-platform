import {
  applyDecorators,
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
  ApiPayloadTooLargeResponse,
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
import { ExportOwnPayouts } from '../application/use-cases/export-own-payouts.use-case';
import { OWN_PAYOUT_EXPORT_COLUMNS, OWN_PAYOUT_SORT_KEYS } from '../domain/own-payout-list';

/** The Earnings list's filter and sort keys (list and export). */
const OWN_PAYOUT_QUERY = [
  {
    name: 'status',
    required: false,
    enum: ['scheduled', 'awaiting-approval', 'on-its-way', 'paid', 'not-sent', 'failed', 'settled'],
  },
  { name: 'q', required: false, description: 'A payout id, exact.' },
  {
    name: 'from',
    required: false,
    description:
      'Payout day (slotAt) at or after (ISO instant; the panel sends the start of a store-zone day).',
  },
  {
    name: 'to',
    required: false,
    description: 'Payout day (slotAt) before (ISO instant; the start of the store-zone day after).',
  },
  { name: 'minAmount', required: false, description: 'The transfer, minor units.' },
  { name: 'maxAmount', required: false, description: 'The transfer, minor units.' },
  {
    name: 'sort',
    required: false,
    enum: [...OWN_PAYOUT_SORT_KEYS],
    description: 'Default slot (the payout day), ties by payout id.',
  },
  { name: 'direction', required: false, enum: ['asc', 'desc'], description: 'Default desc.' },
];
const ownPayoutQueries = () => applyDecorators(...OWN_PAYOUT_QUERY.map((q) => ApiQuery(q)));
import { sendExport } from './list-export-route';
import { ListPayouts } from '../application/use-cases/list-payouts.use-case';
import { ExportPayouts } from '../application/use-cases/export-payouts.use-case';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import {
  PAYOUT_EXPORT_COLUMNS,
  PAYOUT_LIST_VIEWS,
  PAYOUT_SORT_KEYS,
} from '../domain/admin-payout-list';
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
  ownPayoutListBody,
  OwnPayoutListBody,
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

/** `page`, `pageSize` and `limit` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize', 'limit']) {
    if (out[key] !== undefined) out[key] = parseLimit(out[key]);
  }
  return out;
}

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
    private readonly exportPayouts: ExportPayouts,
    private readonly view: ViewPayout,
    private readonly approve: ApprovePayout,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The seller payouts (admin): the Payouts super list',
    description:
      'Needs commission-payouts.payout.view. `view` is a tab: all (default), awaiting-approval, ' +
      'sending (approved, instructing, instructed), paid, failed or not-sent; `status` narrows ' +
      'it to one state. `q` is a payout id (exact); `search` a part of the store name (2 to 80 ' +
      'characters). Filters: sellerId, approvalMode (AUTO or MANUAL), from and to (ISO instants ' +
      'on the creation time, to excluded), minAmount and maxAmount (the transfer in minor units, ' +
      'both included). Page numbers (List paging `pages`, the default): `sort` created (default), ' +
      'amount, state-changed or slot, `direction` asc or desc (default desc), `page` from 1 and ' +
      '`pageSize` 1 to 100 (default 25), at most row 10,000; the answer has `total`. Previous and ' +
      'Next (List paging `prev-next`): `cursor` and `limit` (1 to 100, default 50), newest first ' +
      'only; the answer has `nextCursor`. `counts` holds the count of each view whatever the ' +
      'filter. Each row names its `actions` (open, approve, place-hold, release-hold) from the ' +
      "caller's keys and the payout's state; each action checks them again when it runs.",
  })
  @ApiQuery({ name: 'view', required: false, enum: PAYOUT_LIST_VIEWS })
  @ApiQuery({ name: 'status', required: false, enum: PAYOUT_STATES })
  @ApiQuery({ name: 'q', required: false, description: 'A payout id, exact.' })
  @ApiQuery({ name: 'search', required: false, description: 'Store name, 2 to 80 characters.' })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'approvalMode', required: false, enum: ['AUTO', 'MANUAL'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'minAmount', required: false })
  @ApiQuery({ name: 'maxAmount', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: PAYOUT_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'page',
    required: false,
    description: '1 or more; page x pageSize at most 10,000.',
  })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery(CURSOR)
  @ApiQuery(LIMIT)
  @ApiOkResponse({ type: PayoutListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.search-unavailable (the store search could not be read)',
  })
  async payouts(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, numbersOf(query));
    logRoute(
      this.#logger,
      'commission-payouts.list-payouts-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutListBody(result.value);
  }

  // Before `:payoutId`, so `export` is never read as a payout id.
  @Get('export')
  @ApiOperation({
    summary: 'Export the payouts of the list as a file (admin)',
    description:
      'Needs commission-payouts.payout.view. `format` is csv (default) or xlsx. `columns` is the ' +
      `comma-separated optional columns in the order shown (${PAYOUT_EXPORT_COLUMNS.join(', ')}); ` +
      'payout id, store, status, transfer, currency and created are always there; amounts are ' +
      'decimals of the currency. The payouts are `ids` (comma-separated, at most 200; an id that ' +
      'is not a payout of the Market refuses the whole file as not found) or the selector keys of ' +
      'the list (view, status, q, search, sellerId, approvalMode, from, to, minAmount, maxAmount, ' +
      'sort, direction), at most 10,000 (more: batch.too-large with the total). CSV: a text cell ' +
      'that starts with = + - @ gets a leading quote. XLSX: every cell is a string value.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiOkResponse({ description: 'payouts-<date>.csv or payouts-<date>.xlsx, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.payout-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.search-unavailable' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportPayouts.execute(context, { ...query });
    logRoute(
      this.#logger,
      'commission-payouts.export-payouts-route',
      context,
      result.ok ? 'export' : result.error.code,
    );
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
        msg: 'commission-payouts.export-payouts',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
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
    private readonly exportOwn: ExportOwnPayouts,
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
    description:
      'The Earnings super list (list 33). A payout that was voided never happened and is not ' +
      'listed. Filters: status (scheduled, awaiting-approval, on-its-way, paid, not-sent, failed, ' +
      'settled), q (a payout id, exact), from and to (ISO instants on the payout day, slotAt), ' +
      'minAmount and maxAmount (the transfer in minor units). Page numbers: page, pageSize ' +
      '(default 25, at most 100; page x pageSize at most 10,000), sort (slot, created, amount; ' +
      'default slot, the payout day) and direction (default desc), ties by payout id. ' +
      'Previous/Next: limit (default 50) and cursor, latest payout day first, or newest created ' +
      'first with sort=created; no page, pageSize or direction, and no sort=amount ' +
      '(details.fields code with-cursor). The cursor names its sort ("slot.<ms>.<id>" or ' +
      '"created.<ms>.<id>"): a cursor of another sort is refused (cursor: other-sort), an older ' +
      'cursor without a sort as format. counts covers every shown payout of the seller.',
  })
  @ApiQuery({
    ...CURSOR,
    example: 'slot.1793998800000.01990000-0000-7000-8000-000000001001',
  })
  @ApiQuery(LIMIT)
  @ownPayoutQueries()
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ type: OwnPayoutListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async payouts(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.history.execute(context, numbersOf(query));
    logRoute(
      this.#logger,
      'commission-payouts.list-own-payouts-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownPayoutListBody(result.value);
  }

  @Get('payouts/export')
  @ApiOperation({
    summary: "Export the seller's payouts as a file",
    description:
      '`format` is csv (default) or xlsx. `columns` is the comma-separated optional columns in ' +
      `the order shown (${OWN_PAYOUT_EXPORT_COLUMNS.join(', ')}; headers Earned, Kept against ` +
      'what you owed, Created on, Updated on). The base headers are always there: Payout ID, ' +
      'Status, Amount, Currency, Payout on (slotAt). Dates are ISO 8601 in the store zone with ' +
      'its offset (for example 2026-11-06T01:00:00+10:00; UTC while the store has no zone); ' +
      'amounts are decimals of the currency. The file follows the list sort (default slot ' +
      'desc). The ' +
      "payouts are `ids` (at most 200; an id that is not one of the seller's payouts refuses " +
      'the whole file as not found; the filter keys are then ignored) or the filter keys of the ' +
      'list with sort and direction, at most 10,000 (more: batch.too-large with the total).',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ownPayoutQueries()
  @ApiOkResponse({
    description:
      'payouts-<date>.csv or payouts-<date>.xlsx (the date in the store zone), as an attachment. ' +
      'Example CSV with columns=created: "Payout ID,Status,Amount,Currency,Payout on,Created on" ' +
      'then "01990000-0000-7000-8000-000000001001,Paid,123.45,<currency>,2026-11-06T01:00:00+10:00,' +
      '2026-11-05T23:30:00+10:00".',
  })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.payout-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: "commission-payouts.unavailable (the store's zone could not be read)",
  })
  async exportPayouts(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportOwn.execute(context, { ...query });
    await sendExport(
      response,
      result,
      context,
      this.#logger,
      'commission-payouts.export-own-payouts-route',
    );
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
