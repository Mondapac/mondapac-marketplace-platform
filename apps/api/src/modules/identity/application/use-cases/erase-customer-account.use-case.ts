import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AccountErasedAudit } from '../../domain/audit';
import type { AccountRepository } from '../ports/account.repository';

export interface EraseCustomerAccountInput {
  readonly accountId: Id<'Account'>;
}

export interface EraseCustomerAccountOutput {
  /** `erased` now, `already-erased` when no such customer account is left (safe to call twice). */
  readonly code: 'erased' | 'already-erased';
}

export type EraseCustomerAccountFailure = { readonly code: 'access.denied' };

export interface EraseCustomerAccountDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly audit: AuditWriter;
}

/**
 * `identity.erase-customer-account`: erases a customer account for account deletion (CUS-03,
 * customers package 5b). Rule `system`; `customers` calls it through the identity facade from
 * its deletion job. One serializable unit, as the purge of an unverified account: the account's
 * credential lock, then the subject key destroyed and the row deleted, which removes its
 * credential, sessions, links and challenges (C8). Only a customer account:
 * any other population is refused `access.denied` and nothing changes. An id with no customer
 * account in the Market answers `already-erased`, so the caller can run again. The audit row
 * names the account id only.
 */
export class EraseCustomerAccount extends UseCase<
  EraseCustomerAccountInput,
  EraseCustomerAccountOutput,
  EraseCustomerAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.erase-customer-account',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EraseCustomerAccountDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: EraseCustomerAccountInput,
  ): Promise<Result<EraseCustomerAccountOutput, EraseCustomerAccountFailure>> {
    const { market } = context;
    const { unitOfWork, accounts, audit } = this.deps;
    return unitOfWork.run(
      market,
      async (): Promise<Result<EraseCustomerAccountOutput, EraseCustomerAccountFailure>> => {
        if (!(await accounts.lockCredential(market, input.accountId))) {
          return ok({ code: 'already-erased' });
        }
        const account = await accounts.findById(market, input.accountId);
        if (account === null) return ok({ code: 'already-erased' });
        if (account.state.population !== 'customer') return err({ code: 'access.denied' });
        await accounts.remove(market, account);
        await audit.record(context, AccountErasedAudit.entry(account.state.id, {}));
        return ok({ code: 'erased' });
      },
      { isolation: 'serializable' },
    );
  }
}
