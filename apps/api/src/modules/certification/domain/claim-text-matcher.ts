import type { CertificationTypeCode } from './claim-types';
import {
  ARABIC_PRE_MAP,
  LEET_MAP,
  MAX_TEXTS,
  MAX_TEXT_LENGTH,
  PRE_FOLD_MAP,
  SKELETON_MAP,
  numericOrIndicatorToAscii,
} from './claim-text-data';
import { UTS39_CONFUSABLES } from './generated/uts39-confusables';

/**
 * The one claim-text matcher (design 4.6, CERT-01, ADR-0019 R1): pure, no I/O, no model. The
 * facade `matchClaimTerms` for `catalog`, the claim guard for `platform/ai` and (later) `sellers`
 * all call it with the vocabulary of the Market: every type, active or inactive, from published
 * revisions, with the terms of every locale applied to every text.
 */

export interface ClaimVocabularyEntry {
  readonly typeCode: CertificationTypeCode;
  /** Terms written by people (R10): phrases of one or more tokens. Never regular expressions. */
  readonly terms: readonly string[];
}

export interface ClaimTermMatch {
  readonly typeCode: CertificationTypeCode;
  /** `token`: whole-token phrase match. `compact`: found with separators removed (M8). */
  readonly pass: 'token' | 'compact';
  /** Token indexes in the number reading of the text; `null` for a compact match (no token span). */
  readonly span: { readonly fromToken: number; readonly toToken: number } | null;
}

export interface PreparedVocabulary {
  readonly entries: readonly {
    readonly typeCode: CertificationTypeCode;
    readonly phrases: readonly (readonly string[])[];
    readonly compacts: readonly string[];
  }[];
}

const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Mn}ـ]/gu;
// Everything that is not a letter or a number is a separator, and so is a modifier letter
// (symbols, emoji, enclosing and spacing marks included): Hassan, PR 132.
const SEPARATOR = /[^\p{L}\p{N}]|\p{Lm}/gu;

function mapChars(s: string, map: Readonly<Record<string, string>>): string {
  let out = '';
  for (const ch of s) out += Object.hasOwn(map, ch) ? map[ch]! : ch;
  return out;
}

// Left to the curated tables, not the UTS #39 table (issue #133): ASCII (UTS maps `!`, `%` and
// digits to letters, which would bypass the separators and the second pass; `m` to `rn`) and the
// Arabic script (UTS maps alef to `l` and heh to `o`; inside Arabic words the folds are the
// mini-review's of 2026-10-14, and between Latin letters `latinContextFold` applies UTS).
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const ARABIC_LETTER = /(?=\p{L})\p{Script=Arabic}/u;
const LATIN_LETTER = /(?=\p{L})\p{Script=Latin}/u;
const isCurated = (ch: string): boolean =>
  Object.hasOwn(SKELETON_MAP, ch) || Object.hasOwn(SKELETON_MAP, ch.toLowerCase());

/**
 * Per-character results are a pure function of the character (and the reading), so each is
 * computed once per process (Hassan S4). A hostile text can name at most 1.1 million distinct
 * characters; the cache is emptied past this size so it never grows without bound.
 */
const MEMO_LIMIT = 150_000;
const utsMemo = [new Map<string, string>(), new Map<string, string>()];
const curatedMemo = new Map<string, string>();

function memoised(memo: Map<string, string>, ch: string, compute: () => string): string {
  const known = memo.get(ch);
  if (known !== undefined) return known;
  const value = compute();
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(ch, value);
  return value;
}

/** The UTS #39 prototype of one case-preserved character, or the character itself. */
function utsOf(ch: string, visualDigits: boolean): string {
  if (ch.charCodeAt(0) < 0x80) return ch;
  return memoised(utsMemo[visualDigits ? 1 : 0]!, ch, () => computeUtsOf(ch, visualDigits));
}

function computeUtsOf(ch: string, visualDigits: boolean): string {
  const cp = ch.codePointAt(0)!;
  if (isCurated(ch)) return ch;
  if (numericOrIndicatorToAscii(cp) !== null) {
    // A digit is read as its number (the second pass maps numbers to letters), or in the visual
    // reading as the letter it looks like (٥ ۵ as o, ٧ as V; Hassan S2).
    return visualDigits && cp < 0x1f100 ? (UTS39_CONFUSABLES.get(ch) ?? ch) : ch;
  }
  if (ARABIC_SCRIPT.test(ch)) return ch;
  return caseInsensitiveRow(ch) ?? ch;
}

const ASCII_ALNUM = /^[a-z0-9]$/;

/**
 * UTS #39 is case-sensitive: a letter and its other case can have different rows (Cyrillic З is
 * 3 but з is ɜ; Cherokee Ꮶ is K but ꮶ is ĸ). A case edit must never change a skeleton, so a
 * letter and its case partner share one row: the one whose prototype is an ASCII letter or digit
 * when either is (the look-alike a reader sees), else the lower letter's, else its own.
 */
function caseInsensitiveRow(ch: string): string | undefined {
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  const single = (s: string) => [...s].length === 1;
  const rows = [ch, lower, upper]
    .filter((c, i, all) => single(c) && all.indexOf(c) === i && !isCurated(c))
    .map((c) => ({ c, row: UTS39_CONFUSABLES.get(c) }))
    .filter((r): r is { c: string; row: string } => r.row !== undefined);
  const asciiRow = rows.find((r) => ASCII_ALNUM.test(r.row.toLowerCase()));
  if (asciiRow !== undefined) return asciiRow.row;
  return (rows.find((r) => r.c === lower) ?? rows.find((r) => r.c === ch))?.row;
}

/** The curated table, then digits of every script and regional indicators as ASCII. */
function curatedOf(ch: string): string {
  if (ch.charCodeAt(0) < 0x80 && !Object.hasOwn(SKELETON_MAP, ch)) return ch;
  return memoised(curatedMemo, ch, () => computeCuratedOf(ch));
}

function computeCuratedOf(ch: string): string {
  if (Object.hasOwn(SKELETON_MAP, ch)) return SKELETON_MAP[ch]!;
  return numericOrIndicatorToAscii(ch.codePointAt(0)!) ?? ch;
}

/**
 * One round of the skeleton: UTS #39 on the case-preserved NFD text (UTS is case-sensitive, so a
 * capital look-alike is read before lower-casing; Hassan B1), then the capital-I rule, case fold,
 * marks and default-ignorable, bidi and format characters removed, then the curated table.
 */
function skeletonRound(s: string, visualDigits: boolean): string {
  let out = '';
  for (const ch of s.normalize('NFD')) out += utsOf(ch, visualDigits);
  // A prototype can hold compatibility characters (‰ is º/₀₀): NFKC again before the folds.
  out = mapChars(out.normalize('NFKC'), PRE_FOLD_MAP)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .normalize('NFD')
    .replace(IGNORABLE, '')
    .normalize('NFC');
  let curated = '';
  for (const ch of out) curated += curatedOf(ch);
  return curated;
}

/** Not a letter or number (or a modifier letter): punctuation, spaces and symbols between letters. */
const SEPARATOR_CHAR = /^(?:[^\p{L}\p{N}]|\p{Lm})$/u;

/**
 * An Arabic-script letter with an ASCII-letter look-alike that has no Arabic letter directly
 * next to it, inside Latin text, is read as that letter: «haاal» is halal (Hassan S1). Only a
 * DIRECTLY adjacent Arabic letter blocks the fold (as before Hassan S5, so nothing that folded
 * then stops folding: «halaا ب», «halaا-بيع»). Skipping punctuation, spaces and other separators
 * can only ADD Latin context («ha.ا.al», «ha ا al»); a letter of another script does not count
 * as Latin context. Inside Arabic words the folds stand.
 */
/** @internal exported for the differential test only. */
export function latinContextFold(s: string): string {
  if (!ARABIC_SCRIPT.test(s)) return s;
  const chars = [...s];
  // The nearest non-separator character on each side, found in one pass each way.
  const before: string[] = new Array<string>(chars.length);
  const after: string[] = new Array<string>(chars.length);
  let last = '';
  for (let i = 0; i < chars.length; i++) {
    before[i] = last;
    if (!SEPARATOR_CHAR.test(chars[i]!)) last = chars[i]!;
  }
  last = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    after[i] = last;
    if (!SEPARATOR_CHAR.test(chars[i]!)) last = chars[i]!;
  }
  return chars
    .map((ch, i) => {
      if (!ARABIC_SCRIPT.test(ch)) return ch;
      if (ARABIC_LETTER.test(chars[i - 1] ?? '') || ARABIC_LETTER.test(chars[i + 1] ?? ''))
        return ch;
      if (!LATIN_LETTER.test(before[i]!) && !LATIN_LETTER.test(after[i]!)) return ch;
      const prototype = UTS39_CONFUSABLES.get(ch)?.toLowerCase();
      return prototype !== undefined && /^[a-z]+$/.test(prototype) ? prototype : ch;
    })
    .join('');
}

/** Rounds until nothing changes: a prototype can itself have a look-alike row. */
const MAX_ROUNDS = 6;

/**
 * Unicode NFKC, then the confusable skeleton until it settles (UTS #39 on case-preserved text,
 * case fold, marks and ignorables removed, the curated table), then the Arabic-script folds.
 * Idempotent. `visualDigits` reads non-ASCII digits as the letters they look like (the second
 * reading of `matchClaimTerms`).
 */
export function normaliseClaimText(input: string, visualDigits = false): string {
  if (input.length > MAX_TEXT_LENGTH) throw new RangeError('claim text too long');
  // Dagger alef is a mark and would be stripped below: fold it first (with the alef and lam
  // variants, and the Greek lunate sigmas NFKC would turn into σ), before NFKC.
  const folded = mapChars(input, ARABIC_PRE_MAP);
  let s = folded.normalize('NFKC');
  // NFKC can grow a text a lot (one character to many): check the size again.
  if (s.length > MAX_TEXT_LENGTH) throw new RangeError('claim text too long');
  s = mapChars(s, PRE_FOLD_MAP);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = latinContextFold(skeletonRound(s, visualDigits));
    if (next === s) break;
    s = next;
  }
  // Every vertical stroke (١ ۱ 1 l i I | and their look-alikes) is `l` or `1` after the skeleton;
  // between Arabic letters it is an alef (mini-review C2, Hassan M1). Latin context is untouched,
  // so "ha١al" still goes the leet way in the second pass.
  return s.replace(/(?<=\p{Script=Arabic})[l1](?=\p{Script=Arabic})/gu, 'ا');
}

/** Tokens split on whitespace and punctuation (as SL 3.5). */
export function tokenise(normalised: string): string[] {
  return normalised.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/** Second-pass form: separators removed, then the digit-to-letter map. */
export function compactForm(normalised: string): string {
  // The map runs first: `@` is punctuation and would otherwise be removed as a separator.
  return mapChars(normalised, LEET_MAP).replace(SEPARATOR, '');
}

export function prepareVocabulary(vocabulary: readonly ClaimVocabularyEntry[]): PreparedVocabulary {
  return {
    entries: vocabulary.map((entry) => {
      const phrases: string[][] = [];
      const compacts: string[] = [];
      for (const term of entry.terms) {
        const normalised = normaliseClaimText(term);
        const tokens = tokenise(normalised);
        const compact = compactForm(normalised);
        // An empty term would match every text: a vocabulary fault, not a quiet skip.
        if (tokens.length === 0 || compact.length === 0) {
          throw new RangeError('claim term has no matchable content');
        }
        phrases.push(tokens);
        compacts.push(compact);
      }
      return { typeCode: entry.typeCode, phrases, compacts };
    }),
  };
}

function findPhrase(tokens: readonly string[], phrase: readonly string[]): number {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return i;
  }
  return -1;
}

type Span = { readonly fromToken: number; readonly toToken: number };

/** Raw pieces of a text between separators: a digit stays in its piece, whatever the reading. */
const RAW_PIECE = /[^\p{L}\p{N}]+/u;

interface PieceCount {
  readonly number: number;
  readonly visual: number;
}

/**
 * The raw pieces of one text with their token counts in both readings, built at most once per
 * text and shared by every vocabulary entry (Hassan M1). `null` when the counts cannot be
 * trusted: the pieces joined by spaces must normalise and tokenise to exactly the tokens of the
 * whole text in both readings (a symbol NFKC turns into letters, or an ignorable inside a word,
 * breaks that; Hassan L1).
 */
function pieceTable(
  text: string,
  numberTokens: readonly string[],
  visualTokens: readonly string[],
) {
  const pieces = text.split(RAW_PIECE).filter((p) => p.length > 0);
  const joined = pieces.join(' ');
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((t, i) => t === b[i]);
  if (
    !same(tokenise(normaliseClaimText(joined)), numberTokens) ||
    !same(tokenise(normaliseClaimText(joined, true)), visualTokens)
  ) {
    return null;
  }
  const counts: PieceCount[] = pieces.map((piece) => ({
    number: tokenise(normaliseClaimText(piece)).length,
    visual: tokenise(normaliseClaimText(piece, true)).length,
  }));
  if (
    counts.reduce((n, c) => n + c.number, 0) !== numberTokens.length ||
    counts.reduce((n, c) => n + c.visual, 0) !== visualTokens.length
  ) {
    return null;
  }
  return counts;
}

/**
 * The span of a match found in the visual reading, as token indexes of the number reading (the
 * one the spans are about). The readings split a text differently only around non-ASCII digits
 * (٠ ۰ are `.` in the visual reading; Tamil and Malayalam digits expand), so each raw piece of
 * the text is counted in both readings and the match is widened to whole pieces. When the piece
 * table cannot be checked against the whole text (`pieceTable`) or the match falls in no piece,
 * the span covers every token: it over-reports rather than pointing at a token that is not the
 * match (the span only drives highlighting; the match itself is always reported).
 */
function toNumberReading(
  counts: readonly PieceCount[] | null,
  visualSpan: Span,
  numberTokens: number,
): Span {
  const whole: Span = { fromToken: 0, toToken: Math.max(0, numberTokens - 1) };
  if (counts === null) return whole;
  let numberAt = 0;
  let visualAt = 0;
  let from = -1;
  let to = -1;
  for (const c of counts) {
    const visualEnd = visualAt + c.visual - 1;
    if (c.visual > 0 && visualEnd >= visualSpan.fromToken && visualAt <= visualSpan.toToken) {
      if (from < 0) from = numberAt;
      to = numberAt + c.number - 1;
    }
    numberAt += c.number;
    visualAt += c.visual;
  }
  return from >= 0 && to >= from ? { fromToken: from, toToken: to } : whole;
}

/** One answer per input text, in order; a text with no claim word answers `[]`. */
export function matchClaimTerms(
  texts: readonly string[],
  vocabulary: PreparedVocabulary,
): ClaimTermMatch[][] {
  if (texts.length > MAX_TEXTS) throw new RangeError('too many claim texts');
  return texts.map((text) => {
    // Two readings: non-ASCII digits as numbers and as the letters they look like (Hassan S2).
    // They can split into different tokens, so a span found in the second reading is translated
    // to the tokens of the first (`toNumberReading`): a span always indexes the number reading.
    const readings = [normaliseClaimText(text), normaliseClaimText(text, true)].map((n) => ({
      tokens: tokenise(n),
      compact: compactForm(n),
    }));
    const matches: ClaimTermMatch[] = [];
    let table: readonly PieceCount[] | null | undefined; // built lazily, once for this text
    for (const entry of vocabulary.entries) {
      let found: ClaimTermMatch | null = null;
      for (const [r, { tokens }] of readings.entries()) {
        for (const phrase of entry.phrases) {
          const at = findPhrase(tokens, phrase);
          if (at >= 0) {
            const own = { fromToken: at, toToken: at + phrase.length - 1 };
            const first = readings[0]!.tokens;
            const sameSplit =
              r === 0 || (first.length === tokens.length && first.every((t, i) => t === tokens[i]));
            if (!sameSplit && table === undefined) table = pieceTable(text, first, tokens);
            const span = sameSplit ? own : toNumberReading(table ?? null, own, first.length);
            found = { typeCode: entry.typeCode, pass: 'token', span };
            break;
          }
        }
        if (found !== null) break;
      }
      if (
        found === null &&
        readings.some(({ compact }) => entry.compacts.some((c) => compact.includes(c)))
      ) {
        found = { typeCode: entry.typeCode, pass: 'compact', span: null };
      }
      if (found !== null) matches.push(found);
    }
    return matches;
  });
}
