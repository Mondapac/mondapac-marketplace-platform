import { Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
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
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminListOrders } from '../application/use-cases/admin-list-orders.use-case';
import { AdminViewOrder } from '../application/use-cases/admin-view-order.use-case';
import { refusal } from './http-answers';
import { AdminOrderBody, AdminOrderPageBody, adminOrderBody, pageBody } from './orders.dto';

const ERROR = { type: Object };

const parseLimit = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The admin order reads over HTTP: the Market's orders and one order, for support and oversight.
 * The controller authenticates only; each use case's gate needs `ordering.order.view`. A
 * customer's or another Market's order answers exactly as an unknown id. Every response is
 * `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/orders')
export class AdminOrdersController {
  readonly #logger = new Logger('AdminOrdersController');

  constructor(
    private readonly list: AdminListOrders,
    private readonly view: AdminViewOrder,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The Market's orders, newest first (admin)",
    description: 'Needs ordering.order.view.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending-payment', 'confirmed', 'cancelled'],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'An order id or a seller order id (the reference in the order emails), exact.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: AdminOrderPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async orders(
    @Call() context: CallContext,
    @Query('status') status: unknown,
    @Query('q') q: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      status,
      q,
      cursor,
      limit: parseLimit(limit),
    });
    this.log('ordering.admin-list-orders-route', context, result.ok ? 'listed' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return pageBody(result.value, adminOrderBody);
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'One order (admin)', description: 'Needs ordering.order.view.' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: AdminOrderBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.order-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async one(
    @Call() context: CallContext,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { orderId });
    this.log('ordering.admin-view-order-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return adminOrderBody(result.value);
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
