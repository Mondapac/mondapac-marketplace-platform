import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientOriginOf } from '../../../platform/rate-limit/client-origin';
import type { AssistantReply } from '../application/use-cases/send-message.use-case';
import { SendGuestMessage } from '../application/use-cases/send-guest-message.use-case';
import { SendMessage } from '../application/use-cases/send-message.use-case';
import type { AssistantCard } from '../domain/cards';
import { SendMessageRequest } from './assistant.dto';
import { guestCookie, guestTokenOf } from './guest-cookie';
import { closedBody, refusal } from './http-answers';

const ERROR = { type: Object };

/** A card as JSON: Money with its amount as a string of minor units. */
function cardBody(card: AssistantCard) {
  if (card.kind !== 'product') return card;
  const money = (value: typeof card.price) =>
    value === null ? null : { amount: value.amount.toString(), currency: value.currency };
  return { ...card, price: money(card.price), regularPrice: money(card.regularPrice) };
}

/** One server-sent event; `data` is JSON on one line, so no field can break the frame. */
const event = (name: string, data: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The buyer assistant's conversation (plan section 6, option A; package 4). A thin adapter: the
 * customer comes from the session and a guest from the assistant's own cookie, never from the
 * body; one use case does the work behind its gate. In the default per-origin limit class, and
 * the assistant's own message limits (Market settings) in the use case.
 *
 * A refusal is an ordinary JSON error with its status. An answer is `text/event-stream`, sent
 * once the reply guard has checked the whole reply (plan section 5): `conversation`, then one
 * `card` per card, one `text` per checked sentence, one `notice` per fixed message, and `done`.
 */
@ApiTags('assistant')
@RoutePopulation('customer')
@Controller('assistant/conversations')
export class ConversationController {
  readonly #logger = new Logger('ConversationController');

  constructor(
    private readonly sendAccount: SendMessage,
    private readonly sendGuest: SendGuestMessage,
  ) {}

  @Post(':id/messages')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "A buyer's message to the shopping assistant, answered over server-sent events",
    description:
      'id is a new or existing conversation id (a canonical UUID v7 the widget generates); a ' +
      "guest's conversation answers only the guest cookie that started it, a customer's only " +
      'its account. The stream carries events conversation, card, text, notice and done. Prices ' +
      'and stock appear only on cards; certification only on the product page.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({
    name: CSRF_HEADER,
    required: false,
    description: 'The CSRF token of the session; required for a signed-in customer',
  })
  @ApiBody({ type: SendMessageRequest })
  @ApiOkResponse({ description: 'text/event-stream: conversation, card*, text*, notice*, done' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'assistant.off, assistant.sign-in-required' })
  @ApiNotFoundResponse({ ...ERROR, description: 'assistant.conversation-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'assistant.conversation-full' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'request.body-unsupported' })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'request.throttled (Retry-After)' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'assistant.paused (a spend cap), assistant.unavailable, access.unavailable',
  })
  async send(
    @Call() context: CallContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const closed = closedBody(request, body, ['text', 'visitor']);
    if (closed !== null) throw closed;
    const fields = body as { text?: unknown; visitor?: unknown };
    const input = { conversationId: id, text: fields.text, visitor: fields.visitor };
    const { marketId } = context.market;
    const result =
      context.actor.kind === 'authenticated'
        ? await this.sendAccount.execute(context, input)
        : await this.sendGuest.execute(context, {
            ...input,
            token: guestTokenOf(request.headers.cookie, marketId),
            origin: clientOriginOf(clientAddressFrom(request)),
          });
    if (!result.ok) {
      if (result.error.code === 'request.throttled') {
        response.setHeader('Retry-After', String(result.error.retryAfterSeconds));
      }
      throw refusal(result.error, context, this.#logger);
    }
    this.stream(response, marketId, result.value);
  }

  private stream(
    response: Response,
    marketId: CallContext['market']['marketId'],
    reply: AssistantReply,
  ) {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    if (reply.guestToken !== null) {
      response.setHeader('Set-Cookie', guestCookie(marketId, reply.guestToken));
    }
    response.write(event('conversation', { id: reply.conversationId }));
    for (const card of reply.cards) response.write(event('card', cardBody(card)));
    for (const text of reply.sentences) response.write(event('text', { text }));
    for (const code of reply.notices) response.write(event('notice', { code }));
    response.end(event('done', {}));
  }
}
