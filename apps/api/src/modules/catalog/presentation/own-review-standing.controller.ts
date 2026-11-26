import { Controller, Get, HttpException, Logger, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
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
import { OwnReviewStanding } from '../application/use-cases/own-review-standing.use-case';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

export class OwnReviewStandingDto {
  @ApiProperty({ enum: ['probation', 'trusted'] }) status!: 'probation' | 'trusted';
  @ApiProperty({ description: 'Offers counted in the current probation; 0 once Trusted.' })
  count!: number;
  @ApiProperty({ description: 'Offers the probation needs; 0 once Trusted.' }) target!: number;
  @ApiProperty({ description: 'True while the shorter probation after a take-down runs.' })
  restarted!: boolean;
}

const STATUS: Readonly<Record<string, number>> = Object.freeze({ 'access.unavailable': 503 });

/**
 * The seller's own probation progress (risk-based Offer approval slice 7). One read, no body,
 * `Cache-Control: no-store`. Only the progress: never the epoch, the admin flags, the Trusted
 * source or date, or any sampling fact.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/review-standing')
export class OwnReviewStandingController {
  readonly #logger = new Logger('OwnReviewStandingController');

  constructor(private readonly standing: OwnReviewStanding) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'Your probation progress',
    description:
      'Needs catalog.own-product.view. Offers counted and the target while in probation; ' +
      'status trusted once through it. `restarted` is true for the shorter probation after a take-down.',
  })
  @ApiOkResponse({ type: OwnReviewStandingDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnReviewStandingDto> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.standing.execute(context, {});
    const outcome: OwnReviewStandingDto | HttpException = result.ok
      ? { ...result.value }
      : refusalWith(STATUS, result.error, response, context);
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-review-standing',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
