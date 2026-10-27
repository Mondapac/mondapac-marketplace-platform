import type { Id } from '@mondapac/shared-kernel';

// How a review's author is shown (owner decisions N10, N11). The name is the customer's short
// name read at read time, never copied into this module; the author may choose to be anonymous;
// once the account is deleted the link is dropped and the review stays as "Former customer".

export type AuthorLabel =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'verified-buyer' }
  | { readonly kind: 'former-customer' };

export function authorLabel(
  review: { readonly accountId: Id<'Account'> | null; readonly anonymous: boolean },
  shortName: string | undefined,
): AuthorLabel {
  if (review.accountId === null) return { kind: 'former-customer' };
  if (review.anonymous || shortName === undefined || shortName.trim() === '') {
    return { kind: 'verified-buyer' };
  }
  return { kind: 'named', name: shortName };
}
