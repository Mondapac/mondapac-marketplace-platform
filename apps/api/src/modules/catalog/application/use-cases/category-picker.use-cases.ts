import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_OWN_PRODUCT_EDIT,
  CATALOG_PLATFORM_PRODUCT_EDIT,
} from '../../contracts/permissions';
import { categoryPicker, type PickerChoice } from '../../domain/category-picker';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface CategoryPickerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
}

export interface CategoryPickerAnswer {
  /** The locale the names are in (the Market default; a missing name falls back to another). */
  readonly locale: string;
  readonly choices: readonly PickerChoice[];
}

export type CategoryPickerFailure =
  { readonly code: 'access.denied' } | { readonly code: 'catalog.categories-unavailable' };

async function readPicker(
  deps: CategoryPickerDependencies,
  context: CallContext,
  includeHidden: boolean,
): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
  const { market } = context;
  let locale: string;
  let maxLevel: number;
  try {
    locale = deps.policy.locales(market).default;
    maxLevel = deps.policy.maxCategoryDepth(market);
  } catch {
    return err({ code: 'catalog.categories-unavailable' });
  }
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1)),
    { readOnly: true },
  );
  // A tree larger than the cap is refused, never shown in part (fail closed).
  if (!read.ok || read.value.length > MAX_TREE_NODES) {
    return err({ code: 'catalog.categories-unavailable' });
  }
  return ok({ locale, choices: categoryPicker(read.value, locale, maxLevel, includeHidden) });
}

/**
 * `own-product.category-picker` (categories package C5a): the choices of the seller product
 * form's "Categories and tax" card. Levels 3 and 4 only, children first and the level-3 node
 * itself as "General" when it has children; hidden nodes (and anything under one) are not
 * offered to a seller. Rule: the key `catalog.own-product.edit`, as the form that uses it.
 */
export class OwnCategoryPicker extends UseCase<
  Record<string, never>,
  CategoryPickerAnswer,
  CategoryPickerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-category-picker',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryPickerDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'seller') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return readPicker(this.deps, context, false);
  }
}

/**
 * `platform-product.category-picker`: the same read for the admin platform product form; hidden
 * nodes are offered too (a PLATFORM product may sit on a hidden category). Rule: the key
 * `catalog.platform-product.edit`.
 */
export class PlatformCategoryPicker extends UseCase<
  Record<string, never>,
  CategoryPickerAnswer,
  CategoryPickerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-category-picker',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryPickerDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return readPicker(this.deps, context, true);
  }
}
