import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Put,
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
import { ClearCommissionRate } from '../application/use-cases/clear-commission-rate.use-case';
import { SetCommissionRate } from '../application/use-cases/set-commission-rate.use-case';
import { ViewCommissionRate } from '../application/use-cases/view-commission-rate.use-case';
import { ViewOwnLedger } from '../application/use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from '../application/use-cases/view-seller-ledger.use-case';
import {
  CommissionRateBody,
  LedgerBody,
  ledgerBody,
  rateBody,
  SetCommissionRateRequest,
} from './commission-payouts.dto';
import { closedBody, parseLimit, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const CURSOR = {
  name: 'cursor',
  required: false,
  description: 'The `nextCursor` of the last page.',
};
const LIMIT = { name: 'limit', required: false, description: '1 to 100; default 50.' };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * A seller's commission rate (COM-02) and ledger, for admins. Thin adapters: each use case does
 * its work behind its gate. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('admin')
@ReadsSession()
@Controller('commission-payouts/admin/sellers/:sellerId')
export class AdminCommissionController {
  readonly #logger = new Logger('AdminCommissionController');

  constructor(
    private readonly viewRate: ViewCommissionRate,
    private readonly setRate: SetCommissionRate,
    private readonly clearRate: ClearCommissionRate,
    private readonly viewLedger: ViewSellerLedger,
  ) {}

  @Get('commission-rate')
  @ApiOperation({
    summary: "A seller's commission rate (admin)",
    description:
      "Needs commission-payouts.settlement.view. The seller's own rate if one is set, else the Market rate.",
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: CommissionRateBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.rate-unavailable' })
  async rate(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewRate.execute(context, { sellerId });
    logRoute(
      this.#logger,
      'commission-payouts.view-commission-rate-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return rateBody(result.value);
  }

  @Put('commission-rate')
  @HttpCode(200)
  @ApiOperation({
    summary: "Set a seller's own commission rate (admin)",
    description:
      'Needs commission-payouts.commission-rate.edit (protected). Applies to orders placed after ' +
      'the change; earlier orders keep the rate frozen on their lines. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: SetCommissionRateRequest })
  @ApiOkResponse({ type: CommissionRateBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.seller-not-found' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.unavailable or commission-payouts.rate-unavailable',
  })
  async put(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['rateBps']);
    if (invalid !== null) throw invalid;
    const rateBps = (requestBody as { rateBps?: unknown }).rateBps;
    const result = await this.setRate.execute(context, { sellerId, rateBps });
    logRoute(
      this.#logger,
      'commission-payouts.set-commission-rate-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return rateBody(result.value);
  }

  @Delete('commission-rate')
  @HttpCode(200)
  @ApiOperation({
    summary: "Remove a seller's own commission rate (admin)",
    description:
      'Needs commission-payouts.commission-rate.edit (protected). The seller is back on the ' +
      'Market rate for orders placed after the change. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: CommissionRateBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.rate-not-set' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.rate-unavailable' })
  async clear(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.clearRate.execute(context, { sellerId });
    logRoute(
      this.#logger,
      'commission-payouts.clear-commission-rate-route',
      context,
      result.ok ? 'cleared' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return rateBody(result.value);
  }

  @Get('ledger')
  @ApiOperation({
    summary: "A seller's ledger and balance (admin)",
    description: 'Needs commission-payouts.settlement.view. Newest rows first.',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiQuery(CURSOR)
  @ApiQuery(LIMIT)
  @ApiOkResponse({ type: LedgerBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.rate-unavailable' })
  async ledger(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewLedger.execute(context, {
      sellerId,
      cursor,
      limit: parseLimit(limit),
    });
    logRoute(
      this.#logger,
      'commission-payouts.view-seller-ledger-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ledgerBody(result.value);
  }
}

/** The signed-in seller's own ledger: what it sold, the commission taken and the balance. */
@ApiTags('commission-payouts')
@RoutePopulation('seller')
@ReadsSession()
@Controller('commission-payouts/seller/ledger')
export class SellerLedgerController {
  readonly #logger = new Logger('SellerLedgerController');

  constructor(private readonly view: ViewOwnLedger) {}

  @Get()
  @ApiOperation({
    summary: "The seller's own ledger and balance",
    description: 'Needs commission-payouts.earnings.view. Newest rows first.',
  })
  @ApiQuery(CURSOR)
  @ApiQuery(LIMIT)
  @ApiOkResponse({ type: LedgerBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.rate-unavailable' })
  async own(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { cursor, limit: parseLimit(limit) });
    logRoute(
      this.#logger,
      'commission-payouts.view-own-ledger-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return ledgerBody(result.value);
  }
}
