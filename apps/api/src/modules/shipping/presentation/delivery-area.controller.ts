import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { DeliveryArea } from '../application/use-cases/delivery-area.use-case';
import { refusal } from './http-answers';

export class DeliveryAreaBody {
  @ApiProperty({
    description:
      'True when the postcode is in a service area open for delivery. False otherwise, also for ' +
      'a postcode no area lists.',
  })
  delivers!: boolean;
}

/**
 * Whether the Market delivers to a postcode, for the buyer site (cart, checkout, Deliver to). A
 * thin adapter over one anonymous use case; no session is read and nothing is stored. The answer
 * is public configuration; like every answer of the API it is `no-store`.
 */
@ApiTags('shipping')
@RoutePopulation('customer')
@Controller('shipping/delivery-area')
export class DeliveryAreaController {
  readonly #logger = new Logger('DeliveryAreaController');

  constructor(private readonly area: DeliveryArea) {}

  @Get()
  @ApiOperation({ summary: 'Whether the Market delivers to a postcode' })
  @ApiQuery({ name: 'postcode', required: true, description: '1 to 16 printable characters' })
  @ApiOkResponse({ type: DeliveryAreaBody })
  @ApiBadRequestResponse({ type: Object, description: 'validation.failed (postcode format)' })
  async check(
    @Call() context: CallContext,
    @Query('postcode') postcode: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DeliveryAreaBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.area.execute(context, { postcode });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { delivers: result.value.delivers };
  }
}
