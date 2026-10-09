import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Money } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import type {
  CartView,
  GuestCookie,
  LineWritten,
} from '../application/use-cases/view-cart.use-case';
import { AddGuestItem } from '../application/use-cases/add-guest-item.use-case';
import { AddItem } from '../application/use-cases/add-item.use-case';
import { MergeGuestCart } from '../application/use-cases/merge-guest-cart.use-case';
import { RemoveGuestItem } from '../application/use-cases/remove-guest-item.use-case';
import { RemoveItem } from '../application/use-cases/remove-item.use-case';
import { SetGuestLineQuantity } from '../application/use-cases/set-guest-line-quantity.use-case';
import { SetLineQuantity } from '../application/use-cases/set-line-quantity.use-case';
import { ViewCart } from '../application/use-cases/view-cart.use-case';
import { ViewGuestCart } from '../application/use-cases/view-guest-cart.use-case';
import {
  AddItemRequest,
  CartViewBody,
  LineWrittenView,
  MergedView,
  RemovedView,
  SetQuantityRequest,
} from './cart.dto';
import { clearedGuestCookie, guestCookie, guestTokenOf } from './guest-cookie';
import { closedBody, fail } from './http-answers';

/** The HTTP status of each refusal of the cart routes. */
export const CART_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'cart.line-not-found': 404,
  'cart.offer-not-purchasable': 422,
  'cart.too-many-lines': 422,
  'conflict.stale': 409,
  'cart.check-unavailable': 503,
});

const CSRF = {
  name: CSRF_HEADER,
  required: false,
  description: 'The CSRF token of the session; required for a signed-in customer on a write',
};
const ERROR = { type: Object };

const money = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

const viewBody = (view: CartView) => ({
  groups: view.groups.map((group) => ({
    sellerId: group.sellerId,
    subtotal: group.subtotal === null ? null : money(group.subtotal),
    lines: group.lines.map((line) => ({
      lineId: line.lineId,
      offerId: line.offerId,
      variantId: line.variantId,
      quantity: line.quantity,
      state: line.state,
      reason: line.reason,
      unitPrice: line.unitPrice === null ? null : money(line.unitPrice),
      previousPrice: line.priceChanged === null ? null : money(line.priceChanged.previous),
      availability: line.availability,
    })),
  })),
  lineCount: view.lineCount,
});

/**
 * The cart over HTTP (cart design 6): a signed-in customer's cart or a guest's, chosen by the
 * session. A thin adapter: the customer comes from the session and the guest from the
 * `__Host-cart-guest-<market>` cookie, never from the body; one use case does the work behind its
 * gate. Every answer is `no-store`. The guest cookie is set or cleared only on a success.
 */
@ApiTags('cart')
@RoutePopulation('customer')
@Controller('cart')
export class CartController {
  readonly #logger = new Logger('CartController');

  constructor(
    private readonly viewAccount: ViewCart,
    private readonly viewGuest: ViewGuestCart,
    private readonly addAccount: AddItem,
    private readonly addGuest: AddGuestItem,
    private readonly setAccount: SetLineQuantity,
    private readonly setGuest: SetGuestLineQuantity,
    private readonly removeAccount: RemoveItem,
    private readonly removeGuest: RemoveGuestItem,
    private readonly merge: MergeGuestCart,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({ summary: 'The cart, grouped by seller, with the current price and stock state' })
  @ApiOkResponse({ type: CartViewBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'session.invalid' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result =
      context.actor.kind === 'authenticated'
        ? await this.viewAccount.execute(context, {})
        : await this.viewGuest.execute(context, {
            token: guestTokenOf(request.headers.cookie, context.market.marketId),
          });
    return this.answer('cart.view', context, response, result, (view) => ({
      body: viewBody(view),
      cookie: view.cookie,
    }));
  }

  @Post('items')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a sell unit to the cart',
    description:
      'Adds to an existing line. The quantity is limited to the Market maximum or what is left; ' +
      'clamped says which. A guest cart is created by the first add.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AddItemRequest })
  @ApiOkResponse({ type: LineWrittenView })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale' })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'cart.offer-not-purchasable (details.reason) or cart.too-many-lines',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'cart.check-unavailable' })
  async add(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    const input = closedBody(request, body, ['offerId', 'variantId', 'quantity']);
    if (input instanceof HttpException) throw this.refused('cart.add-item', context, input);
    const args = {
      offerId: input.offerId as string,
      variantId: input.variantId as string,
      quantity: input.quantity as number,
    };
    const result =
      context.actor.kind === 'authenticated'
        ? await this.addAccount.execute(context, args)
        : await this.addGuest.execute(context, {
            ...args,
            token: guestTokenOf(request.headers.cookie, context.market.marketId),
          });
    return this.answer('cart.add-item', context, response, result, written);
  }

  @Put('items/:lineId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Set the quantity of one line' })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'lineId', format: 'uuid' })
  @ApiBody({ type: SetQuantityRequest })
  @ApiOkResponse({ type: LineWrittenView })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ ...ERROR, description: 'cart.line-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  async setQuantity(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    const input = closedBody(request, body, ['quantity']);
    if (input instanceof HttpException)
      throw this.refused('cart.set-line-quantity', context, input);
    const args = { lineId, quantity: input.quantity as number };
    const result =
      context.actor.kind === 'authenticated'
        ? await this.setAccount.execute(context, args)
        : await this.setGuest.execute(context, {
            ...args,
            token: guestTokenOf(request.headers.cookie, context.market.marketId),
          });
    return this.answer('cart.set-line-quantity', context, response, result, written);
  }

  @Delete('items/:lineId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Remove one line' })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'lineId', format: 'uuid' })
  @ApiOkResponse({ type: RemovedView })
  @ApiNotFoundResponse({ ...ERROR, description: 'cart.line-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale' })
  async remove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('lineId') lineId: string,
  ) {
    const result =
      context.actor.kind === 'authenticated'
        ? await this.removeAccount.execute(context, { lineId })
        : await this.removeGuest.execute(context, {
            lineId,
            token: guestTokenOf(request.headers.cookie, context.market.marketId),
          });
    return this.answer('cart.remove-item', context, response, result, (value) => ({
      body: { removed: true as const },
      cookie: value.cookie,
    }));
  }

  @Post('merge')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge the guest cart of this browser into the signed-in customer cart',
    description:
      'Call right after sign-in. The guest cookie is read from the request and always cleared. ' +
      'No guest cart, an expired one or one already merged is a successful no-op.',
  })
  @ApiHeader({ ...CSRF, required: true })
  @ApiOkResponse({ type: MergedView })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.stale' })
  async mergeGuest(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.merge.execute(context, {
      guestToken: guestTokenOf(request.headers.cookie, context.market.marketId),
    });
    return this.answer('cart.merge-guest-cart', context, response, result, (value) => ({
      body: { merged: value.merged, clamped: value.clamped, notAdded: value.notAdded },
      cookie: value.cookie,
    }));
  }

  private answer<T, B>(
    operation: string,
    context: CallContext,
    response: Response,
    result:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: { readonly code: string } },
    shape: (value: T) => { body: B; cookie: GuestCookie | null },
  ): B {
    response.setHeader('Cache-Control', 'no-store');
    if (!result.ok) throw this.refused(operation, context, this.refusal(result.error, context));
    const { body, cookie } = shape(result.value);
    if (cookie !== null) {
      response.append(
        'Set-Cookie',
        cookie.action === 'set'
          ? guestCookie(context.market.marketId, cookie.token)
          : clearedGuestCookie(context.market.marketId),
      );
    }
    this.#logger.log({
      msg: operation,
      outcome: 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return body;
  }

  /** Logs the outcome code (never a body, an id or a token) and returns the exception to throw. */
  private refused(operation: string, context: CallContext, exception: HttpException) {
    const code = (exception.getResponse() as { code: string }).code;
    this.#logger[exception.getStatus() >= 500 ? 'warn' : 'log']({
      msg: operation,
      outcome: code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return exception;
  }

  private refusal(
    error: { readonly code: string; readonly fields?: unknown; readonly reason?: unknown },
    context: CallContext,
  ): HttpException {
    const status =
      CART_STATUS[error.code] ??
      ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (status === undefined) {
      this.#logger.error({
        msg: 'cart.unmapped-refusal',
        code: error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return fail(500, 'internal');
    }
    if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
    if (error.reason !== undefined) return fail(status, error.code, { reason: error.reason });
    return fail(status, error.code);
  }
}

const written = (value: LineWritten) => ({
  body: {
    lineId: value.lineId,
    quantity: value.quantity,
    changed: value.changed,
    clamped: value.clamped,
  },
  cookie: value.cookie,
});
