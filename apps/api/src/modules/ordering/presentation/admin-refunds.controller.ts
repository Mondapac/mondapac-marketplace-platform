import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminListRefunds } from '../application/use-cases/admin-list-refunds.use-case';
import { REFUND_SORT_KEYS } from '../domain/admin-refund-list';
import { LOSS_BEARERS } from '../domain/reason-codes';
import { REFUND_REASONS } from '../domain/refund';
import { RefundListPageBody, refundListPageBody } from './admin-refund-list.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

const parseWhole = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The admin Refunds list (Sales > Refunds): every refund of the Market, one row each. Read only;
 * a refund is made on the order page. The controller authenticates only; the use case's gate needs
 * `ordering.order.view`. Every response is `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/refunds')
export class AdminRefundsController {
  readonly #logger = new Logger('AdminRefundsController');

  constructor(private readonly list: AdminListRefunds) {}

  @Get()
  @ApiOperation({
    summary: "The Market's refunds, newest first (admin)",
    description:
      'Needs ordering.order.view. Page numbers with a total; page x pageSize may not pass 10,000 ' +
      '(`too-deep`): narrow the filter instead.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'From 1; default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery({ name: 'sort', required: false, enum: REFUND_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'state', required: false, enum: ['pending', 'succeeded', 'failed'] })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A refund, order or seller order id, or a Stripe refund id (re_...), exact.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Customer name or store name, 2 to 80 characters. Customer names need ' +
      'identity.customer-account.view; without it only store names match.',
  })
  @ApiQuery({ name: 'reason', required: false, enum: REFUND_REASONS })
  @ApiQuery({ name: 'actor', required: false, enum: ['admin', 'seller'] })
  @ApiQuery({ name: 'lossBearer', required: false, enum: LOSS_BEARERS })
  @ApiQuery({
    name: 'ledger',
    required: false,
    enum: ['waiting', 'recorded'],
    description: '`waiting`: succeeded, not yet in the seller ledger.',
  })
  @ApiQuery({ name: 'sellerId', required: false, description: "One seller's refunds." })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO instant: requested at or after it.',
  })
  @ApiQuery({ name: 'to', required: false, description: 'ISO instant: requested before it.' })
  @ApiQuery({ name: 'minAmount', required: false, description: 'Gross, minor units, included.' })
  @ApiQuery({ name: 'maxAmount', required: false, description: 'Gross, minor units, included.' })
  @ApiOkResponse({ type: RefundListPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'access.unavailable, or ordering.search-unavailable when `search` could not run',
  })
  async refunds(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      page: parseWhole(query['page']),
      pageSize: parseWhole(query['pageSize']),
      sort: query['sort'],
      direction: query['direction'],
      state: query['state'],
      q: query['q'],
      search: query['search'],
      reason: query['reason'],
      actor: query['actor'],
      lossBearer: query['lossBearer'],
      ledger: query['ledger'],
      sellerId: query['sellerId'],
      from: query['from'],
      to: query['to'],
      minAmount: query['minAmount'],
      maxAmount: query['maxAmount'],
    });
    this.#logger.log({
      msg: 'ordering.admin-list-refunds-route',
      outcome: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return refundListPageBody(result.value);
  }
}
