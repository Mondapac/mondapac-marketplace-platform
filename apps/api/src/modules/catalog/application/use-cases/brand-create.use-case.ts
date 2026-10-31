import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT } from '../../contracts/permissions';
import {
  Brand,
  brandNameKey,
  isBrandSlug,
  parseBrandContent,
  suggestBrandSlug,
  type BrandRefusal,
} from '../../domain/brand';
import {
  adminAccountOf,
  closedInput,
  invalid,
  invalidFields,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandRepository } from '../ports/brand.repository';

export interface BrandCreateInput {
  readonly name?: unknown;
  /** Optional: the URL slug; derived from the name when absent. */
  readonly slug?: unknown;
  readonly summary?: unknown;
  readonly originCountry?: unknown;
  readonly logoImageId?: unknown;
  readonly logoAlt?: unknown;
  readonly headerImageId?: unknown;
}

/** A brand that stands in the way of a new name, as the refusal lists it. */
export interface SimilarBrand {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}

export type BrandCreateFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.slug-taken' }
  | { readonly code: 'brand.near-duplicate'; readonly brands: readonly SimilarBrand[] }
  | ValidationFailure;

export interface BrandCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = [
  'name',
  'slug',
  'summary',
  'originCountry',
  'logoImageId',
  'logoAlt',
  'headerImageId',
] as const;

/** How many slugs a create tries before it falls back to a random suffix. */
const MAX_SLUG_PROBES = 50;

/** How many look-alikes a refusal lists. */
export const SIMILAR_LIMIT = 5;

export const similarOf = (state: {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}): SimilarBrand => ({ id: state.id, slug: state.slug, name: state.name, status: state.status });

/**
 * `brand.create` (catalog brand package): an admin creates a brand, active at once. Rule: the key
 * `catalog.brand.edit` and the admin population. The name is tidied and checked; a name whose key
 * (case, punctuation, "&" or "and") matches a brand that is not archived, or that is an alias of
 * one, is `brand.near-duplicate` with the look-alikes: the admin merges or edits instead of
 * making a twin. The slug is the one given, which must be free (`brand.slug-taken`), or one derived
 * from the name with a numeric suffix when taken.
 */
export class BrandCreate extends UseCase<
  BrandCreateInput,
  { readonly brand: BrandView },
  BrandCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-create',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandCreateInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.brand-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: BrandCreateInput,
  ): Promise<Result<{ readonly brand: BrandView }, BrandCreateFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const content = parseBrandContent(body.value);
    if (!content.ok) return invalidFields(content.error);
    const givenSlug = body.value['slug'];
    if (givenSlug !== undefined && givenSlug !== null && !isBrandSlug(givenSlug)) {
      return invalid('slug', 'format');
    }
    const { market } = context;
    const { brands } = this.deps;

    return this.deps.unitOfWork.run<{ readonly brand: BrandView }, BrandCreateFailure>(
      market,
      async () => {
        const similar = await brands.similarTo(market, {
          name: content.value.name,
          nameKey: brandNameKey(content.value.name),
          limit: SIMILAR_LIMIT,
        });
        if (similar.length > 0) {
          return err({ code: 'brand.near-duplicate', brands: similar.map(similarOf) } as const);
        }
        let slug: string;
        if (typeof givenSlug === 'string') {
          if (await brands.slugTaken(market, givenSlug))
            return err({ code: 'brand.slug-taken' } as const);
          slug = givenSlug;
        } else {
          const base = suggestBrandSlug(content.value.name);
          let free: string | null = null;
          // A handful of probes finds a free suffix; the unique index settles a race.
          for (let n = 1; n <= MAX_SLUG_PROBES && free === null; n += 1) {
            const candidate = n === 1 ? base : `${base}-${n}`;
            if (!(await brands.slugTaken(market, candidate))) free = candidate;
          }
          slug = free ?? `${base}-${this.deps.ids.next<'Brand'>().slice(-8)}`;
        }
        const created = Brand.create({
          id: this.deps.ids.next<'Brand'>(),
          content: content.value,
          slug,
          origin: { kind: 'admin', accountId },
          now: this.deps.clock.now(),
        });
        if (!created.ok) return err(created.error);
        const added = await brands.add(market, created.value);
        if (added !== null) return err({ code: added } as const);
        return ok({ brand: viewOf(created.value.state) });
      },
    );
  }
}
