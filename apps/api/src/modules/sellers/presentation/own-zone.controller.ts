import { Controller, Get, Logger, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { OwnZoneRead } from '../application/use-cases/own-zone-read.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class OwnZoneBody {
  @ApiProperty({ description: 'IANA zone the seller chose (approved revision).' })
  zone!: string;
}

/**
 * The acting seller's own time zone over HTTP, so the seller panel shows and takes times in it.
 * Thin adapter: who may read it is the gate's rule (`own-resources`, approved sellers only) and
 * the seller is the actor's; no route takes a seller id.
 */
@ApiTags('sellers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('sellers/own-zone')
export class OwnZoneController {
  readonly #logger = new Logger('OwnZoneController');

  constructor(private readonly read: OwnZoneRead) {}

  @Get()
  @ApiOperation({
    summary: "The seller's own operating time zone",
    description: 'The IANA zone of the approved revision. Approved sellers only.',
  })
  @ApiOkResponse({ type: OwnZoneBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: 'session.invalid' })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnZoneBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.read.execute(context, {});
    this.#logger.log({
      msg: 'sellers.own-zone-read',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return { zone: result.value.zone };
  }
}
