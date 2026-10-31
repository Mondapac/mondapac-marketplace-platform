import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT } from '../../contracts/permissions';
import {
  brandNameKey,
  isBrandSlug,
  parseBrandContent,
  type BrandRefusal,
} from '../../domain/brand';
import {
  adminAccountOf,
  brandIdOf,
  closedInput,
  invalid,
  invalidFields,
  versionOf,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandRepository } from '../ports/brand.repository';
import { similarOf, SIMILAR_LIMIT, type SimilarBrand } from './brand-create.use-case';

export interface BrandEditInput {
  readonly brandId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
  readonly name?: unknown;
  /** Optional; changes the slug of a draft only. */
  readonly slug?: unknown;
  readonly summary?: unknown;
  readonly originCountry?: unknown;
  readonly logoImageId?: unknown;
  readonly logoAlt?: unknown;
  readonly headerImageId?: unknown;
}

export type BrandEditFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | { readonly code: 'brand.slug-taken' }
  | { readonly code: 'brand.near-duplicate'; readonly brands: readonly SimilarBrand[] }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface BrandEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
}

const EDIT_KEYS = [
  'brandId',
  'version',
  'name',
  'slug',
  'summary',
  'originCountry',
  'logoImageId',
  'logoAlt',
  'headerImageId',
] as const;

/**
 * `brand.edit` (catalog brand package): an admin replaces the content of a draft or active brand.
 * Rule: the key `catalog.brand.edit` and the admin population. The request is the whole content (a
 * field left out is cleared) and the version the admin saw; a later version is `conflict.stale`. A
 * new name whose key matches another brand is `brand.near-duplicate`. The slug changes only while
 * the brand is a draft (`brand.slug-locked`): a public URL stays. An archived brand is final.
 */
export class BrandEdit extends UseCase<
  BrandEditInput,
  { readonly brand: BrandView },
  BrandEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandEditInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.brand-edit',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: BrandEditInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandEditFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = brandIdOf(body.value['brandId'], 'brandId');
    if (!id.ok) return err({ code: 'brand.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const content = parseBrandContent(body.value);
    if (!content.ok) return invalidFields(content.error);
    const slug = body.value['slug'];
    if (slug !== undefined && slug !== null && !isBrandSlug(slug)) return invalid('slug', 'format');
    const { market } = context;
    const { brands } = this.deps;

    try {
      return await this.deps.unitOfWork.run<{ readonly brand: BrandView }, BrandEditFailure>(
        market,
        async () => {
          const found = await brands.findById(market, id.value);
          if (found === null) return err({ code: 'brand.not-found' } as const);
          if (found.state.version !== version.value)
            return err({ code: 'conflict.stale' } as const);
          const key = brandNameKey(content.value.name);
          if (key !== found.state.nameKey) {
            const similar = (
              await brands.similarTo(market, {
                name: content.value.name,
                nameKey: key,
                limit: SIMILAR_LIMIT + 1,
              })
            )
              .filter((brand) => brand.id !== found.state.id)
              .slice(0, SIMILAR_LIMIT);
            if (similar.length > 0) {
              return err({ code: 'brand.near-duplicate', brands: similar.map(similarOf) } as const);
            }
          }
          const next = found.edit({
            content: content.value,
            ...(typeof slug === 'string' ? { slug } : {}),
            now: this.deps.clock.now(),
          });
          if (!next.ok) return err(next.error);
          const saved = await brands.save(market, next.value);
          if (saved !== null) return err({ code: saved } as const);
          return ok({ brand: viewOf(next.value.state) });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
