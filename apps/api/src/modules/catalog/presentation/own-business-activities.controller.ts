import { Controller, Get, Header, Logger, Res } from '@nestjs/common';
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
import { OwnBusinessActivities } from '../application/use-cases/own-business-activities.use-case';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

export class OwnBusinessActivityChoiceBody {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The stable code of the activity.' })
  code!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: "The name by locale. Show the seller's language, else `defaultLocale`.",
  })
  names!: Record<string, string>;
}

export class OwnBusinessActivitiesBody {
  @ApiProperty({ type: [OwnBusinessActivityChoiceBody] })
  items!: OwnBusinessActivityChoiceBody[];

  @ApiProperty({ description: "The Market's default locale." })
  defaultLocale!: string;
}

const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'access.denied': 403,
  'access.unavailable': 503,
});

/**
 * The business activities a seller may choose during setup (BUG-012 step 2; ADR-0040 decision 4):
 * the ACTIVE ones of the seller's Market, as ids, codes and names. Read-only; seller session.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/own/business-activities')
export class OwnBusinessActivitiesController {
  readonly #logger = new Logger('OwnBusinessActivitiesController');

  constructor(private readonly activities: OwnBusinessActivities) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The business activities a seller may choose',
    description:
      'The active activities of the Market with their names by locale. Needs ' +
      'catalog.own-product.edit; allowed while the seller is not approved. Nothing else of the ' +
      'activity (scope, categories) is returned.',
  })
  @ApiOkResponse({ type: OwnBusinessActivitiesBody })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnBusinessActivitiesBody> {
    const result = await this.activities.execute(context, {});
    this.#logger.log({
      msg: 'catalog.own-business-activities',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusalWith(STATUS, result.error, response, context);
    return {
      items: result.value.items.map((item) => ({ ...item, names: { ...item.names } })),
      defaultLocale: result.value.defaultLocale,
    };
  }
}
