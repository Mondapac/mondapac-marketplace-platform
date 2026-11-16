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
import { DecideDispute } from '../application/use-cases/decide-dispute.use-case';
import { ListDisputes } from '../application/use-cases/list-disputes.use-case';
import { ListOwnDisputes } from '../application/use-cases/list-own-disputes.use-case';
import { ViewDispute } from '../application/use-cases/view-dispute.use-case';
import { ExportDisputes } from '../application/use-cases/export-disputes.use-case';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import {
  DISPUTE_EXPORT_COLUMNS,
  DISPUTE_LIST_VIEWS,
  DISPUTE_MONEY_STATES,
  DISPUTE_SORT_KEYS,
} from '../domain/admin-dispute-list';
import { DISPUTE_BUCKETS, DISPUTE_STATUSES } from '../domain/dispute';
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
  { name: 'view', required: false, enum: DISPUTE_LIST_VIEWS },
  { name: 'status', required: false, enum: DISPUTE_STATUSES, description: "Stripe's status." },
  { name: 'money', required: false, enum: DISPUTE_MONEY_STATES },
  { name: 'q', required: false, description: 'A dispute id or an order id, exact.' },
  { name: 'search', required: false, description: 'Store name, 2 to 80 characters.' },
  { name: 'sellerId', required: false, description: 'The cases with a seller order of it.' },
  { name: 'from', required: false, description: `Opened at or after. ${ISO}` },
  { name: 'to', required: false, description: `Opened before. ${ISO}` },
  { name: 'dueBefore', required: false, description: `Evidence due before. ${ISO}` },
  { name: 'minAmount', required: false, description: 'Disputed amount, minor units.' },
  { name: 'maxAmount', required: false, description: 'Disputed amount, minor units.' },
  { name: 'sort', required: false, enum: DISPUTE_SORT_KEYS },
  { name: 'direction', required: false, enum: ['asc', 'desc'] },
] as const;

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
    private readonly exportDisputes: ExportDisputes,
    private readonly view: ViewDispute,
    private readonly decide: DecideDispute,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The dispute cases (admin)',
    description:
      'Needs commission-payouts.dispute.view. The Disputes super list: a view (all or one ' +
      'bucket), search, filters and sort, with the count of every view for the Market whatever ' +
      'the filter. Buckets: needs-response (open, Stripe wants evidence), under-review (open, ' +
      'with the bank), decision-needed (lost with a seller order undecided, or lost and ' +
      'reinstated while a seller still repays), won, closed (everything else closed). Page ' +
      'numbers (`page`, `pageSize`, 25 by default) answer the total; `cursor` or `limit` asks ' +
      'for Previous/Next, newest opened first only (the older panel: `filter` is its name of the ' +
      'view, 50 rows by default). Each row carries its `actions`. No Stripe id is answered here.',
  })
  @ApiQuery(SELECTOR_QUERIES[0])
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: DISPUTE_BUCKETS,
    description: 'The older name of `view`.',
  })
  @ApiQuery(SELECTOR_QUERIES[1])
  @ApiQuery(SELECTOR_QUERIES[2])
  @ApiQuery(SELECTOR_QUERIES[3])
  @ApiQuery(SELECTOR_QUERIES[4])
  @ApiQuery(SELECTOR_QUERIES[5])
  @ApiQuery(SELECTOR_QUERIES[6])
  @ApiQuery(SELECTOR_QUERIES[7])
  @ApiQuery(SELECTOR_QUERIES[8])
  @ApiQuery(SELECTOR_QUERIES[9])
  @ApiQuery(SELECTOR_QUERIES[10])
  @ApiQuery(SELECTOR_QUERIES[11])
  @ApiQuery(SELECTOR_QUERIES[12])
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'From 1; page x pageSize at most 10,000.',
  })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 50.' })
  @ApiOkResponse({ type: DisputeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.search-unavailable' })
  async cases(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, numbersOf(query));
    logRoute(
      this.#logger,
      'commission-payouts.list-disputes-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return disputeListBody(result.value);
  }

  // Before `:disputeId`, so `export` is never read as a dispute id.
  @Get('export')
  @ApiOperation({
    summary: 'Export the dispute cases of the list as a file (admin)',
    description:
      'Needs commission-payouts.dispute.view. `format` is csv (default) or xlsx. `columns` is ' +
      `the comma-separated optional columns in the order shown (${DISPUTE_EXPORT_COLUMNS.join(', ')}); ` +
      'dispute id, order id, sellers, stage, amount, currency and opened are always there; ' +
      "amounts are decimals of the currency. Stripe's dispute id is never written. The cases " +
      'are `ids` (comma-separated, at most 200; an id that is not a case of the Market refuses ' +
      'the whole file as not found) or the selector keys of the list, at most 10,000 (more: ' +
      'batch.too-large with the total). CSV: a text cell that starts with = + - @ gets a ' +
      'leading quote. XLSX: every cell is a string value.',
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
  @ApiQuery(SELECTOR_QUERIES[10])
  @ApiQuery(SELECTOR_QUERIES[11])
  @ApiQuery(SELECTOR_QUERIES[12])
  @ApiOkResponse({ description: 'disputes-<date>.csv or disputes-<date>.xlsx, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.dispute-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.search-unavailable' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportDisputes.execute(context, { ...query });
    logRoute(
      this.#logger,
      'commission-payouts.export-disputes-route',
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
        msg: 'commission-payouts.export-disputes',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
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
