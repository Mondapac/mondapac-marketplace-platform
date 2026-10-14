import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SeededType } from '../../application/ports/type-seed';
import type { CertificationTypeCode } from '../../domain/claim-types';

/**
 * The directory of the per-Market type seeds (`config/certification-seed/<MARKET>.json`): Market
 * data, so the Market's identifiers and the certification names live in a configuration file and
 * not in core code (ADR-0003 decision 2; design 5.2).
 */
export const DEFAULT_TYPE_SEED_DIR = path.resolve(
  __dirname,
  '../../../../../../../config/certification-seed',
);

const text = z.string().min(1).max(2000);
const locale = z.strictObject({
  name: text,
  customerDescription: text,
  claimTerms: z.array(text),
});
const type = z.strictObject({
  code: z.string(),
  status: z.enum(['active', 'inactive']),
  verificationMode: z.enum(['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION']),
  requiresIssuerRegistry: z.boolean(),
  requiresDocument: z.boolean(),
  requiresExpiry: z.boolean(),
  defaultBasis: z.enum(['SELLER_REQUIRED', 'NOT_APPLICABLE']),
  autoApproveSelfDeclaration: z.boolean(),
  badgeIconKey: z.string(),
  locales: z.record(z.string(), locale),
});
const file = z.strictObject({
  market: z.string().regex(/^[A-Z][A-Z0-9_]{1,7}$/),
  note: z.string().optional(),
  types: z.array(type),
});

/** A seed file that is unreadable, malformed or named for another Market: the start-up stops. */
export class TypeSeedFileError extends Error {}

/**
 * Reads every `<MARKET>.json` of the directory. A missing directory is an empty set; a bad file
 * throws. The revision rules (`validateTypeRevision`) are checked by the seed use case.
 */
export function loadFileTypeSeeds(
  directory: string = DEFAULT_TYPE_SEED_DIR,
): Readonly<Record<string, readonly SeededType[]>> {
  const seeds: Record<string, readonly SeededType[]> = {};
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return seeds;
  }
  for (const name of names) {
    const parsed = file.safeParse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
    if (!parsed.success) throw new TypeSeedFileError(`${name}: ${parsed.error.message}`);
    if (path.basename(name, '.json') !== parsed.data.market) {
      throw new TypeSeedFileError(`${name}: names Market ${parsed.data.market}`);
    }
    seeds[parsed.data.market] = parsed.data.types.map(({ code, status, ...content }) => ({
      code: code as CertificationTypeCode,
      status,
      content,
    }));
  }
  return seeds;
}
