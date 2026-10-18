import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { forgetAccount } from '../engagement-flow';

/**
 * `engagement.forget-account`: deletes an account's behaviour and personalization switch in the
 * Market (rule `system`), for account deletion. Not exposed over HTTP; reached through the
 * engagement facade.
 */
export class ForgetAccount extends UseCase<
  { readonly accountId: Id<'Account'> },
  { readonly events: number },
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.forget-account',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly accountId: Id<'Account'> }) {
    return forgetAccount(this.deps, context, input);
  }
}
