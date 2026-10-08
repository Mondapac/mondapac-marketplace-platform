import { Controller } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  testCallContext,
  testMarketContext,
  TEST_CORRELATION_ID,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { attachMarketContext } from '../market-context/attached-market-context';
import { MissingMarketContextError } from '../market-context/market.decorator';
import { NoMarketContext } from '../market-context/no-market-context.decorator';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import { ActorGuard } from './actor.guard';
import { callContextOf, MissingCorrelationIdError } from './call-context.decorator';
import { actorOf, attachActor, MissingActorError } from './request-actor';

// platform-foundations 5.2 rules 1 and 4 (identity slice 1d, W1/W3): the actor and the
// CallContext of a request, never defaulted.

@Controller('scoped')
class ScopedController {}

@NoMarketContext()
@Controller('exempt')
class ExemptController {}

function httpContext(request: object, controller: object, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => controller,
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe.each(TEST_MARKETS)('the actor and CallContext of a request in %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  it("ActorGuard attaches the Market's anonymous actor (no session before slice 2)", () => {
    const request = { id: TEST_CORRELATION_ID };
    attachMarketContext(request, market);

    expect(new ActorGuard().canActivate(httpContext(request, ScopedController))).toBe(true);

    const actor = actorOf(request);
    expect(actor.kind).toBe('anonymous');
    expect(actor.marketId).toBe(market.marketId);
  });

  it('ActorGuard throws when the Market guard did not run first', () => {
    expect(() => new ActorGuard().canActivate(httpContext({}, ScopedController))).toThrow(
      MissingMarketContextError,
    );
  });

  it('ActorGuard leaves an exempt controller without an actor', () => {
    const request = {};

    expect(new ActorGuard().canActivate(httpContext(request, ExemptController))).toBe(true);
    expect(() => actorOf(request)).toThrow(MissingActorError);
  });

  it('ActorGuard refuses a non-HTTP context', () => {
    expect(() => new ActorGuard().canActivate(httpContext({}, ScopedController, 'rpc'))).toThrow(
      /HTTP requests only/,
    );
  });

  it('callContextOf builds the context from the attached Market, actor and request id', () => {
    const request = { id: TEST_CORRELATION_ID };
    attachMarketContext(request, market);
    new ActorGuard().canActivate(httpContext(request, ScopedController));

    const context = callContextOf(request);

    expect(context.market).toBe(market);
    expect(context.actor).toBe(actorOf(request));
    expect(context.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('callContextOf throws without a valid correlation id', () => {
    for (const id of [undefined, '', 'bad id with spaces', 42]) {
      const request = { id };
      attachMarketContext(request, market);
      new ActorGuard().canActivate(httpContext(request, ScopedController));

      expect(() => callContextOf(request)).toThrow(MissingCorrelationIdError);
    }
  });

  it('callContextOf throws without an actor; it never defaults', () => {
    const request = { id: TEST_CORRELATION_ID };
    attachMarketContext(request, market);

    expect(() => callContextOf(request)).toThrow(MissingActorError);
  });

  it('attachActor refuses an actor that was not minted, and a second actor', () => {
    const minted = testCallContext(market, 'anonymous').actor;
    const request = {};

    expect(() => attachActor(request, { ...minted })).toThrow(/not minted/);
    attachActor(request, minted);
    expect(() => attachActor(request, minted)).toThrow(/already has an actor/);
  });
});
