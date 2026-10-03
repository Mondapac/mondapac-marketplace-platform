import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { isMinted } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';

/** A controller asked for the Market of a request that has none: a programmer error. */
export class MissingMarketContextError extends Error {
  constructor() {
    super(
      'No MarketContext is attached to this request. @Market() needs a market-scoped ' +
        'controller; an exempt controller has no Market and gets no default.',
    );
    this.name = 'MissingMarketContextError';
  }
}

// The context of each request, keyed by the request object. Private to this file: code reads
// it through @Market() only, and only MarketContextGuard attaches it.
const attached = new WeakMap<object, MarketContext>();

/**
 * Attaches the resolved Market to a request; called by MarketContextGuard only. Refuses a
 * context the kernel did not mint (a literal, a copy, a value from another copy of the
 * kernel) and a second context on the same request.
 */
export function attachMarketContext(request: object, market: MarketContext): void {
  if (!isMinted(market)) {
    throw new TypeError('attachMarketContext: the MarketContext was not minted by the kernel');
  }
  if (attached.has(request)) {
    throw new Error('attachMarketContext: this request already has a MarketContext');
  }
  attached.set(request, market);
}

/** The Market attached to a request. Throws when there is none: it never defaults. */
export function marketContextOf(request: object): MarketContext {
  const market = attached.get(request);
  if (market === undefined) throw new MissingMarketContextError();
  return market;
}

/**
 * Parameter decorator: the minted `MarketContext` that MarketContextGuard resolved for this
 * request. It throws when nothing is attached (an exempt controller), so no handler ever
 * runs with a default Market.
 */
export const Market = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MarketContext =>
    marketContextOf(context.switchToHttp().getRequest<object>()),
);
