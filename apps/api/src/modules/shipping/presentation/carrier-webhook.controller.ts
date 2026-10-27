import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
  Body,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { clientAddressOf } from '../../../platform/rate-limit/client-origin';
import { ReceiveCarrierWebhook } from '../application/use-cases/receive-carrier-webhook.use-case';

/** The HTTP status of each refusal. Drive retries any answer that is not 2xx. */
export const CARRIER_WEBHOOK_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'shipping.signature-invalid': 400,
  'shipping.event-refused': 400,
  'shipping.carrier-delivery-not-found': 404,
  'shipping.webhook-unavailable': 503,
  ...ACCESS_DENIED_STATUS,
});

const ERROR = { type: Object };

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

/**
 * Mondapac Drive's status webhook of one Market:
 * `POST /shipping/carriers/mondapac-drive/webhook/<MARKET>` (SHP-03). A thin adapter: the raw
 * body and the `Drive-Timestamp` and `Drive-Signature` headers go unchanged to one use case,
 * which verifies, deduplicates and applies the event. The answer never echoes the event.
 */
@ApiTags('shipping')
@RoutePopulation('customer')
@MarketFromPath()
@Controller('shipping/carriers/mondapac-drive/webhook')
export class CarrierWebhookController {
  readonly #logger = new Logger('CarrierWebhookController');

  constructor(private readonly receive: ReceiveCarrierWebhook) {}

  @Post(':market')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a Mondapac Drive status webhook (called by Drive only)',
    description:
      'Verifies the Drive-Signature header (HMAC-SHA256 of "<Drive-Timestamp>.<raw body>", ' +
      'within 300 seconds) and takes each event once by its id. A status change moves the ' +
      "seller order's carrier delivery forward: picked up is shipped, delivered is delivered, " +
      'failed or returned is an exception. Other event types are acknowledged and dropped.',
  })
  @ApiParam({ name: 'market', description: 'The Market id of this endpoint, as in HOSTED_MARKETS' })
  @ApiHeader({ name: 'drive-timestamp', required: true })
  @ApiHeader({ name: 'drive-signature', required: true })
  @ApiOkResponse({ schema: { type: 'object', properties: { received: { type: 'boolean' } } } })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed, shipping.signature-invalid, shipping.event-refused, ' +
      'market.header-invalid or market.not-hosted',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.carrier-delivery-not-found (retried)' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'shipping.webhook-unavailable' })
  async webhook(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('drive-timestamp') timestamp: unknown,
    @Headers('drive-signature') signature: unknown,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json' || !Buffer.isBuffer(body)) {
      this.log(context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.receive.execute(context, {
      payload: body,
      timestamp,
      signature,
      clientAddress: clientAddressOf(clientAddressFrom(request)),
    });
    this.log(context, result.ok ? result.value : result.error.code);
    if (!result.ok) {
      const status = CARRIER_WEBHOOK_STATUS[result.error.code];
      if (status === undefined) throw fail(500, 'internal');
      throw fail(status, result.error.code);
    }
    return { received: true };
  }

  /** The outcome and the correlation id only: never the body, the event or the signature. */
  private log(context: CallContext, outcome: string): void {
    this.#logger.log({
      msg: 'shipping.carrier-webhook-route',
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
