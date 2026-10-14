import { Body, Controller, Get, HttpCode, Logger, Param, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import { SetFlatFee } from '../application/use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from '../application/use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from '../application/use-cases/view-own-flat-fee.use-case';
import { FlatFeeBody, SetFlatFeeRequest } from './flat-fee.dto';
import { closedBody, moneyBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

const body = (value: { sellerId: string; fee: { amount: bigint; currency: string } }) => ({
  sellerId: value.sellerId,
  ...moneyBody(value.fee),
});

/**
 * The flat shipping fee of a seller (SHP-01): one fee per seller order, set by an admin. Thin
 * adapters: the seller of the seller route comes from the session, never from the request; each
 * use case does its work behind its gate. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('shipping')
@RoutePopulation('admin')
@ReadsSession()
@Controller('shipping/admin/sellers/:sellerId/flat-fee')
export class AdminFlatFeeController {
  readonly #logger = new Logger('AdminFlatFeeController');

  constructor(
    private readonly view: ViewFlatFee,
    private readonly set: SetFlatFee,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A seller's flat shipping fee (admin)",
    description: 'Needs shipping.flat-fee.view. 404 shipping.fee-not-set before a fee exists.',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: FlatFeeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.fee-not-set' })
  async one(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.log('shipping.view-flat-fee-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: "Set a seller's flat shipping fee (admin)",
    description:
      'Needs shipping.flat-fee.manage (protected). Zero is a valid fee (free shipping). The ' +
      'fee applies to orders placed after the change; the change is audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: SetFlatFeeRequest })
  @ApiOkResponse({ type: FlatFeeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.seller-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'shipping.unavailable' })
  async put(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['amount']);
    if (invalid !== null) throw invalid;
    const amount = (requestBody as { amount?: unknown }).amount;
    const result = await this.set.execute(context, { sellerId, amount });
    this.log('shipping.set-flat-fee-route', context, result.ok ? 'set' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
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

/** The signed-in seller's own flat shipping fee. */
@ApiTags('shipping')
@RoutePopulation('seller')
@ReadsSession()
@Controller('shipping/seller/flat-fee')
export class SellerFlatFeeController {
  readonly #logger = new Logger('SellerFlatFeeController');

  constructor(private readonly view: ViewOwnFlatFee) {}

  @Get()
  @ApiOperation({
    summary: "The seller's own flat shipping fee",
    description: 'Needs shipping.own-fee.view. 404 shipping.fee-not-set until an admin sets it.',
  })
  @ApiOkResponse({ type: FlatFeeBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.fee-not-set' })
  async own(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.#logger.log({
      msg: 'shipping.view-own-flat-fee-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
  }
}
