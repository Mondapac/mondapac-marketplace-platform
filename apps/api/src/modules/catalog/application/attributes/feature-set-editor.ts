import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { AttributeDefinitionRecord } from '../ports/attribute-admin.reader';
import {
  levelOf,
  REQUIREMENT_LEVELS,
  type AttributeFamily,
  type AttributeFamilyRefusal,
  type FamilyGroup,
  type FeatureSetContent,
  type RequirementLevel,
} from '../../domain/attribute-family';
import {
  codeFrom,
  invalid,
  localizedOf,
  type FieldIssue,
  type PlacedText,
  type ValidationFailure,
} from './attribute-editor';

/** One entry of a group as an admin sends it: the code and how much a seller must fill it. */
interface ParsedEntry {
  readonly code: string;
  readonly level: RequirementLevel;
}

/** A group as sent, before the use case adds each attribute's variant flag from its definition. */
interface ParsedGroup {
  readonly groupCode: string | null;
  readonly names: Readonly<Record<string, string>>;
  readonly attributes: readonly ParsedEntry[];
}

export interface ParsedFeatureSet {
  readonly names: Readonly<Record<string, string>>;
  readonly groups: readonly ParsedGroup[];
}

export const FEATURE_SET_CONTENT_KEYS = ['names', 'groups'] as const;

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
// The bounds the domain keeps, read here too so a huge body is refused before any claim check.
const GROUPS_INPUT_MAX = 40;
const ATTRIBUTES_INPUT_MAX = 200;

/**
 * Reads the content of a feature set as the editor sends it (attributes package A4): names per
 * locale and the groups in order, each with its names and its attributes in order, each with a
 * code and a level. Shapes only: lengths, plain text, the Core group and counts are the domain's.
 * A group without a code gets one from its default-locale name; the Core group names itself.
 */
export function parseFeatureSetContent(
  body: Record<string, unknown>,
  locales: { readonly default: string; readonly supported: readonly string[] },
): Result<ParsedFeatureSet, ValidationFailure> {
  const names = localizedOf(body['names'], 'names', locales.supported);
  if (!names.ok) return names;
  const rawGroups = body['groups'];
  if (!Array.isArray(rawGroups)) return invalid('groups', 'type');
  if (rawGroups.length > GROUPS_INPUT_MAX) return invalid('groups', 'too-many');
  const groups: ParsedGroup[] = [];
  let attributeTotal = 0;
  for (const [g, rawGroup] of (rawGroups as readonly unknown[]).entries()) {
    const path = `groups[${g}]`;
    if (typeof rawGroup !== 'object' || rawGroup === null || Array.isArray(rawGroup)) {
      return invalid(path, 'type');
    }
    const group = rawGroup as Record<string, unknown>;
    for (const key of Object.keys(group)) {
      if (key !== 'groupCode' && key !== 'names' && key !== 'attributes') {
        return invalid(`${path}.${key.slice(0, 16)}`, 'unknown');
      }
    }
    const groupNames = localizedOf(group['names'] ?? {}, `${path}.names`, locales.supported);
    if (!groupNames.ok) return groupNames;
    const code = group['groupCode'];
    if (code !== undefined && code !== null && (typeof code !== 'string' || !CODE.test(code))) {
      return invalid(`${path}.groupCode`, 'format');
    }
    const rawAttributes = group['attributes'] ?? [];
    if (!Array.isArray(rawAttributes)) return invalid(`${path}.attributes`, 'type');
    attributeTotal += rawAttributes.length;
    if (attributeTotal > ATTRIBUTES_INPUT_MAX) return invalid('groups', 'too-many');
    const attributes: ParsedEntry[] = [];
    for (const [a, rawEntry] of (rawAttributes as readonly unknown[]).entries()) {
      const at = `${path}.attributes[${a}]`;
      if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
        return invalid(at, 'type');
      }
      const entry = rawEntry as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        if (key !== 'code' && key !== 'level')
          return invalid(`${at}.${key.slice(0, 16)}`, 'unknown');
      }
      if (typeof entry['code'] !== 'string' || !CODE.test(entry['code'])) {
        return invalid(`${at}.code`, 'format');
      }
      const level = entry['level'];
      if (typeof level !== 'string' || !(REQUIREMENT_LEVELS as readonly string[]).includes(level)) {
        return invalid(`${at}.level`, 'unknown');
      }
      attributes.push({ code: entry['code'], level: level as RequirementLevel });
    }
    groups.push({
      groupCode: typeof code === 'string' ? code : null,
      names: groupNames.value,
      attributes,
    });
  }
  return ok({ names: names.value, groups });
}

/**
 * The group codes of the parsed groups: the one given, or one from the default-locale name made
 * unique within the set. A group with neither a code nor a usable name is refused.
 */
export function groupCodesOf(
  groups: readonly ParsedGroup[],
  defaultLocale: string,
): Result<readonly string[], ValidationFailure> {
  const taken = new Set(
    groups.flatMap((group) => (group.groupCode === null ? [] : [group.groupCode])),
  );
  const codes: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.groupCode !== null) {
      codes.push(group.groupCode);
      continue;
    }
    const base = codeFrom(group.names[defaultLocale] ?? '');
    if (base === null) return invalid(`groups[${index}].groupCode`, 'required');
    let code = base;
    for (let n = 2; taken.has(code) && n < 100; n += 1) code = `${base.slice(0, 60)}-${n}`;
    if (taken.has(code)) return invalid(`groups[${index}].groupCode`, 'required');
    taken.add(code);
    codes.push(code);
  }
  return ok(codes);
}

/** What the use case found wrong with the attributes the content names. */
export type MembershipRefusal =
  | { readonly code: 'feature-set.attribute-unknown'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'feature-set.attribute-not-active'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'feature-set.too-many-variant-attributes' }
  | {
      readonly code: 'feature-set.material-removal-needs-request';
      readonly fields: readonly FieldIssue[];
    };

/**
 * Builds the content to store from the parsed one and the Market's definitions (attributes A4):
 * every code must name an **active** definition (a draft or archived one is refused, so a seller
 * never meets an attribute the admin has not published), the variant flag of each entry comes
 * from its definition and never from the request, and at most `maxVariantAttributes` entries
 * vary. `required` follows the level.
 */
export function buildFeatureSetContent(
  parsed: ParsedFeatureSet,
  codes: readonly string[],
  definitions: ReadonlyMap<string, AttributeDefinitionRecord>,
  maxVariantAttributes: number,
): Result<FeatureSetContent, MembershipRefusal> {
  const unknown: FieldIssue[] = [];
  const notActive: FieldIssue[] = [];
  let variants = 0;
  const groups: FamilyGroup[] = parsed.groups.map((group, g) => ({
    groupCode: codes[g]!,
    names: group.names,
    attributes: group.attributes.map((entry, a) => {
      const definition = definitions.get(entry.code);
      const path = `groups[${g}].attributes[${a}].code`;
      if (definition === undefined) unknown.push({ path, code: 'unknown' });
      else if (definition.status !== 'active') notActive.push({ path, code: 'not-active' });
      const isVariantOption = definition?.revision.isVariantOption ?? false;
      if (isVariantOption) variants += 1;
      return {
        code: entry.code,
        required: entry.level === 'required',
        isVariantOption,
        level: entry.level,
      };
    }),
  }));
  if (unknown.length > 0) return err({ code: 'feature-set.attribute-unknown', fields: unknown });
  if (notActive.length > 0) {
    return err({ code: 'feature-set.attribute-not-active', fields: notActive });
  }
  if (variants > maxVariantAttributes)
    return err({ code: 'feature-set.too-many-variant-attributes' });
  return ok({ names: parsed.names, groups });
}

/**
 * Removing a `material` attribute from a feature set is a relaxation that needs a second admin
 * (catalog design 8.2): an edit that drops one is refused here. The confirm half of the request
 * belongs to a later package.
 */
export function materialRemoval(
  before: AttributeFamily,
  next: FeatureSetContent,
  definitions: ReadonlyMap<string, AttributeDefinitionRecord>,
): MembershipRefusal | null {
  const kept = new Set(next.groups.flatMap((group) => group.attributes.map((entry) => entry.code)));
  const dropped: FieldIssue[] = [];
  for (const group of before.state.groups) {
    for (const entry of group.attributes) {
      if (!kept.has(entry.code) && definitions.get(entry.code)?.revision.material === true) {
        dropped.push({ path: `groups.${group.groupCode}.${entry.code}`, code: 'material' });
      }
    }
  }
  return dropped.length > 0
    ? { code: 'feature-set.material-removal-needs-request', fields: dropped }
    : null;
}

/** The codes whose membership changed between two contents: added or removed. */
export function membershipChanges(
  before: readonly FamilyGroup[],
  after: readonly FamilyGroup[],
): readonly string[] {
  const of = (groups: readonly FamilyGroup[]) =>
    new Set(groups.flatMap((group) => group.attributes.map((entry) => entry.code)));
  const was = of(before);
  const now = of(after);
  return [...new Set([...was, ...now])].filter((code) => was.has(code) !== now.has(code));
}

/** The audit shape of a family: counts, never a name. */
export function featureSetAuditShape(family: AttributeFamily) {
  const entries = family.state.groups.flatMap((group) => group.attributes);
  const count = (level: RequirementLevel) =>
    entries.filter((entry) => levelOf(entry) === level).length;
  return {
    revisionNo: family.state.revisionNo,
    groupCount: family.state.groups.length,
    attributeCount: entries.length,
    requiredCount: count('required'),
    recommendedCount: count('recommended'),
    optionalCount: count('optional'),
  };
}

/** The required fields a revision no longer requires: dropped or lowered (recorded in audit). */
export function requiredRelaxed(before: AttributeFamily, after: AttributeFamily): number {
  const required = (family: AttributeFamily) =>
    new Set(
      family.state.groups.flatMap((group) =>
        group.attributes
          .filter((entry) => levelOf(entry) === 'required')
          .map((entry) => entry.code),
      ),
    );
  const was = required(before);
  const now = required(after);
  return [...was].filter((code) => !now.has(code)).length;
}

/** Every customer-visible text of a feature set, each with the fixed path of its verdict. */
export function featureSetTexts(content: FeatureSetContent): PlacedText[] {
  const texts: PlacedText[] = [];
  for (const [locale, text] of Object.entries(content.names)) {
    texts.push({ path: `names.${locale}`, locale, text });
  }
  content.groups.forEach((group, g) => {
    for (const [locale, text] of Object.entries(group.names ?? {})) {
      texts.push({ path: `groups[${g}].names.${locale}`, locale, text });
    }
  });
  return texts;
}

/** A refusal of the domain as an answer: its code, and the field it points at. */
export interface FeatureSetDomainFailure {
  readonly code: AttributeFamilyRefusal['code'];
  readonly fields?: readonly FieldIssue[];
}

export function featureSetDomainFailureOf(
  refusal: AttributeFamilyRefusal,
): FeatureSetDomainFailure {
  switch (refusal.code) {
    case 'attribute-family.default-name-required':
      return { code: refusal.code, fields: [{ path: refusal.path, code: 'required' }] };
    case 'attribute-family.text-invalid':
      return { code: refusal.code, fields: [{ path: refusal.path, code: 'invalid' }] };
    case 'attribute-family.too-many':
      return { code: refusal.code, fields: [{ path: refusal.path, code: 'too-many' }] };
    case 'attribute-family.level-invalid':
      return { code: refusal.code, fields: [{ path: refusal.path, code: 'invalid' }] };
    case 'attribute-family.core-invalid':
      return { code: refusal.code, fields: [{ path: refusal.path, code: 'core' }] };
    default:
      return { code: refusal.code };
  }
}
