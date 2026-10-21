import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { customerCaller } from '../customer-caller';
import { removeSaved, type SavedDependencies, type SavedFailure } from '../saved-operations';

/** `remove-saved` for a signed-in customer (rule `own-resources`); a guest keeps its list in the browser. */
export class RemoveSaved extends UseCase<
  { readonly savedId: unknown },
  { readonly removed: true },
  SavedFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.remove-saved',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly savedId: unknown }) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return removeSaved(this.deps, context, caller, input);
  }
}
