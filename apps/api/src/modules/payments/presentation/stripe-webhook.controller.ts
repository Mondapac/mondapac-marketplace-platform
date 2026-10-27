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
import { ReceiveStripeEvent } from '../application/use-cases/receive-stripe-event.use-case';

/** The HTTP status of each refusal. Stripe retries any answer that is not 2xx. */
export const WEBHOOK_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'payments.signature-invalid': 400,
  'payments.event-refused': 400,
  'payments.webhook-unavailable': 503,
  ...ACCESS_DENIED_STATUS,
});

const ERROR = { type: Object };

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

/**
 * The Stripe webhook endpoint of one Market: `POST /payments/stripe/webhook/<MARKET>` (one
 * endpoint per Market in the Stripe dashboard, since Stripe cannot send `x-market-id`). A thin
 * adapter: the raw body and the `Stripe-Signature` header go unchanged to one use case, which
 * verifies, deduplicates and stores the event; the worker applies it. The answer never echoes
 * the event.
 */
@ApiTags('payments')
@RoutePopulation('customer')
@MarketFromPath()
@Controller('payments/stripe/webhook')
export class StripeWebhookController {
  readonly #logger = new Logger('StripeWebhookController');

  constructor(private readonly receive: ReceiveStripeEvent) {}

  @Post(':market')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a Stripe webhook event (called by Stripe only)',
    description:
      'Verifies the Stripe-Signature header over the raw body, refuses live-mode and ' +
      'connected-account events and events of another Market, and stores each Checkout event ' +
      'once by its id. Other event types are acknowledged and dropped.',
  })
  @ApiParam({ name: 'market', description: 'The Market id of this endpoint, as in HOSTED_MARKETS' })
  @ApiHeader({ name: 'stripe-signature', required: true })
  @ApiOkResponse({ schema: { type: 'object', properties: { received: { type: 'boolean' } } } })
  @ApiBadRequestResponse({
    ...ERROR,
    description:
      'validation.failed, payments.signature-invalid, payments.event-refused, ' +
      'market.header-invalid or market.not-hosted',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'payments.webhook-unavailable' })
  async webhook(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('stripe-signature') signature: unknown,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json' || !Buffer.isBuffer(body)) {
      this.log(context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.receive.execute(context, {
      payload: body,
      signature,
      clientAddress: clientAddressOf(clientAddressFrom(request)),
    });
    this.log(context, result.ok ? result.value : result.error.code);
    if (!result.ok) {
      const status = WEBHOOK_STATUS[result.error.code];
      if (status === undefined) throw fail(500, 'internal');
      throw fail(status, result.error.code);
    }
    return { received: true };
  }

  /** The outcome and the correlation id only: never the body, the event or the signature. */
  private log(context: CallContext, outcome: string): void {
    this.#logger.log({
      msg: 'payments.stripe-webhook-route',
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
