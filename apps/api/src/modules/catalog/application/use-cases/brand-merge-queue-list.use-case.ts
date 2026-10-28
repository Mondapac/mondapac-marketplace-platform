import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_READ } from '../../contracts/permissions';
import {
  closedInput,
  MERGE_QUEUE_LIMIT,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandReader } from '../ports/brand.reader';

export interface BrandMergeQueueGroup {
  /** The shared name key; what `brand-merge-queue.dismiss` names. */
  readonly groupKey: string;
  readonly brands: readonly (BrandView & {
    /** Products of the request's Market that use this brand. */
    readonly productCount: number;
  })[];
}

export interface BrandMergeQueueListOutput {
  readonly groups: readonly BrandMergeQueueGroup[];
}

export type BrandMergeQueueListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface BrandMergeQueueListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `brand-merge-queue.list` (catalog brand package): the groups of brands whose names are
 * near-duplicates of each other (case, punctuation, "&" or "and"), written by the migration's
 * backfill and still waiting for an admin. Nothing is merged by itself. Rule: the key
 * `catalog.brand.read` and the admin population. One read-only unit.
 */
export class BrandMergeQueueList extends UseCase<
  Record<string, never>,
  BrandMergeQueueListOutput,
  BrandMergeQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-merge-queue-list',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
  };

  readonly #logger = new Logger('BrandMergeQueueList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandMergeQueueListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, never>,
  ): Promise<Result<BrandMergeQueueListOutput, BrandMergeQueueListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.brand-merge-queue-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: Record<string, never>,
  ): Promise<Result<BrandMergeQueueListOutput, BrandMergeQueueListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, []);
    if (!body.ok) return body;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.brandReader.mergeQueue(market, MERGE_QUEUE_LIMIT)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      groups: read.value.map((group) => ({
        groupKey: group.groupKey,
        brands: group.brands.map((entry) => ({
          ...viewOf(entry.brand),
          productCount: entry.productCount,
        })),
      })),
    });
  }
}
