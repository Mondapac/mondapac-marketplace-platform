import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExclusiveSellerAnswer, ExclusiveSellerFailure } from '../../contracts';
import { ownExclusiveSeller, type InvitationDependencies } from '../seller-invitations-flow';

/**
 * `customers.read-own-exclusive-seller`: the seller whose exclusive customer the signed-in customer
 * is now, or null (phase 4b: checkout freezes it on the order lines with the lower commission).
 * Rule `own-resources`; the account is the session's; a Login-as session is refused. Not exposed
 * over HTTP.
 */
export class ReadOwnExclusiveSeller extends UseCase<
  Record<string, never>,
  ExclusiveSellerAnswer | null,
  ExclusiveSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-own-exclusive-seller',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ExclusiveSellerAnswer | null, ExclusiveSellerFailure>> {
    const read = await ownExclusiveSeller(this.deps, context);
    if (read.ok) return ok(read.value);
    return read.error.code === 'access.denied'
      ? err({ code: 'access.denied' })
      : err({ code: 'customers.unavailable' });
  }
}
