import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  CertificationTypeView,
  CertificationUnavailable,
  CertificationValidationFailed,
  ClaimTextInput,
} from '../contracts/certification.facade';
import {
  matchClaimTerms,
  prepareVocabulary,
  type ClaimTermMatch,
} from '../domain/claim-text-matcher';
import { MAX_TEXTS, MAX_TEXT_LENGTH } from '../domain/claim-text-data';
import type { PublishedTypesReader } from './ports/published-types.reader';

export type QueryFailure = CertificationValidationFailed | CertificationUnavailable;

const logger = new Logger('CertificationQueries');
const UNAVAILABLE: CertificationUnavailable = { code: 'certification.unavailable' };
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const invalid = (path: string, code: string): Result<never, CertificationValidationFailed> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

/** The request check of `matchClaimTerms`: refused whole, before any read. */
function parseTexts(
  texts: readonly ClaimTextInput[],
): Result<readonly string[], CertificationValidationFailed> {
  if (!Array.isArray(texts) || texts.length > MAX_TEXTS) return invalid('texts', 'length');
  const plain: string[] = [];
  for (const [index, item] of (texts as readonly unknown[]).entries()) {
    const entry = item as Partial<ClaimTextInput> | null;
    if (typeof entry !== 'object' || entry === null) return invalid(`texts.${index}`, 'format');
    if (typeof entry.locale !== 'string' || !LOCALE_PATTERN.test(entry.locale)) {
      return invalid(`texts.${index}.locale`, 'format');
    }
    if (typeof entry.text !== 'string') return invalid(`texts.${index}.text`, 'format');
    if (entry.text.length > MAX_TEXT_LENGTH) return invalid(`texts.${index}.text`, 'length');
    plain.push(entry.text);
  }
  return ok(plain);
}

/**
 * The one query behind both use cases of the pair (design 8.1, 4.6). It reads the published
 * vocabulary of the caller's Market and nothing of the actor, so the answer is the same for
 * every caller. A failed read, or a vocabulary the matcher cannot use, is `certification.
 * unavailable`: never an empty answer a caller could read as "no claim words" (M8).
 */
export async function matchClaimTermsFor(
  reader: PublishedTypesReader,
  context: CallContext,
  texts: readonly ClaimTextInput[],
): Promise<Result<readonly (readonly ClaimTermMatch[])[], QueryFailure>> {
  const parsed = parseTexts(texts);
  if (!parsed.ok) return parsed;
  try {
    const vocabulary = prepareVocabulary(await reader.claimVocabulary(context.market));
    return ok(matchClaimTerms(parsed.value, vocabulary));
  } catch (error) {
    // Never the texts or the terms: the class of the failure only.
    logger.error(`matchClaimTerms failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return err(UNAVAILABLE);
  }
}

export async function certificationTypesFor(
  reader: PublishedTypesReader,
  context: CallContext,
  filter: { readonly status?: 'active' | 'inactive' },
): Promise<Result<readonly CertificationTypeView[], QueryFailure>> {
  const status = (filter as { status?: unknown } | null)?.status;
  if (status !== undefined && status !== 'active' && status !== 'inactive') {
    return invalid('status', 'format');
  }
  try {
    return ok(await reader.types(context.market, status === undefined ? {} : { status }));
  } catch (error) {
    logger.error(`certificationTypes failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return err(UNAVAILABLE);
  }
}
