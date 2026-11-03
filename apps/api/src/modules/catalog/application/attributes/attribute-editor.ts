import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MeasureSettings, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import type {
  AttributeBounds,
  AttributeDefinition,
  AttributeDefinitionRefusal,
  AttributeDisplaySettings,
  AttributeOption,
  LocalizedText,
} from '../../domain/attribute-definition';
import { ATTRIBUTE_OPTIONS_MAX } from '../../domain/attribute-definition';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import { MAX_MATCH_TEXTS, type ClaimTextMatcher } from '../ports/claim-text-matcher';

/** One refused field: a fixed path and a code; never the admin's own text. */
export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly FieldIssue[];
}

/** The refusals every attribute write shares (attributes A2). */
export type AttributeWriteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'claim-text.check-unavailable' }
  | { readonly code: 'attribute.claim-word'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'attribute.locale-uncheckable'; readonly fields: readonly FieldIssue[] }
  | ValidationFailure;

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

/**
 * The admin account of an authenticated admin who is not in an acting-as session (catalog design
 * 8.2 "AA": no attribute write from a Login as Seller session), or null.
 */
export function editorAccountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (isActingAsSession(actor)) return null;
  return actor.accountId;
}

/** A closed input: only these keys, as an object. */
export function closedInput(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!allowed.includes(key)) return invalid(key.slice(0, 64), 'unknown');
  }
  return ok(record);
}

export function attributeIdOf(raw: unknown): Id<'AttributeDefinition'> | null {
  const parsed = typeof raw === 'string' ? parseId<'AttributeDefinition'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

export function versionOf(raw: unknown): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return invalid('version', 'type');
  }
  return ok(raw);
}

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
// The domain's longest customer text is a help text (300 characters); anything longer is refused
// here, before the claim check sends it anywhere.
const MAX_TEXT_INPUT = 300;
// The admin-only note is never sent to the matcher; the domain caps it at 1,000.
const MAX_NOTE_INPUT = 2_000;

/** The keys of the content an editor sends, on create and on edit (the whole content). */
export const CONTENT_KEYS = [
  'names',
  'material',
  'isVariantOption',
  'bounds',
  'options',
  'helpText',
  'showOnProductPage',
  'searchable',
  'canBeFilter',
  'internalNote',
  'position',
] as const;

/** The content of a definition as the editor sends it, parsed but not yet checked by the domain. */
export interface EditorContent {
  readonly names: LocalizedText;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: AttributeBounds;
  /** In the order given; a value's position is its index. */
  readonly options: readonly AttributeOption[];
  readonly display: AttributeDisplaySettings;
}

/**
 * Reads the editor's content (attributes A2). Every locale must be one of the Market's; values
 * keep the order given (their position is their index). A value without a code gets one from its
 * label in the default locale. Shapes only: lengths, plain text and bounds are the domain's.
 */
export function parseEditorContent(
  body: Record<string, unknown>,
  locales: { readonly default: string; readonly supported: readonly string[] },
): Result<EditorContent, ValidationFailure> {
  const names = localizedOf(body['names'], 'names', locales.supported);
  if (!names.ok) return names;
  const help = localizedOf(body['helpText'] ?? {}, 'helpText', locales.supported);
  if (!help.ok) return help;
  const flags: Record<string, boolean> = {};
  for (const [key, fallback] of [
    ['material', false],
    ['isVariantOption', false],
    ['showOnProductPage', true],
    ['searchable', false],
    ['canBeFilter', false],
  ] as const) {
    const raw = body[key];
    if (raw !== undefined && typeof raw !== 'boolean') return invalid(key, 'type');
    flags[key] = raw ?? fallback;
  }
  const bounds = boundsOf(body['bounds']);
  if (!bounds.ok) return bounds;
  const note = body['internalNote'];
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return invalid('internalNote', 'type');
  }
  if (typeof note === 'string' && note.length > MAX_NOTE_INPUT) {
    return invalid('internalNote', 'too-long');
  }
  const position = body['position'] ?? 0;
  if (typeof position !== 'number' || !Number.isInteger(position)) {
    return invalid('position', 'type');
  }
  const options = optionsOf(body['options'], locales);
  if (!options.ok) return options;
  return ok({
    names: names.value,
    material: flags['material']!,
    isVariantOption: flags['isVariantOption']!,
    bounds: bounds.value,
    options: options.value,
    display: {
      helpText: help.value,
      showOnProductPage: flags['showOnProductPage']!,
      searchable: flags['searchable']!,
      canBeFilter: flags['canBeFilter']!,
      internalNote: typeof note === 'string' && note.trim() !== '' ? note : null,
      position,
    },
  });
}

function localizedOf(
  raw: unknown,
  path: string,
  supported: readonly string[],
): Result<LocalizedText, ValidationFailure> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid(path, 'type');
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(raw as Record<string, unknown>)) {
    if (!supported.includes(locale))
      return invalid(`${path}.${locale.slice(0, 16)}`, 'unsupported');
    if (typeof text !== 'string') return invalid(`${path}.${locale}`, 'type');
    if ([...text].length > MAX_TEXT_INPUT) return invalid(`${path}.${locale}`, 'too-long');
    // An empty entry is a language not entered yet: it is left out, never stored empty.
    if (text.trim() === '') continue;
    out[locale] = text;
  }
  return ok(out);
}

function boundsOf(raw: unknown): Result<AttributeBounds, ValidationFailure> {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid('bounds', 'type');
  const out: { maxLength?: number; min?: number; max?: number; measure?: MeasureSettings } = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'maxLength' && key !== 'min' && key !== 'max' && key !== 'measure') {
      return invalid(`bounds.${key.slice(0, 16)}`, 'unknown');
    }
    if (value === null || value === undefined) continue;
    if (key === 'measure') {
      const measure = measureOf(value);
      if (!measure.ok) return measure;
      out.measure = measure.value;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return invalid(`bounds.${key}`, 'type');
    }
    out[key] = value;
  }
  return ok(out);
}

/**
 * Whether every unit a `measure` offers is one the Market lists under `catalog.units` (attributes
 * A3). The domain checks the dimension and the default; which units this Market offers is
 * configuration, so it is checked here. Returns the field to mark, or null.
 */
export function marketUnitsRefusal(
  bounds: AttributeBounds,
  marketUnits: readonly { readonly code: string }[],
): FieldIssue | null {
  const offered = new Set(marketUnits.map((unit) => unit.code));
  const missing = bounds.measure?.units.some((unit) => !offered.has(unit)) ?? false;
  return missing ? { path: 'bounds.measure.units', code: 'not-offered' } : null;
}

/** The unit settings of a measure, shapes only: the domain checks that they add up. */
function measureOf(raw: unknown): Result<MeasureSettings, ValidationFailure> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('bounds.measure', 'type');
  }
  const item = raw as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!['dimension', 'units', 'defaultUnit', 'decimals'].includes(key)) {
      return invalid(`bounds.measure.${key.slice(0, 16)}`, 'unknown');
    }
  }
  const { dimension, units, defaultUnit, decimals } = item;
  if (typeof dimension !== 'string') return invalid('bounds.measure.dimension', 'type');
  if (!Array.isArray(units) || units.some((unit) => typeof unit !== 'string')) {
    return invalid('bounds.measure.units', 'type');
  }
  if (units.length > 16) return invalid('bounds.measure.units', 'too-many');
  if (typeof defaultUnit !== 'string') return invalid('bounds.measure.defaultUnit', 'type');
  if (typeof decimals !== 'number' || !Number.isInteger(decimals)) {
    return invalid('bounds.measure.decimals', 'type');
  }
  return ok({
    dimension: dimension as MeasureSettings['dimension'],
    units: units as string[],
    defaultUnit,
    decimals,
  });
}

function optionsOf(
  raw: unknown,
  locales: { readonly default: string; readonly supported: readonly string[] },
): Result<readonly AttributeOption[], ValidationFailure> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) return invalid('options', 'type');
  if (raw.length > ATTRIBUTE_OPTIONS_MAX) return invalid('options', 'too-many');
  const out: AttributeOption[] = [];
  // Explicit codes are reserved first, so a derived code never takes one a later value names.
  const explicit = new Set<string>();
  for (const entry of raw as readonly unknown[]) {
    const code = (entry as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code !== '') explicit.add(code);
  }
  const taken = new Set<string>();
  for (const [index, entry] of (raw as readonly unknown[]).entries()) {
    const path = `options[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return invalid(path, 'type');
    }
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key !== 'code' && key !== 'labels' && key !== 'active') {
        return invalid(`${path}.${key.slice(0, 16)}`, 'unknown');
      }
    }
    const labels = localizedOf(item['labels'], `${path}.labels`, locales.supported);
    if (!labels.ok) return labels;
    const active = item['active'] ?? true;
    if (typeof active !== 'boolean') return invalid(`${path}.active`, 'type');
    let code = item['code'];
    if (code === undefined || code === null || code === '') {
      code = freeCode(
        codeFrom(labels.value[locales.default] ?? ''),
        new Set([...taken, ...explicit]),
      );
      if (code === null) return invalid(`${path}.code`, 'required');
    }
    if (typeof code !== 'string' || !CODE.test(code)) return invalid(`${path}.code`, 'format');
    if (taken.has(code)) return invalid(`${path}.code`, 'repeated');
    taken.add(code);
    out.push({ code, labels: labels.value, active, position: index });
  }
  return ok(out);
}

/**
 * A code from a text: lower-case ASCII letters and digits joined by `-`, starting with a letter
 * (`v-` is put before a leading digit), at most 64 characters; null when nothing usable is left
 * (a text in another script).
 */
export function codeFrom(text: string): string | null {
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
  if (ascii === '') return null;
  // A code starts with a letter: "500 g" becomes "v-500-g".
  return /^[a-z]/.test(ascii) ? ascii : `v-${ascii}`;
}

function freeCode(base: string | null, taken: ReadonlySet<string>): string | null {
  if (base === null) return null;
  if (!taken.has(base)) return base;
  for (let n = 2; n <= ATTRIBUTE_OPTIONS_MAX + 1; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** One text the editor writes, with the fixed path its verdict is reported on. */
interface PlacedText {
  readonly path: string;
  readonly locale: string;
  readonly text: string;
}

/** Every customer-visible text of the content: names, help texts and value labels. */
function textsOf(content: EditorContent): PlacedText[] {
  const texts: PlacedText[] = [];
  for (const [locale, text] of Object.entries(content.names)) {
    texts.push({ path: `names.${locale}`, locale, text });
  }
  for (const [locale, text] of Object.entries(content.display.helpText)) {
    texts.push({ path: `helpText.${locale}`, locale, text });
  }
  content.options.forEach((option, index) => {
    for (const [locale, text] of Object.entries(option.labels)) {
      texts.push({ path: `options[${index}].labels.${locale}`, locale, text });
    }
  });
  return texts;
}

/**
 * The claim-text check of an attribute's content (attributes A2; catalog design 6.1). Two
 * refusals, both fail-closed and with no override for anyone:
 *
 * 1. A text in a locale where the certification vocabulary has no term cannot be checked, so it
 *    is refused (`attribute.locale-uncheckable`); an unreadable vocabulary is
 *    `claim-text.check-unavailable`.
 * 2. Every name, help text and value label, in every locale, goes to the matcher; a match is
 *    `attribute.claim-word` with the paths of the texts, never the words. A batch the matcher
 *    cannot answer is `claim-text.check-unavailable`.
 *
 * The internal note is admin-only (never shown to a seller or buyer) and is not checked. Call it
 * with no unit of work open: the certification facade opens its own.
 */
export async function refuseClaimContent(
  deps: { readonly matcher: ClaimTextMatcher; readonly claimLocales: ClaimTermLocales },
  context: CallContext,
  content: EditorContent,
): Promise<AttributeWriteFailure | null> {
  const texts = textsOf(content);
  if (texts.length === 0) return null;
  const covered = await deps.claimLocales.covered(context);
  if (!covered.ok) return { code: 'claim-text.check-unavailable' };
  const uncheckable = texts
    .filter((text) => !covered.value.includes(text.locale))
    .map((text) => ({ path: text.path, code: 'locale-uncheckable' }));
  if (uncheckable.length > 0) return { code: 'attribute.locale-uncheckable', fields: uncheckable };

  const found: FieldIssue[] = [];
  for (let from = 0; from < texts.length; from += MAX_MATCH_TEXTS) {
    const batch = texts.slice(from, from + MAX_MATCH_TEXTS);
    let answer: Awaited<ReturnType<ClaimTextMatcher['match']>>;
    try {
      answer = await deps.matcher.match(
        context,
        batch.map(({ locale, text }) => ({ locale, text })),
      );
    } catch {
      return { code: 'claim-text.check-unavailable' };
    }
    if (!answer.ok || !Array.isArray(answer.value) || answer.value.length !== batch.length) {
      return { code: 'claim-text.check-unavailable' };
    }
    batch.forEach((text, index) => {
      const hits = answer.ok ? answer.value[index] : undefined;
      if (!Array.isArray(hits)) found.push({ path: text.path, code: 'unavailable' });
      else if (hits.length > 0) found.push({ path: text.path, code: 'claim-word' });
    });
  }
  if (found.some((issue) => issue.code === 'unavailable')) {
    return { code: 'claim-text.check-unavailable' };
  }
  return found.length > 0 ? { code: 'attribute.claim-word', fields: found } : null;
}

/** What a write answers: enough for the panel to re-read the attribute and keep its version. */
export interface AttributeWriteView {
  readonly id: string;
  readonly code: string;
  readonly status: 'draft' | 'active' | 'archived';
  readonly version: number;
  readonly revisionNo: number;
}

export function writeViewOf(definition: AttributeDefinition): AttributeWriteView {
  const { id, code, status, version, revisionNo } = definition.state;
  return { id, code, status, version, revisionNo };
}

/** The audit shape of a definition: flags and counts, never a text. */
export function auditShapeOf(definition: AttributeDefinition) {
  const { status, revisionNo, material, isVariantOption, options } = definition.state;
  return {
    status,
    revisionNo,
    material,
    isVariantOption,
    optionCount: options.length,
    activeOptionCount: options.filter((option) => option.active).length,
  };
}

/**
 * A domain refusal as an answer (attributes A2): its code, and where it names a locale or a value,
 * the field it points at as `fields` (the panel marks that input). Locales and value codes are
 * the Market's and the admin's identifiers, never a text.
 */
export interface DomainFailure {
  readonly code: AttributeDefinitionRefusal['code'];
  readonly fields?: readonly FieldIssue[];
}

export function domainFailureOf(refusal: AttributeDefinitionRefusal): DomainFailure {
  const at = (path: string, code: string): DomainFailure => ({
    code: refusal.code,
    fields: [{ path, code }],
  });
  switch (refusal.code) {
    case 'attribute-definition.default-name-required':
      return at(`names.${refusal.locale}`, 'required');
    case 'attribute-definition.default-label-required':
      return at(`options.${refusal.option}.labels.${refusal.locale}`, 'required');
    case 'attribute-definition.text-invalid':
      return refusal.option === undefined
        ? at(`names.${refusal.locale}`, 'invalid')
        : at(`options.${refusal.option}.labels.${refusal.locale}`, 'invalid');
    case 'attribute-definition.help-invalid':
      return at(`helpText.${refusal.locale}`, 'invalid');
    case 'attribute-definition.option-removed':
      return at(`options.${refusal.option}`, 'removed');
    default:
      return { code: refusal.code };
  }
}
