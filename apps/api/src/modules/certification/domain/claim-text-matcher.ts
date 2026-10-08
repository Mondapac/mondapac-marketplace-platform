import type { CertificationTypeCode } from './claim-types';
import { LEET_MAP, MAX_TEXT_LENGTH, PRE_FOLD_MAP, SKELETON_MAP } from './claim-text-data';

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
const SEPARATOR = /[\s\p{P}\p{Z}\p{C}]/gu;

function mapChars(s: string, map: Readonly<Record<string, string>>): string {
  let out = '';
  for (const ch of s) out += map[ch] ?? ch;
  return out;
}

/**
 * Unicode NFKC, the capital-I rule, case fold, marks and default-ignorable, bidi and format
 * characters removed, then the confusable skeleton. Idempotent.
 */
export function normaliseClaimText(input: string): string {
  if (input.length > MAX_TEXT_LENGTH) throw new RangeError('claim text too long');
  let s = input.normalize('NFKC');
  s = mapChars(s, PRE_FOLD_MAP);
  s = s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  s = s.normalize('NFD').replace(IGNORABLE, '').normalize('NFC');
  return mapChars(s, SKELETON_MAP);
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
  return texts.map((text) => {
    const normalised = normaliseClaimText(text);
    const tokens = tokenise(normalised);
    const compact = compactForm(normalised);
    const matches: ClaimTermMatch[] = [];
    for (const entry of vocabulary.entries) {
      let found: ClaimTermMatch | null = null;
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
      if (found === null && entry.compacts.some((c) => compact.includes(c))) {
        found = { typeCode: entry.typeCode, pass: 'compact', span: null };
      }
      if (found !== null) matches.push(found);
    }
    return matches;
  });
}
