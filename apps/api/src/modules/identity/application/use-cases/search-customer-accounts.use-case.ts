import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CUSTOMER_ACCOUNT_VIEW } from '../../contracts/permissions';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';

/** The shortest and the longest search term, in characters after trimming. */
export const MIN_CUSTOMER_SEARCH_LENGTH = 2;
export const MAX_CUSTOMER_SEARCH_LENGTH = 80;
/** At most this many accounts are answered; a wider match is flagged `capped`. */
export const MAX_CUSTOMER_SEARCH_MATCHES = 200;

export interface SearchCustomerAccountsInput {
  /** PERSONAL DATA: never logged, never echoed in an error. */
  readonly term: string;
}

export interface SearchCustomerAccountsView {
  readonly accountIds: readonly Id<'Account'>[];
  /** True when more than {@link MAX_CUSTOMER_SEARCH_MATCHES} accounts matched. */
  readonly capped: boolean;
}

export type SearchCustomerAccountsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface SearchCustomerAccountsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.search-customer-accounts';

/**
 * `searchCustomerAccounts` (the admin order list's customer-name search): the customer accounts
 * whose display name contains the term. Same gate as `customerAccountSummaries`: rule
 * `permissions [identity.customer-account.view]`, checked by the gate and again in the read,
 * before any customer row; refused with `access.denied` for the system actor, a seller or
 * customer actor, an acting-as session and an admin without the key. Only the Market's customer
 * accounts are searched. One read-only unit, one query, no audit row. The log line carries the
 * counts, never the term or a name.
 */
export class SearchCustomerAccounts extends UseCase<
  SearchCustomerAccountsInput,
  SearchCustomerAccountsView,
  SearchCustomerAccountsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [CUSTOMER_ACCOUNT_VIEW.key] },
  };

  readonly #logger = new Logger('SearchCustomerAccounts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchCustomerAccountsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchCustomerAccountsInput,
  ): Promise<Result<SearchCustomerAccountsView, SearchCustomerAccountsFailure>> {
    const { actor, market } = context;
    const result = await this.read(context, input);
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'search-customer-accounts.read' : result.error.code,
      ...(result.ok ? { rows: result.value.accountIds.length, capped: result.value.capped } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: SearchCustomerAccountsInput,
  ): Promise<Result<SearchCustomerAccountsView, SearchCustomerAccountsFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const raw = input?.term as unknown;
    const term = typeof raw === 'string' ? raw.trim() : null;
    if (
      term === null ||
      [...term].length < MIN_CUSTOMER_SEARCH_LENGTH ||
      [...term].length > MAX_CUSTOMER_SEARCH_LENGTH
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'term', code: 'length' }] });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SearchCustomerAccountsView, SearchCustomerAccountsFailure>> => {
        // The actor again, in this read, before any customer row is searched.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [CUSTOMER_ACCOUNT_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const ids = await this.deps.accounts.searchCustomerIdsByName(
          market,
          term,
          MAX_CUSTOMER_SEARCH_MATCHES + 1,
        );
        return ok({
          accountIds: ids.slice(0, MAX_CUSTOMER_SEARCH_MATCHES),
          capped: ids.length > MAX_CUSTOMER_SEARCH_MATCHES,
        });
      },
      { readOnly: true },
    );
  }
}
