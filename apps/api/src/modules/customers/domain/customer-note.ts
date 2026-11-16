import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// Admins' internal notes about a customer (customers management phase 2, PR 2a), like the admin
// order notes: never shown to the customer or a seller, written once and never changed or removed
// (a trail of support work). Free text about a person: stored only sealed under the customer
// account's subject key, never logged or audited. Plain text: rendered escaped, never as markup.

/** The longest note, in characters (code points). */
export const CUSTOMER_NOTE_MAX = 2000;
/** The newest notes one page of the Overview shows; older ones are paged. */
export const CUSTOMER_NOTES_PAGE_MAX = 100;

/**
 * Control characters other than a line break or a tab, line and paragraph separators, the
 * bidirectional marks, embeddings, overrides and isolates, and the invisible ones are refused (no
 * hidden or reordered text in the support trail). The joiners U+200C and U+200D, which Persian
 * text needs, are allowed.
 */
const HIDDEN =
  /(?![\n\t])\p{Cc}|[\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** The note's text: trimmed, Windows line breaks made plain, 1 to 2000 characters. */
export function parseCustomerNoteBody(
  value: unknown,
): Result<string, { readonly path: 'body'; readonly code: string }> {
  if (typeof value !== 'string') return err({ path: 'body', code: 'type' });
  const body = value.replace(/\r\n?/g, '\n').trim();
  if (body.length === 0) return err({ path: 'body', code: 'required' });
  if (Array.from(body).length > CUSTOMER_NOTE_MAX) return err({ path: 'body', code: 'too-long' });
  if (HIDDEN.test(body)) return err({ path: 'body', code: 'format' });
  return ok(body);
}

/** A note as stored: its text is sealed under the customer account's subject key. */
export interface StoredCustomerNote {
  readonly id: Id<'CustomerNote'>;
  readonly accountId: Id<'Account'>;
  readonly authorAccountId: Id<'Account'>;
  readonly bodySealed: string;
  readonly createdAt: Temporal.Instant;
}
