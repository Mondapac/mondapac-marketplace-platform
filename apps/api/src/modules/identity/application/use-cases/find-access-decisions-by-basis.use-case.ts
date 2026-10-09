import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AccessDecisionBasisRow,
  AccessDecisionRepository,
} from '../ports/access-decision.repository';
import {
  MAX_BASIS_PAIRS,
  readFailed,
  type AccessDecisionByBasis,
  type AccessDecisionsUnavailable,
  type FieldsInvalid,
} from '../sellers/access-decision-reads';

export type { AccessDecisionByBasis } from '../sellers/access-decision-reads';

export interface FindAccessDecisionsByBasisInput {
  /** 1 to 100 pairs, as the caller passed them; parsed here, and never echoed. */
  readonly items: readonly { readonly sellerId: string; readonly basisId: string }[];
}

export type FindAccessDecisionsByBasisFailure =
  { readonly code: 'access.denied' } | FieldsInvalid | AccessDecisionsUnavailable;

export interface FindAccessDecisionsByBasisDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly decisions: AccessDecisionRepository;
}

const USE_CASE = 'identity.find-access-decisions-by-basis';

const pairKey = (sellerId: string, basisId: string): string => `${sellerId}|${basisId}`;

/**
 * The decisions taken on `sellers`' submissions, by `{ sellerId, basisId }` pair (identity design
 * 8.1; sellers request R-5, the reconciliation job `sellers.reconcile-decisions`; slice 9a),
 * behind `SellerAccessContract.accessDecisionsByBasis`. Rule `system` only, checked by the gate
 * and again here; the Market comes only from the dispatcher's context. Never over HTTP.
 *
 * A row matches only when its Market, `basis_id` and `seller_id` all match one pair: a row of
 * the same basis under another seller is dropped before anything is answered, and another
 * Market's row is never read (Hassan C5). Duplicate pairs are answered once. No reason, no
 * decider: nothing is decrypted. One read-only unit with no transaction (ADR-0025).
 *
 * Fail-closed: any thrown failure is `access-decisions.unavailable`, never an empty list; only
 * `ok` without a row for a pair means "no decision" (Hassan C6, sellers 7.3).
 */
export class FindAccessDecisionsByBasis extends UseCase<
  FindAccessDecisionsByBasisInput,
  readonly AccessDecisionByBasis[],
  FindAccessDecisionsByBasisFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('FindAccessDecisionsByBasis');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FindAccessDecisionsByBasisDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FindAccessDecisionsByBasisInput,
  ): Promise<Result<readonly AccessDecisionByBasis[], FindAccessDecisionsByBasisFailure>> {
    const result = await this.find(context, input);
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'access-decisions.found' : result.error.code,
      ...(result.ok ? { rows: result.value.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async find(
    context: CallContext,
    input: FindAccessDecisionsByBasisInput,
  ): Promise<Result<readonly AccessDecisionByBasis[], FindAccessDecisionsByBasisFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const items: unknown = input?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BASIS_PAIRS) {
      return err({ code: 'validation.failed', fields: [{ path: 'items', code: 'length' }] });
    }
    const pairs = new Set<string>();
    const basisIds = new Set<Id>();
    for (const item of items as readonly unknown[]) {
      const { sellerId, basisId } = (item ?? {}) as { sellerId?: unknown; basisId?: unknown };
      const seller = typeof sellerId === 'string' ? parseId<'Seller'>(sellerId) : null;
      const basis = typeof basisId === 'string' ? parseId(basisId) : null;
      if (seller === null || !seller.ok || basis === null || !basis.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'items', code: 'format' }] });
      }
      pairs.add(pairKey(seller.value, basis.value));
      basisIds.add(basis.value);
    }
    let rows: readonly AccessDecisionBasisRow[];
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.decisions.findByBasis(market, [...basisIds])),
        { readOnly: true },
      );
      // The work never answers `err`; were it to, nothing may be concluded from it.
      if (!read.ok) return err(readFailed(this.#logger, USE_CASE, context, read.error, null));
      rows = read.value;
    } catch (error) {
      return err(readFailed(this.#logger, USE_CASE, context, error, null));
    }
    // C5: a row of another seller under the same basis is dropped before anything is answered.
    return ok(
      rows
        .filter((row) => pairs.has(pairKey(row.sellerId, row.basisId)))
        .map((row) => ({
          sellerId: row.sellerId,
          basisId: row.basisId,
          decisionId: row.id,
          kind: row.decision,
          decidedAt: row.decidedAt,
        })),
    );
  }
}
