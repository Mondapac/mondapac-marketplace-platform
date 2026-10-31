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

export interface BrandArchiveInput {
  readonly brandId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
}

export type BrandArchiveFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface BrandArchiveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
}

/**
 * `brand.archive` (catalog brand package): an admin archives a draft or active brand. Its public
 * page stops answering at once; its slug and aliases stay, and the products that point at it keep
 * their `brand_id`. This is also how a seller's proposal is turned down. Rule: the key
 * `catalog.brand.edit` and the admin population.
 */
export class BrandArchive extends UseCase<
  BrandArchiveInput,
  { readonly brand: BrandView },
  BrandArchiveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandArchive');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandArchiveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandArchiveInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandArchiveFailure>> {
    const result = await this.#archive(context, input);
    this.#logger.log({
      msg: 'catalog.brand-archive',
      code: result.ok ? 'archived' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #archive(
    context: CallContext,
    input: BrandArchiveInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandArchiveFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['brandId', 'version']);
    if (!body.ok) return body;
    const id = brandIdOf(body.value['brandId'], 'brandId');
    if (!id.ok) return err({ code: 'brand.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<{ readonly brand: BrandView }, BrandArchiveFailure>(
        market,
        async () => {
          const found = await this.deps.brands.findById(market, id.value);
          if (found === null) return err({ code: 'brand.not-found' } as const);
          if (found.state.version !== version.value)
            return err({ code: 'conflict.stale' } as const);
          const next = found.archive({ now: this.deps.clock.now() });
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
