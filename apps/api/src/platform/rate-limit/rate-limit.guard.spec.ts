import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { Request, Response } from 'express';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { clientAddressResolver } from '../http/client-address';
import { MarketRegistry } from '../market-config/market-registry';
import { attachMarketContext } from '../market-context/attached-market-context';
import { RateLimitGuard } from './rate-limit.guard';

class SomeController {
  handle(this: void): void {}
}

function contextFor(request: object): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => SomeController,
    getHandler: () => SomeController.prototype.handle,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * A request as the middleware of `configureApp` leaves it (ADR-0037, feature off): its client
 * address resolved from the socket. The guard reads only that resolved address.
 */
function resolvedRequest(remoteAddress: string | undefined, id?: string): object {
  const request = {
    headers: {},
    rawHeaders: [],
    socket: { remoteAddress },
    originalUrl: '/test',
    url: '/test',
    ...(id === undefined ? {} : { id }),
  };
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
  clientAddressResolver({ trust: null, clock })(
    request as unknown as Request,
    {} as Response,
    () => undefined,
  );
  return request;
}

async function refusalOf(guard: RateLimitGuard, request: object): Promise<unknown> {
  try {
    await guard.canActivate(contextFor(request));
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  return null;
}

describe('RateLimitGuard fails closed (identity design 5.2 and 6.8)', () => {
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const guard = new RateLimitGuard(new Reflector(), markets);
  const unavailable = { status: 503, body: { statusCode: 503, code: 'access.unavailable' } };

  it('refuses a request whose socket has no address', async () => {
    const request = resolvedRequest(undefined, 'test-correlation-0001');
    attachMarketContext(request, testMarketContext('AU', 'default'));

    expect(await refusalOf(guard, request)).toEqual(unavailable);
  });

  it('refuses a market-scoped request that reached it without a Market', async () => {
    expect(await refusalOf(guard, resolvedRequest('203.0.113.7'))).toEqual(unavailable);
  });

  it('refuses a request whose address the middleware never resolved (ADR-0037)', async () => {
    const request = { socket: { remoteAddress: '203.0.113.9' } };
    attachMarketContext(request, testMarketContext('AU', 'default'));

    expect(await refusalOf(guard, request)).toEqual(unavailable);
  });

  it('admits a request under the limit', async () => {
    const request = resolvedRequest('203.0.113.8');
    attachMarketContext(request, testMarketContext('ZZ', 'default'));

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });
});
