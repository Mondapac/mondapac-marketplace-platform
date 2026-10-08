import type { AttributeField, AttributeSchema, Id } from '@mondapac/shared-kernel';
import type { AttributeDefinitionState } from './attribute-definition';
import type { AttributeFamilyState } from './attribute-family';

/**
 * Builds the {@link AttributeSchema} of a family from the published revisions of its definitions
 * (catalog design 3.3 rule 1). The schema records the family code, the family revision and the
 * definition revisions it was built from, so a product revision can always say what it was
 * validated against. The fields follow the family's groups in order; an inactive option is not
 * offered. `localizable`, the data type and the `material` flag come from the definition;
 * `required` and `isVariantOption` are the family's choice and the definition's capability
 * together (a variant option must be a variant-capable select).
 *
 * Returns the codes the family names that no definition supplies, instead of a schema, so a
 * caller never validates against a partial form.
 */
export function buildAttributeSchema(
  family: AttributeFamilyState,
  definitions: readonly AttributeDefinitionState[],
):
  | { readonly ok: true; readonly schema: AttributeSchema }
  | { readonly ok: false; readonly missingCodes: readonly string[] } {
  const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
  const fields: AttributeField[] = [];
  const used: Id[] = [];
  const missing: string[] = [];
  for (const group of family.groups) {
    for (const entry of group.attributes) {
      const definition = byCode.get(entry.code);
      if (definition === undefined || definition.status !== 'active') {
        missing.push(entry.code);
        continue;
      }
      used.push(definition.revisionId);
      const options = definition.options
        .filter((option) => option.active)
        .sort((a, b) => a.position - b.position)
        .map((option) => ({ code: option.code }));
      fields.push({
        code: definition.code,
        dataType: definition.dataType,
        localizable: definition.localizable,
        required: entry.required,
        isVariantOption: entry.isVariantOption && definition.isVariantOption,
        material: definition.material,
        claimChecked: true,
        bounds: {
          ...(definition.bounds.maxLength === undefined
            ? {}
            : { maxLength: definition.bounds.maxLength }),
          ...(definition.bounds.min === undefined ? {} : { min: definition.bounds.min }),
          ...(definition.bounds.max === undefined ? {} : { max: definition.bounds.max }),
          ...(options.length > 0 ? { options } : {}),
        },
      });
    }
  }
  if (missing.length > 0) return { ok: false, missingCodes: missing };
  return {
    ok: true,
    schema: {
      schemaRef: {
        familyCode: family.code,
        familyRevisionId: family.revisionId,
        definitionRevisionIds: used,
      },
      fields,
    },
  };
}
