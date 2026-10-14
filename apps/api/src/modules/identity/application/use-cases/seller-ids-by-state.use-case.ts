import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../contracts/permissions';
import { SELLER_ACCESS_STATES } from '../../domain/events';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccountReader, SellerStateCounts } from '../ports/seller-account-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { MAX_SELLER_IDS } from '../sellers/read-seller-access';

export interface SellerIdsByStateInput {
  /** The state to page through; null with `limit` 0 for the counts only. */
  readonly state: string | null;
  /** The last id of the previous page; null for the first page. */
  readonly before: string | null;
  /** 0 (the counts only) to 100. */
  readonly limit: number;
}

export interface SellerIdsByStatePage {
  /** Newest first (UUID v7: by id, descending). */
  readonly sellerIds: readonly Id<'Seller'>[];
  /** The `before` of the next page, or null after the last. */
  readonly next: Id<'Seller'> | null;
  readonly counts: SellerStateCounts;
}

export type SellerIdsByStateFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface SellerIdsByStateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sellerAccounts: SellerAccountReader;
}

const USE_CASE = 'identity.seller-ids-by-state';

/**
 * The admin part of sellers design R-6 (identity design 8.1; sellers design 7.8; sellers slice
 * 6b): one page of registered seller ids in one access state, newest first, and the count of the
 * Market's registered sellers per state, behind the seller-access contract that only `sellers`
 * may import. `sellers` pages its identity-state tabs with it and decorates the ids from its own
 * rows and `sellerAccountSummaries`. Ids and counts only: no owner, no personal field.
 *
 * Rule `permissions [identity.seller-access.view]`, checked by the gate and again here: the actor
 * must still be an active admin holding the key, read in the unit **before** any seller row, as
 * `sellerAccountSummaries`. Refused with `access.denied`: the system actor (by the gate), a
 * seller actor, an acting-as session and an admin without the key. Never over HTTP. One
 * read-only unit (ADR-0025). The log line carries the outcome, the page size and codes.
 */
export class SellerIdsByState extends UseCase<
  SellerIdsByStateInput,
  SellerIdsByStatePage,
  SellerIdsByStateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
  };

  readonly #logger = new Logger('SellerIdsByState');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerIdsByStateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerIdsByStateInput,
  ): Promise<Result<SellerIdsByStatePage, SellerIdsByStateFailure>> {
    const { actor, market } = context;
    const result = await this.read(context, input);
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'seller-ids.read' : result.error.code,
      ...(result.ok
        ? { rows: result.value.sellerIds.length, more: result.value.next !== null }
        : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: SellerIdsByStateInput,
  ): Promise<Result<SellerIdsByStatePage, SellerIdsByStateFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const valid = validated(input);
    if (!valid.ok) return valid;
    const { state, before, limit } = valid.value;
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SellerIdsByStatePage, SellerIdsByStateFailure>> => {
        // The actor again, in this read, before any seller row.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [SELLER_ACCESS_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const counts = await this.deps.sellerAccounts.stateCounts(market);
        if (state === null || limit === 0) return ok({ sellerIds: [], next: null, counts });
        // One id more than the page tells whether another page exists.
        const ids = await this.deps.sellerAccounts.sellerIdsInState(market, {
          state,
          before,
          limit: limit + 1,
        });
        const more = ids.length > limit;
        const sellerIds = more ? ids.slice(0, limit) : ids;
        return ok({ sellerIds, next: more ? sellerIds[sellerIds.length - 1]! : null, counts });
      },
      { readOnly: true },
    );
  }
}

function validated(input: SellerIdsByStateInput): Result<
  {
    readonly state: SellerAccessStateCode | null;
    readonly before: Id<'Seller'> | null;
    readonly limit: number;
  },
  SellerIdsByStateFailure
> {
  const fields: { path: string; code: string }[] = [];
  const { limit } = input;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_SELLER_IDS) {
    fields.push({ path: 'limit', code: 'range' });
  }
  let state: SellerAccessStateCode | null = null;
  if (input.state !== null) {
    if ((SELLER_ACCESS_STATES as readonly unknown[]).includes(input.state)) {
      state = input.state as SellerAccessStateCode;
    } else fields.push({ path: 'state', code: 'unknown' });
  } else if (limit > 0) fields.push({ path: 'state', code: 'required' });
  let before: Id<'Seller'> | null = null;
  if (input.before !== null) {
    const parsed = typeof input.before === 'string' ? parseId<'Seller'>(input.before) : null;
    if (parsed === null || !parsed.ok) fields.push({ path: 'before', code: 'format' });
    else before = parsed.value;
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ state, before, limit });
}
