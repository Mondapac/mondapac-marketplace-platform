import { Controller, HttpException, Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { AuthenticatedActor, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
  TEST_CORRELATION_ID,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../test/support/test-config';
import type { Authenticator, SessionCredential } from '../authz/authenticator';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { attachMarketContext } from '../market-context/attached-market-context';
import { MissingMarketContextError } from '../market-context/market.decorator';
import { NoMarketContext } from '../market-context/no-market-context.decorator';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import { ActorGuard } from './actor.guard';
import { callContextOf, MissingCorrelationIdError } from './call-context.decorator';
import { csrfTokenFor } from './csrf';
import { actorOf, attachActor, MissingActorError } from './request-actor';
import { sessionCsrfTokenOf } from './session-csrf-token';
import { SessionPopulation } from './session-population.decorator';

// platform-foundations 5.2 rules 1 and 4; identity design 6.2 to 6.4 (slice 2): the actor and
// the CallContext of a request, never defaulted; the session cookie, the CSRF token and the
// origin checks.

@Controller('scoped')
class ScopedController {
  anonymousRoute(this: void): void {}
  @SessionPopulation('customer')
  customerRoute(this: void): void {}
}

@NoMarketContext()
@Controller('exempt')
class ExemptController {}

const TOKEN = `ms1_${'A'.repeat(43)}`;
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

interface FakeRequest {
  id?: unknown;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

class FakeResponse {
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function httpContext(
  request: object,
  handler: keyof ScopedController | null,
  controller: object = ScopedController,
  type = 'http',
  response: FakeResponse = new FakeResponse(),
): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => controller,
    getHandler: () => (handler === null ? () => undefined : ScopedController.prototype[handler]),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

class FakeAuthenticator implements Authenticator {
  readonly calls: SessionCredential[] = [];
  answer: 'actor' | 'rejected' | 'throws' | AuthenticatedActor = 'actor';
  constructor(private readonly market: MarketContext) {}

  authenticate(market: MarketContext, credential: SessionCredential) {
    this.calls.push(credential);
    if (this.answer === 'throws') return Promise.reject(new Error('database down'));
    if (this.answer === 'rejected')
      return Promise.resolve(err({ code: 'credential.rejected' as const }));
    return Promise.resolve(
      ok(
        this.answer === 'actor'
          ? testAuthenticatedActor(market, {
              population: 'customer',
              accountId: id('01990000-0000-7000-8000-000000000001'),
              sessionId: id('01990000-0000-7000-8000-00000000a001'),
              sellerId: null,
            })
          : this.answer,
      ),
    );
  }
}

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('the actor and CallContext of a request in %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const cookieName = `__Host-session-customer-${code}`;
  let authenticator: FakeAuthenticator;
  let guard: ActorGuard;

  let warnings: jest.SpyInstance;

  beforeEach(() => {
    authenticator = new FakeAuthenticator(market);
    guard = new ActorGuard(new Reflector(), markets, authenticator);
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  it('logs a refusal with its reason and the correlation id, never the token', async () => {
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}; ${cookieName}=x` } });

    await refusal(guard.canActivate(httpContext(req, 'customerRoute')));

    expect(warnings).toHaveBeenCalledWith({
      msg: 'actor.refused',
      code: 'session.invalid',
      reason: 'cookie-refused',
      population: 'customer',
      marketId: code,
      correlationId: TEST_CORRELATION_ID,
    });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(TOKEN);
  });

  function request(fields: Partial<FakeRequest> = {}): FakeRequest {
    const built: FakeRequest = { id: TEST_CORRELATION_ID, method: 'GET', headers: {}, ...fields };
    attachMarketContext(built, market);
    return built;
  }

  async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpException)
        return { status: error.getStatus(), body: error.getResponse() };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it("attaches the Market's anonymous actor on a route that reads no session", async () => {
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(actorOf(req).marketId).toBe(market.marketId);
    expect(authenticator.calls).toEqual([]);
  });

  it('attaches the anonymous actor on a session route without the cookie', async () => {
    const req = request({ headers: { cookie: 'other=1' } });

    await expect(guard.canActivate(httpContext(req, 'customerRoute'))).resolves.toBe(true);

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  it("authenticates the population's cookie of the request's Market and records the CSRF token", async () => {
    const req = request({ headers: { cookie: `a=b; ${cookieName}=${TOKEN}` } });

    await expect(guard.canActivate(httpContext(req, 'customerRoute'))).resolves.toBe(true);

    expect(authenticator.calls).toEqual([{ token: TOKEN, transport: 'cookie' }]);
    expect(actorOf(req)).toMatchObject({ kind: 'authenticated', population: 'customer' });
    expect(sessionCsrfTokenOf(req)).toBe(csrfTokenFor(TOKEN));
  });

  it("ignores another Market's or population's cookie", async () => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const req = request({
      headers: {
        cookie: `__Host-session-customer-${other}=${TOKEN}; __Host-session-admin-${code}=${TOKEN}`,
      },
    });

    await guard.canActivate(httpContext(req, 'customerRoute'));

    expect(actorOf(req).kind).toBe('anonymous');
    expect(authenticator.calls).toEqual([]);
  });

  it('refuses a repeated cookie name with session.invalid and clears it (HF7)', async () => {
    const response = new FakeResponse();
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}; ${cookieName}=${TOKEN}` } });

    await expect(
      refusal(
        guard.canActivate(httpContext(req, 'customerRoute', ScopedController, 'http', response)),
      ),
    ).resolves.toEqual({ status: 401, body: { statusCode: 401, code: 'session.invalid' } });
    expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${cookieName}=; Max-Age=0;`));
    expect(authenticator.calls).toEqual([]);
  });

  it('refuses any Authorization header with session.invalid (HF14), also on an anonymous route', async () => {
    for (const handler of ['anonymousRoute', 'customerRoute'] as const) {
      const req = request({ headers: { authorization: `Bearer ${TOKEN}` } });

      await expect(refusal(guard.canActivate(httpContext(req, handler)))).resolves.toMatchObject({
        status: 401,
        body: { code: 'session.invalid' },
      });
    }
  });

  it('answers session.invalid and clears the cookie when the Authenticator rejects', async () => {
    authenticator.answer = 'rejected';
    const response = new FakeResponse();
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(
      refusal(
        guard.canActivate(httpContext(req, 'customerRoute', ScopedController, 'http', response)),
      ),
    ).resolves.toMatchObject({ status: 401, body: { code: 'session.invalid' } });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(() => actorOf(req)).toThrow(MissingActorError);
  });

  it('fails closed with access.unavailable when the Authenticator throws', async () => {
    authenticator.answer = 'throws';
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(refusal(guard.canActivate(httpContext(req, 'customerRoute')))).resolves.toEqual({
      status: 503,
      body: { statusCode: 503, code: 'access.unavailable' },
    });
  });

  it('refuses an actor of another population than the route', async () => {
    authenticator.answer = testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id('01990000-0000-7000-8000-000000000001'),
      sessionId: id('01990000-0000-7000-8000-00000000a001'),
      sellerId: null,
    });
    const req = request({ headers: { cookie: `${cookieName}=${TOKEN}` } });

    await expect(
      refusal(guard.canActivate(httpContext(req, 'customerRoute'))),
    ).resolves.toMatchObject({
      status: 401,
      body: { code: 'session.invalid' },
    });
  });

  describe('unsafe methods (identity design 6.4)', () => {
    it('needs the CSRF token of the session, checked before the Authenticator runs', async () => {
      for (const header of [undefined, 'wrong', csrfTokenFor(`ms1_${'B'.repeat(43)}`)]) {
        const req = request({
          method: 'POST',
          headers: { cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': header },
        });

        await expect(
          refusal(guard.canActivate(httpContext(req, 'customerRoute'))),
        ).resolves.toEqual({
          status: 403,
          body: { statusCode: 403, code: 'request.csrf' },
        });
      }
      expect(authenticator.calls).toEqual([]);
    });

    it('accepts the right CSRF token', async () => {
      const req = request({
        method: 'DELETE',
        headers: { cookie: `${cookieName}=${TOKEN}`, 'x-csrf-token': csrfTokenFor(TOKEN) },
      });

      await expect(guard.canActivate(httpContext(req, 'customerRoute'))).resolves.toBe(true);
    });

    it('refuses Sec-Fetch-Site other than same-origin, with or without a session (HF14)', async () => {
      for (const site of ['cross-site', 'same-site', 'none']) {
        const req = request({ method: 'POST', headers: { 'sec-fetch-site': site } });

        await expect(
          refusal(guard.canActivate(httpContext(req, 'anonymousRoute'))),
        ).resolves.toMatchObject({
          status: 403,
          body: { code: 'request.csrf' },
        });
      }
    });

    it("refuses an Origin that is not on the Market's list, and accepts one that is", async () => {
      const allowed = markets.get(market.marketId).allowedOrigins;
      const refused = request({
        method: 'POST',
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      });

      await expect(
        refusal(guard.canActivate(httpContext(refused, 'anonymousRoute'))),
      ).resolves.toMatchObject({
        status: 403,
        body: { code: 'request.csrf' },
      });
      for (const origin of allowed) {
        const req = request({
          method: 'POST',
          headers: { origin, 'sec-fetch-site': 'same-origin' },
        });
        await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);
      }
    });

    it('passes a request with neither origin header (a non-browser client)', async () => {
      const req = request({ method: 'POST' });

      await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);
    });

    it('does not apply the origin checks to a safe method', async () => {
      const req = request({
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      });

      await expect(guard.canActivate(httpContext(req, 'anonymousRoute'))).resolves.toBe(true);
    });
  });

  it('throws when the Market guard did not run first', async () => {
    await expect(
      guard.canActivate(httpContext({ method: 'GET', headers: {} }, 'anonymousRoute')),
    ).rejects.toThrow(MissingMarketContextError);
  });

  it('leaves an exempt controller without an actor', async () => {
    const req = { method: 'GET', headers: {} };

    await expect(guard.canActivate(httpContext(req, null, ExemptController))).resolves.toBe(true);
    expect(() => actorOf(req)).toThrow(MissingActorError);
  });

  it('refuses a non-HTTP context', async () => {
    await expect(
      guard.canActivate(httpContext({}, 'anonymousRoute', ScopedController, 'rpc')),
    ).rejects.toThrow(/HTTP requests only/);
  });

  it('callContextOf builds the context from the attached Market, actor and request id', async () => {
    const req = request();
    await guard.canActivate(httpContext(req, 'anonymousRoute'));

    const context = callContextOf(req);

    expect(context.market).toBe(market);
    expect(context.actor).toBe(actorOf(req));
    expect(context.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('callContextOf throws without a valid correlation id', async () => {
    for (const correlation of [undefined, '', 'bad id with spaces', 42]) {
      const req = request({ id: correlation });
      await guard.canActivate(httpContext(req, 'anonymousRoute'));

      expect(() => callContextOf(req)).toThrow(MissingCorrelationIdError);
    }
  });

  it('callContextOf throws without an actor; it never defaults', () => {
    const req = request();

    expect(() => callContextOf(req)).toThrow(MissingActorError);
  });

  it('attachActor refuses an actor that was not minted, and a second actor', () => {
    const minted = testCallContext(market, 'anonymous').actor;
    const req = {};

    expect(() => attachActor(req, { ...minted })).toThrow(/not minted/);
    attachActor(req, minted);
    expect(() => attachActor(req, minted)).toThrow(/already has an actor/);
  });
});
