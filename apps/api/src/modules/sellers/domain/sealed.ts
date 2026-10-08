/**
 * The personal fields of the draft that are stored only as ciphertext under the seller's key
 * (sellers design 8.1, T2 option B; data design 3.1, 4.2). Their labels are constants of
 * `infrastructure/`; the domain knows only which field a sealed value belongs to.
 */
export const SEALED_FIELDS = [
  'business-name',
  'phone',
  'contact-email',
  'address',
  'registered-address',
] as const;
export type SealedField = (typeof SEALED_FIELDS)[number];

/**
 * A field's ciphertext, typed by its field so that a value sealed for one column cannot be put
 * in another. Opaque to the domain: it is never compared, parsed or shown (PF 4 row 2).
 */
export type Sealed<F extends SealedField> = string & { readonly __sealed: F };
