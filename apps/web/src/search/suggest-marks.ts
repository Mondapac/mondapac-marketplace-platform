/** A piece of a name: marked when it is text the buyer typed. */
export interface MarkPart {
  readonly text: string;
  readonly marked: boolean;
}

/**
 * Splits `text` into parts and marks every place where a word of `query` appears (case-blind).
 * Built by code from plain strings: the caller renders each part as text, so nothing a seller
 * wrote can become markup. When lower-casing would change the length (rare letters), nothing is
 * marked rather than marking the wrong characters.
 */
export function markParts(text: string, query: string): MarkPart[] {
  const lower = text.toLowerCase();
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/u)
        .filter((w) => w !== ''),
    ),
  ];
  if (lower.length !== text.length || words.length === 0) return [{ text, marked: false }];
  const spans: [number, number][] = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      spans.push([at, at + word.length]);
    }
  }
  if (spans.length === 0) return [{ text, marked: false }];
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  const parts: MarkPart[] = [];
  let from = 0;
  for (const [start, end] of merged) {
    if (start > from) parts.push({ text: text.slice(from, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    from = end;
  }
  if (from < text.length) parts.push({ text: text.slice(from), marked: false });
  return parts;
}
