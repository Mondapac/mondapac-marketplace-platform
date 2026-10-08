import { err, ok, type Result } from '@mondapac/shared-kernel';
import type { Sealed } from './sealed';

/**
 * The business identifier of the draft (sellers design 2.1, 4.2, 8.2; data design 3.1): a number
 * the Market's scheme names (an ABN-like registration number, a company number, ...). The scheme
 * is Market configuration; this file knows no scheme, no Market and no country.
 */

/** The two refusals of a scheme (sellers design 4.2). Codes only: the value is never echoed. */
export type IdentifierInvalid = 'identifier.format' | 'identifier.checksum';

/**
 * What one scheme knows (sellers design 4.2 `BusinessIdentifierScheme`): pure functions, no I/O.
 * `normalise` makes one canonical text of what a person typed (spacing and punctuation removed,
 * letters in one case), `validate` checks that text, `display` shows it the way people write it.
 */
export interface IdentifierRules {
  /** The scheme code of Market configuration (`sellers.businessIdentifier.scheme`). */
  readonly scheme: string;
  normalise(text: string): string;
  validate(normalised: string): Result<void, IdentifierInvalid>;
  display(normalised: string): string;
}

/** The normalised, validated text of an identifier. Only {@link parseBusinessIdentifier} makes one. */
export type NormalisedIdentifier = string & { readonly __normalisedIdentifier: true };

/** A validated identifier of one scheme. */
export interface BusinessIdentifier {
  readonly scheme: string;
  readonly value: NormalisedIdentifier;
}

/** The most a person may type: a transport backstop above every real scheme (ID 8.3). */
export const IDENTIFIER_INPUT_MAX_LENGTH = 64;

/**
 * Parses what a seller typed for the Market's scheme: not text, too long, or refused by the
 * scheme is `identifier.format` or `identifier.checksum`. A scheme must not throw on any text
 * (checked by its own tests); the length bound is applied first so it never sees a huge input.
 */
export function parseBusinessIdentifier(
  raw: unknown,
  rules: IdentifierRules,
): Result<BusinessIdentifier, IdentifierInvalid> {
  if (typeof raw !== 'string' || [...raw].length > IDENTIFIER_INPUT_MAX_LENGTH) {
    return err('identifier.format');
  }
  const normalised = rules.normalise(raw);
  const valid = rules.validate(normalised);
  if (!valid.ok) return valid;
  return ok({ scheme: rules.scheme, value: normalised as NormalisedIdentifier });
}

/**
 * `IdentifierIndex.of(...)`'s output (sellers design 8.2): 32 bytes, pseudonymous personal data
 * (data design S5). Opaque to the domain; compared byte for byte only.
 */
export type IdentifierIndexKey = Uint8Array & { readonly __identifierIndexKey: true };

export const IDENTIFIER_INDEX_BYTES = 32;

export function identifierIndexKeyOf(bytes: Uint8Array): IdentifierIndexKey {
  if (bytes.length !== IDENTIFIER_INDEX_BYTES) {
    throw new RangeError('An identifier index is 32 bytes');
  }
  return bytes as IdentifierIndexKey;
}

/** What the draft holds of the identifier: the scheme (clear), the sealed value and its index. */
export interface DraftIdentifier {
  readonly scheme: string;
  readonly sealed: Sealed<'identifier'>;
  readonly index: IdentifierIndexKey;
}

/** Whether two draft identifiers are the same value of the same scheme (the sealed text differs per seal). */
export function sameIdentifier(a: DraftIdentifier | null, b: DraftIdentifier | null): boolean {
  if (a === null || b === null) return a === b;
  return a.scheme === b.scheme && Buffer.from(a.index).equals(Buffer.from(b.index));
}
