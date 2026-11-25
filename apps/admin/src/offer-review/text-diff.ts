// A word-level diff of two texts for the Live | Proposed view. Pure: a part is `same`, `removed`
// (only in the live text) or `added` (only in the proposed one); the view marks removed and added
// parts with a sign and a word as well as a style, never with colour only.

export interface Part {
  readonly kind: 'same' | 'removed' | 'added';
  readonly text: string;
}

/** Texts longer than this are not compared word by word (the table is quadratic). */
const MAX_TOKENS = 1500;

const tokens = (text: string): string[] => text.split(/(\s+)/).filter((token) => token !== '');

function push(parts: Part[], kind: Part['kind'], text: string) {
  const last = parts[parts.length - 1];
  if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
  else parts.push({ kind, text });
}

/** The parts that turn `live` into `proposed`; one removed and one added part when too long. */
export function diffText(live: string, proposed: string): { live: Part[]; proposed: Part[] } {
  if (live === proposed) {
    const same: Part[] = live === '' ? [] : [{ kind: 'same', text: live }];
    return { live: same, proposed: same };
  }
  const a = tokens(live);
  const b = tokens(proposed);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return {
      live: live === '' ? [] : [{ kind: 'removed', text: live }],
      proposed: proposed === '' ? [] : [{ kind: 'added', text: proposed }],
    };
  }
  // Longest common subsequence of tokens, filled from the end.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const left: Part[] = [];
  const right: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(left, 'same', a[i]!);
      push(right, 'same', b[j]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(left, 'removed', a[i++]!);
    } else {
      push(right, 'added', b[j++]!);
    }
  }
  while (i < a.length) push(left, 'removed', a[i++]!);
  while (j < b.length) push(right, 'added', b[j++]!);
  return { live: left, proposed: right };
}

export interface LocaleDiff {
  readonly locale: string;
  readonly live: string;
  readonly proposed: string;
  readonly changed: boolean;
}

/** One entry per locale of either side, the changed ones first (then by locale code). */
export function descriptionDiffs(
  live: Readonly<Record<string, string>>,
  proposed: Readonly<Record<string, string>>,
): readonly LocaleDiff[] {
  const locales = [...new Set([...Object.keys(live), ...Object.keys(proposed)])];
  const rows = locales.map((locale) => {
    const before = live[locale] ?? '';
    const after = proposed[locale] ?? '';
    return { locale, live: before, proposed: after, changed: before !== after };
  });
  return rows.sort(
    (x, y) => Number(y.changed) - Number(x.changed) || x.locale.localeCompare(y.locale),
  );
}

/** The type codes of `proposed` not live yet, those live that stay, and those live that go. */
export function tagDiff(
  live: readonly string[],
  proposed: readonly string[],
): { added: string[]; kept: string[]; removed: string[] } {
  const now = new Set(live);
  const next = new Set(proposed);
  return {
    added: [...next].filter((code) => !now.has(code)).sort(),
    kept: [...next].filter((code) => now.has(code)).sort(),
    removed: [...now].filter((code) => !next.has(code)).sort(),
  };
}
