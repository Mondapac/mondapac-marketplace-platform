import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpProofConsumer, StepUpRefusal } from '../../../platform/authz';

// The admin step-up of a protected money action, spent once in the use case's own unit (issue
// #491; ADR-0018: authorization in the use case). The route's `@RequiresStepUp` only checks that a
// fresh proof exists; the proof is deleted here, right before the change it allows, so one code
// pays for one action. An acting-as session (Login as Seller) never spends one.

/** What a refused step-up looks like to the caller: the codes identity gives, as given. */
export type StepUpFailure =
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

/** The ports a flow needs to spend a proof. */
export interface StepUpDependencies {
  readonly stepUp: StepUpProofConsumer;
}

/** Whether the actor is an acting-as session (Login as Seller): the reserved marker on the actor. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

function failureOf(refusal: StepUpRefusal): StepUpFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/**
 * Spends the caller's proof for `actionKey`. Call it inside the open read-write unit, after the
 * checks that can refuse for another reason and right before the write; on `err` return it so the
 * unit commits nothing.
 */
export async function spendStepUp(
  deps: StepUpDependencies,
  context: CallContext,
  actionKey: string,
): Promise<Result<ConsumedStepUp, StepUpFailure>> {
  if (isActingAs(context)) return err({ code: 'access.denied' });
  const spent = await deps.stepUp.consume(context, actionKey);
  return spent.ok ? ok(spent.value) : err(failureOf(spent.error));
}
