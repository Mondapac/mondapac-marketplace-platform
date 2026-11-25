import {
  Body,
  Controller,
  Get,
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
import { ACCESS_DENIED_STATUS, RequiresStepUp } from '../../../../../platform/authz';
import { Call } from '../../../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../../../platform/call-context/route-population.decorator';
import { SetOfferCost } from '../../../application/use-cases/set-offer-cost.use-case';
import { ViewOfferCosts } from '../../../application/use-cases/view-offer-costs.use-case';
import { closedBody, fail } from '../../http-answers';
import { setRetryAfter } from '../../retry-after';
import { CostPresenter } from './cost.presenter';
import { CostRequest, CostWritten, OfferCostsBody } from './offer-costs.dto';

/** The HTTP status of each refusal of the Cost routes. */
export const COST_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'pricing.acting-as-refused': 403,
  'pricing.offer-not-found': 404,
  'pricing.currency-mismatch': 422,
  'pricing.amount-out-of-range': 422,
  'pricing.series-retired': 409,
  'conflict.stale': 409,
  'request.throttled': 429,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The seller's private Cost (pricing design 6.5; ux F41, C5): its own routes, apart from the price
 * routes, so a Cost is requested only when the seller presses "Show costs". Thin adapters: the
 * seller comes from the session and one use case does the work through its gate
 * (`pricing.cost.view` to read; `pricing.price.edit` and `pricing.cost.view` to write). Every
 * answer, success or refusal, is `Cache-Control: no-store`. A refusal never echoes a value: a
 * validation error carries only paths and codes (Hassan finding 5). Logs hold codes only.
 */
@ApiTags('pricing')
@RoutePopulation('seller')
@Controller('pricing/seller/offers/:offerId')
export class SellerOfferCostsController {
  readonly #logger = new Logger('SellerOfferCostsController');

  constructor(
    private readonly viewCosts: ViewOfferCosts,
    private readonly setCost: SetOfferCost,
  ) {}

  @Get('costs')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read the private Cost of one own Offer, per Variant',
    description:
      'Needs pricing.cost.view and a seller who may sell. Refused when signed in as the seller.',
  })
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiOkResponse({ type: OfferCostsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or pricing.acting-as-refused',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'pricing.offer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
  ): Promise<OfferCostsBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewCosts.execute(context, { offerId });
    this.log('pricing.view-cost-route', context, result.ok ? 'ok' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return {
      offerId: result.value.offerId,
      currency: result.value.currency,
      variants: result.value.variants.map((variant) => ({
        variantId: variant.variantId,
        seriesVersion: variant.seriesVersion,
        cost: CostPresenter.wire(variant.cost),
      })),
    };
  }

  @Put('variants/:variantId/cost')
  @RequiresStepUp('pricing.price.change')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record or clear the private Cost of one Variant of an own Offer',
    description:
      'Needs pricing.price.edit and pricing.cost.view and a seller who may sell. The amount is a ' +
      'string of minor units in the Market currency, GST included; cost null clears it. Never ' +
      'held for review. Refused when signed in as the seller.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiBody({ type: CostRequest })
  @ApiOkResponse({ type: CostWritten })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, access.seller-not-approved, request.csrf or pricing.acting-as-refused',
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
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
  ): Promise<CostWritten> {
    response.setHeader('Cache-Control', 'no-store');
    const input = closedBody(request, body, ['cost', 'expectedVersion']);
    let outcome: CostWritten | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setCost.execute(context, {
        offerId,
        variantId,
        cost: input.cost as { amount: string; currency: string } | null,
        expectedVersion: input.expectedVersion as number | null,
      });
      outcome = result.ok
        ? { status: result.value.status, seriesVersion: result.value.seriesVersion }
        : refusal(result.error, context, this.#logger);
    }
    this.log(
      'pricing.set-cost-route',
      context,
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    );
    if (outcome instanceof HttpException) {
      setRetryAfter(response, outcome);
      throw outcome;
    }
    return outcome;
  }

  /** The outcome code only: never a body, a field value or a Cost (Hassan finding 5). */
  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

function refusal(
  error: {
    readonly code: string;
    readonly fields?: unknown;
    readonly retryAfterSeconds?: number;
  },
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    COST_STATUS[error.code] ??
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
  if (error.retryAfterSeconds !== undefined) {
    return fail(status, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
  return error.fields === undefined
    ? fail(status, error.code)
    : fail(status, error.code, { fields: error.fields });
}
