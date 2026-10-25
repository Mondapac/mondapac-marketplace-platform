import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewStoreFlatFee } from '../application/use-cases/view-store-flat-fee.use-case';
import { moneyBody, refusal } from './http-answers';

export class StoreFlatFeeBody {
  @ApiProperty({ description: 'Minor units as a string of digits; zero means free shipping.' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217, the Market currency.' }) currency!: string;
}

/**
 * The flat shipping fee of one store, for the buyer site's store page: a thin adapter over one
 * anonymous use case. No session is read; the store is named by its public address and answers
 * only while it may sell. The answer is `no-store`, like every answer of the API.
 */
@ApiTags('shipping')
@RoutePopulation('customer')
@Controller('shipping/stores')
export class StoreFlatFeeController {
  readonly #logger = new Logger('StoreFlatFeeController');

  constructor(private readonly fee: ViewStoreFlatFee) {}

  @Get(':slug/flat-fee')
  @ApiOperation({
    summary: 'The flat shipping fee of a store that sells now (public)',
    description:
      'No session needed. One fee per seller order. An unknown, retired or not-selling store ' +
      'and a store with no fee set all answer 404 shipping.store-fee-not-found, alike.',
  })
  @ApiOkResponse({ type: StoreFlatFeeBody })
  @ApiNotFoundResponse({ type: Object, description: 'shipping.store-fee-not-found' })
  @ApiServiceUnavailableResponse({ type: Object, description: 'shipping.unavailable' })
  async get(
    @Call() context: CallContext,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreFlatFeeBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.fee.execute(context, { slug });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return moneyBody(result.value);
  }
}
