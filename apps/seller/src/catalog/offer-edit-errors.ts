import type { ApiFailure } from '../api/client.ts';
import { createProblemOf, type CreateProblem } from './create-errors.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'claim-text.refused': 'claim-text',
  'conflict.stale': 'stale',
  'offer.not-editable': 'not-editable',
  'offer.not-found': 'not-found',
  'access.denied': 'denied',
};

/** The problem of a failed offer edit; field errors and shared causes come from the create form. */
export function offerEditProblemOf(failure: ApiFailure): CreateProblem {
  const named = BY_CODE[failure.code];
  if (named !== undefined) {
    return {
      form: `catalog.offer-edit.error.${named}`,
      fields: named === 'claim-text' ? { description: `catalog.offer-edit.error.${named}` } : {},
    };
  }
  return createProblemOf(failure);
}
