import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../contracts/permissions';
import { AccessDecision } from '../../domain/access-decision';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type {
  AccessDecisionRepository,
  StoredAccessDecision,
} from '../ports/access-decision.repository';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import {
  isActingAsSession,
  MAX_ACCESS_DECISIONS,
  readFailed,
  RESULTING_STATE,
  type AccessDecisionsUnavailable,
  type FieldsInvalid,
  type SellerAccessDecisionHistory,
  type SellerAccessDecisionView,
} from '../sellers/access-decision-reads';

export type {
  AccessDecisionReasonView,
  SellerAccessDecisionHistory,
  SellerAccessDecisionView,
} from '../sellers/access-decision-reads';

export interface ListSellerAccessDecisionsInput {
  /** As the caller passed it; parsed here, and never echoed when it does not parse. */
  readonly sellerId: string;
}

export type ListSellerAccessDecisionsFailure =
  { readonly code: 'access.denied' } | FieldsInvalid | AccessDecisionsUnavailable;

export interface ListSellerAccessDecisionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly decisions: AccessDecisionRepository;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.list-seller-access-decisions';

/**
 * A seller's access decisions for the admin review (identity design 8.1; sellers request R-5;
 * slice 9a), behind `SellerAccessContract.accessDecisionsOf`, which only `sellers` may import.
 * Rule `permissions [identity.seller-access.view]`, checked by the gate and again here, in the
 * read: the actor must still be an active, verified admin holding the key. Refused with
 * `access.denied`: the system actor (by the gate), a seller actor, an acting-as session (by its
 * marker, Hassan C1) and an admin without the key. Never over HTTP.
 *
 * One read-only unit with no transaction (ADR-0025), so no audit row is written (Hassan C4:
 * `sellers`' `review.read` audit row names the decisions it showed). Newest first, at most
 * {@link MAX_ACCESS_DECISIONS}, with `truncated`. The reason is opened inside `identity` under
 * the seller's key: `present`, `none` (approve, reinstate), or `erased` when the key is
 * destroyed. Any thrown failure (an integrity or missing-key error, the database) makes the whole
 * call `access-decisions.unavailable`, never a partial answer (C2). A seller of another Market
 * and an unknown id both answer an empty list.
 *
 * The log line carries the outcome, the seller id, the row count, the Market and the
 * correlation id: never a reason.
 */
export class ListSellerAccessDecisions extends UseCase<
  ListSellerAccessDecisionsInput,
  SellerAccessDecisionHistory,
  ListSellerAccessDecisionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
  };

  readonly #logger = new Logger('ListSellerAccessDecisions');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSellerAccessDecisionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListSellerAccessDecisionsInput,
  ): Promise<Result<SellerAccessDecisionHistory, ListSellerAccessDecisionsFailure>> {
    const { actor, market } = context;
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    const sellerId = parsed !== null && parsed.ok ? parsed.value : null;
    const result = await this.list(context, sellerId);
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'access-decisions.listed' : result.error.code,
      ...(sellerId === null ? {} : { sellerId }),
      ...(result.ok
        ? { rows: result.value.decisions.length, truncated: result.value.truncated }
        : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    sellerId: Id<'Seller'> | null,
  ): Promise<Result<SellerAccessDecisionHistory, ListSellerAccessDecisionsFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    if (sellerId === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    let read: Result<readonly StoredAccessDecision[], { readonly code: 'access.denied' }>;
    try {
      read = await this.deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<readonly StoredAccessDecision[], { readonly code: 'access.denied' }>
        > => {
          // The actor again, in this read, before any reason is opened (Hassan C1).
          const acting = await readActingGrants(
            this.deps,
            market,
            self,
            [],
            [SELLER_ACCESS_VIEW.key],
          );
          if (acting === null) return err({ code: 'access.denied' });
          return ok(
            await this.deps.decisions.historyOf(market, sellerId, MAX_ACCESS_DECISIONS + 1),
          );
        },
        { readOnly: true },
      );
      if (!read.ok) return read;
      return ok({
        sellerId,
        decisions: read.value.slice(0, MAX_ACCESS_DECISIONS).map(viewOf),
        truncated: read.value.length > MAX_ACCESS_DECISIONS,
      });
    } catch (error) {
      return err(readFailed(this.#logger, USE_CASE, context, error, sellerId));
    }
  }
}

function viewOf(stored: StoredAccessDecision): SellerAccessDecisionView {
  return {
    decisionId: stored.id,
    kind: stored.decision,
    resultingState: RESULTING_STATE[stored.decision],
    decidedAt: stored.decidedAt,
    decidedBy:
      stored.decidedByAccountId === null
        ? { kind: 'system' }
        : { kind: 'admin', accountId: stored.decidedByAccountId },
    basisId: stored.basisId,
    reason: reasonOf(stored),
  };
}

/** Only a destroyed key is `erased`; a reason missing otherwise is a broken row, never "erased". */
function reasonOf(stored: StoredAccessDecision): SellerAccessDecisionView['reason'] {
  if (!AccessDecision.needsReason(stored.decision)) return { status: 'none' };
  if (stored.reasonErased) return { status: 'erased' };
  if (stored.reason === null) throw new Error('identity.access_decisions: a reason is missing');
  return { status: 'present', text: stored.reason };
}
