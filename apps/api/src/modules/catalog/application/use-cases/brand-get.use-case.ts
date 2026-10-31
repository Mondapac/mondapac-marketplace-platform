import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_READ } from '../../contracts/permissions';
import { brandIdOf, viewOf, type BrandView, type ValidationFailure } from '../brands/brand-views';
import type { BrandReader } from '../ports/brand.reader';

export interface BrandGetInput {
  readonly brandId: unknown;
}

export interface BrandGetOutput extends BrandView {
  readonly aliases: readonly string[];
  /** Products of the request's Market that point at this brand. */
  readonly productCount: number;
}

export type BrandGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | ValidationFailure;

export interface BrandGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `brand.get` (catalog brand package): one brand of any status, with its aliases and the number of
 * the request's Market products that use it. A malformed id is `brand.not-found`, like an unknown
 * one. Rule: the key `catalog.brand.read` and the admin population.
 */
export class BrandGet extends UseCase<BrandGetInput, BrandGetOutput, BrandGetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-get',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
  };

  readonly #logger = new Logger('BrandGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandGetInput,
  ): Promise<Result<BrandGetOutput, BrandGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.brand-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: BrandGetInput,
  ): Promise<Result<BrandGetOutput, BrandGetFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = brandIdOf(input?.brandId, 'brandId');
    if (!id.ok) return err({ code: 'brand.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.brandReader.detail(market, id.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'brand.not-found' });
    const { brand, aliases, productCount } = read.value;
    return ok({ ...viewOf(brand), aliases, productCount });
  }
}
