import { Body, Controller, Get, Logger, Param, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SellerActivitiesGetUseCase } from '../application/use-cases/seller-activities-get.use-case';
import { SellerActivitiesSetUseCase } from '../application/use-cases/seller-activities-set.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class SellerActivitiesRequest {
  @ApiProperty({
    format: 'uuid',
    description: 'The one main business activity. Active, in the Market.',
  })
  mainActivityId!: string;

  @ApiProperty({
    type: [String],
    maxItems: 9,
    description: 'Up to nine more activities: distinct, active, and not the main one.',
  })
  extraActivityIds!: string[];

  @ApiProperty({
    minLength: 1,
    maxLength: 300,
    description: 'Why an admin changes the activities directly. Kept in the change log.',
  })
  reason!: string;
}

export class SellerActivitiesChangeBody {
  @ApiProperty({ format: 'uuid' })
  mainActivityId!: string;

  @ApiProperty({ type: [String] })
  extraActivityIds!: string[];

  @ApiProperty({ description: 'False when the seller already carried exactly this set.' })
  changed!: boolean;
}

export class SellerActivitiesLastChangeBody {
  @ApiProperty({ format: 'uuid', description: 'The admin account that made the change.' })
  changedBy!: string;

  @ApiProperty({ description: 'An instant in UTC (ISO 8601).' })
  changedAt!: string;

  @ApiProperty()
  reason!: string;
}

export class SellerActivitiesBody {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  mainActivityId!: string | null;

  @ApiProperty({ type: [String] })
  extraActivityIds!: string[];

  @ApiProperty({ type: SellerActivitiesLastChangeBody, nullable: true })
  lastChange!: SellerActivitiesLastChangeBody | null;
}

/**
 * The business activities a seller carries (ADR-0040 decision 4; package 4a), for a Platform
 * Administrator. A thin adapter: the `CallContext` comes from `@Call()` and the admin session cookie
 * of the request's Market; an unsafe request also needs `Origin` on the Market's admin list,
 * `Sec-Fetch-Site: same-origin` and the CSRF header. Who may do it is the use case's gate
 * (`sellers.business-activity.view` to read, `.manage` to replace). The body is JSON only and
 * closed; the answers are `Cache-Control: no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class SellerActivitiesController {
  readonly #logger = new Logger('SellerActivitiesController');

  constructor(
    private readonly getActivities: SellerActivitiesGetUseCase,
    private readonly setActivities: SellerActivitiesSetUseCase,
  ) {}

  @Get(':sellerId/business-activities')
  @ApiOperation({
    summary: 'Read the business activities of a seller (admin)',
    description:
      'The main activity, the extras and the latest change with its reason. A seller with no ' +
      'activity answers a null main activity. Needs sellers.business-activity.view.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: SellerActivitiesBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async getBusinessActivities(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerActivitiesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.getActivities.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-activities-get',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      mainActivityId: result.value.mainActivityId,
      extraActivityIds: [...result.value.extraActivityIds],
      lastChange: result.value.lastChange,
    };
  }

  @Put(':sellerId/business-activities')
  @ApiOperation({
    summary: 'Replace the business activities of a seller (admin)',
    description:
      'Replaces the whole set: exactly one main activity, up to nine extras, a reason of 1 to ' +
      '300 characters. Every activity must exist and be active in the Market. A repeat of the ' +
      'set the seller already carries writes nothing. Needs sellers.business-activity.manage.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SellerActivitiesRequest })
  @ApiOkResponse({ type: SellerActivitiesChangeBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async putBusinessActivities(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerActivitiesChangeBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.setActivities.execute(context, { sellerId, body });
    this.#logger.log({
      msg: 'sellers.seller-activities-set',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      mainActivityId: result.value.mainActivityId,
      extraActivityIds: [...result.value.extraActivityIds],
      changed: result.value.changed,
    };
  }
}
