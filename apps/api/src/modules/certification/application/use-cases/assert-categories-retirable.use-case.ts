import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  CategoryReferencedByPolicy,
  CertificationUnavailable,
  CertificationValidationFailed,
} from '../../contracts/certification.facade';
import type { CategoryRetirementRepository } from '../ports/category-retirement.repository';

const logger = new Logger('AssertCategoriesRetirable');

/**
 * The most distinct category ids one call takes: a whole moved, merged or archived subtree of a
 * Market's tree. A larger call is refused whole (`validation.failed`), never cut.
 */
export const MAX_RETIRED_CATEGORY_IDS = 5000;

export interface CategoryIdsInput {
  readonly categoryIds: unknown;
}

export type AssertCategoriesRetirableFailure =
  | { readonly code: 'access.denied' }
  | CertificationValidationFailed
  | CertificationUnavailable
  | CategoryReferencedByPolicy;

/** The distinct ids of a call, in first-seen order, or the refusal of the whole call. */
export function parseCategoryIds(
  input: CategoryIdsInput,
): Result<readonly Id<'Category'>[], CertificationValidationFailed> {
  const raw = typeof input === 'object' && input !== null ? input.categoryIds : undefined;
  if (!Array.isArray(raw)) {
    return err({ code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'type' }] });
  }
  const ids = new Set<Id<'Category'>>();
  for (const item of raw as unknown[]) {
    const parsed = typeof item === 'string' ? parseId<'Category'>(item) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'format' }] });
    }
    ids.add(parsed.value);
    if (ids.size > MAX_RETIRED_CATEGORY_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'categoryIds', code: 'range' }] });
    }
  }
  return ok([...ids]);
}

/**
 * The check both use cases of the pair run (design 3.7, 8.1; B2; ADR-0028 d5): refused with
 * `category.referenced-by-policy` and the type codes while a `NOT_APPLICABLE` or
 * `SELLER_REQUIRED` row of a published or pending policy revision names one of the ids; a fault
 * is `certification.unavailable` (the caller refuses its change: fail closed). The answer is the
 * same for every caller and reads nothing of the actor.
 */
export async function assertRetirable(
  repository: CategoryRetirementRepository,
  context: CallContext,
  input: CategoryIdsInput,
): Promise<Result<void, AssertCategoriesRetirableFailure>> {
  const ids = parseCategoryIds(input);
  if (!ids.ok) return ids;
  if (ids.value.length === 0) return ok(undefined);
  let typeCodes: readonly string[];
  try {
    typeCodes = await repository.blockingTypeCodes(context.market, ids.value);
  } catch (error) {
    logger.error(
      `assertCategoriesRetirable failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return err({ code: 'certification.unavailable' });
  }
  if (typeCodes.length > 0) return err({ code: 'category.referenced-by-policy', typeCodes });
  return ok(undefined);
}

/**
 * `assertCategoriesRetirable` for request actors (an admin's move, merge or archive in
 * `catalog`): rule `anonymous`. `catalog` calls it before its unit and refuses its own use case on
 * a refusal or an error (C-4).
 */
export class AssertCategoriesRetirable extends UseCase<
  CategoryIdsInput,
  void,
  AssertCategoriesRetirableFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.assert-categories-retirable',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly repository: CategoryRetirementRepository,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CategoryIdsInput,
  ): Promise<Result<void, AssertCategoriesRetirableFailure>> {
    return assertRetirable(this.repository, context, input);
  }
}
