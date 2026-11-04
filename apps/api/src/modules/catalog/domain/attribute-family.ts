import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import type { LocalizedText } from './attribute-definition';
import type { CategoryAuthorKind } from './platform-category';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
const NAME_MAX = 120;

/** The most groups, attributes per group and attributes in all one feature set may hold. */
export const FEATURE_SET_GROUPS_MAX = 20;
export const FEATURE_SET_GROUP_ATTRIBUTES_MAX = 50;
export const FEATURE_SET_ATTRIBUTES_MAX = 100;

/**
 * The shared Core group (attributes plan, package A4): the first group of every feature an admin
 * writes, holding the fields every product has. Its members are fixed; only their level may be
 * set, except the brand, which is always required. Net weight or volume joins when the
 * number-with-unit type (package A3) is seeded.
 */
export const FEATURE_SET_CORE_GROUP = 'core';
export const FEATURE_SET_CORE_ATTRIBUTES: readonly string[] = ['brand', 'country-of-origin'];
export const FEATURE_SET_CORE_REQUIRED: readonly string[] = ['brand'];

/** How much a seller must fill a field: refused when empty, asked for, or left to the seller. */
export type RequirementLevel = 'required' | 'recommended' | 'optional';
export const REQUIREMENT_LEVELS: readonly RequirementLevel[] = [
  'required',
  'recommended',
  'optional',
];

export interface FamilyAttribute {
  readonly code: string;
  /** True exactly when the level is `required` (the schema builder reads this flag). */
  readonly required: boolean;
  readonly isVariantOption: boolean;
  /** Absent in a revision written before package A4: it reads as required or optional. */
  readonly level?: RequirementLevel;
}

export interface FamilyGroup {
  readonly groupCode: string;
  /** The group's name per locale; absent in a revision written before package A4. */
  readonly names?: LocalizedText;
  readonly attributes: readonly FamilyAttribute[];
}

/** The level of an entry, whether or not its revision names one. */
export function levelOf(entry: FamilyAttribute): RequirementLevel {
  return entry.level ?? (entry.required ? 'required' : 'optional');
}

export interface AttributeFamilyState {
  readonly id: Id<'AttributeFamily'>;
  readonly marketId: MarketId;
  readonly code: string;
  readonly status: 'active' | 'archived';
  readonly createdByKind: CategoryAuthorKind;
  readonly revisionId: Id<'AttributeFamilyRevision'>;
  readonly revisionNo: number;
  /** The feature set's name per locale; empty for the seeded family. */
  readonly names: LocalizedText;
  readonly groups: readonly FamilyGroup[];
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export type AttributeFamilyRefusal =
  | { readonly code: 'attribute-family.code-invalid' }
  | { readonly code: 'attribute-family.group-invalid' }
  | { readonly code: 'attribute-family.group-repeated' }
  | { readonly code: 'attribute-family.attribute-invalid' }
  | { readonly code: 'attribute-family.attribute-repeated' }
  | { readonly code: 'attribute-family.archived' }
  | { readonly code: 'attribute-family.default-name-required'; readonly path: string }
  | { readonly code: 'attribute-family.text-invalid'; readonly path: string }
  | { readonly code: 'attribute-family.locale-invalid' }
  | { readonly code: 'attribute-family.too-many'; readonly path: string }
  | { readonly code: 'attribute-family.level-invalid'; readonly path: string }
  | { readonly code: 'attribute-family.core-invalid'; readonly path: string };

/** The content an admin writes: names, and the groups in order with their attributes in order. */
export interface FeatureSetContent {
  readonly names: LocalizedText;
  readonly groups: readonly FamilyGroup[];
}

function validName(text: string): boolean {
  const length = [...text].length;
  return text === text.trim() && length >= 1 && length <= NAME_MAX && parsePlainText(text).ok;
}

function checkNames(
  names: LocalizedText,
  defaultLocale: string,
  path: string,
): AttributeFamilyRefusal | null {
  for (const [locale, text] of Object.entries(names)) {
    if (!LOCALE.test(locale)) return { code: 'attribute-family.locale-invalid' };
    if (!validName(text))
      return { code: 'attribute-family.text-invalid', path: `${path}.${locale}` };
  }
  if (names[defaultLocale] === undefined) {
    return { code: 'attribute-family.default-name-required', path: `${path}.${defaultLocale}` };
  }
  return null;
}

/**
 * The checks every admin-written revision passes (attributes plan, package A4; decisions ت۷, ت۱۰,
 * ت۱۲): the name and every group name in the default locale, groups and attributes in bounded
 * numbers, an attribute once in the set, a known level that agrees with the `required` flag, and
 * the Core group first and complete. That each code names an active definition, and the count
 * of variant attributes, are checked by the use case, which reads the definitions.
 */
export function checkFeatureSetContent(
  content: FeatureSetContent,
  defaultLocale: string,
): AttributeFamilyRefusal | null {
  const named = checkNames(content.names, defaultLocale, 'names');
  if (named !== null) return named;
  const { groups } = content;
  if (groups.length === 0 || groups.length > FEATURE_SET_GROUPS_MAX) {
    return { code: 'attribute-family.too-many', path: 'groups' };
  }
  const groupCodes = new Set<string>();
  const attributeCodes = new Set<string>();
  for (const [g, group] of groups.entries()) {
    const at = `groups[${g}]`;
    if (!CODE.test(group.groupCode)) return { code: 'attribute-family.group-invalid' };
    if (groupCodes.has(group.groupCode)) return { code: 'attribute-family.group-repeated' };
    groupCodes.add(group.groupCode);
    const groupNamed = checkNames(group.names ?? {}, defaultLocale, `${at}.names`);
    if (groupNamed !== null) return groupNamed;
    if (group.attributes.length > FEATURE_SET_GROUP_ATTRIBUTES_MAX) {
      return { code: 'attribute-family.too-many', path: `${at}.attributes` };
    }
    for (const [a, attribute] of group.attributes.entries()) {
      if (!CODE.test(attribute.code)) return { code: 'attribute-family.attribute-invalid' };
      if (attributeCodes.has(attribute.code)) {
        return { code: 'attribute-family.attribute-repeated' };
      }
      attributeCodes.add(attribute.code);
      const level = attribute.level;
      if (level === undefined || !REQUIREMENT_LEVELS.includes(level)) {
        return { code: 'attribute-family.level-invalid', path: `${at}.attributes[${a}]` };
      }
      if (attribute.required !== (level === 'required')) {
        return { code: 'attribute-family.level-invalid', path: `${at}.attributes[${a}]` };
      }
    }
  }
  if (attributeCodes.size > FEATURE_SET_ATTRIBUTES_MAX) {
    return { code: 'attribute-family.too-many', path: 'groups' };
  }
  const first = groups[0]!;
  if (first.groupCode !== FEATURE_SET_CORE_GROUP) {
    return { code: 'attribute-family.core-invalid', path: 'groups[0]' };
  }
  const coreCodes = first.attributes.map((attribute) => attribute.code);
  if (
    coreCodes.length !== FEATURE_SET_CORE_ATTRIBUTES.length ||
    FEATURE_SET_CORE_ATTRIBUTES.some((code) => !coreCodes.includes(code))
  ) {
    return { code: 'attribute-family.core-invalid', path: 'groups[0].attributes' };
  }
  for (const [a, attribute] of first.attributes.entries()) {
    if (FEATURE_SET_CORE_REQUIRED.includes(attribute.code) && attribute.level !== 'required') {
      return { code: 'attribute-family.core-invalid', path: `groups[0].attributes[${a}]` };
    }
  }
  return null;
}

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
        names: {},
        groups: input.groups,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  /**
   * A feature set written by an admin (package A4): active at once (nothing sells from it until
   * a category names it), revision 1, with the content checked by {@link checkFeatureSetContent}.
   */
  static createByAdmin(input: {
    readonly id: Id<'AttributeFamily'>;
    readonly revisionId: Id<'AttributeFamilyRevision'>;
    readonly marketId: MarketId;
    readonly code: string;
    readonly content: FeatureSetContent;
    readonly defaultLocale: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeFamily, AttributeFamilyRefusal> {
    if (!CODE.test(input.code)) return err({ code: 'attribute-family.code-invalid' });
    const refusal = checkFeatureSetContent(input.content, input.defaultLocale);
    if (refusal !== null) return err(refusal);
    return ok(
      new AttributeFamily({
        id: input.id,
        marketId: input.marketId,
        code: input.code,
        status: 'active',
        createdByKind: 'admin',
        revisionId: input.revisionId,
        revisionNo: 1,
        names: input.content.names,
        groups: input.content.groups,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  /** A family read back from its current revision. */
  static rehydrate(state: AttributeFamilyState): AttributeFamily {
    return new AttributeFamily(state);
  }

  /**
   * The next revision with the whole content (insert-only: earlier revisions stay readable); the
   * code never changes. An archived family is not revised.
   */
  revise(input: {
    readonly revisionId: Id<'AttributeFamilyRevision'>;
    readonly content: FeatureSetContent;
    readonly defaultLocale: string;
  }): Result<AttributeFamily, AttributeFamilyRefusal> {
    if (this.#state.status === 'archived') return err({ code: 'attribute-family.archived' });
    const refusal = checkFeatureSetContent(input.content, input.defaultLocale);
    if (refusal !== null) return err(refusal);
    return ok(
      new AttributeFamily({
        ...this.#state,
        revisionId: input.revisionId,
        revisionNo: this.#state.revisionNo + 1,
        names: input.content.names,
        groups: input.content.groups,
        version: this.#state.version + 1,
      }),
    );
  }

  get state(): AttributeFamilyState {
    return this.#state;
  }
}
