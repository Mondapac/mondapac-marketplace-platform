import { Controller, Get, Logger, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { DeliveryAreaMap } from '../application/use-cases/delivery-area-map.use-case';
import { refusal } from './http-answers';

export class DeliveryAreaMapAreaBody {
  @ApiProperty({ example: 'greater-brisbane' })
  code!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Display names by language tag; always has "en".',
  })
  names!: Record<string, string>;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'GeoJSON MultiPolygon (WGS 84, [longitude, latitude]) of the area, made from public ' +
      'postal-area shapes of the postcodes the area lists.',
  })
  boundary!: {
    type: 'MultiPolygon';
    coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
  };
}

export class DeliveryAreaMapBody {
  @ApiProperty({ type: [DeliveryAreaMapAreaBody], description: 'Areas open for delivery only.' })
  areas!: DeliveryAreaMapAreaBody[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'north, south, west, east in degrees around every area; null when none.',
  })
  bounds!: { north: number; south: number; west: number; east: number } | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'name, licence and attribution of the shapes; null when no area is shown.',
  })
  source!: { name: string; licence: string; attribution: string } | null;
}

/**
 * The outlines of the areas the Market delivers to, for the buyer site's Deliver to map. A thin
 * adapter over one anonymous use case: public configuration, no session read, nothing stored,
 * `no-store` like every answer of the API (the storefront server keeps its own short copy).
 */
@ApiTags('shipping')
@RoutePopulation('customer')
@Controller('shipping/delivery-area-map')
export class DeliveryAreaMapController {
  readonly #logger = new Logger('DeliveryAreaMapController');

  constructor(private readonly map: DeliveryAreaMap) {}

  @Get()
  @ApiOperation({ summary: 'Outlines of the service areas open for delivery' })
  @ApiOkResponse({ type: DeliveryAreaMapBody })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DeliveryAreaMapBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.map.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    const { areas, bounds, source } = result.value;
    return {
      areas: areas.map(({ code, names, boundary }) => ({
        code,
        names: { ...names },
        boundary,
      })),
      bounds,
      source,
    };
  }
}
