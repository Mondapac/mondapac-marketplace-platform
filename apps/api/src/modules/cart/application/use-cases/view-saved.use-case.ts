import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { customerCaller } from '../customer-caller';
import {
  viewSaved,
  type SavedDependencies,
  type SavedFailure,
  type SavedItemView,
} from '../saved-operations';

/** `view-saved` for a signed-in customer (rule `own-resources`); a guest keeps its list in the browser. */
export class ViewSaved extends UseCase<
  Record<string, never>,
  readonly SavedItemView[],
  SavedFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.view-saved',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return viewSaved(this.deps, context, caller);
  }
}

export type { SavedItemView } from '../saved-operations';
