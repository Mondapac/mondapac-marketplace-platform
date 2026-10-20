import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { customerCaller } from '../customer-caller';
import { saveForLater, type SavedDependencies, type SavedFailure } from '../saved-operations';

/** `save-for-later` for a signed-in customer (rule `own-resources`); a guest keeps its list in the browser. */
export class SaveForLater extends UseCase<
  { readonly lineId: unknown },
  { readonly savedId: Id<'SavedItem'> },
  SavedFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.save-for-later',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly lineId: unknown }) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return saveForLater(this.deps, context, caller, input);
  }
}
