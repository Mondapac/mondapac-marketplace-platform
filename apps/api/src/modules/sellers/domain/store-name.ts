import { err, ok, parsePlainText, type PlainText, type Result } from '@mondapac/shared-kernel';
import type { ReservedWords } from './reserved-words';

/** The store name as typed (design 8.1: clear, public once approved) and its search key. */
export interface StoreName {
  readonly name: PlainText;
  /** NFKC, case-folded, inner whitespace collapsed (data design 3.1 `store_name_key`). */
  readonly key: string;
}

export type StoreNameInvalid = {
  readonly code: 'store-name.invalid';
  readonly rule: 'length' | 'characters';
};

/** Q-M11: store name 1 to 100 characters. */
export const STORE_NAME_MAX_LENGTH = 100;

/** Control characters and bidi marks, the class of the CHECK S7 (data design 2). */
const FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/**
 * The search key of a store name: NFKC, lower-cased, runs of whitespace collapsed to one space,
 * trimmed. The database re-checks the shape (`store_name_key` CHECKs) as a backstop.
 */
export function storeNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * A store name (design 6.3, Q-M11): kept as typed after trimming; 1 to 100 characters after
 * NFC; no control, bidi or default-ignorable character; not only invisible text. Claim words
 * are not refused here: they are a reviewer flag (`claimWordsIn`).
 */
export function parseStoreName(raw: unknown): Result<StoreName, StoreNameInvalid> {
  if (typeof raw !== 'string') return err({ code: 'store-name.invalid', rule: 'length' });
  const trimmed = raw.trim().normalize('NFC');
  const length = [...trimmed].length;
  if (length < 1 || length > STORE_NAME_MAX_LENGTH) {
    return err({ code: 'store-name.invalid', rule: 'length' });
  }
  const text = parsePlainText(trimmed);
  if (!text.ok || FORBIDDEN.test(trimmed)) {
    return err({ code: 'store-name.invalid', rule: 'characters' });
  }
  const key = storeNameKey(trimmed);
  if (key.length === 0) return err({ code: 'store-name.invalid', rule: 'characters' });
  return ok({ name: text.value, key });
}

/** The claim words found in a store name, per token: a reviewer flag, never a refusal (3.5). */
export function claimWordsIn(name: string, reserved: ReservedWords): readonly string[] {
  const tokens = storeNameKey(name).split(/[\s-]+/u);
  return [...new Set(tokens.filter((token) => reserved.claimWords.has(token)))];
}
