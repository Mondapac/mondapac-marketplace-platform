import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import { FEATURE_SET_LOAD_MAX } from '../attributes/attribute-admin-views';
import { closedInput, type ValidationFailure } from '../brands/brand-views';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';

export type FeatureSetAdminListInput = Record<string, never>;

export interface FeatureSetListItem {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly revisionNo: number;
  readonly groupCount: number;
  /** Distinct attribute codes across the groups. */
  readonly attributeCount: number;
  /** Products of the Market whose published revision uses this feature set. */
  readonly productCount: number;
}

export interface FeatureSetAdminListOutput {
  readonly items: readonly FeatureSetListItem[];
  /** True when the Market has more feature sets than the list carries. */
  readonly truncated: boolean;
}

export type FeatureSetAdminListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface FeatureSetAdminListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
}

/**
 * `feature-set.admin-list` (attributes plan, package A1): the attribute families of the request's
 * Market, shown to admins as "feature sets" (plan 3), by code, with their group, attribute and
 * product counts. Read only. Rule: the key `catalog.attribute.view` and the admin population.
 */
export class FeatureSetAdminList extends UseCase<
  FeatureSetAdminListInput,
  FeatureSetAdminListOutput,
  FeatureSetAdminListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.feature-set-admin-list',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('FeatureSetAdminList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FeatureSetAdminListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FeatureSetAdminListInput,
  ): Promise<Result<FeatureSetAdminListOutput, FeatureSetAdminListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.feature-set-admin-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: FeatureSetAdminListInput,
  ): Promise<Result<FeatureSetAdminListOutput, FeatureSetAdminListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, []);
    if (!body.ok) return body;
    const { market } = context;
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const loaded = await reader.featureSets(market, FEATURE_SET_LOAD_MAX + 1);
        const sets = loaded.slice(0, FEATURE_SET_LOAD_MAX);
        const counts = await reader.featureSetProductCounts(
          market,
          sets.map((set) => set.id),
        );
        return ok({ sets, counts, truncated: loaded.length > FEATURE_SET_LOAD_MAX });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { sets, counts, truncated } = read.value;
    return ok({
      items: sets.map((set) => ({
        id: set.id,
        code: set.code,
        status: set.status,
        revisionNo: set.revisionNo,
        groupCount: set.groups.length,
        attributeCount: new Set(
          set.groups.flatMap((group) => group.attributes.map((entry) => entry.code)),
        ).size,
        productCount: counts.get(set.id) ?? 0,
      })),
      truncated,
    });
  }
}
