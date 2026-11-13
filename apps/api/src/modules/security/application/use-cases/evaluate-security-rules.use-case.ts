import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { evaluateRules, type EvaluationReport } from '../evaluate-flow';
import type { SecurityDependencies } from '../security-dependencies';

/**
 * `security.evaluate-security-rules`: one run of every SOC rule for one Market. Rule `system`: run
 * by the evaluator job every minute only.
 */
export class EvaluateSecurityRules extends UseCase<Record<string, never>, EvaluationReport, never> {
  static override readonly access: AccessDeclaration = {
    name: 'security.evaluate-security-rules',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return evaluateRules(this.deps, context);
  }
}
