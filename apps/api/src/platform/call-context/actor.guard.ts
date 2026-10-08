import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isMinted } from '@mondapac/shared-kernel';
import type { MarketContext, Population } from '@mondapac/shared-kernel';
import { anonymousActor } from '@mondapac/shared-kernel/contexts';
import { AUTHENTICATOR, type Authenticator } from '../authz/authenticator';
import { MarketRegistry } from '../market-config/market-registry';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import { marketContextOf } from '../market-context/market.decorator';
import { CSRF_HEADER, csrfTokenFor, csrfTokenMatches, isUnsafeMethod, originRefused } from './csrf';
import { attachActor } from './request-actor';
import { clearedSessionCookie, readCookie, sessionCookieName } from './session-cookie';
import { recordSessionCsrfToken } from './session-csrf-token';
import { SESSION_POPULATION } from './session-population.decorator';

/** The answer codes of this guard (identity design 5.2). */
export const SESSION_INVALID = 'session.invalid';
export const REQUEST_CSRF = 'request.csrf';
const UNAVAILABLE = 'access.unavailable';

type Refusal = 'session.invalid' | 'request.csrf' | 'access.unavailable';
const STATUS: Readonly<Record<Refusal, number>> = {
  'session.invalid': 401,
  'request.csrf': 403,
  'access.unavailable': 503,
};

/**
 * Attaches the actor of every market-scoped request (platform-foundations 5.2 rule 4; identity
 * design 6.2 to 6.4): the third global guard, after the Market guard and the rate limiter, so a
 * refused or throttled request never gets this far. In order:
 *
 * 1. **`Authorization` header** (HF14): any request that carries one is `session.invalid` (401).
 *    Phase 2 issues cookie sessions only; the bearer transport is a later branch here (6.4).
 * 2. **Origin checks** (HF14): a request with an unsafe method, with or without a session, is
 *    `request.csrf` (403) when `Sec-Fetch-Site` is present and not `same-origin`, or `Origin`
 *    is present and not on the Market's `allowedOrigins`.
 * 3. **Session cookie**: a route reads a session only when it names a population with
 *    `@SessionPopulation()`; otherwise its actor is the Market's anonymous actor, whatever
 *    cookie came with it (sign-in and sign-up). The guard reads only the cookie named for that
 *    population and the request's Market; a name that appears twice, or a malformed value, is
 *    `session.invalid` (HF7). No cookie: the anonymous actor, and the use case's rule decides.
 * 4. **CSRF token**: with an unsafe method the request must carry `x-csrf-token`, equal to the
 *    HMAC of the session token, compared in constant time before anything is read; otherwise
 *    `request.csrf`.
 * 5. **Authenticator** (identity's): a rejected credential is `session.invalid` with the cookie
 *    cleared; an exception is `access.unavailable` (503, fail closed). The actor must be of the
 *    route's population and of the request's Market.
 *
 * Forwarded headers are never read (Hassan I4). The token is never logged; a refusal is logged
 * with its reason and the correlation id.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  readonly #logger = new Logger('ActorGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly markets: MarketRegistry,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      throw new Error('ActorGuard attaches the actor of HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage & { id?: unknown }>();
    const response = http.getResponse<ServerResponse>();
    const market = marketContextOf(request);
    const population = this.reflector.getAllAndOverride<Population | undefined>(
      SESSION_POPULATION,
      [context.getHandler(), context.getClass()],
    );
    const refuse = (code: Refusal, reason: string): never =>
      this.refuse(request, response, market, population, code, reason);

    if (request.headers.authorization !== undefined) {
      refuse(SESSION_INVALID, 'authorization-header');
    }
    const unsafe = isUnsafeMethod(request.method);
    if (
      unsafe &&
      originRefused(request.headers, this.markets.get(market.marketId).allowedOrigins)
    ) {
      refuse(REQUEST_CSRF, 'origin');
    }
    if (population === undefined) {
      attachActor(request, anonymousActor(market));
      return true;
    }

    const cookie = readCookie(
      request.headers.cookie,
      sessionCookieName(population, market.marketId),
    );
    if (cookie.kind === 'refused') refuse(SESSION_INVALID, 'cookie-refused');
    if (cookie.kind !== 'one') {
      attachActor(request, anonymousActor(market));
      return true;
    }
    if (unsafe && !csrfTokenMatches(cookie.value, request.headers[CSRF_HEADER])) {
      refuse(REQUEST_CSRF, 'csrf-token');
    }

    let authenticated;
    try {
      authenticated = await this.authenticator.authenticate(market, {
        token: cookie.value,
        transport: 'cookie',
      });
    } catch {
      return refuse(UNAVAILABLE, 'authenticator-error');
    }
    if (!authenticated.ok) return refuse(SESSION_INVALID, 'credential-rejected');
    const actor = authenticated.value;
    if (
      !isMinted(actor) ||
      actor.kind !== 'authenticated' ||
      actor.population !== population ||
      actor.marketId !== market.marketId
    ) {
      return refuse(SESSION_INVALID, 'actor-mismatch');
    }
    attachActor(request, actor);
    recordSessionCsrfToken(request, csrfTokenFor(cookie.value));
    return true;
  }

  private refuse(
    request: { id?: unknown },
    response: ServerResponse,
    market: MarketContext,
    population: Population | undefined,
    code: Refusal,
    reason: string,
  ): never {
    this.#logger.warn({
      msg: 'actor.refused',
      code,
      reason,
      population: population ?? null,
      marketId: market.marketId,
      correlationId: request.id ?? null,
    });
    if (code === SESSION_INVALID && population !== undefined) {
      response.setHeader('Set-Cookie', clearedSessionCookie(population, market.marketId));
    }
    throw new HttpException({ statusCode: STATUS[code], code }, STATUS[code]);
  }
}
