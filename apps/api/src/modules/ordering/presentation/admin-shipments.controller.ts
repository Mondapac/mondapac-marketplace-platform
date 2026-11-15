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
import { AdminListShipments } from '../application/use-cases/admin-list-shipments.use-case';
import { SHIPMENT_SORT_KEYS, SHIPMENT_STAGES } from '../domain/admin-shipment-list';
import { DELIVERY_METHODS } from '../domain/delivery-method';
import { ShipmentListPageBody, shipmentListPageBody } from './admin-shipment-list.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

const parseWhole = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The admin Shipments list (Sales > Shipments): the seller orders of the Market's paid orders,
 * one row each. Read only. The controller authenticates only; the use case's gate needs
 * `ordering.order.view`. Every response is `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/shipments')
export class AdminShipmentsController {
  readonly #logger = new Logger('AdminShipmentsController');

  constructor(private readonly list: AdminListShipments) {}

  @Get()
  @ApiOperation({
    summary: "The Market's shipments, newest payment first (admin)",
    description:
      'Needs ordering.order.view. Follows the List paging setting: page numbers with a total ' +
      '(page x pageSize may not pass 10,000, `too-deep`), or Previous/Next with `cursor` and ' +
      '`limit`, which also reaches rows past 10,000.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'From 1; default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Previous/Next paging (List paging prev-next, or past row 10,000): the nextCursor of the ' +
      'page before. Newest payment first; not with page, pageSize, sort or direction.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Previous/Next paging: 1 to 100 rows; default 25.',
  })
  @ApiQuery({ name: 'sort', required: false, enum: SHIPMENT_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'stage', required: false, enum: SHIPMENT_STAGES })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A seller order or order id, or a tracking reference, exact.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Customer name or store name, 2 to 80 characters. Customer names need ' +
      'identity.customer-account.view; without it only store names match.',
  })
  @ApiQuery({ name: 'deliveryMethod', required: false, enum: DELIVERY_METHODS })
  @ApiQuery({
    name: 'attention',
    required: false,
    enum: ['any', 'no-carrier', 'carrier-unknown', 'cancel-unknown'],
  })
  @ApiQuery({ name: 'fleet', required: false, description: 'The fleet code quoted at placement.' })
  @ApiQuery({ name: 'sellerId', required: false, description: "One seller's shipments." })
  @ApiQuery({ name: 'paidFrom', required: false, description: 'ISO instant: paid at or after.' })
  @ApiQuery({ name: 'paidTo', required: false, description: 'ISO instant: paid before.' })
  @ApiQuery({
    name: 'shippedFrom',
    required: false,
    description: 'ISO instant: shipped at or after.',
  })
  @ApiQuery({ name: 'shippedTo', required: false, description: 'ISO instant: shipped before.' })
  @ApiOkResponse({ type: ShipmentListPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'access.unavailable, or ordering.search-unavailable when `search` could not run',
  })
  async shipments(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      page: parseWhole(query['page']),
      pageSize: parseWhole(query['pageSize']),
      cursor: query['cursor'],
      limit: parseWhole(query['limit']),
      sort: query['sort'],
      direction: query['direction'],
      stage: query['stage'],
      q: query['q'],
      search: query['search'],
      deliveryMethod: query['deliveryMethod'],
      attention: query['attention'],
      fleet: query['fleet'],
      sellerId: query['sellerId'],
      paidFrom: query['paidFrom'],
      paidTo: query['paidTo'],
      shippedFrom: query['shippedFrom'],
      shippedTo: query['shippedTo'],
    });
    this.#logger.log({
      msg: 'ordering.admin-list-shipments-route',
      outcome: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return shipmentListPageBody(result.value);
  }
}
