// Internal notes on an order, for admins only (order detail decision 3, 31 Oct 2026): the
// customer and the seller never see them, and a seller's own notes are a separate list the admin
// does not see. A note is written once and never changed or removed (an audit trail of support
// work). Free text (ordering data design O8): stored only sealed under the order's customer
// account key, never logged or audited. Plain text: rendered escaped, never as markup or links.

/** The longest note, in characters (code points). */
export const NOTE_MAX_LENGTH = 2000;

/**
 * Control characters other than a line break or a tab, line and paragraph separators, the
 * bidirectional marks, embeddings, overrides and isolates (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069) and the invisible ones (U+200B, U+2060 to U+2064, U+FEFF) are refused:
 * no hidden or reordered text in the support trail. The joiners U+200C and U+200D, which Persian
 * text needs, are allowed.
 */
function hasHiddenCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x09) continue;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200b ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x2060 && code <= 0x2064) ||
      code === 0xfeff ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The note's text: a string, trimmed at both ends, with Windows line breaks made plain, from 1 to
 * {@link NOTE_MAX_LENGTH} characters, with no control or bidirectional override characters.
 */
export function parseNoteBody(
  value: unknown,
):
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  if (typeof value !== 'string') return { ok: false, fields: [{ path: 'body', code: 'type' }] };
  const body = value.replace(/\r\n?/g, '\n').trim();
  if (body.length === 0) return { ok: false, fields: [{ path: 'body', code: 'required' }] };
  if (Array.from(body).length > NOTE_MAX_LENGTH) {
    return { ok: false, fields: [{ path: 'body', code: 'too-long' }] };
  }
  if (hasHiddenCharacter(body)) return { ok: false, fields: [{ path: 'body', code: 'format' }] };
  return { ok: true, body };
}
