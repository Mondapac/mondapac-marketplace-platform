import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { anonymousActor } from '@mondapac/shared-kernel/contexts';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import { marketContextOf } from '../market-context/market.decorator';
import { attachActor } from './request-actor';

/**
 * Attaches the actor of every market-scoped request (platform-foundations 5.2 rule 4): the
 * third global guard, after the Market guard and the rate limiter, so a refused or throttled
 * request never gets this far.
 *
 * Slice 1d: no session exists yet, so every request is the anonymous actor of its Market.
 * Slice 2 replaces the body: it calls identity's `Authenticator` with the credential (6.2,
 * 6.3) and attaches the authenticated actor, or answers `session.invalid`.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      throw new Error('ActorGuard attaches the actor of HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;
    const request = context.switchToHttp().getRequest<object>();
    attachActor(request, anonymousActor(marketContextOf(request)));
    return true;
  }
}
