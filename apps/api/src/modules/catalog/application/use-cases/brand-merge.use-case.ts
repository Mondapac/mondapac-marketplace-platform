import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT } from '../../contracts/permissions';
import {
  aliasForMergedName,
  BRAND_NAME_MAX,
  brandNameKey,
  sameBrandSpelling,
  tidyBrandName,
  type BrandRefusal,
} from '../../domain/brand';
import {
  adminAccountOf,
  brandIdOf,
  closedInput,
  invalid,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandRepository } from '../ports/brand.repository';
import { similarOf, SIMILAR_LIMIT, type SimilarBrand } from './brand-create.use-case';

export interface BrandMergeInput {
  /** The brand that keeps the products and the aliases (the target). */
  readonly brandId?: unknown;
  /** Brands whose products, names and aliases move to the target; each is archived. */
  readonly sourceBrandIds?: unknown;
  /** Extra spellings that should resolve to the target from now on. */
  readonly aliases?: unknown;
}

export interface BrandMergeOutput {
  readonly brand: BrandView;
  readonly merged: readonly { readonly brandId: string; readonly productsMoved: number }[];
  /** The aliases that were new, in the order they were recorded. */
  readonly aliasesAdded: readonly string[];
}

export type BrandMergeFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | { readonly code: 'brand.alias-taken'; readonly brands: readonly SimilarBrand[] }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface BrandMergeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly clock: Clock;
}

const MERGE_KEYS = ['brandId', 'sourceBrandIds', 'aliases'] as const;
export const MAX_MERGE_SOURCES = 10;
export const MAX_MERGE_ALIASES = 20;
/** A merge moves every product of the Market from the sources: room for a large brand. */
const MERGE_TIMEOUT_MS = 30_000;

/**
 * `brand.merge` (catalog brand package): an admin merges brand values into a brand. Each source
 * brand is archived into the target; its name and its aliases become aliases of the target, so the
 * old text keeps resolving; the products of the REQUEST'S Market that pointed at it now point at the
 * target. Extra `aliases` are recorded for the target too. Rule: the key `catalog.brand.edit` and
 * the admin population.
 *
 * Brands are shared by every Market but a unit sees one Market's products, so a merge moves this
 * Market's products only. The source stays archived with `mergedIntoId` set, and the same merge run
 * again by an admin of another Market moves that Market's products (a repeat changes nothing else).
 * The target must be active; a source may be a draft or active brand. The merge queue rows of the
 * sources are resolved as merged. One unit.
 */
export class BrandMerge extends UseCase<BrandMergeInput, BrandMergeOutput, BrandMergeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_EDIT.key] },
  };

  readonly #logger = new Logger('BrandMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandMergeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandMergeInput,
  ): Promise<Result<BrandMergeOutput, BrandMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.brand-merge',
      code: result.ok ? 'merged' : result.error.code,
      ...(result.ok ? { sources: result.value.merged.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: BrandMergeInput,
  ): Promise<Result<BrandMergeOutput, BrandMergeFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, MERGE_KEYS);
    if (!body.ok) return body;
    const targetId = brandIdOf(body.value['brandId'], 'brandId');
    if (!targetId.ok) return err({ code: 'brand.not-found' });
    const sources = parseSources(body.value['sourceBrandIds']);
    if (!sources.ok) return sources;
    const extra = parseAliases(body.value['aliases']);
    if (!extra.ok) return extra;
    if (sources.value.length === 0 && extra.value.length === 0) {
      return invalid('sourceBrandIds', 'required');
    }
    const { market } = context;
    const { brands } = this.deps;

    try {
      return await this.deps.unitOfWork.run<BrandMergeOutput, BrandMergeFailure>(
        market,
        async () => {
          const target = await brands.findById(market, targetId.value);
          if (target === null) return err({ code: 'brand.not-found' } as const);
          if (target.state.status !== 'active') {
            return err({ code: 'brand.merge-target-not-active' } as const);
          }
          const now = this.deps.clock.now();
          const names: string[] = [];
          const merged: { brandId: string; productsMoved: number }[] = [];
          for (const sourceId of sources.value) {
            const source = await brands.findById(market, sourceId);
            if (source === null) return err({ code: 'brand.not-found' } as const);
            const next = source.mergeInto({ target: target.state, now });
            if (!next.ok) return err(next.error);
            if (next.value.hasChanges) await brands.save(market, next.value);
            await brands.moveAliases(market, sourceId, targetId.value);
            const alias = aliasForMergedName(source.state.name, target.state.name);
            if (alias !== null) names.push(alias);
            merged.push({
              brandId: sourceId,
              productsMoved: await brands.moveProducts(market, sourceId, targetId.value),
            });
          }
          if (sources.value.length > 0) {
            await brands.resolveMerged(market, {
              sources: sources.value,
              target: targetId.value,
              accountId,
              now,
            });
          }
          // The extra spellings must not belong to another brand, by name or as an alias.
          const wanted: string[] = [];
          for (const alias of extra.value) {
            if (sameBrandSpelling(alias, target.state.name)) continue;
            const owners = (await brands.spellingOwners(market, alias, SIMILAR_LIMIT + 1)).filter(
              (brand) => brand.id !== targetId.value && !sources.value.includes(brand.id),
            );
            if (owners.length > 0) {
              return err({
                code: 'brand.alias-taken',
                brands: owners.slice(0, SIMILAR_LIMIT).map(similarOf),
              } as const);
            }
            wanted.push(alias);
          }
          const aliasesAdded = await brands.addAliases(
            market,
            targetId.value,
            [...names, ...wanted],
            now,
          );
          return ok({ brand: viewOf(target.state), merged, aliasesAdded });
        },
        { timeoutMs: MERGE_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}

function parseSources(raw: unknown): Result<Id<'Brand'>[], ValidationFailure> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) return invalid('sourceBrandIds', 'type');
  if (raw.length > MAX_MERGE_SOURCES) return invalid('sourceBrandIds', 'too-many');
  const ids: Id<'Brand'>[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = brandIdOf(item, `sourceBrandIds.${index}`);
    if (!parsed.ok) return parsed;
    if (ids.includes(parsed.value)) return invalid(`sourceBrandIds.${index}`, 'duplicate');
    ids.push(parsed.value);
  }
  return ok(ids);
}

function parseAliases(raw: unknown): Result<string[], ValidationFailure> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) return invalid('aliases', 'type');
  if (raw.length > MAX_MERGE_ALIASES) return invalid('aliases', 'too-many');
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `aliases.${index}`;
    if (typeof item !== 'string') return invalid(path, 'type');
    const alias = tidyBrandName(item);
    if (alias === '' || alias.length > BRAND_NAME_MAX) return invalid(path, 'length');
    if (brandNameKey(alias) === '') return invalid(path, 'no-letters');
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(alias)) return invalid(path, 'chars');
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return ok(aliases);
}
