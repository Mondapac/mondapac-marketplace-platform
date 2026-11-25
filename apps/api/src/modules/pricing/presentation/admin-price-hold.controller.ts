import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
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
  ApiPayloadTooLargeResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { QueryPriceHolds } from '../application/use-cases/query-price-holds.use-case';
import { ExportPriceHolds } from '../application/use-cases/export-price-holds.use-case';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { HOLD_EXPORT_COLUMNS, HOLD_LIST_VIEWS, HOLD_SORT_KEYS } from '../domain/hold-list';
import { ApprovePriceHold } from '../application/use-cases/approve-price-hold.use-case';
import {
  ListPriceHolds,
  type PriceHoldPage,
} from '../application/use-cases/list-price-holds.use-case';
import { RejectPriceHold } from '../application/use-cases/reject-price-hold.use-case';
import { ViewPriceHold } from '../application/use-cases/view-price-hold.use-case';
import { closedBody, fail } from './http-answers';
import {
  PriceHoldApproved,
  PriceHoldListBody,
  PriceHoldPageBody,
  PriceHoldRejected,
  PriceHoldRow,
  RejectPriceHoldRequest,
} from './price-hold.dto';

/** The HTTP status of each refusal of the price-hold review routes. */
export const PRICE_HOLD_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'pricing.hold.not-found': 404,
  'pricing.hold.not-pending': 409,
  'pricing.hold.own-submission': 403,
  'pricing.series-retired': 409,
  'pricing.amount-out-of-range': 422,
  'pricing.currency-mismatch': 422,
  'pricing.regular-not-above-special': 409,
  'pricing.special-not-below-regular': 409,
  'pricing.special-window.ended': 409,
  'conflict.stale': 409,
  'conflict.retry': 409,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The admin price-hold review over HTTP (pricing design 3.1, 5.2; slice 4): the queue, one held
 * record, approve and reject. A thin adapter: the admin comes from the session cookie of the
 * request's Market (`@RoutePopulation('admin')` with `@ReadsSession()`); the controller
 * authenticates only, each use case's gate decides (`pricing.price-hold.view` for the reads, the
 * protected `pricing.price-hold.decide` for the decisions). A record of another Market answers
 * exactly as an unknown id. Every response is `Cache-Control: no-store`, errors included.
 */
@ApiTags('pricing')
@RoutePopulation('admin')
@ReadsSession()
@Controller('pricing/admin/price-holds')
export class AdminPriceHoldController {
  readonly #logger = new Logger('AdminPriceHoldController');

  constructor(
    private readonly list: ListPriceHolds,
    private readonly query: QueryPriceHolds,
    private readonly exportHolds: ExportPriceHolds,
    private readonly view: ViewPriceHold,
    private readonly approve: ApprovePriceHold,
    private readonly reject: RejectPriceHold,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The queue of held prices (admin)',
    description: 'Oldest submission first, keyset-paged. Needs pricing.price-hold.view.',
  })
  @ApiQuery({ name: 'after', required: false, description: 'The `next` of the previous page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 50.' })
  @ApiOkResponse({ type: PriceHoldPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async queue(
    @Call() context: CallContext,
    @Query('after') after: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PriceHoldPageBody> {
    response.setHeader('Cache-Control', 'no-store');
    const asked = parseLimit(limit);
    const result = await this.list.execute(context, {
      after: after === undefined ? null : typeof after === 'string' ? after : '[invalid]',
      limit: asked,
    });
    this.log('pricing.list-price-holds-route', context, result.ok ? 'listed' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return {
      items: result.value.items.map(rowOf),
      next: result.value.next,
      total: result.value.total,
    };
  }

  // Before `:recordId`, so `list` and `export` are never read as a record id.
  @Get('list')
  @ApiOperation({
    summary: 'The held prices as a super list (admin)',
    description:
      'Needs pricing.price-hold.view. Views (all, regular, special, up, down) with counts, ' +
      'filters (kind, change, q = a record or Offer id, sellerId, from/to submitted, ' +
      'minAmount/maxAmount in minor units), sort (submitted or amount, with direction; oldest ' +
      'submission first by default), page numbers with a total (`paging=pages`, default) or ' +
      'Previous/Next without one (`paging=prev-next`), and each row’s actions. The older queue ' +
      'route keeps its cursor answer.',
  })
  @ApiQuery({ name: 'view', required: false, enum: HOLD_LIST_VIEWS })
  @ApiQuery({ name: 'kind', required: false, enum: ['regular', 'special'] })
  @ApiQuery({ name: 'change', required: false, enum: ['up', 'down'] })
  @ApiQuery({ name: 'q', required: false, description: 'A record id or an Offer id, exact.' })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Submitted at or after (ISO instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Submitted before (ISO instant).' })
  @ApiQuery({ name: 'minAmount', required: false, description: 'Held amount, minor units.' })
  @ApiQuery({ name: 'maxAmount', required: false, description: 'Held amount, minor units.' })
  @ApiQuery({ name: 'sort', required: false, enum: HOLD_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'From 1; page x pageSize at most 10,000.',
  })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: PriceHoldListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listHolds(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PriceHoldListBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.query.execute(context, numbersOf(query));
    this.log('pricing.query-price-holds-route', context, result.ok ? 'listed' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    const page = result.value;
    return {
      items: page.items.map((row) => ({ ...rowOf(row), actions: [...row.actions] })),
      counts: { ...page.counts },
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      paging: page.paging,
      hasNext: page.hasNext,
    };
  }

  @Get('export')
  @ApiOperation({
    summary: 'Export the held prices of the list as a file (admin)',
    description:
      'Needs pricing.price-hold.view. `format` is csv (default) or xlsx. `columns` is the ' +
      `comma-separated optional columns in the order shown (${HOLD_EXPORT_COLUMNS.join(', ')}); ` +
      'product, variant, store, kind, direction, held amount, reference amount, currency and ' +
      'submitted are always there; amounts are decimals of the currency. The records are `ids` ' +
      '(comma-separated, at most 200; an id that is not a pending record of the Market refuses ' +
      'the whole file as not found) or the selector keys of the list, at most 10,000 (more: ' +
      'batch.too-large with the total). CSV: a text cell that starts with = + - @ gets a leading ' +
      'quote. XLSX: every cell is a string value. No Cost, no submitter.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiOkResponse({
    description: 'price-holds-<date>.csv or price-holds-<date>.xlsx, as an attachment',
  })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.hold.not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportHolds.execute(context, { ...query });
    this.log('pricing.export-price-holds-route', context, result.ok ? 'export' : result.error.code);
    if (!result.ok) {
      const error =
        result.error.code === 'batch.too-large'
          ? fail(413, 'batch.too-large', {
              max: result.error.max,
              ...(result.error.total === undefined ? {} : { total: result.error.total }),
            })
          : refusal(result.error, context, this.#logger);
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
        msg: 'pricing.export-price-holds',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Get(':recordId')
  @ApiOperation({
    summary: 'One held price with its anchor (admin)',
    description:
      'Needs pricing.price-hold.view. Only a record still pending is shown: an unknown id, a ' +
      'record of another Market and a decided record all answer pricing.hold.not-found.',
  })
  @ApiParam({ name: 'recordId', format: 'uuid' })
  @ApiOkResponse({ type: PriceHoldRow })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.hold.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async one(
    @Call() context: CallContext,
    @Param('recordId') recordId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PriceHoldRow> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { recordId });
    this.log('pricing.view-price-hold-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return rowOf(result.value);
  }

  @Post(':recordId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a held price (admin)',
    description:
      'Needs pricing.price-hold.decide (protected). The price takes effect from approval. ' +
      'The decider can never be the account that submitted the record. The amount is checked ' +
      'again against the current Market limits. No body.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'recordId', format: 'uuid' })
  @ApiOkResponse({ type: PriceHoldApproved })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf or pricing.hold.own-submission',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.hold.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'pricing.hold.not-pending, pricing.series-retired, conflict.stale or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'pricing.amount-out-of-range or pricing.currency-mismatch (reject instead)',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async approveHold(
    @Call() context: CallContext,
    @Param('recordId') recordId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PriceHoldApproved> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.approve.execute(context, { recordId });
    this.log(
      'pricing.approve-price-hold-route',
      context,
      result.ok ? 'approved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return {
      recordId: result.value.recordId,
      outcome: 'approved',
      effectiveFrom: result.value.effectiveFrom.toString(),
      seriesVersion: result.value.seriesVersion,
    };
  }

  @Post(':recordId/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject a held price (admin)',
    description:
      'Needs pricing.price-hold.decide (protected). A reason code is required; the note is ' +
      'optional. The previous price is untouched.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'recordId', format: 'uuid' })
  @ApiBody({ type: RejectPriceHoldRequest })
  @ApiOkResponse({ type: PriceHoldRejected })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf or pricing.hold.own-submission',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.hold.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'pricing.hold.not-pending, pricing.series-retired, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async rejectHold(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('recordId') recordId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PriceHoldRejected> {
    response.setHeader('Cache-Control', 'no-store');
    const input = closedBody(request, body, ['reasonCode', 'note'], ['note']);
    if (input instanceof HttpException) throw input;
    const result = await this.reject.execute(context, {
      recordId,
      reasonCode: input.reasonCode as string,
      note: input.note as string | null | undefined,
    });
    this.log(
      'pricing.reject-price-hold-route',
      context,
      result.ok ? 'rejected' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return {
      recordId: result.value.recordId,
      outcome: 'rejected',
      seriesVersion: result.value.seriesVersion,
    };
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

/** `page` and `pageSize` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    if (out[key] !== undefined) out[key] = parseLimit(out[key]);
  }
  return out;
}

/** The `limit` query: absent is the default; anything else must be a whole number (the use case checks the range). */
function parseLimit(value: unknown): number | null {
  if (value === undefined) return null;
  return typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : -1;
}

function rowOf(view: PriceHoldPage['items'][number]): PriceHoldRow {
  return {
    recordId: view.recordId,
    offerId: view.offerId,
    variantId: view.variantId,
    sellerId: view.sellerId,
    productName: view.productName,
    variantLabel: view.variantLabel,
    storeName: view.storeName,
    kind: view.kind,
    ...(view.window === null
      ? {}
      : {
          window: {
            startsAt: view.window.startsAt.toString(),
            endsAt: view.window.endsAt.toString(),
          },
        }),
    amount: { amount: view.amount.amount.toString(), currency: view.amount.currency },
    anchorAmount: {
      amount: view.anchorAmount.amount.toString(),
      currency: view.anchorAmount.currency,
    },
    basis: view.basis,
    direction: view.direction,
    submittedAt: view.submittedAt.toString(),
  };
}

function refusal(
  error: { readonly code: string; readonly fields?: unknown },
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    PRICE_HOLD_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'pricing.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  return error.fields === undefined
    ? fail(status, error.code)
    : fail(status, error.code, { fields: error.fields });
}
