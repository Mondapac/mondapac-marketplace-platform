import { Body, Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiHeader,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { RecordBlockEvents } from '../application/use-cases/record-block-events.use-case';
import { BLOCK_REQUEST_FIELDS } from '../domain/block-count';
import { BlockEventsRequest } from './engagement.dto';
import { globalPrivacyControlOf } from './guest-cookie';
import { closedBody, logRoute, refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * The storefront reports which blocks of a published page were shown or clicked (personalization
 * 1d-3). Aggregate counts only, with no session, cookie or identifier of the shopper: the route
 * reads no session and no cookie, sets none, and neither the body nor the address is logged or
 * kept. The answer is always 204 with `no-store`, whether anything was counted or not, so it
 * never says which placements are valid. Rate limited per client origin like every public route.
 */
@ApiTags('engagement')
@RoutePopulation('customer')
@RateLimit('default')
@Controller('engagement/blocks')
export class BlockEventsController {
  readonly #logger = new Logger('BlockEventsController');

  constructor(private readonly recordBlocks: RecordBlockEvents) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Count blocks shown or clicked (public)',
    description:
      'No session needed; none is read and no cookie is set. 1 to 20 events, each a page id, a ' +
      'placement id and a type (impression or click). Only the numbers per block and UTC day are ' +
      'kept: nothing about the shopper. An event for a placement that is not served now on that ' +
      'page is skipped silently. Nothing is counted when the browser sends Sec-GPC: 1. Always ' +
      '204 once the body is valid.',
  })
  @ApiHeader({ name: 'Sec-GPC', required: false, description: '1: count nothing' })
  @ApiBody({ type: BlockEventsRequest })
  @ApiNoContentResponse({ description: 'Accepted (counted or skipped)' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  async record(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    // Set first, so an error answer is `no-store` too.
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, BLOCK_REQUEST_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.recordBlocks.execute(context, {
      events: (body as Record<string, unknown>).events,
      globalPrivacyControl: globalPrivacyControlOf(request.headers['sec-gpc']),
    });
    logRoute(
      this.#logger,
      'engagement.record-block-events-route',
      context,
      result.ok ? (result.value.recorded ? 'recorded' : 'not-recorded') : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
  }
}
