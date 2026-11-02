import type {
  PublishedSpecification,
  PublishedSpecificationGroup,
  PublishedSpecificationValue,
} from '../contracts/catalog.facade';

/** The most specifications of one product page: a family is far smaller; this bounds a bad one. */
export const MAX_SPECIFICATIONS = 100;

/** Attribute codes shown elsewhere on the page (the brand link), never twice. */
const SHOWN_ELSEWHERE: ReadonlySet<string> = new Set(['brand']);

export interface SpecificationFamilyGroup {
  readonly groupCode: string;
  readonly attributes: readonly { readonly code: string }[];
}

/** An attribute definition at the revision the product was validated against. */
export interface SpecificationDefinition {
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  readonly names: Readonly<Record<string, string>>;
  readonly options: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

export interface SpecificationLocales {
  readonly requested: string;
  readonly fallback: string;
}

function pickText(
  texts: Readonly<Record<string, unknown>>,
  locales: SpecificationLocales,
): string | null {
  const text = (key: string): string | null => {
    const value = texts[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  const found = text(locales.requested) ?? text(locales.fallback);
  if (found !== null) return found;
  const first = Object.keys(texts)
    .sort()
    .find((key) => text(key) !== null);
  return first === undefined ? null : text(first);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The shown form of one stored value, or null when it is empty or not of the type's shape. */
function valueOf(
  definition: SpecificationDefinition,
  raw: unknown,
  locales: SpecificationLocales,
): PublishedSpecificationValue | null {
  switch (definition.dataType) {
    case 'text': {
      const text = definition.localizable
        ? isRecord(raw)
          ? pickText(raw, locales)
          : null
        : typeof raw === 'string' && raw.trim() !== ''
          ? raw
          : null;
      return text === null ? null : { kind: 'text', text };
    }
    case 'integer':
      return typeof raw === 'number' && Number.isSafeInteger(raw)
        ? { kind: 'text', text: String(raw) }
        : null;
    case 'decimal':
    case 'date':
      return typeof raw === 'string' && raw !== '' ? { kind: 'text', text: raw } : null;
    case 'boolean':
      return typeof raw === 'boolean' ? { kind: 'boolean', value: raw } : null;
    case 'select':
    case 'multi-select': {
      const codes = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
      const labels = codes.flatMap((code): string[] => {
        const option = typeof code === 'string' ? definition.options.get(code) : undefined;
        const label = option === undefined ? null : pickText(option, locales);
        return label === null ? [] : [label];
      });
      if (labels.length === 0) return null;
      return definition.dataType === 'select'
        ? { kind: 'text', text: labels[0]! }
        : { kind: 'list', items: labels };
    }
    default:
      // long-text is the description; any type this version does not know is left out.
      return null;
  }
}

/**
 * The specifications of a published revision: the family's groups in order, each attribute with
 * its stored value, name and option labels in the asked locale (fallback, then first by code).
 * An attribute with no value, no definition, no name, or an unreadable value is left out, as is an
 * empty group. Pure.
 */
export function publishedSpecificationsOf(
  groups: readonly SpecificationFamilyGroup[],
  definitions: ReadonlyMap<string, SpecificationDefinition>,
  values: Readonly<Record<string, unknown>>,
  locales: SpecificationLocales,
): PublishedSpecificationGroup[] {
  const out: PublishedSpecificationGroup[] = [];
  let count = 0;
  for (const group of groups) {
    const items: PublishedSpecification[] = [];
    for (const { code } of group.attributes) {
      if (count >= MAX_SPECIFICATIONS) break;
      const definition = definitions.get(code);
      if (definition === undefined || SHOWN_ELSEWHERE.has(code)) continue;
      if (!Object.hasOwn(values, code)) continue;
      const value = valueOf(definition, values[code], locales);
      const name = pickText(definition.names, locales);
      if (value === null || name === null) continue;
      items.push({ code, name, value });
      count += 1;
    }
    if (items.length > 0) out.push({ groupCode: group.groupCode, items });
  }
  return out;
}
