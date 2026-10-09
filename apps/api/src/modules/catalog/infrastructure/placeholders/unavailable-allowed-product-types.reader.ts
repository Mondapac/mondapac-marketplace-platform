import type { AllowedProductTypesReader } from '../../application/ports/allowed-product-types.reader';

/**
 * ADR-0031 decision 1: `sellers` has no `allowedProductTypesOf` yet, so every answer is an error
 * and the callers refuse. Replaced by its own binding PR when the method merges (sellers slice 9);
 * the `@FailClosedPlaceholder` marker arrives with the registry PR (decision 4).
 */
export class UnavailableAllowedProductTypesReader implements AllowedProductTypesReader {
  allowedFor(): Promise<null> {
    return Promise.resolve(null);
  }
}
