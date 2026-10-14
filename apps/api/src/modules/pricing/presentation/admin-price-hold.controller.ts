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
    return { items: result.value.items.map(rowOf), next: result.value.next };
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
    kind: 'regular',
    amount: { amount: view.amount.amount.toString(), currency: view.amount.currency },
    anchorAmount: {
      amount: view.anchorAmount.amount.toString(),
      currency: view.anchorAmount.currency,
    },
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
