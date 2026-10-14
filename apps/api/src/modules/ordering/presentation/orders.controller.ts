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
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ListOrders } from '../application/use-cases/list-orders.use-case';
import { StartCheckout } from '../application/use-cases/start-checkout.use-case';
import { ViewOrder } from '../application/use-cases/view-order.use-case';
import { closedBody, moneyBody, refusal } from './http-answers';
import { CheckoutStartedView, OrderBody, OrderPageBody, orderBody, pageBody } from './orders.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/** The `limit` query: absent is the default; anything else must be a whole number in range. */
const parseLimit = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The signed-in customer's checkout and orders over HTTP. A thin adapter: the customer comes from
 * the session, never from the body; one use case does the work behind its gate. Every answer is
 * `no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('customer')
@ReadsSession()
@Controller('orders')
export class OrdersController {
  readonly #logger = new Logger('OrdersController');

  constructor(
    private readonly start: StartCheckout,
    private readonly view: ViewOrder,
    private readonly list: ListOrders,
  ) {}

  @Post('checkout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start checkout: the cart becomes a pending order and a hosted payment page',
    description:
      'Reserves the stock for the whole cart, stores the order with its seller split and opens a ' +
      'Stripe Checkout page. Nothing is charged here. Send the customer to checkoutUrl. The body ' +
      'is an empty JSON object.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  @ApiOkResponse({ type: CheckoutStartedView })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'ordering.stock-insufficient (details.lines) or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'ordering.cart-empty or ordering.cart-not-purchasable (details.lineIndexes)',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description:
      'ordering.check-unavailable, ordering.shipping-unavailable (a seller has no delivery fee yet), ordering.payment-unavailable or access.unavailable',
  })
  async checkout(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body);
    if (invalid !== null) throw this.refused(invalid, context);
    const result = await this.start.execute(context, {});
    this.log('ordering.start-checkout-route', context, result.ok ? 'started' : result.error.code);
    if (!result.ok) {
      if (result.error.code === 'request.throttled') {
        response.setHeader('Retry-After', String(result.error.retryAfterSeconds));
      }
      throw refusal(result.error, context, this.#logger);
    }
    return {
      orderId: result.value.orderId,
      checkoutUrl: result.value.checkoutUrl,
      payBy: result.value.payBy.toString(),
      total: moneyBody(result.value.total),
    };
  }

  @Get()
  @ApiOperation({ summary: "The customer's own orders, newest first" })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: OrderPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async orders(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { cursor, limit: parseLimit(limit) });
    this.log('ordering.list-orders-route', context, result.ok ? 'listed' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return pageBody(result.value, orderBody);
  }

  @Get(':orderId')
  @ApiOperation({ summary: "One of the customer's own orders" })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: OrderBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: "ordering.order-not-found (also another customer's order)",
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async one(
    @Call() context: CallContext,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { orderId });
    this.log('ordering.view-order-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return orderBody(result.value);
  }

  private refused(error: HttpException, context: CallContext): HttpException {
    this.log('ordering.start-checkout-route', context, 'refused-before-use-case');
    return error;
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
