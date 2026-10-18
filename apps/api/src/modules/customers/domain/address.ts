import { err, ok, parsePlainText, type Result } from '@mondapac/shared-kernel';

// A delivery address of the customer's address book (customers package 1). Personal data: it
// leaves the module only as ciphertext under the customer account's key, and never reaches a log,
// an event or an error (a refused field names its path and a code, never the value).

/** The Market's address rules, from Market configuration (`customers.address`). */
export interface AddressFormat {
  readonly countryCode: string;
  /** Anchored, bounded source (the boot check of `market-config.ts`); run with the `u` flag. */
  readonly postcodePattern: string;
  /** The closed region list; empty for a Market whose addresses carry no region. */
  readonly regions: readonly string[];
}

/** What the customer typed, validated. */
export interface AddressContent {
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  /** An optional leading `+` and digits; spaces, hyphens, dots and brackets removed. */
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  /** One of the Market's regions; null when the Market has none. */
  readonly region: string | null;
  readonly postcode: string;
  /** A note for the courier, such as where to leave the parcel. */
  readonly deliveryNotes: string | null;
}

/** A refused field: its path and a code, never the value. */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/** The keys an address body may carry, besides `isDefault`. */
export const ADDRESS_FIELDS = [
  'recipientFirstName',
  'recipientLastName',
  'phone',
  'line1',
  'line2',
  'suburb',
  'region',
  'postcode',
  'deliveryNotes',
] as const;

/** Plaintext limits, in code points after NFC. */
export const ADDRESS_LIMITS = {
  recipientFirstName: 60,
  recipientLastName: 60,
  line1: 120,
  line2: 120,
  suburb: 80,
  postcode: 16,
  deliveryNotes: 250,
} as const;
const PHONE_INPUT_MAX_LENGTH = 64;

const CONTROL = /\p{Cc}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * A single-line value of 1 to `maxLength` code points, kept as typed after trim and NFC: no
 * control (line feeds included), bidi, format or default-ignorable character, and at least one
 * letter or digit.
 */
function line(raw: unknown, maxLength: number): Result<string, string> {
  if (typeof raw !== 'string') return err('type');
  const value = raw.trim().normalize('NFC');
  const length = [...value].length;
  if (length < 1 || length > maxLength) return err('length');
  if (!parsePlainText(value).ok || CONTROL.test(value) || !LETTER_OR_DIGIT.test(value)) {
    return err('characters');
  }
  return ok(value);
}

/** A phone number: an optional `+` and 4 to 20 digits once spaces and punctuation are removed. */
function phone(raw: unknown): Result<string, string> {
  if (typeof raw !== 'string') return err('type');
  const typed = raw.trim();
  if (typed.length === 0 || typed.length > PHONE_INPUT_MAX_LENGTH) return err('length');
  if (!parsePlainText(typed).ok || CONTROL.test(typed)) return err('characters');
  const normalised = typed.replace(/[\s().-]/gu, '');
  if (!/^\+?[0-9]{4,20}$/u.test(normalised)) return err('format');
  return ok(normalised);
}

/**
 * Validates an address against the Market's format. Every key of {@link ADDRESS_FIELDS} is read;
 * the caller refuses any other key. `line2`, `deliveryNotes` and (in a Market without regions)
 * `region` are optional: absent, null or blank is "not entered". A region is matched without
 * regard to case and stored as the Market spells it; a postcode must match the Market's pattern.
 */
export function parseAddress(
  raw: unknown,
  format: AddressFormat,
): Result<AddressContent, readonly FieldProblem[]> {
  if (!isRecord(raw)) return err([{ path: '', code: 'type' }]);
  const problems: FieldProblem[] = [];
  const required = (key: keyof typeof ADDRESS_LIMITS): string => {
    if (blank(raw[key])) {
      problems.push({ path: key, code: 'required' });
      return '';
    }
    const value = line(raw[key], ADDRESS_LIMITS[key]);
    if (!value.ok) problems.push({ path: key, code: value.error });
    return value.ok ? value.value : '';
  };
  const optional = (key: 'line2' | 'deliveryNotes'): string | null => {
    if (blank(raw[key])) return null;
    const value = line(raw[key], ADDRESS_LIMITS[key]);
    if (!value.ok) problems.push({ path: key, code: value.error });
    return value.ok ? value.value : null;
  };

  const recipientFirstName = required('recipientFirstName');
  const recipientLastName = required('recipientLastName');
  let phoneValue = '';
  if (blank(raw.phone)) problems.push({ path: 'phone', code: 'required' });
  else {
    const parsed = phone(raw.phone);
    if (parsed.ok) phoneValue = parsed.value;
    else problems.push({ path: 'phone', code: parsed.error });
  }
  const line1 = required('line1');
  const line2 = optional('line2');
  const suburb = required('suburb');

  let region: string | null = null;
  if (format.regions.length === 0) {
    if (!blank(raw.region)) problems.push({ path: 'region', code: 'region' });
  } else if (blank(raw.region)) {
    problems.push({ path: 'region', code: 'required' });
  } else if (typeof raw.region !== 'string') {
    problems.push({ path: 'region', code: 'type' });
  } else {
    const typed = raw.region.trim().normalize('NFC').toUpperCase();
    region = format.regions.find((name) => name.toUpperCase() === typed) ?? null;
    if (region === null) problems.push({ path: 'region', code: 'region' });
  }

  const postcode = required('postcode');
  if (postcode !== '' && !new RegExp(format.postcodePattern, 'u').test(postcode)) {
    problems.push({ path: 'postcode', code: 'format' });
  }
  const deliveryNotes = optional('deliveryNotes');

  if (problems.length > 0) return err(problems);
  return ok({
    recipientFirstName,
    recipientLastName,
    phone: phoneValue,
    line1,
    line2,
    suburb,
    region,
    postcode,
    deliveryNotes,
  });
}

/** The canonical JSON that is sealed: the fields in a fixed order. */
export function addressToJson(content: AddressContent): string {
  return JSON.stringify(Object.fromEntries(ADDRESS_FIELDS.map((key) => [key, content[key]])));
}

/**
 * Reads back a sealed address. Only this module writes it, through {@link parseAddress}: a bad
 * shape means damage, so it throws instead of guessing.
 */
export function addressFromJson(json: string): AddressContent {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error('customers.stored-address-invalid');
  for (const key of ADDRESS_FIELDS) {
    const field = value[key];
    const nullable = key === 'line2' || key === 'region' || key === 'deliveryNotes';
    if (!(typeof field === 'string' || (nullable && field === null))) {
      throw new Error('customers.stored-address-invalid');
    }
  }
  return value as unknown as AddressContent;
}
