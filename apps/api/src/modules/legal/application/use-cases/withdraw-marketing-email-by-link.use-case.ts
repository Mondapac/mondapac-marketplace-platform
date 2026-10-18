import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LegalDependencies } from '../legal-dependencies';
import { withdrawMarketingEmailByLink } from '../marketing-consent-flow';

/**
 * `legal.withdraw-marketing-email-by-link`: withdraws the marketing email consent of the account a
 * one-click unsubscribe link names (rule `anonymous`: the person who clicks has no session). Only
 * notifications calls it, through the legal facade, after it verified the link's signature; it is
 * not a controller dependency. It can only withdraw, never grant.
 */
export class WithdrawMarketingEmailByLink extends UseCase<
  { readonly accountId: Id<'Account'> },
  { readonly withdrawn: boolean },
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.withdraw-marketing-email-by-link',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LegalDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly accountId: Id<'Account'> }) {
    return withdrawMarketingEmailByLink(this.deps, context, input);
  }
}
