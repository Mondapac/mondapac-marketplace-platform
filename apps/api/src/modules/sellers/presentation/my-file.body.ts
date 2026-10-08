// The shape checks of the request bodies of the seller's draft routes (sellers design 6.2, 8.3).
// They check JSON types, a closed set of field names and length bounds only; the values' meaning
// (formats, patterns, zones, reserved words) stays in the domain behind the use case. A problem
// is a path and a code: a value is never echoed (design 8.3).

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/** At most this many unknown field names are echoed, then one {@link MORE_FIELDS} marker. */
export const MAX_ECHOED_UNKNOWN_FIELDS = 10;
/** The path of the marker that stands for the unknown fields not echoed (U+2026). */
export const MORE_FIELDS = '…';
const MAX_ECHOED_NAME_CODE_POINTS = 64;
const UNSAFE_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/** A client-supplied field name made safe to echo: unsafe characters replaced, cut to 64. */
export function echoedFieldName(name: string): string {
  return Array.from(name.replace(UNSAFE_IN_NAME, '�'))
    .slice(0, MAX_ECHOED_NAME_CODE_POINTS)
    .join('');
}

/**
 * Generous transport bounds, above every domain limit (store name 100, business name 200, phone
 * input 64, email 254, slug 50): they stop absurd input early; the domain decides the real limit.
 */
export const BODY_LIMITS = {
  text: 512,
  slug: 100,
  timezone: 64,
  addressFields: 20,
  addressKey: 64,
  addressValue: 256,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const length = (text: string): number => [...text].length;

function unknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): FieldProblem[] {
  const unknown = Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .sort();
  const problems = unknown
    .slice(0, MAX_ECHOED_UNKNOWN_FIELDS)
    .map((key) => ({ path: echoedFieldName(key), code: 'unknown-field' }));
  if (unknown.length > MAX_ECHOED_UNKNOWN_FIELDS) {
    problems.push({ path: MORE_FIELDS, code: 'unknown-field' });
  }
  return problems;
}

const valueOf = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** A string within `max` characters, or null / absent (not entered). */
function optionalText(
  record: Record<string, unknown>,
  key: string,
  max: number,
  problems: FieldProblem[],
  path = key,
): string | null | undefined {
  const value = valueOf(record, key);
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    problems.push({ path, code: 'type' });
    return undefined;
  }
  if (length(value) > max) {
    problems.push({ path, code: 'length' });
    return undefined;
  }
  return value;
}

export const GENERAL_FIELDS = ['storeName', 'businessName', 'phone', 'contactEmail'] as const;

export interface GeneralBody {
  readonly storeName?: string | null;
  readonly businessName?: string | null;
  readonly phone?: string | null;
  readonly contactEmail?: string | null;
}

/** The body of `PUT my-file/general`: four optional texts, no other field. */
export function parseGeneralBody(body: unknown): GeneralBody | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, GENERAL_FIELDS);
  const parsed: Record<string, string | null | undefined> = {};
  for (const field of GENERAL_FIELDS) {
    parsed[field] = optionalText(body, field, BODY_LIMITS.text, problems);
  }
  return problems.length > 0 ? problems : parsed;
}

export const ADDRESS_FIELDS = [
  'address',
  'registeredAddress',
  'timezone',
  'browserTimezone',
] as const;

export interface AddressBody {
  readonly address: Readonly<Record<string, string>>;
  readonly registeredAddress?: Readonly<Record<string, string>> | null;
  readonly timezone?: string | null;
  readonly browserTimezone?: string | null;
}

/** An object of text fields (the Market format's names are checked by the domain). */
function addressObject(
  value: unknown,
  path: string,
  problems: FieldProblem[],
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    problems.push({ path, code: 'type' });
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > BODY_LIMITS.addressFields) {
    problems.push({ path, code: 'length' });
    return undefined;
  }
  // No prototype, so a `__proto__` key stays an own entry and the domain refuses it as unknown.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  // Like the domain: one entry at the object's path, never the caller's key text.
  const seen = new Set<string>();
  const problem = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    problems.push({ path, code });
  };
  for (const key of keys) {
    const item = value[key];
    if (length(key) > BODY_LIMITS.addressKey) problem('length');
    else if (typeof item !== 'string') problem('type');
    else if (length(item) > BODY_LIMITS.addressValue) problem('length');
    else out[key] = item;
  }
  return out;
}

/** The body of `PUT my-file/address`: the operating address, and the optional others. */
export function parseAddressBody(body: unknown): AddressBody | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ADDRESS_FIELDS);
  const address = valueOf(body, 'address');
  const operating =
    address === undefined
      ? (problems.push({ path: 'address', code: 'required' }), undefined)
      : addressObject(address, 'address', problems);
  const registered = valueOf(body, 'registeredAddress');
  const registeredOut =
    registered === undefined || registered === null
      ? registered
      : addressObject(registered, 'registeredAddress', problems);
  const timezone = optionalText(body, 'timezone', BODY_LIMITS.timezone, problems);
  const browserTimezone = optionalText(body, 'browserTimezone', BODY_LIMITS.timezone, problems);
  if (problems.length > 0 || operating === undefined) return problems;
  return {
    address: operating,
    ...(registeredOut !== undefined && { registeredAddress: registeredOut }),
    ...(timezone !== undefined && { timezone }),
    ...(browserTimezone !== undefined && { browserTimezone }),
  };
}

/** The body of `POST my-file/slug-check`: the slug to check, nothing else. */
export function parseSlugBody(body: unknown): { readonly slug: string } | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['slug']);
  const slug = valueOf(body, 'slug');
  if (slug === undefined) problems.push({ path: 'slug', code: 'required' });
  else if (typeof slug !== 'string') problems.push({ path: 'slug', code: 'type' });
  else if (length(slug) > BODY_LIMITS.slug) problems.push({ path: 'slug', code: 'length' });
  return problems.length > 0 ? problems : { slug: slug as string };
}
