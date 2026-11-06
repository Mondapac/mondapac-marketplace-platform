import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  CertificationUnavailable,
  CertificationValidationFailed,
  RetiredCategoriesFlagged,
} from '../../contracts/certification.facade';
import {
  RetiredCategoryFlaggedAudit,
  RetiredCategoryFlaggedRelaxingAudit,
} from '../../domain/audit';
import type { CategoryRetirementRepository } from '../ports/category-retirement.repository';
import { parseCategoryIds, type CategoryIdsInput } from './assert-categories-retirable.use-case';

const logger = new Logger('PlatformCategoriesRetired');

export type PlatformCategoriesRetiredFailure =
  { readonly code: 'access.denied' } | CertificationValidationFailed | CertificationUnavailable;

export interface PlatformCategoriesRetiredDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly repository: CategoryRetirementRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `platformCategoriesRetired` (design 3.7, 8.1; C-4; B2): the backstop for the race between
 * `assertCategoriesRetirable` and `catalog`'s commit. `catalog`'s own handler of its merge and
 * archive events calls it with the retired ids. In one read-write unit it flags every id that a
 * row of a published or pending policy revision names (`retired_category_flags`, a repeat is
 * ignored) and writes one audit row per new flag: `flagged-relaxing` (a security event, so the
 * admins are alerted) when a `NOT_APPLICABLE` or `SELLER_REQUIRED` row names it, `flagged`
 * otherwise. It never rewrites a policy row. Idempotent: a repeated call flags nothing new and
 * writes nothing. Rule `system`. A fault is `certification.unavailable`, so the handler retries.
 */
export class PlatformCategoriesRetired extends UseCase<
  CategoryIdsInput,
  RetiredCategoriesFlagged,
  PlatformCategoriesRetiredFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.platform-categories-retired',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformCategoriesRetiredDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryIdsInput,
  ): Promise<Result<RetiredCategoriesFlagged, PlatformCategoriesRetiredFailure>> {
    const ids = parseCategoryIds(input);
    if (!ids.ok) return ids;
    if (ids.value.length === 0) return ok({ flagged: 0, relaxing: 0 });
    const { deps } = this;
    const { market } = context;
    try {
      return await deps.unitOfWork.run(market, async () => {
        const named = await deps.repository.namedCategories(market, ids.value);
        const inserted = new Set(
          await deps.repository.insertFlags(
            market,
            named.map((row) => row.categoryId),
            deps.clock.now(),
          ),
        );
        let relaxing = 0;
        for (const row of named) {
          if (!inserted.has(row.categoryId)) continue;
          const action = row.relaxingRowNamed
            ? RetiredCategoryFlaggedRelaxingAudit
            : RetiredCategoryFlaggedAudit;
          if (row.relaxingRowNamed) relaxing += 1;
          await deps.audit.record(context, action.entry(row.categoryId, {}));
        }
        return ok({ flagged: inserted.size, relaxing });
      });
    } catch (error) {
      logger.error(
        `platformCategoriesRetired failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return err({ code: 'certification.unavailable' });
    }
  }
}
