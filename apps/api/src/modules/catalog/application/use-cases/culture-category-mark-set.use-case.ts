import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CULTURE_EDIT } from '../../contracts/permissions';
import { CultureCategoryMarkChangedAudit } from '../../domain/audit';
import { parseCategoryMark, type CultureCategoryRow } from '../../domain/culture-category';
import { liveTreeOf } from '../cultures/culture-references';
import { markViewsOf, type CultureCategoryMarkView } from '../cultures/culture-mark-views';
import {
  adminAccountOf,
  categoryIdOf,
  closedInput,
  cultureIdOf,
  invalidFields,
  type ValidationFailure,
} from '../cultures/culture-views';

import type { CultureMarkWriteDependencies } from './culture-category-marks.use-case';

type Denied = { readonly code: 'access.denied' };
type Unavailable = { readonly code: 'access.unavailable' };
type CultureNotFound = { readonly code: 'culture.not-found' };

export interface CultureCategoryMarkSetInput {
  readonly cultureId?: unknown;
  readonly categoryId?: unknown;
  readonly visible?: unknown;
  readonly certificationMark?: unknown;
}
export interface CultureCategoryMarkOutput {
  readonly mark: CultureCategoryMarkView;
}
export type CultureCategoryMarkWriteFailure =
  | Denied
  | Unavailable
  | CultureNotFound
  | { readonly code: 'culture-category.not-found' }
  | ValidationFailure;

/**
 * `culture.category-mark-set` (multi-culture package 1): an admin sets the row of one culture on one
 * category: `visible` (default true) and `certificationMark` (`required`, `neutral`, or null to
 * inherit). Rule: the key `catalog.culture.edit` (protected) and the admin population. The category
 * must exist and be live. Audited.
 */
export class CultureCategoryMarkSet extends UseCase<
  CultureCategoryMarkSetInput,
  CultureCategoryMarkOutput,
  CultureCategoryMarkWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-category-mark-set',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_EDIT.key] },
  };

  readonly #logger = new Logger('CultureCategoryMarkSet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureMarkWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureCategoryMarkSetInput,
  ): Promise<Result<CultureCategoryMarkOutput, CultureCategoryMarkWriteFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.culture-category-mark-set',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: CultureCategoryMarkSetInput,
  ): Promise<Result<CultureCategoryMarkOutput, CultureCategoryMarkWriteFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['cultureId', 'categoryId', 'visible', 'certificationMark']);
    if (!body.ok) return body;
    const cultureId = cultureIdOf(body.value['cultureId'], 'cultureId');
    if (!cultureId.ok) return err({ code: 'culture.not-found' });
    const categoryId = categoryIdOf(body.value['categoryId'], 'categoryId');
    if (!categoryId.ok) return categoryId;
    const mark = parseCategoryMark(body.value);
    if (!mark.ok) return invalidFields(mark.error);
    const { market } = context;
    const { cultures } = this.deps;
    return this.deps.unitOfWork.run<CultureCategoryMarkOutput, CultureCategoryMarkWriteFailure>(
      market,
      async () => {
        const culture = await cultures.findById(market, cultureId.value);
        if (culture === null) return err({ code: 'culture.not-found' } as const);
        const live = await liveTreeOf(market, this.deps);
        if (!live.ok) return live;
        if (!live.value.some((c) => c.id === categoryId.value)) {
          return invalidFields([{ path: 'categoryId', code: 'unknown' }]);
        }
        const before = (await cultures.categoryRows(market, cultureId.value)).find(
          (row) => row.categoryId === categoryId.value,
        );
        const row: CultureCategoryRow = { categoryId: categoryId.value, ...mark.value };
        await cultures.setCategoryRow(
          market,
          cultureId.value,
          row,
          accountId,
          this.deps.clock.now(),
        );
        await this.deps.audit.record(
          context,
          CultureCategoryMarkChangedAudit.entry(culture.id, {
            before: {
              categoryId: categoryId.value,
              hadRow: before !== undefined,
              visible: before?.visible ?? true,
              certificationMark: before?.certificationMark ?? 'inherit',
            },
            after: {
              categoryId: categoryId.value,
              hasRow: true,
              visible: row.visible,
              certificationMark: row.certificationMark ?? 'inherit',
            },
          }),
        );
        const rows = await cultures.categoryRows(market, cultureId.value);
        const view = markViewsOf(live.value, rows).find((v) => v.categoryId === categoryId.value)!;
        return ok({ mark: view });
      },
    );
  }
}
