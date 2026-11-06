import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import {
  attributeIdOf,
  closedInput,
  editorAccountOf,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import {
  impactViewOf,
  type AttributeImpactView,
  type AttributeRestructureDependencies,
} from '../attributes/attribute-restructure';

export type AttributeImpactGetFailure =
  ValidationFailure | { readonly code: 'access.denied' } | { readonly code: 'attribute.not-found' };

/**
 * `attribute-definition.impact` (attributes A8): what merging values, converting or archiving an
 * attribute would reach, shown in the impact dialog before the change: published products,
 * drafts, active feature sets, categories, filters, variants, and whether the attribute is
 * `material`. Read only. Counts stop at a cap and say "at least". Rule: the key
 * `catalog.attribute.restructure` (protected), the admin population, never in an acting-as
 * session.
 */
export class AttributeImpactGet extends UseCase<
  { readonly [key: string]: unknown },
  AttributeImpactView,
  AttributeImpactGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-impact-get',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<
      AttributeRestructureDependencies,
      'unitOfWork' | 'attributeStore' | 'impact'
    >,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<AttributeImpactView, AttributeImpactGetFailure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const { market } = context;
    return this.deps.unitOfWork.run<AttributeImpactView, AttributeImpactGetFailure>(
      market,
      async () => {
        const definition = await this.deps.attributeStore.findById(market, id);
        if (definition === null) return err({ code: 'attribute.not-found' } as const);
        const impact = await this.deps.impact.impactOf(market, {
          code: definition.state.code,
          isVariantOption: definition.state.isVariantOption,
        });
        return ok(impactViewOf(definition, impact));
      },
      { readOnly: true },
    );
  }
}
