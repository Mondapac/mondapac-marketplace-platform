import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CUSTOMER_ACCOUNT_VIEW } from '../../contracts/permissions';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';

/** At most this many ids per call; a larger call is refused whole. */
export const MAX_CUSTOMER_IDS = 100;

export interface CustomerAccountSummariesInput {
  /** As the caller passed them; parsed here, and never echoed when one does not parse. */
  readonly accountIds: readonly string[];
}

/**
 * One customer of `customerAccountSummaries`. The name and the address are PERSONAL DATA for the
 * admin who asked: never logged, stored, cached or put in an event or an error body.
 */
export interface CustomerAccountSummaryView {
  readonly accountId: Id<'Account'>;
  readonly displayName: string | null;
  /** The sign-in address, as typed. */
  readonly email: string;
}

export type CustomerAccountSummariesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface CustomerAccountSummariesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.customer-account-summaries';

/**
 * `customerAccountSummaries` (the admin order pages): per customer account, its display name and
 * sign-in address, so an order shows who placed it. Rule `permissions
 * [identity.customer-account.view]`, the key of the customer lookup, checked by the gate and
 * again here, in the read: the actor must still be an active, verified admin holding the key,
 * read **before** any customer row. Refused with `access.denied`: the system actor (by the gate),
 * a seller or customer actor, an acting-as session and an admin without the key. Never over HTTP.
 *
 * Up to 100 ids (0 answers an empty list without a read), duplicates answered once. One bad
 * entry never fails the batch: a malformed id is skipped (counted in the log, never echoed) and
 * answered absent like an unknown one. Only customer accounts of the context's Market are
 * answered: an unknown id, another Market's and another population's account are absent; an
 * account without a password credential is still answered (the summary reads none). One
 * read-only unit with one account query, no audit row. The log line carries the counts, never
 * an address or a name.
 */
export class CustomerAccountSummaries extends UseCase<
  CustomerAccountSummariesInput,
  readonly CustomerAccountSummaryView[],
  CustomerAccountSummariesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [CUSTOMER_ACCOUNT_VIEW.key] },
  };

  readonly #logger = new Logger('CustomerAccountSummaries');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerAccountSummariesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CustomerAccountSummariesInput,
  ): Promise<Result<readonly CustomerAccountSummaryView[], CustomerAccountSummariesFailure>> {
    const { actor, market } = context;
    let skipped = 0;
    const result = await this.read(context, input, () => (skipped += 1));
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'customer-account-summaries.read' : result.error.code,
      ...(result.ok ? { rows: result.value.length } : {}),
      ...(skipped > 0 ? { malformedIds: skipped } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: CustomerAccountSummariesInput,
    skip: () => void,
  ): Promise<Result<readonly CustomerAccountSummaryView[], CustomerAccountSummariesFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const raw = input?.accountIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_CUSTOMER_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] });
    }
    const ids = new Set<Id<'Account'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Account'>(value) : null;
      if (parsed === null || !parsed.ok) skip();
      else ids.add(parsed.value);
    }
    if (ids.size === 0) return ok([]);
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<
        Result<readonly CustomerAccountSummaryView[], CustomerAccountSummariesFailure>
      > => {
        // The actor again, in this read, before any customer's address is loaded.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [CUSTOMER_ACCOUNT_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const rows = await this.deps.accounts.customerSummaries(market, [...ids]);
        return ok(
          rows.map((row) => ({
            accountId: row.id,
            displayName: row.displayName,
            email: row.email,
          })),
        );
      },
      { readOnly: true },
    );
  }
}
