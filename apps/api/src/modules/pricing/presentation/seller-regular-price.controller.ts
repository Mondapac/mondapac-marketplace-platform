import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Put,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SetRegularPrice } from '../application/use-cases/set-regular-price.use-case';
import { closedBody, fail } from './http-answers';
import { RegularPriceRequest, RegularPriceWritten } from './regular-price.dto';

/** The HTTP status of each refusal of the seller regular-price route. */
export const REGULAR_PRICE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'pricing.offer-not-found': 404,
  'pricing.currency-mismatch': 422,
  'pricing.amount-out-of-range': 422,
  'pricing.series-retired': 409,
  'conflict.stale': 409,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * `PUT /pricing/seller/offers/:offerId/variants/:variantId/regular-price`: a seller sets the
 * regular price of one Variant of an own Offer, from now. A thin adapter: the seller comes from
 * the session, one use case does the work through its gate (`pricing.price.edit`). A jump past
 * the Market's threshold is held and answers 200 `pending-review`. The answer to an Offer that
 * is absent, deleted or not the seller's is one byte-identical 404. Under the platform's
 * default per-origin rate limit only; a per-account write limit is a known gap (security review
 * of the route), tracked for a follow-up.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId/variants/:variantId/regular-price')
export class SellerRegularPriceController {
  readonly #logger = new Logger('SellerRegularPriceController');

  constructor(private readonly setPrice: SetRegularPrice) {}

  @Put()
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Set the regular price of one Variant of an own Offer',
    description:
      'Needs pricing.price.edit and a seller who may sell. The amount is a string of minor ' +
      'units in the Market currency. pending-review means a large jump is held for review.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiBody({ type: RegularPriceRequest })
  @ApiOkResponse({ type: RegularPriceWritten })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale or pricing.series-retired' })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'pricing.currency-mismatch or pricing.amount-out-of-range',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async set(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) _response: Response,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
  ): Promise<RegularPriceWritten> {
    const input = closedBody(request, body, ['amount', 'currency', 'expectedVersion']);
    let outcome: RegularPriceWritten | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setPrice.execute(context, {
        offerId,
        variantId,
        price: { amount: input.amount as string, currency: input.currency as string },
        expectedVersion: input.expectedVersion as number | null,
      });
      outcome = result.ok
        ? {
            status: result.value.status,
            seriesVersion: result.value.seriesVersion,
            recordId: result.value.recordId,
            effectiveFrom: result.value.effectiveFrom?.toString() ?? null,
          }
        : refusal(result.error, context, this.#logger);
    }
    this.#logger[outcome instanceof HttpException && outcome.getStatus() >= 500 ? 'warn' : 'log']({
      msg: 'pricing.set-regular-price',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}

function refusal(
  error: { readonly code: string; readonly fields?: unknown },
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    REGULAR_PRICE_STATUS[error.code] ??
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
