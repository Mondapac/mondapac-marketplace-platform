import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

export const AREA_NAME_MAX_LENGTH = 120;
export const AREA_NAMES_MAX_EDITS = 20;

const AREA_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const KEYS = ['areaCode', 'names'] as const;

export interface AreaNamesProblem {
  readonly path: string;
  readonly code: string;
}

/** One language of an edit: a name to set, or null to restore the name the configuration holds. */
export type AreaNameChange = string | null;

export interface AreaNamesEdit {
  readonly areaCode: string;
  /** Language tag to the new name, or null to remove the edit for that language. */
  readonly names: ReadonlyMap<string, AreaNameChange>;
}

export interface AreaNamesRefused {
  readonly code: 'validation.failed';
  readonly fields: readonly AreaNamesProblem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a name once trimmed, or null when it breaks the rules (length, control characters). */
export function cleanAreaName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > AREA_NAME_MAX_LENGTH) return null;
  return FORBIDDEN.test(trimmed) ? null : trimmed;
}

/**
 * Checks the body of an edit of service area names: a closed object `{ areaCode, names }` where
 * `names` maps a language of the list to a name or to null (restore the configured name).
 * Whether the area exists is the use case's. A problem is a path and a code; a value is never
 * echoed.
 */
export function parseAreaNamesEdit(
  raw: unknown,
  languages: readonly string[],
): Result<AreaNamesEdit, AreaNamesRefused> {
  if (!isRecord(raw)) {
    return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
  }
  const problems: AreaNamesProblem[] = [];
  for (const key of Object.keys(raw).sort()) {
    if (!(KEYS as readonly string[]).includes(key)) {
      problems.push({ path: key.slice(0, 64), code: 'unknown-field' });
    }
  }
  const areaCode = raw['areaCode'];
  if (typeof areaCode !== 'string') {
    problems.push({ path: 'areaCode', code: areaCode === undefined ? 'required' : 'type' });
  } else if (!AREA_CODE.test(areaCode)) {
    problems.push({ path: 'areaCode', code: 'format' });
  }
  const names = new Map<string, AreaNameChange>();
  const namesRaw = raw['names'];
  if (!isRecord(namesRaw)) {
    problems.push({ path: 'names', code: namesRaw === undefined ? 'required' : 'type' });
  } else {
    const locales = Object.keys(namesRaw).sort();
    if (locales.length === 0) problems.push({ path: 'names', code: 'empty' });
    if (locales.length > AREA_NAMES_MAX_EDITS) problems.push({ path: 'names', code: 'too-many' });
    for (const locale of locales.slice(0, AREA_NAMES_MAX_EDITS)) {
      const path = `names.${locale.slice(0, 16)}`;
      const value = namesRaw[locale];
      if (!LOCALE.test(locale) || !languages.includes(locale)) {
        problems.push({ path, code: 'locale' });
      } else if (value === null) {
        names.set(locale, null);
      } else if (typeof value !== 'string') {
        problems.push({ path, code: 'type' });
      } else {
        const clean = cleanAreaName(value);
        if (clean === null) problems.push({ path, code: 'value' });
        else names.set(locale, clean);
      }
    }
  }
  if (problems.length > 0 || typeof areaCode !== 'string') {
    return err({ code: 'validation.failed', fields: problems });
  }
  return ok({ areaCode, names });
}
