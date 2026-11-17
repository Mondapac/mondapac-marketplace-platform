import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
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
import { DeleteConversation } from '../application/use-cases/delete-conversation.use-case';
import {
  ListConversations,
  type ConversationListItem,
} from '../application/use-cases/list-conversations.use-case';
import type { AssistantReply } from '../application/use-cases/send-message.use-case';
import {
  ViewConversation,
  type ConversationTranscript,
} from '../application/use-cases/view-conversation.use-case';
import { SendGuestMessage } from '../application/use-cases/send-guest-message.use-case';
import { SendMessage } from '../application/use-cases/send-message.use-case';
import type { AssistantCard } from '../domain/cards';
import { PREVIEW_HEADER, SendMessageRequest } from './assistant.dto';
import { guestCookie, guestTokenOf } from './guest-cookie';
import { closedBody, fail, refusal } from './http-answers';

const ERROR = { type: Object };

type Money = { readonly amount: bigint; readonly currency: string };
const money = (value: Money | null) =>
  value === null ? null : { amount: value.amount.toString(), currency: value.currency };

/** A card as JSON: Money with its amount as a string of minor units. */
function cardBody(card: AssistantCard) {
  switch (card.kind) {
    case 'product':
      return { ...card, price: money(card.price), regularPrice: money(card.regularPrice) };
    case 'cart-action':
      return {
        ...card,
        units: card.units.map((unit) => ({ ...unit, price: money(unit.price) })),
      };
    case 'cart':
      return {
        ...card,
        total: money(card.total),
        groups: card.groups.map((group) => ({
          ...group,
          subtotal: money(group.subtotal),
          minimumOrder: { ...group.minimumOrder, minimum: money(group.minimumOrder.minimum) },
          lines: group.lines.map((line) => ({ ...line, unitPrice: money(line.unitPrice) })),
        })),
      };
    default:
      return card;
  }
}

const listItemBody = (item: ConversationListItem) => ({
  id: item.id,
  title: item.title,
  turns: item.turns,
  full: item.full,
  startedAt: item.startedAt.toString(),
  lastMessageAt: item.lastMessageAt.toString(),
});

/** History is for a signed-in customer only; a guest has no list (stage 0, B2). */
function signedInOnly(context: CallContext): void {
  if (context.actor.kind !== 'authenticated') {
    throw fail(403, 'assistant.sign-in-required');
  }
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
    private readonly list: ListConversations,
    private readonly view: ViewConversation,
    private readonly remove: DeleteConversation,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: "A signed-in buyer's own conversations with the shopping assistant, newest first",
    description:
      'Only conversations that keep text and are within the retention in force (the shorter of ' +
      "the one they started with and the Market's current setting). The title is the first buyer " +
      'message, masked, at most 30 characters. A guest is refused: guests have no history.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'nextCursor of the previous page',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
    description: 'Default 20',
  })
  @ApiOkResponse({
    description:
      '{ items: [{ id, title, turns, full, startedAt, lastMessageAt }], nextCursor: string | null }',
  })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'assistant.sign-in-required, assistant.off' })
  async listOwn(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    signedInOnly(context);
    const result = await this.list.execute(context, { cursor, limit });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    response.setHeader('Cache-Control', 'no-store');
    return { items: result.value.items.map(listItemBody), nextCursor: result.value.nextCursor };
  }

  @Get(':id')
  @ReadsSession()
  @ApiOperation({
    summary: "One of a signed-in buyer's own conversations, every stored message in order",
    description:
      "Another buyer's conversation, a guest's, or one past its retention answers 404. Cards " +
      'come back as their kind and ids only (product: offerId; seller: sellerId; page: page; ' +
      'support): a price or ' +
      'product text is never replayed from an old answer. Continue it with POST ' +
      '/assistant/conversations/:id/messages (409 assistant.conversation-full when full is true).',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({
    description:
      '{ id, title, turns, full, startedAt, lastMessageAt, messages: [{ position, role, text, ' +
      'cards, at }] }',
  })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'assistant.sign-in-required, assistant.off' })
  @ApiNotFoundResponse({ ...ERROR, description: 'assistant.conversation-not-found' })
  async viewOwn(
    @Call() context: CallContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    signedInOnly(context);
    const result = await this.view.execute(context, { conversationId: id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    response.setHeader('Cache-Control', 'no-store');
    const transcript: ConversationTranscript = result.value;
    return {
      ...listItemBody(transcript),
      messages: transcript.messages.map((message) => ({
        position: message.position,
        role: message.role,
        text: message.text,
        cards: message.cards,
        at: message.at.toString(),
      })),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({
    summary: "Deletes one of a signed-in buyer's own conversations",
    description:
      'The conversation, its messages and its encryption key are deleted at once. Works while ' +
      'the assistant is off too.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'assistant.sign-in-required, request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'assistant.conversation-not-found' })
  async deleteOwn(@Call() context: CallContext, @Param('id') id: string): Promise<void> {
    signedInOnly(context);
    const result = await this.remove.execute(context, { conversationId: id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
  }

  @Post(':id/messages')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "A buyer's message to the shopping assistant, answered over server-sent events",
    description:
      'id is a new or existing conversation id (a canonical UUID v7 the widget generates); a ' +
      "guest's conversation answers only the guest cookie that started it, a customer's only " +
      'its account. The stream carries events conversation, card, text, notice and done. Prices ' +
      'and stock appear only on cards; certification only as the badge of a product card.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({
    name: CSRF_HEADER,
    required: false,
    description: 'The CSRF token of the session; required for a signed-in customer',
  })
  @ApiHeader({
    name: PREVIEW_HEADER,
    required: false,
    description:
      'An internal preview token (see GET /assistant/storefront); invalid counts as none',
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
    const preview = request.headers[PREVIEW_HEADER];
    const input = {
      conversationId: id,
      text: fields.text,
      visitor: fields.visitor,
      preview: typeof preview === 'string' ? preview : undefined,
    };
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
