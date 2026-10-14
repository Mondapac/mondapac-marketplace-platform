import {
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
  ApiQuery,
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
import { SellerDeliverOrder } from '../application/use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from '../application/use-cases/seller-list-orders.use-case';
import { SellerShipOrder } from '../application/use-cases/seller-ship-order.use-case';
import { SellerViewOrder } from '../application/use-cases/seller-view-order.use-case';
import { closedBody, refusal } from './http-answers';
import {
  SellerOrderDetailBody,
  SellerOrderPageBody,
  ShipSellerOrderRequest,
  sellerOrderDetailBody,
  sellerOrderPageBody,
} from './orders.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

const parseLimit = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The shop's paid orders over HTTP (SHP-01): the list, one order, the shipment (carrier and an
 * optional tracking reference) and the delivery. The seller comes from the session, never from
 * the request; an order of another shop answers exactly as an unknown id. Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('seller')
@ReadsSession()
@Controller('ordering/seller/orders')
export class SellerOrdersController {
  readonly #logger = new Logger('SellerOrdersController');

  constructor(
    private readonly list: SellerListOrders,
    private readonly view: SellerViewOrder,
    private readonly ship: SellerShipOrder,
    private readonly deliver: SellerDeliverOrder,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The shop's paid orders, newest payment first",
    description: 'Needs ordering.seller-order.view. Only orders the customer has paid appear.',
  })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: SellerOrderPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async orders(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { cursor, limit: parseLimit(limit) });
    this.log(
      'ordering.seller-list-orders-route',
      context,
      result.ok ? 'listed' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerOrderPageBody(result.value);
  }

  @Get(':sellerOrderId')
  @ApiOperation({
    summary: "One of the shop's paid orders",
    description: 'Needs ordering.seller-order.view.',
  })
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiOkResponse({ type: SellerOrderDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.seller-order-not-found' })
  async one(
    @Call() context: CallContext,
    @Param('sellerOrderId') sellerOrderId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerOrderId });
    this.log('ordering.seller-view-order-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerOrderDetailBody(result.value);
  }

  @Post(':sellerOrderId/ship')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record the shipment of a paid order',
    description:
      'Needs ordering.seller-order.ship. The carrier is required, the tracking reference is ' +
      'optional. A shipment is recorded once; a second call answers 409 ordering.fulfilment-conflict.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiBody({ type: ShipSellerOrderRequest })
  @ApiOkResponse({ type: SellerOrderDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.seller-order-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'ordering.fulfilment-conflict' })
  async shipOrder(
    @Call() context: CallContext,
    @Param('sellerOrderId') sellerOrderId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['carrier', 'trackingRef']);
    if (invalid !== null) throw invalid;
    const { carrier, trackingRef } = body as { carrier?: unknown; trackingRef?: unknown };
    const result = await this.ship.execute(context, { sellerOrderId, carrier, trackingRef });
    this.log(
      'ordering.seller-ship-order-route',
      context,
      result.ok ? 'shipped' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerOrderDetailBody(result.value);
  }

  @Post(':sellerOrderId/deliver')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark a shipped order delivered',
    description:
      'Needs ordering.seller-order.mark-delivered. The body is an empty JSON object. Only a ' +
      'shipped order can be delivered; otherwise 409 ordering.fulfilment-conflict.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  @ApiOkResponse({ type: SellerOrderDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.seller-order-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'ordering.fulfilment-conflict' })
  async deliverOrder(
    @Call() context: CallContext,
    @Param('sellerOrderId') sellerOrderId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body);
    if (invalid !== null) throw invalid;
    const result = await this.deliver.execute(context, { sellerOrderId });
    this.log(
      'ordering.seller-deliver-order-route',
      context,
      result.ok ? 'delivered' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerOrderDetailBody(result.value);
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
