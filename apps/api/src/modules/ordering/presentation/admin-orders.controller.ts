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
  ApiUnprocessableEntityResponse,
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
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminListOrders } from '../application/use-cases/admin-list-orders.use-case';
import { AdminRefundOrder } from '../application/use-cases/admin-refund-order.use-case';
import { AdminViewOrderDocument } from '../application/use-cases/admin-view-order-document.use-case';
import { AdminViewOrder } from '../application/use-cases/admin-view-order.use-case';
import { OrderDocumentBody, orderDocumentBody } from './documents.dto';
import { closedBody, refusal } from './http-answers';
import { REFUND_BODY_KEYS, RefundBody, RefundRequestBody, refundBody } from './refunds.dto';
import {
  AdminOrderBody,
  AdminOrderPageBody,
  adminOrderBody,
  adminOrderPageBody,
} from './orders.dto';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

const parseLimit = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The admin order reads over HTTP: the Market's orders and one order, for support and oversight,
 * and (tax step 3, switched off) a refund of a seller order. The controller authenticates only;
 * each use case's gate needs `ordering.order.view`, the refund `ordering.order.refund`. A
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
    private readonly refund: AdminRefundOrder,
    private readonly documentOf: AdminViewOrderDocument,
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
    return adminOrderPageBody(result.value);
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

  @Get(':orderId/document')
  @ApiOperation({
    summary: 'The document of an order (admin)',
    description:
      'Needs ordering.order.view. ' +
      'Built from the values frozen at placement. An order confirmation (no number) while ' +
      'tax.invoice.enabled is off; on, 503 ordering.invoice-numbering-unavailable (numbering ' +
      'not built).',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: OrderDocumentBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.order-not-found' })
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
    this.log(
      'ordering.admin-view-order-document-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return orderDocumentBody(result.value);
  }

  @Post(':orderId/seller-orders/:sellerOrderId/refunds')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refund part or all of a seller order of a paid order (admin; Stripe test mode only)',
    description:
      'Needs ordering.order.refund (protected). Off until the Market switch ' +
      'tax.refundCredit.enabled is on: 409 ordering.refund-disabled. Lines (units) and part or ' +
      'all of the shipping fee; the tax reversed comes from the tax frozen on the order. ' +
      'lossBearer is seller (default; the seller ledger is reversed) or platform (with a ' +
      'lossReasonCode; the seller keeps its share). One ' +
      'refund at a time per seller order (409 ordering.refund-in-progress while one is pending).',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiParam({ name: 'sellerOrderId', format: 'uuid' })
  @ApiBody({ type: RefundRequestBody })
  @ApiOkResponse({ type: RefundBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.seller-order-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'ordering.refund-disabled, ordering.refund-not-allowed, ordering.refund-in-progress or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description:
      'ordering.refund-exceeds (details.fields), ordering.refund-tax-unknown or ordering.refund-rejected',
  })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'ordering.refund-tax-unavailable or access.unavailable',
  })
  async refundSellerOrder(
    @Call() context: CallContext,
    @Param('orderId') orderId: string,
    @Param('sellerOrderId') sellerOrderId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, REFUND_BODY_KEYS);
    if (invalid !== null) throw invalid;
    const { lines, shippingAmount, reason, lossBearer, lossReasonCode } = body as Record<
      string,
      unknown
    >;
    const result = await this.refund.execute(context, {
      orderId,
      sellerOrderId,
      lines,
      shippingAmount,
      reason,
      lossBearer,
      lossReasonCode,
    });
    this.log(
      'ordering.admin-refund-order-route',
      context,
      result.ok ? `refund-${result.value.state}` : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return refundBody(result.value);
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
