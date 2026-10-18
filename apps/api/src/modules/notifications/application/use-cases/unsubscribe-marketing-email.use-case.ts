import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  unsubscribeMarketingEmail,
  type MarketingDependencies,
  type UnsubscribeFailure,
} from '../marketing-mail-flow';

/**
 * `notifications.unsubscribe-marketing-email`: the one-click unsubscribe of a marketing mail
 * (rule `anonymous`: the mail client or the reader has no session). The signed token names the
 * account; the consent is withdrawn in `legal`.
 */
export class UnsubscribeMarketingEmail extends UseCase<
  { readonly token: unknown },
  { readonly unsubscribed: true },
  UnsubscribeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.unsubscribe-marketing-email',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MarketingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly token: unknown }) {
    return unsubscribeMarketingEmail(this.deps, context, input);
  }
}
