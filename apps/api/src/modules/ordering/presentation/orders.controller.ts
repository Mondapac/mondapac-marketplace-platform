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
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { DeliveryQuotes } from '../application/use-cases/delivery-quotes.use-case';
import { ListOrders } from '../application/use-cases/list-orders.use-case';
import { RegeneratePickupCode } from '../application/use-cases/regenerate-pickup-code.use-case';
import { PayByCard } from '../application/use-cases/pay-by-card.use-case';
import { StartCheckout } from '../application/use-cases/start-checkout.use-case';
import { ViewOrder } from '../application/use-cases/view-order.use-case';
import { ViewOrderDocument } from '../application/use-cases/view-order-document.use-case';
import { OrderDocumentBody, orderDocumentBody } from './documents.dto';
import { closedBody, moneyBody, refusal } from './http-answers';
import {
  CardPaymentStartedView,
  CheckoutRequest,
  CheckoutStartedView,
  DeliveryQuoteRequest,
  DeliveryQuotesView,
  deliveryQuotesBody,
  OrderPageBody,
  OwnOrderBody,
  OwnPickupCodeBody,
  PayByCardRequest,
  ownListOrderBody,
  ownOrderBody,
  ownPickupCodeBody,
  pageBody,
} from './orders.dto';

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
    private readonly pay: PayByCard,
    private readonly quotes: DeliveryQuotes,
    private readonly view: ViewOrder,
    private readonly list: ListOrders,
    private readonly documentOf: ViewOrderDocument,
    private readonly regenerate: RegeneratePickupCode,
  ) {}

  @Post('delivery-quotes')
  @HttpCode(200)
  @ApiOperation({
    summary: "The delivery methods and prices of the customer's basket for a saved address",
    description:
      'For each seller of the basket: the delivery methods open now (or the reason one is not), ' +
      'the price of each delivering method (the courier quote plus the Market margin, tax ' +
      'included, with the tax apart), the scheduled-window facts and the pickup postcode. The ' +
      'prices are stored on the server and held for ten minutes; send the `quoteId` back in ' +
      'checkout. The client never sends a price. Only the postcode, suburb and region of the ' +
      'saved address reach a courier.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: DeliveryQuoteRequest })
  @ApiOkResponse({ type: DeliveryQuotesView })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (addressId required or format)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'ordering.cart-not-ready (details.sellers) or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description:
      'ordering.address-not-found, ordering.outside-delivery-area, ordering.cart-empty or ' +
      'ordering.cart-not-purchasable',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'ordering.check-unavailable or access.unavailable',
  })
  async deliveryQuotes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['addressId']);
    if (invalid !== null) throw this.refused(invalid, context);
    const { addressId } = body as { addressId?: unknown };
    const result = await this.quotes.execute(context, { addressId });
    this.log('ordering.delivery-quotes-route', context, result.ok ? 'quoted' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return deliveryQuotesBody(result.value);
  }

  @Post('checkout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start checkout: the cart becomes a pending order and a hosted payment page',
    description:
      "Copies the chosen address of the customer's address book onto the order (a later change " +
      'of the address book never touches it) after checking the Market delivers to its ' +
      'postcode, keeps the optional note to each seller with it, reserves the stock for the whole cart, stores the ' +
      'order with its seller split and opens a Stripe Checkout page. Nothing is charged here. ' +
      'Send the customer to checkoutUrl.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: CheckoutRequest })
  @ApiOkResponse({ type: CheckoutStartedView })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed (details.fields: addressId required or format; sellerNotes type, ' +
      'range, format or length; deliveryMethods.<sellerId>.method, windowStart, windowEnd or quoteId)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'ordering.stock-insufficient (details.lines), ordering.cart-not-ready (details.sellers: ' +
      'sellerId, reason below-minimum or check-unavailable, minimum), ordering.delivery-quote-changed (details.quotes: sellerId, quoteId, total, validUntil; the delivery price moved, nothing was charged) or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description:
      "ordering.address-not-found (not one of the customer's addresses), " +
      'ordering.outside-delivery-area (the Market does not deliver to its postcode), ' +
      'ordering.delivery-method-unavailable (details.methodSellerIds: the seller does not offer ' +
      'the chosen method), ordering.pickup-unavailable (details.methodSellerIds: the seller has ' +
      'no approved pickup address), ordering.cart-empty or ' +
      'ordering.cart-not-purchasable (details.lineIndexes)',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'ordering.check-unavailable, ordering.payment-unavailable or access.unavailable',
  })
  async checkout(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['addressId', 'sellerNotes', 'deliveryMethods']);
    if (invalid !== null) throw this.refused(invalid, context);
    const { addressId, sellerNotes, deliveryMethods } = body as {
      addressId?: unknown;
      sellerNotes?: unknown;
      deliveryMethods?: unknown;
    };
    const result = await this.start.execute(context, { addressId, sellerNotes, deliveryMethods });
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

  @Post('pay')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pay by card: the cart becomes a pending order and the card is authorised',
    description:
      'The same order as checkout (address, notes, delivery choices, stock hold) but the card is ' +
      'paid on the MondaPac page: send the ConfirmationToken of the Payment Element. The server ' +
      'prices everything again; the client never sends a price, fee, discount or tax. Visa and ' +
      'Mastercard only (read from Stripe, not from the client). The money is only held here ' +
      '(manual capture); the order is confirmed and captured when the signed Stripe event ' +
      'arrives. A customer has a few attempts per ten minutes.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PayByCardRequest })
  @ApiOkResponse({ type: CardPaymentStartedView })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed (details.fields: confirmationToken required, format or invalid; ' +
      'expectedTotal format; and the fields of checkout)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'ordering.price-changed (details.total: the total now), ordering.stock-insufficient, ' +
      'ordering.cart-not-ready, ordering.delivery-quote-changed or conflict.retry',
  })
  @ApiResponse({
    status: 402,
    ...ERROR,
    description: 'ordering.card-declined: the bank refused the card; nothing was charged',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description:
      'ordering.card-not-accepted (Visa and Mastercard only) and the refusals of checkout',
  })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'request.throttled (Retry-After)' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'ordering.check-unavailable, ordering.payment-unavailable or access.unavailable',
  })
  async payByCard(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, [
      'addressId',
      'sellerNotes',
      'deliveryMethods',
      'confirmationToken',
      'expectedTotal',
    ]);
    if (invalid !== null) throw this.refused(invalid, context);
    const { addressId, sellerNotes, deliveryMethods, confirmationToken, expectedTotal } =
      body as Record<string, unknown>;
    const result = await this.pay.execute(context, {
      addressId,
      sellerNotes,
      deliveryMethods,
      confirmationToken,
      expectedTotal,
    });
    // Only the outcome: never the token, the secret or anything of the card.
    this.log(
      'ordering.pay-by-card-route',
      context,
      result.ok ? result.value.status : result.error.code,
    );
    if (!result.ok) {
      if (result.error.code === 'request.throttled') {
        response.setHeader('Retry-After', String(result.error.retryAfterSeconds));
      }
      throw refusal(result.error, context, this.#logger);
    }
    return {
      orderId: result.value.orderId,
      status: result.value.status,
      clientSecret: result.value.clientSecret,
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
    return pageBody(result.value, ownListOrderBody);
  }

  @Get(':orderId')
  @ApiOperation({ summary: "One of the customer's own orders" })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: OwnOrderBody })
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
    return ownOrderBody(result.value);
  }

  @Get(':orderId/document')
  @ApiOperation({
    summary: "The document of one of the customer's own paid orders",
    description:
      'Own orders only. Built from the values frozen at placement. An order confirmation (no number) ' +
      'while tax.invoice.enabled is off; on, 503 ordering.invoice-numbering-unavailable ' +
      '(numbering not built).',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: OrderDocumentBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: "ordering.order-not-found (also another customer's order)",
  })
  @ApiConflictResponse({ ...ERROR, description: 'ordering.document-not-available (not paid)' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'ordering.invoice-numbering-unavailable or access.unavailable',
  })
  async document(
    @Call() context: CallContext,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.documentOf.execute(context, { orderId });
    this.log('ordering.view-order-document-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return orderDocumentBody(result.value);
  }

  @Post(':orderId/pickup/:sellerId/regenerate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get a new pickup code for one pickup part of an own order',
    description:
      'Own orders only. For a part the customer collects in person that the seller has marked ' +
      'ready and that is not collected yet: the old code stops working, the wrong-try count goes ' +
      'back to zero and a lock is lifted. The body is an empty JSON object. The new code is ' +
      'answered here, to the customer only.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  @ApiOkResponse({ type: OwnPickupCodeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: "ordering.order-not-found (also another customer's order)",
  })
  @ApiConflictResponse({
    ...ERROR,
    description: 'ordering.fulfilment-conflict (not a ready pickup part, or already collected)',
  })
  async regeneratePickup(
    @Call() context: CallContext,
    @Param('orderId') orderId: string,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body);
    if (invalid !== null) throw invalid;
    const result = await this.regenerate.execute(context, { orderId, sellerId });
    this.log(
      'ordering.regenerate-pickup-code-route',
      context,
      result.ok ? 'regenerated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ownPickupCodeBody(result.value);
  }

  private refused(error: HttpException, context: CallContext): HttpException {
    this.log('ordering.checkout-route', context, 'refused-before-use-case');
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
