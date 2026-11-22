import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BADGE_ICON_KEY_PATTERN } from '../domain/type-revision';

/**
 * The checked-in list of badge artwork keys (`config/certification-badge-artwork/keys.json`):
 * data, so artwork names such as a type's code live in a configuration file and not in core code
 * (ADR-0003 decision 2). A revision naming another key is refused (FE-091, new-type design 5).
 */
export const DEFAULT_BADGE_ARTWORK_FILE = path.resolve(
  __dirname,
  '../../../../../../config/certification-badge-artwork/keys.json',
);

const file = z.strictObject({
  note: z.string().optional(),
  keys: z.array(z.string().regex(BADGE_ICON_KEY_PATTERN)).min(1),
});

/** A list that is unreadable, malformed or repeats a key: the start-up stops. */
export class BadgeArtworkKeysError extends Error {}

export function loadBadgeArtworkKeys(
  location: string = DEFAULT_BADGE_ARTWORK_FILE,
): readonly string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(location, 'utf8'));
  } catch (error) {
    throw new BadgeArtworkKeysError(`badge artwork keys unreadable: ${(error as Error).message}`);
  }
  const parsed = file.safeParse(raw);
  if (!parsed.success) throw new BadgeArtworkKeysError(parsed.error.message);
  if (new Set(parsed.data.keys).size !== parsed.data.keys.length) {
    throw new BadgeArtworkKeysError('badge artwork keys: a key is listed twice');
  }
  return Object.freeze([...parsed.data.keys]);
}
