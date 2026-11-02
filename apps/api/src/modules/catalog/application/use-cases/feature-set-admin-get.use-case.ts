import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AttributeDataType, CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import type { LocalizedText } from '../../domain/attribute-definition';
import {
  ATTRIBUTE_LOAD_MAX,
  featureSetIdOf,
  marketLocalesOf,
  type MarketLocales,
} from '../attributes/attribute-admin-views';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface FeatureSetAdminGetInput {
  readonly featureSetId: unknown;
}

export interface FeatureSetAttributeView {
  readonly code: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
  /** The definition behind the code; null when the Market has none (never after the seed). */
  readonly attributeId: string | null;
  readonly names: LocalizedText | null;
  readonly dataType: AttributeDataType | null;
  readonly status: string | null;
  readonly material: boolean | null;
}

export interface FeatureSetAdminGetOutput {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly revisionNo: number;
  readonly createdAt: string;
  readonly groups: readonly {
    readonly groupCode: string;
    readonly attributes: readonly FeatureSetAttributeView[];
  }[];
  readonly productCount: number;
  /** The Market's languages, the default first: the screen names attributes in the default. */
  readonly locales: MarketLocales;
}

export type FeatureSetAdminGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'feature-set.not-found' };

export interface FeatureSetAdminGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `feature-set.admin-get` (attributes plan, package A1): one family of the request's Market with
 * its groups in order, each attribute with its required and variant flags and the name, type and
 * status of its definition, and the product count. A malformed id is `feature-set.not-found`.
 * Rule: the key `catalog.attribute.view` and the admin population.
 */
export class FeatureSetAdminGet extends UseCase<
  FeatureSetAdminGetInput,
  FeatureSetAdminGetOutput,
  FeatureSetAdminGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.feature-set-admin-get',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('FeatureSetAdminGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FeatureSetAdminGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FeatureSetAdminGetInput,
  ): Promise<Result<FeatureSetAdminGetOutput, FeatureSetAdminGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.feature-set-admin-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: FeatureSetAdminGetInput,
  ): Promise<Result<FeatureSetAdminGetOutput, FeatureSetAdminGetFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = featureSetIdOf(input?.featureSetId);
    if (id === null) return err({ code: 'feature-set.not-found' });
    const { market } = context;
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const set = await reader.featureSet(market, id);
        if (set === null) return ok(null);
        const definitions = await reader.definitions(market, ATTRIBUTE_LOAD_MAX);
        const counts = await reader.featureSetProductCounts(market, [id]);
        return ok({ set, definitions, productCount: counts.get(id) ?? 0 });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'feature-set.not-found' });
    const { set, definitions, productCount } = read.value;
    const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
    return ok({
      id: set.id,
      code: set.code,
      status: set.status,
      revisionNo: set.revisionNo,
      createdAt: set.createdAt.toString(),
      groups: set.groups.map((group) => ({
        groupCode: group.groupCode,
        attributes: group.attributes.map((entry) => {
          const definition = byCode.get(entry.code);
          return {
            code: entry.code,
            required: entry.required,
            isVariantOption: entry.isVariantOption,
            attributeId: definition?.id ?? null,
            names: definition === undefined ? null : { ...definition.revision.names },
            dataType: definition?.dataType ?? null,
            status: definition?.status ?? null,
            material: definition?.revision.material ?? null,
          };
        }),
      })),
      productCount,
      locales: marketLocalesOf(this.deps.policy.locales(market)),
    });
  }
}
