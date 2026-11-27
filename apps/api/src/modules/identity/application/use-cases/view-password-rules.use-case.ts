import { ok, type CallContext, type Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PasswordRules } from '../../domain/password-policy';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';

/** The ports the use case needs, bound by `IdentityModule`. */
export interface ViewPasswordRulesDependencies {
  readonly policy: IdentityMarketPolicy;
}

/**
 * `identity.view-password-rules`: the storefront's Create account form shows the request
 * Market's password length rule before the visitor types (identity design 6.5; `ux.md` A2). The
 * numbers are the Market's public configuration, the same for every visitor; the API still
 * checks every new password itself. Reads no account and opens no transaction.
 */
export class ViewPasswordRules extends UseCase<Record<string, never>, PasswordRules, never> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.view-password-rules',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewPasswordRulesDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<PasswordRules, never>> {
    const { minLength, maxLength } = this.deps.policy.passwordRules(context.market);
    return Promise.resolve(ok({ minLength, maxLength }));
  }
}
