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
  /** Token indexes in the normalised text; `null` for a compact match (no token span). */
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

/** The UTS #39 prototype of one case-preserved character, or the character itself. */
function utsOf(ch: string, visualDigits: boolean): string {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80 || isCurated(ch)) return ch;
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

/**
 * An Arabic-script letter with an ASCII-letter look-alike that has no Arabic letter on either
 * side, inside Latin text, is read as that letter: «haاal» is halal (Hassan S1). Inside Arabic
 * words the mini-review's folds stand.
 */
function latinContextFold(s: string): string {
  const chars = [...s];
  return chars
    .map((ch, i) => {
      if (!ARABIC_SCRIPT.test(ch)) return ch;
      const before = chars[i - 1] ?? '';
      const after = chars[i + 1] ?? '';
      if (ARABIC_LETTER.test(before) || ARABIC_LETTER.test(after)) return ch;
      if (!LATIN_LETTER.test(before) && !LATIN_LETTER.test(after)) return ch;
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

/** One answer per input text, in order; a text with no claim word answers `[]`. */
export function matchClaimTerms(
  texts: readonly string[],
  vocabulary: PreparedVocabulary,
): ClaimTermMatch[][] {
  if (texts.length > MAX_TEXTS) throw new RangeError('too many claim texts');
  return texts.map((text) => {
    // Two readings: non-ASCII digits as numbers and as the letters they look like (Hassan S2).
    // They split into the same tokens, so a span of either holds for both.
    const readings = [normaliseClaimText(text), normaliseClaimText(text, true)].map((n) => ({
      tokens: tokenise(n),
      compact: compactForm(n),
    }));
    const matches: ClaimTermMatch[] = [];
    for (const entry of vocabulary.entries) {
      let found: ClaimTermMatch | null = null;
      for (const { tokens } of readings) {
        for (const phrase of entry.phrases) {
          const at = findPhrase(tokens, phrase);
          if (at >= 0) {
            found = {
              typeCode: entry.typeCode,
              pass: 'token',
              span: { fromToken: at, toToken: at + phrase.length - 1 },
            };
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
