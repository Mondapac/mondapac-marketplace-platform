import {
  applyDecorators,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { callContextOf } from '../call-context/call-context.decorator';
import { ACCESS_DENIED_STATUS } from './access-denied';

/** Why a guarded action may not go ahead; the codes of `IdentityFacade.requireStepUp`. */
export type StepUpRefusal =
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.unavailable' }
  | { readonly code: keyof typeof ACCESS_DENIED_STATUS };

/**
 * The port the guard asks, implemented by `identity` (seller OTP policy; issue #491): may this
 * session do this registered action now? A seller action follows the shop's rule for a seller
 * session; an admin action (`audience: 'admin'`) always needs a fresh proof of an admin session.
 * It is provided by `AuthzModule` from `identity`'s export, as the gate's `AuthorisationCheck` is
 * (`platform/` imports no module). A use case may inject it ({@link STEP_UP_CHECK}) to check the
 * same proof in the application layer.
 */
export interface StepUpCheck {
  check(context: CallContext, actionKey: string): Promise<Result<void, StepUpRefusal>>;
}

/** What a consumed proof was: the session it belonged to and when its code was verified. */
export interface ConsumedStepUp {
  readonly sessionId: Id<'Session'>;
  readonly verifiedAt: Temporal.Instant;
}

/**
 * Spends the fresh proof of an admin action once (issue #491, single use), implemented by
 * `identity`. Call it inside the caller's own open read-write unit, right before the change the
 * proof allows, as `AuditWriter` is called: it opens no unit and passes no gate (the guarded use
 * case has passed its own). It deletes the proof of this session for this action and answers
 * when its code was verified, or the refusal (`second-factor.required` when no fresh proof is
 * left, `second-factor.enrolment-required`, `access.denied`, `access.unavailable`). Fail closed:
 * on any refusal the caller returns `err`, so its unit commits nothing. Two units with one proof
 * are serialised on the proof's row and exactly one gets it.
 */
export interface StepUpProofConsumer {
  consume(context: CallContext, actionKey: string): Promise<Result<ConsumedStepUp, StepUpRefusal>>;
}

/** What `identity` exports; `AuthzModule` binds it to {@link STEP_UP_CHECK}. */
export const STEP_UP_SOURCE = Symbol('STEP_UP_SOURCE');
/** What the guard injects; global through `AuthzModule`. */
export const STEP_UP_CHECK = Symbol('STEP_UP_CHECK');
/** What `identity` exports; `AuthzModule` binds it to {@link STEP_UP_CONSUMER}. */
export const STEP_UP_CONSUMER_SOURCE = Symbol('STEP_UP_CONSUMER_SOURCE');
/** What a use case injects to spend an admin proof in its own unit; global through `AuthzModule`. */
export const STEP_UP_CONSUMER = Symbol('STEP_UP_CONSUMER');

const REQUIRES_STEP_UP = 'requires-step-up-action';

const STATUS: Readonly<Record<string, number>> = {
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  'access.unavailable': 503,
};

/**
 * Guards one unsafe route with the two-step rule of a registered action (seller OTP policy; issue
 * #491): `@RequiresStepUp('pricing.price.change')`. The guard runs after the global guards
 * (Market, rate limit, actor, CSRF), so the actor is the verified session's. With a rule that
 * asks for a code and no proof of this session for this action in the last few minutes, the
 * request is refused `403 second-factor.required` with `details.actionKey`: the panel then
 * presents a code and repeats the request.
 *
 * - A seller action: the shop's rule. An action the shop does not guard passes at once; a caller
 *   that is not a seller session is not subject to a shop's rule. The seller panel verifies with
 *   `POST identity/seller/step-up/verify`.
 * - An admin action (`audience: 'admin'`): always required for an admin session, refused for any
 *   other caller. The admin panel verifies with `POST identity/admin/step-up/verify`.
 *
 * An unregistered key answers `503 access.unavailable`; an acting-as session is refused. Put it
 * on the route of the action, never on a read.
 */
export const RequiresStepUp = (actionKey: string): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(REQUIRES_STEP_UP, actionKey), UseGuards(StepUpGuard));

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(STEP_UP_CHECK) private readonly stepUp: StepUpCheck,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const actionKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRES_STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);
    // A route without the decorator never gets this guard; fail closed if one does.
    if (actionKey === undefined) throw new HttpException({ code: 'access.unavailable' }, 503);
    const request = context.switchToHttp().getRequest<{ id?: unknown }>();
    const result = await this.stepUp.check(callContextOf(request), actionKey);
    if (result.ok) return true;
    const refusal = result.error;
    const status =
      STATUS[refusal.code] ??
      ACCESS_DENIED_STATUS[refusal.code as keyof typeof ACCESS_DENIED_STATUS] ??
      503;
    throw new HttpException(
      {
        statusCode: status,
        code: refusal.code,
        ...('actionKey' in refusal ? { details: { actionKey: refusal.actionKey } } : {}),
      },
      status,
    );
  }
}
