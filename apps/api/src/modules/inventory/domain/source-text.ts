import { err, ok, type Result } from '@mondapac/shared-kernel';

/**
 * C0 and C1 controls and the bidi marks, embeddings, overrides and isolates (inventory data
 * design 3.3; the class of identity's display name). U+200D (joiner) is allowed.
 */
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** Other invisible format characters (zero-width space, word joiner, BOM), except U+200D. */
const INVISIBLE = /(?!\u200d)\p{Cf}/u;

/** 1 to 80 code points (inventory design 2.1; data design 11.2 M3: a technical bound). */
export const SOURCE_NAME_MAX = 80;
/** One address field value: 1 to 120 code points (the width of sellers' address fields). */
export const SOURCE_ADDRESS_VALUE_MAX = 120;
/** The most fields an address object holds. */
export const SOURCE_ADDRESS_FIELDS_MAX = 12;
const ADDRESS_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/u;

export type SourceTextInvalid = { readonly rule: 'type' | 'length' | 'characters' };

/** Trimmed, NFC, within `max` code points, free of control and bidi characters. */
function cleanText(raw: unknown, max: number): Result<string, SourceTextInvalid> {
  if (typeof raw !== 'string') return err({ rule: 'type' });
  // Bound the work before normalising: a code point is at most two UTF-16 units, and NFC can
  // lengthen a text, so four units per allowed code point is a generous ceiling.
  if (raw.length > max * 4) return err({ rule: 'length' });
  const text = raw.normalize('NFC').trim();
  const length = [...text].length;
  if (length < 1 || length > max) return err({ rule: 'length' });
  if (FORBIDDEN.test(text) || INVISIBLE.test(text)) return err({ rule: 'characters' });
  return ok(text);
}

/**
 * A source (stock location) name (inventory design 2.1, M3; UX F29 step 3). The seller's own
 * label. **May hold personal data**: it never enters a log, an event or an audit row.
 */
export const parseSourceName = (raw: unknown): Result<string, SourceTextInvalid> =>
  cleanText(raw, SOURCE_NAME_MAX);

/**
 * A source's address (inventory design 2.1, M3): an inventory-owned value, a flat object of
 * text fields. Inventory stores what the Market's address form sends and validates only the
 * shape: 1 to {@link SOURCE_ADDRESS_FIELDS_MAX} fields, each key a short lower-camel word, each
 * value text as {@link parseSourceName} (up to {@link SOURCE_ADDRESS_VALUE_MAX} code points).
 * The Market's field list is `sellers` configuration and is not read here (no shared address
 * type until a second module needs one). **Personal data**: never in a log, event or audit row.
 */
export type SourceAddress = Readonly<Record<string, string>>;

export type SourceAddressInvalid =
  | { readonly rule: 'type' | 'fields' }
  | { readonly rule: SourceTextInvalid['rule']; readonly field: string };

export function parseSourceAddress(raw: unknown): Result<SourceAddress, SourceAddressInvalid> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err({ rule: 'type' });
  const keys = Object.keys(raw);
  if (keys.length < 1 || keys.length > SOURCE_ADDRESS_FIELDS_MAX) return err({ rule: 'fields' });
  const clean: Record<string, string> = {};
  for (const key of keys) {
    if (!ADDRESS_KEY.test(key)) return err({ rule: 'fields' });
    const value = cleanText((raw as Record<string, unknown>)[key], SOURCE_ADDRESS_VALUE_MAX);
    if (!value.ok) return err({ rule: value.error.rule, field: key });
    clean[key] = value.value;
  }
  return ok(Object.freeze(clean));
}

const ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * An IANA zone id the runtime knows (ADR-0005 decision 2; data design 3.3). The database CHECK
 * holds the form; this holds that the zone exists.
 */
export function parseSourceTimeZone(raw: unknown): Result<string, SourceTextInvalid> {
  if (typeof raw !== 'string') return err({ rule: 'type' });
  return ZONES.has(raw) ? ok(raw) : err({ rule: 'characters' });
}
