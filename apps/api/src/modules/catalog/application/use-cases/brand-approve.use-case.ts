import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT } from '../../contracts/permissions';
import type { BrandRefusal } from '../../domain/brand';
import {
  adminAccountOf,
  brandIdOf,
  closedInput,
  versionOf,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandRepository } from '../ports/brand.repository';

export interface BrandApproveInput {
  readonly brandId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
}

export type BrandApproveFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface BrandApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
}

/**
 * `brand.approve` (catalog brand package): an admin approves a draft brand, normally a seller's
 * proposal, and it becomes active: its public page answers from then on, and product values that
 * name it resolve to it. The admin is recorded as the approver. Rule: the key `catalog.brand.edit`
 * and the admin population.
 */
export class BrandApprove extends UseCase<
  BrandApproveInput,
  { readonly brand: BrandView },
  BrandApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandApproveInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandApproveFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.brand-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: BrandApproveInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandApproveFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['brandId', 'version']);
    if (!body.ok) return body;
    const id = brandIdOf(body.value['brandId'], 'brandId');
    if (!id.ok) return err({ code: 'brand.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<{ readonly brand: BrandView }, BrandApproveFailure>(
        market,
        async () => {
          const found = await this.deps.brands.findById(market, id.value);
          if (found === null) return err({ code: 'brand.not-found' } as const);
          if (found.state.version !== version.value)
            return err({ code: 'conflict.stale' } as const);
          const next = found.approve({ accountId, now: this.deps.clock.now() });
          if (!next.ok) return err(next.error);
          await this.deps.brands.save(market, next.value);
          return ok({ brand: viewOf(next.value.state) });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
