import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CUSTOMER_ACCOUNT_VIEW } from '../../contracts/permissions';
import { parseEmailAddress } from '../../domain/email-address';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';

export interface FindCustomerAccountInput {
  /** As typed by the admin; never logged. */
  readonly email: string;
}

/** The minimal fields of one customer account (identity design 12.1). */
export interface CustomerAccountView {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly status: 'active' | 'disabled';
  readonly createdAt: Temporal.Instant;
  readonly emailVerified: boolean;
}

export type FindCustomerAccountFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** No customer with this address in the Market: also the answer for one of another Market. */
  | { readonly code: 'customer.not-found' };

export interface FindCustomerAccountDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

/**
 * Customer lookup by exact email (identity design 12.1 `identity.customer-account.view`): one
 * customer of the context Market and its status. The address is normalised as at sign-in
 * (`parseEmailAddress`) and matched exactly: no partial or prefix search. An unknown address and
 * one of another Market answer the same `customer.not-found`. Rule `permissions
 * [identity.customer-account.view]`, re-checked in the read unit with the actor's state. Reads
 * only; the searched address is never logged.
 */
export class FindCustomerAccount extends UseCase<
  FindCustomerAccountInput,
  CustomerAccountView,
  FindCustomerAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.find-customer-account',
    rule: { kind: 'permissions', allOf: [CUSTOMER_ACCOUNT_VIEW.key] },
  };

  readonly #logger = new Logger('FindCustomerAccount');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FindCustomerAccountDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FindCustomerAccountInput,
  ): Promise<Result<CustomerAccountView, FindCustomerAccountFailure>> {
    const result = await this.find(context, input);
    const { actor, market } = context;
    this.#logger.log({
      msg: 'identity.find-customer-account',
      outcome: result.ok ? 'customer.found' : result.error.code,
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async find(
    context: CallContext,
    input: FindCustomerAccountInput,
  ): Promise<Result<CustomerAccountView, FindCustomerAccountFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<CustomerAccountView, FindCustomerAccountFailure>> => {
        // The actor first, so no personal data is read for one who may no longer see it (C1).
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [CUSTOMER_ACCOUNT_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const account = await this.deps.accounts.findByEmail(
          market,
          'customer',
          email.value.normalized,
        );
        if (account === null) return err({ code: 'customer.not-found' });
        const { state } = account;
        return ok({
          accountId: state.id,
          email: state.email.typed,
          status: state.status,
          createdAt: state.createdAt,
          emailVerified: state.emailVerifiedAt !== null,
        });
      },
      { readOnly: true },
    );
  }
}
