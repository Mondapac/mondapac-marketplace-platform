import { canonicalJson, err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// The content of one store profile revision (data design 3.8): one JSON object, keyed by Market
// locale, sealed as a whole under the seller's key. Only the About text exists today; Description,
// Policies, Meta and Social of the design join as new keys under a new schema version.

/** The JSON shape of the content (`content_schema_version`), not the envelope version. */
export const STORE_PROFILE_CONTENT_SCHEMA_VERSION = 1;

/** `about[locale]` is the text; a locale with no text is absent (never an empty string). */
export interface StoreProfileContent {
  readonly schemaVersion: typeof STORE_PROFILE_CONTENT_SCHEMA_VERSION;
  readonly about: Readonly<Record<string, string>>;
}

export type StoreProfileContentInvalid = { readonly code: 'store-profile-content.invalid' };

const LOCALE_KEY = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/u;

/** The content of the given About texts: blank locales are left out, so equal content is equal bytes. */
export function contentOf(about: Readonly<Record<string, string>>): StoreProfileContent {
  const kept: Record<string, string> = {};
  for (const locale of Object.keys(about).sort()) {
    const text = about[locale];
    if (text !== undefined && text !== '') kept[locale] = text;
  }
  return Object.freeze({
    schemaVersion: STORE_PROFILE_CONTENT_SCHEMA_VERSION,
    about: Object.freeze(kept),
  });
}

/**
 * The canonical bytes of the content (RFC 8785 JSON: sorted keys, no spaces), what is sealed and
 * what the keyed hash covers, so the same content gives the same hash in every process.
 */
export function canonicalStoreContent(
  content: StoreProfileContent,
): Result<string, StoreProfileContentInvalid> {
  if (content.schemaVersion !== STORE_PROFILE_CONTENT_SCHEMA_VERSION) {
    return err({ code: 'store-profile-content.invalid' });
  }
  const json = canonicalJson(content);
  return json.ok ? ok(json.value) : err({ code: 'store-profile-content.invalid' });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the content back from the JSON that was sealed. Exact keys and types only: a stored
 * revision of another shape is a fault of the data, never a value to show (the caller fails
 * closed). A later schema version needs a new reader.
 */
export function parseStoreContent(
  json: string,
): Result<StoreProfileContent, StoreProfileContentInvalid> {
  const invalid = err({ code: 'store-profile-content.invalid' } as const);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return invalid;
  }
  if (!isRecord(raw)) return invalid;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== 'about' || keys[1] !== 'schemaVersion') return invalid;
  if (raw.schemaVersion !== STORE_PROFILE_CONTENT_SCHEMA_VERSION || !isRecord(raw.about)) {
    return invalid;
  }
  for (const [locale, text] of Object.entries(raw.about)) {
    if (!LOCALE_KEY.test(locale) || typeof text !== 'string' || text === '') return invalid;
  }
  return ok(contentOf(raw.about as Record<string, string>));
}
