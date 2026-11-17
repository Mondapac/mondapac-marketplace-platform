import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import {
  STOREFRONT_OFF,
  ViewStorefrontAssistant,
} from '../application/use-cases/view-storefront-assistant.use-case';
import { PREVIEW_HEADER, StorefrontAssistantBody } from './assistant.dto';

/**
 * Whether the storefront shows the buyer assistant to this visitor. No session is read: the
 * actor is the Market's anonymous actor, and the answer holds the safe subset only (on for this
 * visitor, guests allowed, reply language, welcome text, retention days and quick prompts), never limits, caps, model or rollout.
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
      'rollout leaves the visitor out. lang is the storefront language (a BCP 47 tag) for the ' +
      "quick prompts; a language the Market does not support gets the Market's default.",
  })
  @ApiQuery({ name: 'visitor', required: false, type: String })
  @ApiQuery({ name: 'lang', required: false, type: String })
  @ApiHeader({
    name: PREVIEW_HEADER,
    required: false,
    description:
      'An internal preview token from POST /assistant/admin/preview-token: the assistant then ' +
      'answers this browser while the audience is internal. Invalid or expired counts as none.',
  })
  @ApiOkResponse({ type: StorefrontAssistantBody })
  async one(
    @Call() context: CallContext,
    @Query('visitor') visitor: unknown,
    @Query('lang') lang: unknown,
    @Headers(PREVIEW_HEADER) preview: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { visitor, lang, preview });
    // The use case cannot fail: its error type is never.
    return result.ok ? result.value : STOREFRONT_OFF;
  }
}
