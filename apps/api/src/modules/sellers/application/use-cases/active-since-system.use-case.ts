import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  activeSinceFor,
  type ActiveSinceDependencies,
  type ActiveSinceFailure,
  type ActiveSinceInput,
} from './active-since.use-case';

/** `activeSinceOf` for event handlers and jobs: rule `system`, the same answer. */
export class ActiveSinceSystem extends UseCase<
  ActiveSinceInput,
  Temporal.Instant | null,
  ActiveSinceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.active-since-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ActiveSinceDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ActiveSinceInput,
  ): Promise<Result<Temporal.Instant | null, ActiveSinceFailure>> {
    return activeSinceFor(this.deps, context, input.sellerId);
  }
}
