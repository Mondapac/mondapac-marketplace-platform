import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExclusiveSellerAnswer, ExclusiveSellerFailure } from '../../contracts';
import { exclusiveSellerOf, type InvitationDependencies } from '../seller-invitations-flow';

export interface ReadExclusiveSellerInput {
  readonly accountId: Id<'Account'>;
  readonly at: Temporal.Instant;
}

/**
 * `customers.read-exclusive-seller`: the seller whose exclusive customer the account is at `at`
 * (an active attribution recorded by then), or null (phase 4a: the seller's exclusive-customer
 * discount at the quote; phase 4b: checkout's question). Rule `system`. Ids and the instant only.
 * Not exposed over HTTP.
 */
export class ReadExclusiveSeller extends UseCase<
  ReadExclusiveSellerInput,
  ExclusiveSellerAnswer | null,
  ExclusiveSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-exclusive-seller',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReadExclusiveSellerInput,
  ): Promise<Result<ExclusiveSellerAnswer | null, ExclusiveSellerFailure>> {
    const account =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (account === null || !account.ok || !(input.at instanceof Temporal.Instant)) {
      return err({ code: 'validation.failed' });
    }
    const read = await exclusiveSellerOf(this.deps, context, account.value, input.at);
    return read.ok ? ok(read.value) : err({ code: 'customers.unavailable' });
  }
}
