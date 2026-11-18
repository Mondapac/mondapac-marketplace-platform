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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
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
import { SellerCustomerDetail } from '../application/use-cases/seller-customer-detail.use-case';
import { SellerCustomersCodes } from '../application/use-cases/seller-customers-codes.use-case';
import { SellerCustomersExport } from '../application/use-cases/seller-customers-export.use-case';
import { SellerCustomersList } from '../application/use-cases/seller-customers-list.use-case';
import { closedBody, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const SELECTOR_KEYS = ['view', 'q', 'filters'] as const;
const PAGE_QUERY = /^[0-9]{1,4}$/;

/**
 * The seller's Customers super list over HTTP (customers management phase 3): the list, "select
 * all matching", the export and one customer's page by code. A customer is known by the shop's
 * code for them and their first name only. Every answer is `Cache-Control: no-store`; a write
 * needs the CSRF token. List reads are POST because the filters are a JSON document.
 */
@ApiTags('customers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('customers/seller/customers')
export class SellerCustomersController {
  readonly #logger = new Logger('SellerCustomersController');

  constructor(
    private readonly list: SellerCustomersList,
    private readonly codes: SellerCustomersCodes,
    private readonly exportCustomers: SellerCustomersExport,
    private readonly detail: SellerCustomerDetail,
  ) {}

  @Post('list')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List the shop’s customers (super list)',
    description:
      'Needs customers.seller-customers.view; refused while the shop is not approved and in a ' +
      'Login as Seller session. Body: `view` (all, buyers, followers), `q` (a customer code or its ' +
      'start, 2 to 8 symbols; O reads as 0, I and L as 1), `filters` (follower, lastOrderFrom, ' +
      'lastOrderTo as YYYY-MM-DD, ordersMin, ordersMax, spentMin, spentMax in minor units), `sort` ' +
      '(last-order, first-order, orders, spent, followed, code) and `direction`. With `page` (and ' +
      '`pageSize`, at most 100) the answer carries `paging.total`; without it `cursor` and `limit`. ' +
      '`counts` is the size of every tab. A row is the code, the first name and the numbers with ' +
      'this shop: never an email or an account id.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listCustomers(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      ...SELECTOR_KEYS,
      'sort',
      'direction',
      'page',
      'pageSize',
      'cursor',
      'limit',
    ]);
    if (checked instanceof HttpException) throw checked;
    const result = await this.list.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('list/codes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The customer codes the list matches ("select all matching")',
    description:
      'Needs customers.seller-customers.view. Body: `view`, `q`, `filters` as for the list. At most ' +
      '10,000 codes; more is refused with the total (batch.too-large).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async matchingCodes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, SELECTOR_KEYS);
    if (checked instanceof HttpException) throw checked;
    const result = await this.codes.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('export')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Export the shop’s customers as a CSV or XLSX file',
    description:
      'Needs customers.seller-customers.view and customers.seller-customers.export. Body: `format` ' +
      '(csv, the default, or xlsx) and the customers: `codes` (at most 1000) or `view`, `q`, ' +
      '`filters` as for the list, at most 10,000. Columns: code, first name, orders, spent, ' +
      'currency, first and last order, follower, followed since. Audited (format and count only).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ description: 'text/csv or the .xlsx content type, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const checked = closedBody(request, body, ['format', 'codes', ...SELECTOR_KEYS]);
    const result =
      checked instanceof HttpException ? null : await this.exportCustomers.execute(context, body);
    if (checked instanceof HttpException || (result !== null && !result.ok)) {
      const error =
        checked instanceof HttpException
          ? checked
          : refusal((result as { error: { code: string } }).error, context, this.#logger);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    if (result === null || !result.ok) return;
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      this.#logger.warn({
        msg: 'customers.seller-customers-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Get(':code')
  @ApiOperation({
    summary: 'One of the shop’s customers by code, with the shop’s orders of that customer',
    description:
      'Needs customers.seller-customers.view; the orders also need ordering.seller-order.view ' +
      '(`orders` is null without it). Query `page` and `pageSize` (at most 100) page the orders, ' +
      'newest payment first. A code another shop gave, or none gave, is not found.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.seller-customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async customer(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('code') code: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const input: Record<string, unknown> = { code };
    for (const [key, value] of Object.entries(query)) {
      input[key] =
        (key === 'page' || key === 'pageSize') &&
        typeof value === 'string' &&
        PAGE_QUERY.test(value)
          ? Number(value)
          : value;
    }
    const result = await this.detail.execute(context, input);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
