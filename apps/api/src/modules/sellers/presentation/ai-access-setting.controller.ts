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
import { ChangeAiAccessUseCase } from '../application/use-cases/change-ai-access.use-case';
import { ViewAiAccessUseCase } from '../application/use-cases/view-ai-access.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class AiAccessRequest {
  @ApiProperty({ description: 'Whether AI is switched on for the seller (SEL-25).' })
  enabled!: boolean;
}

export class AiAccessChangedBody {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ description: 'False when the switch already held the value.' })
  changed!: boolean;
}

export class AiAccessViewBody {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When an admin last changed the switch (UTC); null when it never changed.',
  })
  changedAt!: string | null;
}

/**
 * The AI switch of a seller (SEL-25; ADR-0019 decision 7), for an admin: the read needs
 * `sellers.seller.view`, the change `sellers.seller-settings.edit`. A thin adapter: the
 * `CallContext` comes from `@Call()` and the admin session cookie of the request's Market; an
 * unsafe request also needs `Origin` on the Market's admin list, `Sec-Fetch-Site: same-origin` and
 * the CSRF header. Who may do it is the use case's gate. The body is JSON only and closed; the
 * answers are `Cache-Control: no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class AiAccessSettingController {
  readonly #logger = new Logger('AiAccessSettingController');

  constructor(
    private readonly change: ChangeAiAccessUseCase,
    private readonly view: ViewAiAccessUseCase,
  ) {}

  @Get(':sellerId/ai-access')
  @ApiOperation({
    summary: "Read a seller's AI switch (admin)",
    description: 'Off by default. Needs sellers.seller.view.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: AiAccessViewBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  async getAiAccess(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AiAccessViewBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.ai-access-read',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      enabled: result.value.enabled,
      changedAt: result.value.changedAt === null ? null : result.value.changedAt.toString(),
    };
  }

  @Put(':sellerId/ai-access')
  @ApiOperation({
    summary: "Switch a seller's AI on or off (admin)",
    description:
      'Off by default. No event is raised: AI features read the switch when they run. Needs ' +
      'sellers.seller-settings.edit.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AiAccessRequest })
  @ApiOkResponse({ type: AiAccessChangedBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  async putAiAccess(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AiAccessChangedBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.change.execute(context, { sellerId, body });
    this.#logger.log({
      msg: 'sellers.ai-access-set',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }
}
