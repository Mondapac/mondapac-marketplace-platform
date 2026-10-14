import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Put,
  Post,
  Req,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SetSpecialPrice } from '../application/use-cases/set-special-price.use-case';
import { WithdrawSpecialPrice } from '../application/use-cases/withdraw-special-price.use-case';
import { closedBody, fail } from './http-answers';
import {
  SpecialPriceRequest,
  SpecialPriceWithdrawn,
  SpecialPriceWritten,
  WithdrawSpecialPriceRequest,
} from './special-price.dto';

/** The HTTP status of each refusal of the seller special-price routes. */
export const SPECIAL_PRICE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'pricing.offer-not-found': 404,
  'pricing.special-price.not-found': 404,
  'pricing.currency-mismatch': 422,
  'pricing.amount-out-of-range': 422,
  'pricing.special-not-below-regular': 422,
  'pricing.special-window.invalid': 422,
  'pricing.special-window.start-in-past': 422,
  'pricing.no-regular-price': 409,
  'pricing.series-retired': 409,
  'conflict.stale': 409,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * `PUT .../special-price` sets a special price of one Variant of an own Offer for a window;
 * `POST .../special-price/withdraw` ends the running or scheduled one now and cancels one that
 * waits for review. Thin adapters: the seller comes from the session, one use case each does the
 * work through its gate (`pricing.price.edit`). A deep discount is held and answers 200
 * `pending-review`. The answer to an Offer that is absent, deleted or not the seller's is one
 * byte-identical 404, as for the regular price. Under the platform's default per-origin rate
 * limit only; the per-account write limit is the same known gap as for the regular price.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId/variants/:variantId/special-price')
export class SellerSpecialPriceController {
  readonly #logger = new Logger('SellerSpecialPriceController');

  constructor(
    private readonly setSpecial: SetSpecialPrice,
    private readonly withdrawSpecial: WithdrawSpecialPrice,
  ) {}

  @Put()
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Set a special price of one Variant of an own Offer for a window',
    description:
      'Needs pricing.price.edit and a seller who may sell. The amount is a string of minor ' +
      'units in the Market currency, strictly below the regular price in force. The window is ' +
      'two UTC instants. A new special replaces the running or scheduled one. pending-review ' +
      'means a deep discount is held for review.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiBody({ type: SpecialPriceRequest })
  @ApiOkResponse({ type: SpecialPriceWritten })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'conflict.stale, pricing.no-regular-price or pricing.series-retired',
  })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description:
      'pricing.currency-mismatch, pricing.amount-out-of-range, pricing.special-not-below-regular, ' +
      'pricing.special-window.invalid or pricing.special-window.start-in-past',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async set(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
  ): Promise<SpecialPriceWritten> {
    const input = closedBody(
      request,
      body,
      ['amount', 'currency', 'startsAt', 'endsAt', 'expectedVersion'],
      ['startsAt'],
    );
    let outcome: SpecialPriceWritten | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setSpecial.execute(context, {
        offerId,
        variantId,
        price: { amount: input.amount as string, currency: input.currency as string },
        startsAt: (input.startsAt ?? null) as string | null,
        endsAt: input.endsAt as string,
        expectedVersion: input.expectedVersion as number,
      });
      outcome = result.ok
        ? {
            status: result.value.status,
            seriesVersion: result.value.seriesVersion,
            recordId: result.value.recordId,
            startsAt: result.value.startsAt.toString(),
            endsAt: result.value.endsAt.toString(),
            effectiveFrom: result.value.effectiveFrom?.toString() ?? null,
          }
        : refusal(result.error, context, this.#logger);
    }
    this.#log('pricing.set-special-price', outcome, context);
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('withdraw')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'End the running or scheduled special price now, and cancel one waiting for review',
    description: 'Needs pricing.price.edit and a seller who may sell.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiBody({ type: WithdrawSpecialPriceRequest })
  @ApiOkResponse({ type: SpecialPriceWithdrawn })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'pricing.offer-not-found or pricing.special-price.not-found',
  })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale or pricing.series-retired' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async withdraw(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
  ): Promise<SpecialPriceWithdrawn> {
    const input = closedBody(request, body, ['expectedVersion']);
    let outcome: SpecialPriceWithdrawn | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.withdrawSpecial.execute(context, {
        offerId,
        variantId,
        expectedVersion: input.expectedVersion as number,
      });
      outcome = result.ok
        ? {
            seriesVersion: result.value.seriesVersion,
            endedRecordId: result.value.endedRecordId,
            cancelledRecordId: result.value.cancelledRecordId,
          }
        : refusal(result.error, context, this.#logger);
    }
    this.#log('pricing.withdraw-special-price', outcome, context);
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  #log(msg: string, outcome: object, context: CallContext): void {
    const failed = outcome instanceof HttpException;
    this.#logger[failed && outcome.getStatus() >= 500 ? 'warn' : 'log']({
      msg,
      outcome: failed ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

function refusal(
  error: { readonly code: string; readonly fields?: unknown },
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    SPECIAL_PRICE_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'pricing.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  return error.fields === undefined
    ? fail(status, error.code)
    : fail(status, error.code, { fields: error.fields });
}
