import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../contracts/permissions';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccountReader } from '../ports/seller-account-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { MAX_SELLER_IDS } from '../sellers/read-seller-access';

export interface SellerAccountSummariesInput {
  /** As the caller passed them; parsed here, and never echoed when one does not parse. */
  readonly sellerIds: readonly string[];
}

/**
 * One seller of `sellerAccountSummaries` (identity design 8.1; slice 9b). The owner's address
 * and name are PERSONAL DATA, for the admin who asked only.
 */
export interface SellerAccountSummaryView {
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  readonly stateChangedAt: Temporal.Instant;
  /** Null while the seller has no owner (an owner invitation not accepted yet). */
  readonly owner: {
    readonly accountId: Id<'Account'>;
    readonly displayName: string | null;
    /** The sign-in address, as typed. */
    readonly email: string;
  } | null;
}

export type SellerAccountSummariesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface SellerAccountSummariesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sellerAccounts: SellerAccountReader;
}

const USE_CASE = 'identity.seller-account-summaries';

/**
 * `sellerAccountSummaries` (identity design 8.1; ADR-0022 decision 2; sellers design 7.8, the
 * seller list SEL-14 "without a join"; slice 9b): per seller, its access state, the instant of
 * its last change, and its owner's account id, display name and sign-in address, behind the
 * seller-access contract that only `sellers` may import. Rule `permissions
 * [identity.seller-access.view]`, checked by the gate and again here, in the read: the actor must
 * still be an active, verified admin holding the key, read **before** any owner row. Refused with
 * `access.denied`: the system actor (by the gate), a seller actor, an acting-as session and an
 * admin without the key. Never over HTTP.
 *
 * 1 to 100 ids (0 answers an empty list without a read), duplicates answered once; a malformed
 * id is `validation.failed` and never echoed. Only registered sellers of the context's Market
 * are answered: an unknown id, another Market's seller and an unregistered one are absent. One
 * read-only unit (ADR-0025: no transaction), so no audit row. The log line carries the counts,
 * the Market and the correlation id: never an address or a name.
 */
export class SellerAccountSummaries extends UseCase<
  SellerAccountSummariesInput,
  readonly SellerAccountSummaryView[],
  SellerAccountSummariesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
  };

  readonly #logger = new Logger('SellerAccountSummaries');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerAccountSummariesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerAccountSummariesInput,
  ): Promise<Result<readonly SellerAccountSummaryView[], SellerAccountSummariesFailure>> {
    const { actor, market } = context;
    const result = await this.read(context, input);
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'seller-account-summaries.read' : result.error.code,
      ...(result.ok ? { rows: result.value.length } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: SellerAccountSummariesInput,
  ): Promise<Result<readonly SellerAccountSummaryView[], SellerAccountSummariesFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const raw = input.sellerIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_SELLER_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] });
    }
    const ids = new Set<Id<'Seller'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
      }
      ids.add(parsed.value);
    }
    if (ids.size === 0) return ok([]);
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<
        Result<readonly SellerAccountSummaryView[], SellerAccountSummariesFailure>
      > => {
        // The actor again, in this read, before any owner's address is loaded.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [SELLER_ACCESS_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const records = await this.deps.sellerAccounts.summariesOf(market, [...ids]);
        return ok(
          records.map((record) => ({
            sellerId: record.sellerId,
            state: record.state,
            stateChangedAt: record.stateChangedAt,
            owner:
              record.owner === null
                ? null
                : {
                    accountId: record.owner.accountId,
                    displayName: record.owner.displayName,
                    email: record.owner.email,
                  },
          })),
        );
      },
      { readOnly: true },
    );
  }
}
