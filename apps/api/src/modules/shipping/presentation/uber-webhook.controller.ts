import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { ReceiveUberWebhook } from '../application/use-cases/receive-uber-webhook.use-case';

/** The HTTP status of each refusal. Uber retries any answer that is not 2xx. */
export const UBER_WEBHOOK_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'shipping.signature-invalid': 401,
  'shipping.fleet-off': 404,
  'shipping.carrier-delivery-not-found': 404,
  ...ACCESS_DENIED_STATUS,
});

const ERROR = { type: Object };

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

/**
 * Uber Direct's delivery status webhook of one Market:
 * `POST /shipping/carriers/uber-direct/webhook/<MARKET>`. A thin adapter: the raw body and the
 * `x-uber-signature` header go unchanged to one use case, which verifies, deduplicates and
 * applies the event. The Market is the path's (as for Drive and Stripe), never the body's. The
 * answer never echoes the event, and a refusal says only its code.
 */
@ApiTags('shipping')
@RoutePopulation('customer')
@MarketFromPath()
@Controller('shipping/carriers/uber-direct/webhook')
export class UberWebhookController {
  readonly #logger = new Logger('UberWebhookController');

  constructor(private readonly receive: ReceiveUberWebhook) {}

  @Post(':market')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive an Uber Direct status webhook (called by Uber only)',
    description:
      'Verifies the x-uber-signature header (hex HMAC-SHA256 of the raw body) and takes each ' +
      "event once by its id. A status change moves the seller order's carrier delivery forward: " +
      'picked up is shipped, delivered is delivered, canceled or returned follows the booking ' +
      'rules. Other event kinds are acknowledged and dropped. 404 when Uber Direct is off for ' +
      'the Market or has no signing secret there.',
  })
  @ApiParam({ name: 'market', description: 'The Market id of this endpoint, as in HOSTED_MARKETS' })
  @ApiHeader({ name: 'x-uber-signature', required: true })
  @ApiOkResponse({ schema: { type: 'object', properties: { received: { type: 'boolean' } } } })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed, market.header-invalid or market.not-hosted',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'shipping.signature-invalid' })
  @ApiNotFoundResponse({
    ...ERROR,
    description:
      'shipping.fleet-off (off, or no signing secret, for the Market), or shipping.carrier-delivery-not-found (retried)',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  async webhook(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-uber-signature') signature: unknown,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json' || !Buffer.isBuffer(body)) {
      this.log(context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.receive.execute(context, { payload: body, signature });
    this.log(context, result.ok ? result.value : result.error.code);
    if (!result.ok) {
      const status = UBER_WEBHOOK_STATUS[result.error.code];
      if (status === undefined) throw fail(500, 'internal');
      throw fail(status, result.error.code);
    }
    return { received: true };
  }

  /** The outcome and the correlation id only: never the body, the event or the signature. */
  private log(context: CallContext, outcome: string): void {
    this.#logger.log({
      msg: 'shipping.uber-webhook-route',
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
