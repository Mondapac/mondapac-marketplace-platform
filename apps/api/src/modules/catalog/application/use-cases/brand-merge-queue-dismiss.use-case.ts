import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT } from '../../contracts/permissions';
import {
  adminAccountOf,
  closedInput,
  invalid,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandRepository } from '../ports/brand.repository';

export interface BrandMergeQueueDismissInput {
  readonly groupKey?: unknown;
}

export interface BrandMergeQueueDismissOutput {
  /** The brands of the group that stay apart. */
  readonly resolved: number;
}

export type BrandMergeQueueDismissFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand-merge-queue.group-not-found' }
  | ValidationFailure;

export interface BrandMergeQueueDismissDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
}

const MAX_GROUP_KEY = 200;

/**
 * `brand-merge-queue.dismiss` (catalog brand package): an admin decides that the brands of a
 * queue group are different brands. Every open row of the group is resolved as `kept-separate`; the
 * brands are untouched. The other way to settle a group is `brand.merge`. Rule: the key
 * `catalog.brand.edit` and the admin population.
 */
export class BrandMergeQueueDismiss extends UseCase<
  BrandMergeQueueDismissInput,
  BrandMergeQueueDismissOutput,
  BrandMergeQueueDismissFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-merge-queue-dismiss',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandMergeQueueDismiss');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandMergeQueueDismissDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandMergeQueueDismissInput,
  ): Promise<Result<BrandMergeQueueDismissOutput, BrandMergeQueueDismissFailure>> {
    const result = await this.#dismiss(context, input);
    this.#logger.log({
      msg: 'catalog.brand-merge-queue-dismiss',
      code: result.ok ? 'dismissed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #dismiss(
    context: CallContext,
    input: BrandMergeQueueDismissInput,
  ): Promise<Result<BrandMergeQueueDismissOutput, BrandMergeQueueDismissFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['groupKey']);
    if (!body.ok) return body;
    const groupKey = body.value['groupKey'];
    if (typeof groupKey !== 'string' || groupKey === '' || groupKey.length > MAX_GROUP_KEY) {
      return invalid('groupKey', 'format');
    }
    const { market } = context;
    return this.deps.unitOfWork.run<BrandMergeQueueDismissOutput, BrandMergeQueueDismissFailure>(
      market,
      async () => {
        const resolved = await this.deps.brands.dismissGroup(market, {
          groupKey,
          accountId,
          now: this.deps.clock.now(),
        });
        if (resolved === 0) return err({ code: 'brand-merge-queue.group-not-found' } as const);
        return ok({ resolved });
      },
    );
  }
}
