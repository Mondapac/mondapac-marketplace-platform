import { err, ok, parsePlainText, type Result } from '@mondapac/shared-kernel';

// The About text of a store (sellers design 3.7, 8.1; slice 12 part 2): free text a seller writes
// for the buyer site, shown as plain text. It is encrypted at rest (8.1) and public once saved.

/** The most characters (code points) one locale's About text may have. */
export const STORE_ABOUT_MAX_LENGTH = 2000;

export type AboutInvalid = {
  readonly code: 'about.invalid';
  /** `length` over the limit; `characters` for a control, bidi or hidden character; `url` for a link or address. */
  readonly rule: 'length' | 'characters' | 'url';
};

/**
 * Control characters other than the line feed, and the bidi marks, embeddings, overrides and
 * isolates (the class of the HF13 display-name rule). A line feed is kept: an About text has
 * paragraphs. Carriage returns are turned into line feeds before this runs.
 */
const FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;
const LINE_FEED = '\n';

/**
 * URL-like text (HF13): a scheme, a `www.` host, an email address, or a dotted host
 * name such as `shop.example.com`, `myshop.com` or `t.me` (a one-letter first label counts). The same patterns as identity's display-name rule (HF13); `sellers` cannot
 * import another module's internals (ADR-0008), so they are repeated here, and a change to one
 * must be made in the other. The store's contact path is the platform, so a link or address in
 * a store's text is refused rather than shown.
 */
const URL_LIKE = [
  /[a-z][a-z0-9+.-]*:\/\//iu,
  /(?:^|[^\p{L}\p{N}])www\./iu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/iu,
  /[\p{L}\p{N}-]+\.[\p{L}\p{N}-]+\.\p{L}{2,}(?=$|[^\p{L}\p{N}-])/iu,
  /[\p{L}\p{N}-]+\.\p{L}{2,}(?=$|[^\p{L}\p{N}-])/iu,
];

/**
 * The text as the URL patterns see it: NFKC turns full-width and compatibility forms (`．`, `＠`,
 * full-width letters) into their ASCII shapes, and the ideographic and half-width full stops
 * (`。`, `｡`), the Arabic full stop and decimal separator (`۔`, `٫`), the middle dot and the
 * hyphenation point (`·`, `‧`), which NFKC leaves alone, become `.`. Combining marks are removed,
 * so a mark placed between a letter and a dot does not hide a host name. Only the test uses this;
 * the stored text is the seller's own (NFC).
 */
function foldForUrlTest(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[。．｡۔٫·‧]/gu, '.')
    .replace(/\p{M}/gu, '');
}

/**
 * One locale's About text: trimmed, line endings made `\n`, NFC; at most
 * {@link STORE_ABOUT_MAX_LENGTH} characters; no control or bidi character (a line feed is fine) and
 * no hidden character (zero-width joiners stay only between letters of a joining script, as the
 * kernel's plain-text rule says); no URL-like text. An empty text is valid: it clears the locale.
 * Personal data: the text never reaches a log, an event or an audit row.
 */
export function parseAboutText(raw: unknown): Result<string, AboutInvalid> {
  if (typeof raw !== 'string') return err({ code: 'about.invalid', rule: 'characters' });
  const text = raw.replace(/\r\n?/gu, LINE_FEED).trim().normalize('NFC');
  if ([...text].length > STORE_ABOUT_MAX_LENGTH) {
    return err({ code: 'about.invalid', rule: 'length' });
  }
  if (!parsePlainText(text).ok || FORBIDDEN.test(text.replaceAll(LINE_FEED, ''))) {
    return err({ code: 'about.invalid', rule: 'characters' });
  }
  const folded = foldForUrlTest(text);
  if (URL_LIKE.some((pattern) => pattern.test(folded))) {
    return err({ code: 'about.invalid', rule: 'url' });
  }
  return ok(text);
}
