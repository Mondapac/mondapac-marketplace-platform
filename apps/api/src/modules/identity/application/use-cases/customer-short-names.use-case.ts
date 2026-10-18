import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CUSTOMER_SHORT_NAME_VIEW } from '../../contracts/permissions';
import { shortDisplayName } from '../../domain/display-name';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { MAX_CUSTOMER_IDS } from './customer-account-summaries.use-case';

export interface CustomerShortNamesInput {
  /** As the caller passed them; parsed here, and never echoed when one does not parse. */
  readonly accountIds: readonly string[];
}

/**
 * One customer of `customerShortNames`: the short name ("Maryam R."), never the full name or the
 * address. PERSONAL DATA for the seller who asked: never logged, stored, cached or put in an
 * event or an error body.
 */
export interface CustomerShortNameView {
  readonly accountId: Id<'Account'>;
  readonly shortName: string;
}

export type CustomerShortNamesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface CustomerShortNamesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.customer-short-names';

/**
 * `customerShortNames` (the seller's order notices): per customer account, the short form of its
 * display name. Rule `permissions [identity.customer-short-name.view]`, seller scope, denied while
 * the seller is not approved, checked by the gate and again here, in the read, before any
 * customer row: the actor must still be an active, verified member of the shop holding the key.
 * Refused with `access.denied`: the system actor (by the gate), an admin or customer actor and an
 * acting-as session. The caller (`ordering`) passes only the customers of the shop's own paid
 * seller orders; this read checks the key, not the order. Never over HTTP.
 *
 * Up to 100 ids, duplicates answered once; a malformed id is skipped (counted in the log, never
 * echoed). Only customer accounts of the context's Market are answered, and only those with a
 * name: an unknown id, another Market's, another population's and a nameless account are absent.
 * One read-only unit, no audit row. The log line carries the counts, never a name.
 */
export class CustomerShortNames extends UseCase<
  CustomerShortNamesInput,
  readonly CustomerShortNameView[],
  CustomerShortNamesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [CUSTOMER_SHORT_NAME_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('CustomerShortNames');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerShortNamesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CustomerShortNamesInput,
  ): Promise<Result<readonly CustomerShortNameView[], CustomerShortNamesFailure>> {
    const { actor, market } = context;
    let skipped = 0;
    const result = await this.read(context, input, () => (skipped += 1));
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'customer-short-names.read' : result.error.code,
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
    input: CustomerShortNamesInput,
    skip: () => void,
  ): Promise<Result<readonly CustomerShortNameView[], CustomerShortNamesFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null ||
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
    const self: GrantSubject = {
      accountId: actor.accountId,
      population: 'seller',
      sellerId: actor.sellerId,
    };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<readonly CustomerShortNameView[], CustomerShortNamesFailure>> => {
        // The actor again, in this read, before any customer's name is loaded.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [CUSTOMER_SHORT_NAME_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const rows = await this.deps.accounts.customerSummaries(market, [...ids]);
        const names: CustomerShortNameView[] = [];
        for (const row of rows) {
          const shortName = shortDisplayName(row.displayName);
          if (shortName !== null) names.push({ accountId: row.id, shortName });
        }
        return ok(names);
      },
      { readOnly: true },
    );
  }
}
