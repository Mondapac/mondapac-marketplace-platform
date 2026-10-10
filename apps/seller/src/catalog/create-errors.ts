import type { ApiFailure } from '../api/client.ts';

export interface CreateProblem {
  /** A full message key for the form-level banner. */
  readonly form: string;
  /** Field name (`typeCode`, `sellerSku`, `conditionCode`, `description.<locale>`) to a message key. */
  readonly fields: Readonly<Record<string, string>>;
}

const FIELD_CODES = new Set(['required', 'length', 'characters']);

const BY_CODE: Readonly<Record<string, string>> = {
  'type.not-allowed': 'type-not-allowed',
  'product.type-not-offered': 'type-not-offered',
  'setting.product-creation-off': 'creation-off',
  'offer.sku-taken': 'sku-taken',
  'seller.not-eligible': 'not-eligible',
  'request.throttled': 'throttled',
};

export function createProblemOf(failure: ApiFailure): CreateProblem {
  if (failure.code === 'validation.failed') {
    const fields: Record<string, string> = {};
    for (const problem of failure.details?.fields ?? []) {
      if (problem.path in fields) continue;
      fields[problem.path] = FIELD_CODES.has(problem.code)
        ? `catalog.create.validation.${problem.code}`
        : 'catalog.create.validation.invalid';
    }
    return { form: 'catalog.create.validation.summary', fields };
  }
  const known = BY_CODE[failure.code];
  if (known !== undefined) {
    const fields: Record<string, string> =
      known === 'type-not-allowed' || known === 'type-not-offered'
        ? { typeCode: `catalog.create.error.${known}` }
        : known === 'sku-taken'
          ? { sellerSku: `catalog.create.error.${known}` }
          : {};
    return { form: `catalog.create.error.${known}`, fields };
  }
  if (failure.code === 'request.csrf') return { form: 'identity.error.request.csrf', fields: {} };
  if (failure.status === 503 || failure.status === 0)
    return { form: 'catalog.create.error.unavailable', fields: {} };
  return { form: 'identity.error.unknown', fields: {} };
}
