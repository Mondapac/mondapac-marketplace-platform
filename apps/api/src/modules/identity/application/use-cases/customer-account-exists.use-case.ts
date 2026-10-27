import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';

export interface CustomerAccountExistsInput {
  readonly accountId: Id<'Account'>;
}

export interface CustomerAccountExistsOutput {
  /** True while a customer account with this id is in the Market; false once erased (or never). */
  readonly exists: boolean;
}

export type CustomerAccountExistsFailure = never;

export interface CustomerAccountExistsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `identity.customer-account-exists`: whether a customer account is still there (customers package
 * 5b: a deletion run that resumes a claim must know whether an earlier run already erased the
 * account before it hands the request back). Rule `system`. One read-only unit; answers a boolean
 * and nothing about the account. Not exposed over HTTP.
 */
export class CustomerAccountExists extends UseCase<
  CustomerAccountExistsInput,
  CustomerAccountExistsOutput,
  CustomerAccountExistsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.customer-account-exists',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerAccountExistsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CustomerAccountExistsInput,
  ): Promise<Result<CustomerAccountExistsOutput, CustomerAccountExistsFailure>> {
    const { market } = context;
    return this.deps.unitOfWork.run(
      market,
      async () => {
        const account = await this.deps.accounts.findById(market, input.accountId);
        return ok({ exists: account !== null && account.state.population === 'customer' });
      },
      { readOnly: true },
    );
  }
}
