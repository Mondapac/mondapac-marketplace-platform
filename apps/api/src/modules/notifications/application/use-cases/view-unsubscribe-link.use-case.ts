import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  checkUnsubscribeLink,
  type MarketingDependencies,
  type UnsubscribeFailure,
} from '../marketing-mail-flow';

/**
 * `notifications.view-unsubscribe-link`: whether a marketing mail's unsubscribe link is valid
 * (rule `anonymous`: the reader of the mail has no session). Changes nothing.
 */
export class ViewUnsubscribeLink extends UseCase<
  { readonly token: unknown },
  { readonly valid: true },
  UnsubscribeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.view-unsubscribe-link',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MarketingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly token: unknown }) {
    return Promise.resolve(checkUnsubscribeLink(this.deps, context, input));
  }
}
