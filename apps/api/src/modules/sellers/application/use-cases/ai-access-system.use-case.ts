import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  aiAccessFor,
  type AiAccessDependencies,
  type AiAccessFailure,
  type AiAccessInput,
} from './ai-access.use-case';

/** `aiAccessOf` for event handlers and jobs: rule `system`, the same answer. */
export class AiAccessSystem extends UseCase<AiAccessInput, boolean, AiAccessFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.ai-access-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AiAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AiAccessInput,
  ): Promise<Result<boolean, AiAccessFailure>> {
    return aiAccessFor(this.deps, context, input.sellerId);
  }
}
