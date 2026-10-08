import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import type { CategoryAuthorKind } from './platform-category';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface FamilyAttribute {
  readonly code: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
}

export interface FamilyGroup {
  readonly groupCode: string;
  readonly attributes: readonly FamilyAttribute[];
}

export interface AttributeFamilyState {
  readonly id: Id<'AttributeFamily'>;
  readonly marketId: MarketId;
  readonly code: string;
  readonly status: 'active' | 'archived';
  readonly createdByKind: CategoryAuthorKind;
  readonly revisionId: Id<'AttributeFamilyRevision'>;
  readonly revisionNo: number;
  readonly groups: readonly FamilyGroup[];
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export type AttributeFamilyRefusal =
  | { readonly code: 'attribute-family.code-invalid' }
  | { readonly code: 'attribute-family.group-invalid' }
  | { readonly code: 'attribute-family.group-repeated' }
  | { readonly code: 'attribute-family.attribute-invalid' }
  | { readonly code: 'attribute-family.attribute-repeated' };

/**
 * A family of attributes (catalog design 2.1; slice 3): groups of attribute codes with a
 * required flag. An attribute code appears once in a family. This slice creates the seeded
 * family with its first revision; that every code names a definition of the Market is checked by
 * the seed use case, which reads the definitions.
 */
export class AttributeFamily {
  readonly #state: AttributeFamilyState;

  private constructor(state: AttributeFamilyState) {
    this.#state = Object.freeze(state);
  }

  static create(input: {
    readonly id: Id<'AttributeFamily'>;
    readonly revisionId: Id<'AttributeFamilyRevision'>;
    readonly marketId: MarketId;
    readonly code: string;
    readonly groups: readonly FamilyGroup[];
    readonly createdByKind: CategoryAuthorKind;
    readonly now: Temporal.Instant;
  }): Result<AttributeFamily, AttributeFamilyRefusal> {
    if (!CODE.test(input.code)) return err({ code: 'attribute-family.code-invalid' });
    const groupCodes = new Set<string>();
    const attributeCodes = new Set<string>();
    for (const group of input.groups) {
      if (!CODE.test(group.groupCode)) return err({ code: 'attribute-family.group-invalid' });
      if (groupCodes.has(group.groupCode)) return err({ code: 'attribute-family.group-repeated' });
      groupCodes.add(group.groupCode);
      for (const attribute of group.attributes) {
        if (!CODE.test(attribute.code)) return err({ code: 'attribute-family.attribute-invalid' });
        if (attributeCodes.has(attribute.code)) {
          return err({ code: 'attribute-family.attribute-repeated' });
        }
        attributeCodes.add(attribute.code);
      }
    }
    return ok(
      new AttributeFamily({
        id: input.id,
        marketId: input.marketId,
        code: input.code,
        status: 'active',
        createdByKind: input.createdByKind,
        revisionId: input.revisionId,
        revisionNo: 1,
        groups: input.groups,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  get state(): AttributeFamilyState {
    return this.#state;
  }
}
