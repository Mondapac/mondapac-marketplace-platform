import { err, ok, type Result } from '@mondapac/shared-kernel';
import { parseLine } from './draft-fields';

/**
 * The `address.format` of a Market as the domain uses it (sellers design 4.1, 4.2; data design
 * 3.1): the fields in order, which one is the postcode and which the region, the postcode
 * pattern and the region list. Plain data from Market configuration, validated at boot; the
 * domain names no Market and no field.
 */
export interface AddressFormatSpec {
  readonly fields: readonly {
    readonly key: string;
    /** Translation key of the field's label, for the form descriptor (Reza 2). */
    readonly labelKey: string;
    readonly required: boolean;
    /** Code points after NFC (Q-M11: at most 120). */
    readonly maxLength: number;
  }[];
  readonly postcodeField: string;
  /** Null for a Market whose zone does not depend on a region. */
  readonly regionField: string | null;
  /** Anchored, bounded source (the boot check of `market-config.ts`); run with the `u` flag. */
  readonly postcodePattern: string;
  readonly regions: readonly string[];
}

/**
 * A validated address: the format's fields that hold a value, in the format's order, plus the
 * postcode and region they name. Personal data (sellers design 8.1): it leaves the module only
 * as ciphertext under the seller's key, and never reaches a log, an event or an error.
 */
export interface Address {
  readonly fields: Readonly<Record<string, string>>;
  readonly postcode: string;
  readonly region: string | null;
}

/** A refused field: its path and a code, never the value (sellers design 8.3). */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/** An object that is not an array; only its own keys are ever read (`Object.keys`, `Object.hasOwn`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates an address against the Market's format (the `AddressFormat` strategy of design 4.2).
 * A field that is absent, null or blank is "not entered"; required fields must be entered. Each
 * value follows the single-line text rule (`parseLine`); the postcode must match the Market's
 * pattern, and the region must be exactly one of the Market's regions. A key the format does
 * not list is refused (`unknown`), so nothing else is ever stored in the ciphertext.
 */
export function parseAddress(
  raw: unknown,
  format: AddressFormatSpec,
  path: string,
): Result<Address, readonly FieldProblem[]> {
  if (!isRecord(raw)) return err([{ path, code: 'format' }]);
  const known = new Set(format.fields.map((field) => field.key));
  const problems: FieldProblem[] = Object.keys(raw)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: `${path}.${key}`, code: 'unknown' }));
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of format.fields) {
    const value = Object.hasOwn(raw, field.key) ? raw[field.key] : undefined;
    const blank =
      value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    const fieldPath = `${path}.${field.key}`;
    if (blank) {
      if (field.required) problems.push({ path: fieldPath, code: 'required' });
      continue;
    }
    const line = parseLine(value, field.maxLength);
    if (!line.ok) {
      problems.push({ path: fieldPath, code: line.error });
      continue;
    }
    if (
      field.key === format.postcodeField &&
      !new RegExp(format.postcodePattern, 'u').test(line.value)
    ) {
      problems.push({ path: fieldPath, code: 'format' });
      continue;
    }
    if (field.key === format.regionField && !format.regions.includes(line.value)) {
      problems.push({ path: fieldPath, code: 'region' });
      continue;
    }
    fields[field.key] = line.value;
  }
  if (problems.length > 0) return err(problems);
  return ok(addressOf({ ...fields }, format));
}

function addressOf(fields: Record<string, string>, format: AddressFormatSpec): Address {
  return Object.freeze({
    fields: Object.freeze(fields),
    postcode: fields[format.postcodeField] ?? '',
    region: format.regionField === null ? null : (fields[format.regionField] ?? null),
  });
}

/** The canonical JSON of an address: its fields in the format's order. Sealed, never logged. */
export function addressToJson(address: Address): string {
  return JSON.stringify(address.fields);
}

/** The thrown error of a stored address that is not an object of strings: a fault, not input. */
export class StoredAddressError extends Error {
  override readonly name = 'StoredAddressError';
  constructor() {
    super('A stored address is not a JSON object of strings');
  }
}

/**
 * An address read back from its JSON. It was validated when it was saved; the Market's format
 * may have changed since, so it is not validated again (the next save does that). Only string
 * values of plain keys are kept.
 */
export function addressFromJson(json: string, format: AddressFormatSpec): Address {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new StoredAddressError();
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || key === '__proto__') throw new StoredAddressError();
    fields[key] = value;
  }
  return addressOf(fields, format);
}
