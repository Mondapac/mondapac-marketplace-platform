import { Body, Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
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
import { BEHAVIOUR_FIELDS } from '../domain/behaviour-event';
import { RecordEvent } from '../application/use-cases/record-event.use-case';
import { RecordGuestEvent } from '../application/use-cases/record-guest-event.use-case';
import { BehaviourEventRequest, RecordedBody } from './engagement.dto';
import {
  clearedEngagementGuestCookie,
  engagementGuestCookie,
  engagementGuestTokenOf,
  globalPrivacyControlOf,
} from './guest-cookie';
import { closedBody, logRoute, refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * The storefront reports shopping behaviour here (personalization package 1a): a signed-in
 * customer's under the account, a guest's under the `__Host-engagement-guest-<market>` cookie,
 * set on the first recorded event and never extended. A thin adapter: who the shopper is comes
 * from the session or the cookie, never from the body. `Sec-GPC: 1` records nothing and
 * expires a guest cookie sent. Every answer
 * is `no-store`; the body, the search text and the cookie are never logged.
 */
@ApiTags('engagement')
@RoutePopulation('customer')
@Controller('engagement/events')
export class BehaviourEventsController {
  readonly #logger = new Logger('BehaviourEventsController');

  constructor(
    private readonly recordAccount: RecordEvent,
    private readonly recordGuest: RecordGuestEvent,
  ) {}

  @Post()
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record what the shopper viewed, searched for or added to the cart',
    description:
      'Ids only. Not recorded (recorded: false) when the browser sends Sec-GPC: 1 or the ' +
      'signed-in customer switched personalization off. A guest gets a 30-day cookie.',
  })
  @ApiHeader({
    name: CSRF_HEADER,
    required: false,
    description: 'The CSRF token of the session; required for a signed-in customer',
  })
  @ApiHeader({ name: 'Sec-GPC', required: false, description: '1: record nothing' })
  @ApiBody({ type: BehaviourEventRequest })
  @ApiOkResponse({ type: RecordedBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  async record(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, BEHAVIOUR_FIELDS);
    if (invalid !== null) throw invalid;
    const event = body as Record<string, unknown>;
    const globalPrivacyControl = globalPrivacyControlOf(request.headers['sec-gpc']);

    if (context.actor.kind === 'authenticated') {
      const result = await this.recordAccount.execute(context, { event, globalPrivacyControl });
      logRoute(this.#logger, 'engagement.record-event-route', context, outcomeOf(result));
      if (!result.ok) throw refusal(result.error, context, this.#logger);
      return { recorded: result.value.recorded } satisfies RecordedBody;
    }

    const result = await this.recordGuest.execute(context, {
      event,
      globalPrivacyControl,
      token: engagementGuestTokenOf(request.headers.cookie, context.market.marketId),
    });
    logRoute(this.#logger, 'engagement.record-guest-event-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    if (result.value.cookie !== null) {
      const cookie = result.value.cookie;
      response.append(
        'Set-Cookie',
        cookie.action === 'set'
          ? engagementGuestCookie(context.market.marketId, cookie.token)
          : clearedEngagementGuestCookie(context.market.marketId),
      );
    }
    return { recorded: result.value.recorded } satisfies RecordedBody;
  }
}

function outcomeOf(
  result:
    | { readonly ok: true; readonly value: { readonly recorded: boolean } }
    | { readonly ok: false; readonly error: { readonly code: string } },
): string {
  if (!result.ok) return result.error.code;
  return result.value.recorded ? 'recorded' : 'not-recorded';
}
