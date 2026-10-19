import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewStorefrontAssistant } from '../application/use-cases/view-storefront-assistant.use-case';
import { StorefrontAssistantBody } from './assistant.dto';

/**
 * Whether the storefront shows the buyer assistant to this visitor. No session is read: the
 * actor is the Market's anonymous actor, and the answer holds the safe subset only (on for this
 * visitor, guests allowed, reply language, welcome text), never limits, caps, model or rollout.
 * A safe GET, so the population only names the allow-list an unsafe request would use.
 */
@ApiTags('assistant')
@RoutePopulation('customer')
@Controller('assistant/storefront')
export class StorefrontAssistantController {
  constructor(private readonly view: ViewStorefrontAssistant) {}

  @Get()
  @ApiOperation({
    summary: 'Whether to show the buyer assistant (public)',
    description:
      "No session needed. visitor is the widget's own random id (16 to 64 of A-Z a-z 0-9 _ -), " +
      'which keeps one browser in or out of a percentage rollout; without it a percentage ' +
      'rollout leaves the visitor out.',
  })
  @ApiQuery({ name: 'visitor', required: false, type: String })
  @ApiOkResponse({ type: StorefrontAssistantBody })
  async one(
    @Call() context: CallContext,
    @Query('visitor') visitor: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { visitor });
    // The use case cannot fail: its error type is never.
    return result.ok
      ? result.value
      : { enabled: false, guestsAllowed: false, replyLanguage: 'buyer', welcomeText: null };
  }
}
