import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CULTURE_EDIT } from '../../contracts/permissions';
import { CultureCategoryMarkChangedAudit } from '../../domain/audit';
import {
  adminAccountOf,
  categoryIdOf,
  closedInput,
  cultureIdOf,
  type ValidationFailure,
} from '../cultures/culture-views';

import type { CultureMarkWriteDependencies } from './culture-category-marks.use-case';

type Denied = { readonly code: 'access.denied' };
type Unavailable = { readonly code: 'access.unavailable' };
type CultureNotFound = { readonly code: 'culture.not-found' };

export type CultureCategoryMarkClearFailure =
  | Denied
  | Unavailable
  | CultureNotFound
  | { readonly code: 'culture-category.not-found' }
  | ValidationFailure;

/**
 * `culture.category-mark-clear` (multi-culture package 1): an admin removes the row of one culture on
 * one category, so the category inherits again from its nearest ancestor (or the default: visible and
 * required). Works for a category that is no longer live. Rule: the key `catalog.culture.edit`
 * (protected) and the admin population. Audited.
 */
export class CultureCategoryMarkClear extends UseCase<
  { readonly cultureId?: unknown; readonly categoryId?: unknown },
  { readonly cleared: true },
  CultureCategoryMarkClearFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-category-mark-clear',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_EDIT.key] },
  };

  readonly #logger = new Logger('CultureCategoryMarkClear');

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<CultureMarkWriteDependencies, 'unitOfWork' | 'cultures' | 'audit'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly cultureId?: unknown; readonly categoryId?: unknown },
  ): Promise<Result<{ readonly cleared: true }, CultureCategoryMarkClearFailure>> {
    const result = await this.#clear(context, input);
    this.#logger.log({
      msg: 'catalog.culture-category-mark-clear',
      code: result.ok ? 'cleared' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #clear(
    context: CallContext,
    input: { readonly cultureId?: unknown; readonly categoryId?: unknown },
  ): Promise<Result<{ readonly cleared: true }, CultureCategoryMarkClearFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['cultureId', 'categoryId']);
    if (!body.ok) return body;
    const cultureId = cultureIdOf(body.value['cultureId'], 'cultureId');
    if (!cultureId.ok) return err({ code: 'culture.not-found' });
    const categoryId = categoryIdOf(body.value['categoryId'], 'categoryId');
    if (!categoryId.ok) return err({ code: 'culture-category.not-found' });
    const { market } = context;
    const { cultures } = this.deps;
    return this.deps.unitOfWork.run<{ readonly cleared: true }, CultureCategoryMarkClearFailure>(
      market,
      async () => {
        const culture = await cultures.findById(market, cultureId.value);
        if (culture === null) return err({ code: 'culture.not-found' } as const);
        const before = (await cultures.categoryRows(market, cultureId.value)).find(
          (row) => row.categoryId === categoryId.value,
        );
        if (before === undefined) return err({ code: 'culture-category.not-found' } as const);
        await cultures.clearCategoryRow(market, cultureId.value, categoryId.value);
        await this.deps.audit.record(
          context,
          CultureCategoryMarkChangedAudit.entry(culture.id, {
            before: {
              categoryId: categoryId.value,
              hadRow: true,
              visible: before.visible,
              certificationMark: before.certificationMark ?? 'inherit',
            },
            after: {
              categoryId: categoryId.value,
              hasRow: false,
              visible: true,
              certificationMark: 'inherit',
            },
          }),
        );
        return ok({ cleared: true } as const);
      },
    );
  }
}
